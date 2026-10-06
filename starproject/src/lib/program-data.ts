import type { Prisma, TaskPriority } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  biggestTask,
  clampPhase,
  openBlockedCount,
  phasesOf,
  programPhase,
  rollupSegments,
  type SegmentRollup,
} from "@/lib/program";

export type ProgramMilestone = {
  id: string;
  title: string;
  dueDate: string; // YYYY-MM-DD
  done: boolean;
  url: string | null;
  subteam: { id: string; name: string; color: string | null } | null;
};

export type ProgramSubteam = {
  id: string;
  name: string;
  color: string | null;
  phase: number;
  openTasks: number;
  nextMilestone: ProgramMilestone | null;
  biggest: {
    id: string;
    projectId: string;
    number: number;
    title: string;
    priority: TaskPriority | null;
    dueDate: string | null;
    blocks: number;
  } | null;
};

/** One project's status: its phases, milestones and where each subteam is. */
export type Program = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  phases: string[];
  phase: number;
  segments: SegmentRollup[];
  milestones: ProgramMilestone[];
  subteams: ProgramSubteam[];
};

/** A homepage card: a tracked top-level project and the systems it shows —
 * its subprojects, plus the project itself when subteams are tracked on it
 * directly (or when it has no subprojects at all). */
export type ProgramCardData = {
  root: Program;
  systems: Program[];
};

const day = (d: Date) => d.toISOString().slice(0, 10);

const statusInclude = {
  phaseStatuses: { include: { subteam: true } },
  milestones: {
    include: { subteam: { select: { id: true, name: true, color: true } } },
    orderBy: { dueDate: "asc" },
  },
} satisfies Prisma.ProjectInclude;

type ProjectWithStatus = Prisma.ProjectGetPayload<{ include: typeof statusInclude }>;

/** Build one project's status from its own tasks (never its subprojects' —
 * each subproject is its own system with its own line). */
async function buildProgram(p: ProjectWithStatus): Promise<Program> {
  const phases = phasesOf(p);
  const tasks = await prisma.task.findMany({
    where: {
      archived: false,
      status: { not: "done" },
      subteamId: { not: null },
      projectId: p.id,
    },
    select: {
      id: true,
      projectId: true,
      number: true,
      title: true,
      status: true,
      priority: true,
      dueDate: true,
      subteamId: true,
      blocking: { select: { task: { select: { status: true } } } },
    },
  });

  const milestones: ProgramMilestone[] = p.milestones.map((m) => ({
    id: m.id,
    title: m.title,
    dueDate: day(m.dueDate),
    done: m.done,
    url: m.url,
    subteam: m.subteam,
  }));

  const subteams: ProgramSubteam[] = p.phaseStatuses
    .map((s) => {
      const mine = tasks.filter((t) => t.subteamId === s.subteamId);
      const big = biggestTask(mine);
      return {
        id: s.subteam.id,
        name: s.subteam.name,
        color: s.subteam.color,
        phase: clampPhase(s.phase, phases.length),
        openTasks: mine.length,
        nextMilestone: milestones.find((m) => !m.done && m.subteam?.id === s.subteamId) ?? null,
        biggest: big && {
          id: big.id,
          projectId: big.projectId,
          number: big.number,
          title: big.title,
          priority: big.priority,
          dueDate: big.dueDate && day(big.dueDate),
          blocks: openBlockedCount(big),
        },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const at = subteams.map((s) => s.phase);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    color: p.color,
    phases,
    phase: programPhase(at, phases.length),
    segments: rollupSegments(at, phases.length),
    milestones,
    subteams,
  };
}

/** Everything the homepage's program cards need, in the admins' card order. */
export async function getProgramCards(): Promise<ProgramCardData[]> {
  const projects = await prisma.project.findMany({
    where: { featured: true, archived: false, parentId: null },
    orderBy: [{ trackOrder: "asc" }, { createdAt: "asc" }],
    include: {
      ...statusInclude,
      children: {
        where: { archived: false },
        // Oldest subproject first; name breaks ties so the rows never shuffle.
        orderBy: [{ createdAt: "asc" }, { name: "asc" }],
        include: statusInclude,
      },
    },
  });

  return Promise.all(
    projects.map(async (p) => {
      const root = await buildProgram(p);
      const children = await Promise.all(p.children.map(buildProgram));
      const rootIsSystem = children.length === 0 || root.subteams.length > 0;
      return { root, systems: rootIsSystem ? [root, ...children] : children };
    }),
  );
}

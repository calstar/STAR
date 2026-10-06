import type { TaskPriority } from "@prisma/client";

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

export type Program = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  /** Header this project sits under on the homepage, or null for its own. */
  group: string | null;
  phases: string[];
  customPhases: boolean;
  phase: number;
  segments: SegmentRollup[];
  milestones: ProgramMilestone[];
  subteams: ProgramSubteam[];
};

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Everything the homepage's program cards need, one query per program. */
export async function getFeaturedPrograms(): Promise<Program[]> {
  const projects = await prisma.project.findMany({
    where: { featured: true, archived: false, parentId: null },
    // Cards are laid out in this order; the board keeps first appearance.
    orderBy: [{ trackOrder: "asc" }, { createdAt: "asc" }],
    include: {
      children: { where: { archived: false }, select: { id: true } },
      phaseStatuses: { include: { subteam: true } },
      milestones: {
        include: { subteam: { select: { id: true, name: true, color: true } } },
        orderBy: { dueDate: "asc" },
      },
    },
  });

  return Promise.all(
    projects.map(async (p) => {
      const phases = phasesOf(p);
      // A program's work is its own tasks and every subproject's.
      const tasks = await prisma.task.findMany({
        where: {
          archived: false,
          status: { not: "done" },
          subteamId: { not: null },
          projectId: { in: [p.id, ...p.children.map((c) => c.id)] },
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
            nextMilestone:
              milestones.find((m) => !m.done && m.subteam?.id === s.subteamId) ?? null,
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
        group: p.trackGroup,
        phases,
        customPhases: p.phases.length > 0,
        phase: programPhase(at, phases.length),
        segments: rollupSegments(at, phases.length),
        milestones,
        subteams,
      };
    }),
  );
}

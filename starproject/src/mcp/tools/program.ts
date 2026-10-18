import { z } from "zod";

import {
  addMilestone,
  deleteMilestone,
  setCardOrder,
  setFeatured,
  setMilestoneDone,
  setMilestoneLink,
  setPhases,
  setSubteamPhase,
  untrackSubteam,
} from "@/lib/actions/program";
import { prisma } from "@/lib/db";
import { clampPhase, phasesOf } from "@/lib/program";
import { getProgramCards } from "@/lib/program-data";

import { DESTRUCTIVE, IDEMPOTENT_WRITE, READ, WRITE, defineTool, type ToolModule } from "./_shared";

// The homepage's program board (src/app/page.tsx → ProgramBoard): which
// projects are tracked, their phase lists, where each subteam is, and their
// milestones. Mutations go through src/lib/actions/program.ts, so the same
// rules apply as in the UI: anyone moves a phase or adds a milestone; only
// admins choose what is tracked, the phase list, and the card order.

// ── Pure serialisation (unit-tested, no DB) ─────────────────────────────────

const day = (d: Date) => d.toISOString().slice(0, 10);

/** "2026-02-31" parses (JS rolls it to March 2); a date input never produces
 * that, but an agent can. Only a day that round-trips is a day. */
export function isCalendarDay(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && day(d) === s;
}

type SubteamRef = { id: string; name: string; color: string | null };

export type MilestoneRow = {
  id: string;
  title: string;
  dueDate: Date;
  done: boolean;
  url: string | null;
  subteam: SubteamRef | null;
};

export type SubteamPhaseRow = { phase: number; subteam: SubteamRef };

export type ProjectProgramRow = {
  id: string;
  name: string;
  parentId: string | null;
  featured: boolean;
  trackOrder: number;
  phases: string[];
  phaseStatuses: SubteamPhaseRow[];
  milestones: MilestoneRow[];
};

export type ProjectProgram = {
  id: string;
  name: string;
  parentId: string | null;
  featured: boolean;
  trackOrder: number;
  phases: string[];
  subteams: {
    subteam: SubteamRef;
    /** Index into `phases`; `phases.length` means every phase is finished. */
    phase: number;
    phaseLabel: string;
    done: boolean;
  }[];
  milestones: {
    id: string;
    title: string;
    dueDate: string; // YYYY-MM-DD
    done: boolean;
    url: string | null;
    subteam: SubteamRef | null;
  }[];
};

/** A milestone as the card shows it: the due day, not a timestamp. */
export function serialiseMilestone(m: MilestoneRow): ProjectProgram["milestones"][number] {
  return { id: m.id, title: m.title, dueDate: day(m.dueDate), done: m.done, url: m.url, subteam: m.subteam };
}

/** A subteam's row on the card. The stored index is clamped the way the
 * board clamps it (the phase list may have been shortened since). */
export function serialiseSubteamPhase(row: SubteamPhaseRow, phases: string[]): ProjectProgram["subteams"][number] {
  const phase = clampPhase(row.phase, phases.length);
  const done = phase === phases.length;
  return { subteam: row.subteam, phase, phaseLabel: done ? "Done" : phases[phase], done };
}

/** One project's program status, in the order the card lists things:
 * subteams by name, milestones by due date. */
export function serialiseProjectProgram(p: ProjectProgramRow): ProjectProgram {
  const phases = phasesOf(p);
  return {
    id: p.id,
    name: p.name,
    parentId: p.parentId,
    featured: p.featured,
    trackOrder: p.trackOrder,
    phases,
    subteams: p.phaseStatuses
      .map((s) => serialiseSubteamPhase(s, phases))
      .sort((a, b) => a.subteam.name.localeCompare(b.subteam.name)),
    milestones: [...p.milestones]
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
      .map(serialiseMilestone),
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

const subteamSelect = { select: { id: true, name: true, color: true } } as const;

async function getProjectProgram(projectId: string): Promise<ProjectProgram> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      parentId: true,
      featured: true,
      trackOrder: true,
      phases: true,
      phaseStatuses: { select: { phase: true, subteam: subteamSelect } },
      milestones: {
        select: { id: true, title: true, dueDate: true, done: true, url: true, subteam: subteamSelect },
        orderBy: { dueDate: "asc" },
      },
    },
  });
  if (!project) throw new Error("Project not found");
  return serialiseProjectProgram(project);
}

/** The tracked top-level projects in card order (what set_card_order changes). */
async function getCardOrder() {
  return prisma.project.findMany({
    where: { featured: true, archived: false, parentId: null },
    orderBy: [{ trackOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, trackOrder: true },
  });
}

async function milestoneProjectId(milestoneId: string): Promise<string> {
  const m = await prisma.milestone.findUnique({ where: { id: milestoneId }, select: { projectId: true } });
  if (!m) throw new Error("Milestone not found");
  return m.projectId;
}

async function requireProject(projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!p) throw new Error("Project not found");
}

async function requireSubteam(subteamId: string): Promise<void> {
  const s = await prisma.subteam.findUnique({ where: { id: subteamId }, select: { id: true } });
  if (!s) throw new Error("Subteam not found");
}

const projectId = z.string().min(1).describe("Project id");
const subteamId = z.string().min(1).describe("Subteam id");
const milestoneId = z.string().min(1).describe("Milestone id (from get_project_program)");

export const programTools: ToolModule = (server) => {
  defineTool(
    server,
    "get_program_board",
    {
      description:
        "The homepage program board: every tracked (featured) top-level project in card order, with each system's phases, per-subteam phase, open-task count, biggest task, and milestones.",
      inputSchema: {},
      annotations: READ,
    },
    async () => getProgramCards(),
  );

  defineTool(
    server,
    "get_project_program",
    {
      description:
        "One project's program status: its phase list (the default list when none is set), each tracked subteam's phase (index, label, done), its milestones by due date, and whether it is featured on the homepage.",
      inputSchema: { projectId },
      annotations: READ,
    },
    async ({ projectId }) => getProjectProgram(projectId),
  );

  // ── Featured projects, phases, card order (admins only) ────────────────

  defineTool(
    server,
    "set_featured",
    {
      description:
        "Admins only. Track a top-level project on the homepage (featured=true; it goes to the bottom of the board and its working subteams start at the first phase) or stop tracking it (false). Subprojects ride on their parent's card and cannot be featured themselves.",
      inputSchema: { projectId, featured: z.boolean() },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ projectId, featured }) => {
      // The action re-numbers a newly tracked project to the bottom of the
      // board every time it runs, so a repeat of the same request is a no-op
      // here rather than a reshuffle.
      const current = await prisma.project.findUnique({ where: { id: projectId }, select: { featured: true } });
      if (!current) throw new Error("Project not found");
      if (current.featured !== featured) await setFeatured(projectId, featured);
      return getProjectProgram(projectId);
    },
  );

  defineTool(
    server,
    "set_phases",
    {
      description:
        "Admins only. Replace a project's phase list, in order (at most 12, each at most 40 characters; blanks are dropped). An empty list restores the default phases.",
      inputSchema: { projectId, phases: z.array(z.string()).describe("Phase names in order; [] = back to the defaults") },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ projectId, phases }) => {
      await requireProject(projectId);
      await setPhases(projectId, phases);
      return getProjectProgram(projectId);
    },
  );

  defineTool(
    server,
    "set_card_order",
    {
      description:
        "Admins only. Re-order the homepage cards: the full list of tracked top-level project ids, top to bottom. Returns the resulting order.",
      inputSchema: { projectIds: z.array(z.string().min(1)).min(1).describe("Every featured top-level project id, in the order to show") },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ projectIds }) => {
      // The action only renumbers the ids it is given; a partial list would
      // leave the rest colliding with the new 0..n-1. The UI always sends the
      // whole board, so require the same here.
      const featured = new Set((await getCardOrder()).map((p) => p.id));
      const given = new Set(projectIds);
      if (given.size !== projectIds.length) throw new Error("projectIds contains a duplicate");
      const missing = [...featured].filter((id) => !given.has(id));
      const extra = projectIds.filter((id) => !featured.has(id));
      if (missing.length || extra.length) {
        throw new Error(
          `projectIds must be exactly the featured top-level projects (see get_program_board).` +
            (missing.length ? ` Missing: ${missing.join(", ")}.` : "") +
            (extra.length ? ` Not featured top-level projects: ${extra.join(", ")}.` : ""),
        );
      }
      await setCardOrder(projectIds);
      return getCardOrder();
    },
  );

  // ── Subteam phases ─────────────────────────────────────────────────────

  defineTool(
    server,
    "set_subteam_phase",
    {
      description:
        "Move a subteam to a phase on a project's card (0 = first phase; the number of phases = done). Adds the subteam to the card if it was not tracked there. Out-of-range values are clamped. The project need not be featured yet; the row shows once it is.",
      inputSchema: { projectId, subteamId, phase: z.number().int().describe("Phase index; phases.length means done") },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ projectId, subteamId, phase }) => {
      await requireProject(projectId);
      await requireSubteam(subteamId);
      await setSubteamPhase(projectId, subteamId, phase);
      return getProjectProgram(projectId);
    },
  );

  defineTool(
    server,
    "untrack_subteam",
    {
      description: "Admins only. Remove a subteam's row from a project's card (its phase is forgotten).",
      inputSchema: { projectId, subteamId },
      annotations: DESTRUCTIVE,
    },
    async ({ projectId, subteamId }) => {
      await requireProject(projectId);
      await untrackSubteam(projectId, subteamId);
      return getProjectProgram(projectId);
    },
  );

  // ── Milestones ─────────────────────────────────────────────────────────

  defineTool(
    server,
    "add_milestone",
    {
      description:
        "Add a dated milestone to a project's card (e.g. 'CDR', 'first cold flow'). With a subteamId it is that subteam's; without one it is program-wide. Returns the new milestone and the refreshed project.",
      inputSchema: {
        projectId,
        title: z.string().trim().min(1).max(120),
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
          .refine(isCalendarDay, "Not a real calendar day")
          .describe("Due day, YYYY-MM-DD"),
        subteamId: z.string().min(1).nullable().optional().describe("Subteam id, or null for a program-wide milestone"),
        url: z.string().nullable().optional().describe("Optional http(s) link the milestone opens"),
      },
      annotations: WRITE,
    },
    async ({ projectId, title, dueDate, subteamId, url }) => {
      await requireProject(projectId);
      if (subteamId) await requireSubteam(subteamId);
      const before = new Date();
      await addMilestone(projectId, { title, dueDate, subteamId: subteamId ?? null, url });
      // The action returns nothing; the row we made is the newest one with
      // exactly these fields, created since we started.
      const created = await prisma.milestone.findFirst({
        where: { projectId, title, subteamId: subteamId ?? null, dueDate: new Date(dueDate), createdAt: { gte: before } },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, dueDate: true, done: true, url: true, subteam: subteamSelect },
      });
      return {
        milestone: created && serialiseMilestone(created),
        project: await getProjectProgram(projectId),
      };
    },
  );

  defineTool(
    server,
    "set_milestone_done",
    {
      description: "Tick or untick a milestone.",
      inputSchema: { milestoneId, done: z.boolean() },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ milestoneId, done }) => {
      const projectId = await milestoneProjectId(milestoneId);
      await setMilestoneDone(milestoneId, done);
      return getProjectProgram(projectId);
    },
  );

  defineTool(
    server,
    "set_milestone_link",
    {
      description:
        "Set or clear (null) the link a milestone opens. Only http(s) links are accepted; a bare 'docs.google.com/…' gets https://.",
      inputSchema: { milestoneId, url: z.string().nullable().describe("The link, or null to clear it") },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ milestoneId, url }) => {
      const projectId = await milestoneProjectId(milestoneId);
      await setMilestoneLink(milestoneId, url);
      return getProjectProgram(projectId);
    },
  );

  defineTool(
    server,
    "delete_milestone",
    {
      description: "Delete a milestone from its project's card. Cannot be undone.",
      inputSchema: { milestoneId },
      annotations: DESTRUCTIVE,
    },
    async ({ milestoneId }) => {
      const projectId = await milestoneProjectId(milestoneId);
      await deleteMilestone(milestoneId);
      return { deleted: milestoneId, project: await getProjectProgram(projectId) };
    },
  );
};

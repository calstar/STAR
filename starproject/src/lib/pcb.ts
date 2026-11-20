// The rules of a PCB task (TaskPcb). Prisma-free so the card, the timeline, the
// server actions and the MCP tools share one set.
//
// A PCB task is one board as one task: six fixed stages, each with its own
// assignees, due date and open/done/skipped. Kept deliberately small: no stage
// editor, no per-stage comments, no dates that cascade. The stages drive the
// task's assignees (everyone on any stage) and due date (the last dated stage),
// the card's "current stage" line and the deadline emails; the task's status
// stays manual.

import type { AssigneeLite } from "@/lib/board";

export const PCB_STAGES = [
  "components",
  "schematic",
  "layout",
  "review",
  "solder",
  "bringup",
] as const;

export type PcbStageKey = (typeof PCB_STAGES)[number];
export type PcbStageState = "open" | "done" | "skipped";

export const PCB_STAGE_LABEL: Record<PcbStageKey, string> = {
  components: "Components",
  schematic: "Schematic",
  layout: "Layout",
  review: "Review",
  solder: "Solder",
  bringup: "Bring-up",
};

export const PCB_STATE_LABEL: Record<PcbStageState, string> = {
  open: "open",
  done: "done",
  skipped: "skipped",
};

export function isPcbStage(s: string): s is PcbStageKey {
  return (PCB_STAGES as readonly string[]).includes(s);
}

/** One stage as the views need it. */
export type PcbStageLite = {
  stage: PcbStageKey;
  status: PcbStageState;
  dueDate: Date | string | null;
  assignees: AssigneeLite[];
};

export type PcbLite = {
  altiumUrl: string | null;
  stages: PcbStageLite[];
};

/** The Prisma include that loads a task's PCB details in the shape above. A
 * plain object, so this module stays Prisma-free. */
export const PCB_INCLUDE = {
  include: {
    stages: {
      include: {
        assignees: { select: { id: true, name: true, email: true, displayName: true } },
      },
    },
  },
} as const;

/** Stages in board order, whatever order they were loaded in. */
export function orderedStages<S extends { stage: PcbStageKey }>(stages: readonly S[]): S[] {
  return [...stages].sort((a, b) => PCB_STAGES.indexOf(a.stage) - PCB_STAGES.indexOf(b.stage));
}

/** The stage the board is at: the first one that is neither done nor skipped,
 * or null when every stage is. */
export function currentStage<S extends { stage: PcbStageKey; status: PcbStageState }>(
  stages: readonly S[],
): S | null {
  return orderedStages(stages).find((s) => s.status === "open") ?? null;
}

const DAY_MS = 86_400_000;

function dayOf(d: Date | string): number {
  return Math.floor(new Date(d).getTime() / DAY_MS);
}

/**
 * The task's due date as its stages set it: the latest due date of any stage
 * that isn't skipped. Null when no such stage is dated, in which case the
 * task's own due date stands (`dueFollowsStages` says which).
 */
export function derivedDueDate(
  stages: readonly { status: PcbStageState; dueDate: Date | string | null }[],
): Date | null {
  let last: number | null = null;
  for (const s of stages) {
    if (s.status === "skipped" || !s.dueDate) continue;
    const t = new Date(s.dueDate).getTime();
    if (last === null || t > last) last = t;
  }
  return last === null ? null : new Date(last);
}

/** Whether the task's due date is the stages' to set: true once any stage that
 * isn't skipped has a date. Until then the task's own due date is editable. */
export function dueFollowsStages(
  stages: readonly { status: PcbStageState; dueDate: Date | string | null }[],
): boolean {
  return derivedDueDate(stages) !== null;
}

/** Everyone assigned to any stage, once each, in stage order. This is the
 * task's assignee list on a PCB task. */
export function stageAssignees<A extends { id: string }>(
  stages: readonly { stage: PcbStageKey; assignees: readonly A[] }[],
): A[] {
  const seen = new Map<string, A>();
  for (const s of orderedStages(stages)) for (const a of s.assignees) if (!seen.has(a.id)) seen.set(a.id, a);
  return [...seen.values()];
}

/** Whether the current stage is past its due date (`today` is a day number,
 * the timeline's). A done task is never overdue. */
export function currentStageOverdue(
  pcb: { stages: readonly PcbStageLite[] },
  taskStatus: string,
  today: number,
): boolean {
  if (taskStatus === "done") return false;
  const cur = currentStage(pcb.stages);
  return !!cur?.dueDate && dayOf(cur.dueDate) < today;
}

/** A dated, unskipped stage as a mark on the timeline, in board order. `outOfOrder`
 * when it is due before an earlier stage: nothing cascades, so the chart shows
 * a slip rather than hiding it. */
export type StageMark = {
  stage: PcbStageKey;
  label: string;
  status: PcbStageState;
  day: number;
  outOfOrder: boolean;
  assignees: string[];
};

export function stageMarks(
  stages: readonly PcbStageLite[],
  name: (a: AssigneeLite) => string,
): StageMark[] {
  const marks: StageMark[] = [];
  let latest = -Infinity;
  for (const s of orderedStages(stages)) {
    if (s.status === "skipped" || !s.dueDate) continue;
    const day = dayOf(s.dueDate);
    marks.push({
      stage: s.stage,
      label: PCB_STAGE_LABEL[s.stage],
      status: s.status,
      day,
      outOfOrder: day < latest,
      assignees: s.assignees.map(name),
    });
    latest = Math.max(latest, day);
  }
  return marks;
}

/**
 * The stage that became current because an earlier one was marked done or
 * skipped: its people are told it is their turn. Null when the current stage
 * didn't move forward (no change, a stage reopened, or the last one finished).
 */
export function stageHandedOff<S extends { stage: PcbStageKey; status: PcbStageState }>(
  before: readonly S[],
  after: readonly S[],
): S | null {
  const was = currentStage(before);
  const now = currentStage(after);
  if (!now) return null;
  if (was && PCB_STAGES.indexOf(now.stage) <= PCB_STAGES.indexOf(was.stage)) return null;
  return now;
}

/** "Layout" or "Done" (every stage done or skipped): what the card leads with. */
export function stageSummary(pcb: { stages: readonly PcbStageLite[] }): string {
  const cur = currentStage(pcb.stages);
  return cur ? PCB_STAGE_LABEL[cur.stage] : "All stages done";
}

/** Activity field names for stage edits: "pcb.layout.due" and so on. */
export function stageField(stage: PcbStageKey, what: "due" | "status" | "assignees"): string {
  return `pcb.${stage}.${what}`;
}

/** Labels for every stage activity field, merged into FIELD_LABEL. */
export const PCB_FIELD_LABEL: Record<string, string> = {
  pcb: "PCB board",
  altiumUrl: "Altium project link",
  "pcb.shift": "stage dates",
  ...Object.fromEntries(
    PCB_STAGES.flatMap((s) => {
      const l = PCB_STAGE_LABEL[s].toLowerCase();
      return [
        [stageField(s, "due"), `${l} due date`],
        [stageField(s, "status"), `${l} stage`],
        [stageField(s, "assignees"), `${l} assignees`],
      ];
    }),
  ),
};

const MAX_URL = 2000;

/** The Altium link as typed: blank clears it; throws a message fit to show. */
export function parseAltiumUrl(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error("Paste a full link, starting with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Paste a full link, starting with https://");
  if (v.length > MAX_URL) throw new Error("That link is too long.");
  return v;
}

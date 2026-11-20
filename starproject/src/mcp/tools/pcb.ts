import { z } from "zod";

import { addPcb, removePcb, shiftPcbDates, updateAltiumUrl, updatePcbStage } from "@/lib/actions/pcb";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { PCB_INCLUDE, PCB_STAGES, type PcbLite, currentStage, orderedStages } from "@/lib/pcb";

import { DESTRUCTIVE, IDEMPOTENT_WRITE, defineTool, toFormData, type ToolModule } from "./_shared";

// PCB boards: a task with six fixed stages (components, schematic, layout,
// review, solder, bring-up), each with assignees, a due date and
// open/done/skipped. Every tool calls the server action the task card's PCB
// section calls (src/lib/actions/pcb.ts), so History and assignment emails are
// the UI's.

const StageEnum = z.enum(PCB_STAGES);
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** A board as the tools return it: stages in board order and the current one. */
export function serializePcb(pcb: PcbLite) {
  const ymd = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  return {
    altiumUrl: pcb.altiumUrl,
    currentStage: currentStage(pcb.stages)?.stage ?? null,
    stages: orderedStages(pcb.stages).map((s) => ({
      stage: s.stage,
      status: s.status,
      dueDate: ymd(s.dueDate),
      assignees: s.assignees.map((a) => ({ id: a.id, displayName: displayNameOf(a), email: a.email })),
    })),
  };
}

async function readBoard(taskId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      number: true,
      title: true,
      dueDate: true,
      assignees: { select: { id: true, name: true, email: true, displayName: true } },
      pcb: PCB_INCLUDE,
    },
  });
  if (!task) throw new Error("Task not found");
  return {
    id: task.id,
    number: task.number,
    title: task.title,
    dueDate: task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null,
    assignees: task.assignees.map((a) => ({ id: a.id, displayName: displayNameOf(a) })),
    pcb: task.pcb ? serializePcb(task.pcb) : null,
  };
}

/** The action's {error} as a thrown error, so defineTool reports it. */
function orThrow(res: { error?: string }) {
  if (res.error) throw new Error(res.error);
}

export const pcbTools: ToolModule = (server) => {
  defineTool(
    server,
    "set_pcb",
    {
      description:
        "Make a task a PCB board (the task card's 'Make this a PCB board'): it gets six stages -- components, " +
        "schematic, layout, review, solder, bringup -- open, undated and unassigned. Optionally set or clear " +
        "(null) the Altium project link in the same call. A no-op on a task that already is one, apart from the " +
        "link. Once a board, the task's assignees are everyone on any stage and its due date is the last dated " +
        "stage's: edit those with update_pcb_stage, not update_task. Its status stays manual.",
      inputSchema: {
        taskId: z.string().min(1),
        altiumUrl: z.string().max(2000).nullable().optional().describe("https link; null clears"),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ taskId, altiumUrl }) => {
      await addPcb(taskId);
      if (altiumUrl !== undefined) orThrow(await updateAltiumUrl(taskId, altiumUrl ?? ""));
      return readBoard(taskId);
    },
  );

  defineTool(
    server,
    "remove_pcb",
    {
      description:
        "Stop tracking a task as a PCB board: deletes its Altium link and all six stages with their dates and " +
        "assignees. The task keeps the assignees and due date the stages last gave it.",
      inputSchema: { taskId: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ taskId }) => {
      await removePcb(toFormData({ id: taskId }));
      return readBoard(taskId);
    },
  );

  defineTool(
    server,
    "update_pcb_stage",
    {
      description:
        "Edit one stage of a PCB board: any of its due date (null clears), status (open, done or skipped) and " +
        "assignees (replaces the set; [] unassigns). The current stage is the first one still open; the card, " +
        "the overdue flag and the due-soon/overdue emails follow it. Then the task's assignees become everyone " +
        "on any stage (new ones are notified) and its due date the latest due date of a stage that isn't " +
        "skipped. Nothing cascades: moving one stage never moves another.",
      inputSchema: {
        taskId: z.string().min(1),
        stage: StageEnum,
        dueDate: YMD.nullable().optional(),
        status: z.enum(["open", "done", "skipped"]).optional(),
        assigneeIds: z.array(z.string().min(1)).optional(),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ taskId, stage, dueDate, status, assigneeIds }) => {
      orThrow(await updatePcbStage(taskId, stage, { dueDate, status, assigneeIds }));
      return readBoard(taskId);
    },
  );

  defineTool(
    server,
    "shift_pcb_dates",
    {
      description:
        "Move a whole PCB board in time (what dragging its Gantt bar does): its start date and every stage's " +
        "due date shift by the same number of days (negative = earlier). Logged as one History row.",
      inputSchema: {
        taskId: z.string().min(1),
        days: z.number().int().min(-3650).max(3650),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ taskId, days }) => {
      await shiftPcbDates(taskId, days);
      return readBoard(taskId);
    },
  );
};

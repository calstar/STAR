"use client";

import type { User } from "@prisma/client";
import { useState } from "react";

import { ConfirmButton } from "@/components/ConfirmButton";
import { AssigneeSelect } from "@/components/fields/AssigneeSelect";
import { FieldSelect } from "@/components/fields/FieldSelect";
import {
  type StagePatch,
  addPcb,
  removePcb,
  updateAltiumUrl,
  updatePcbStage,
} from "@/lib/actions/pcb";
import {
  PCB_STAGE_LABEL,
  type PcbLite,
  type PcbStageKey,
  type PcbStageLite,
  type PcbStageState,
  currentStage,
  orderedStages,
} from "@/lib/pcb";

const label =
  "text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
const input =
  "min-h-11 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900 sm:min-h-0";

const STATE_OPTIONS: { value: PcbStageState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "skipped", label: "Skipped" },
];

/**
 * A task's PCB board: its Altium link and its six stages, each with a state,
 * assignees and a due date. Shown once the task is made a PCB board, which a
 * "Make this a PCB board" button does from here. Each control saves on its own.
 * The task's assignees and due date follow the stages (src/lib/actions/pcb.ts).
 */
export function PcbSection({
  taskId,
  pcb,
  users,
  onChanged,
}: {
  taskId: string;
  pcb: PcbLite | null;
  users: User[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);

  if (!pcb) {
    return (
      <button
        type="button"
        disabled={adding}
        onClick={async () => {
          setAdding(true);
          try {
            await addPcb(taskId);
            onChanged();
          } finally {
            setAdding(false);
          }
        }}
        className="min-h-11 w-full rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-left text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200 sm:min-h-0"
      >
        + Make this a PCB board (components → schematic → layout → review → solder → bring-up)
      </button>
    );
  }

  const cur = currentStage(pcb.stages);

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-2">
        <span className={label}>PCB board</span>
        <ConfirmButton
          action={async (fd) => {
            await removePcb(fd);
            onChanged();
          }}
          id={taskId}
          label="Remove"
          className="ml-auto rounded px-2 text-xs text-neutral-400 hover:text-red-600 dark:text-neutral-500 dark:hover:text-red-400"
          title="Stop tracking this as a PCB board?"
          message="This deletes the Altium link and all six stages with their dates and assignees. The task keeps its current assignees and due date."
          confirmLabel="Remove"
        />
      </div>

      <div className="mt-3">
        <AltiumField taskId={taskId} value={pcb.altiumUrl} onSaved={onChanged} />
      </div>

      <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
        The task&apos;s assignees are everyone on a stage; its due date is the last stage&apos;s.
        Nothing moves on its own when a stage slips.
      </p>

      <ol className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800">
        {orderedStages(pcb.stages).map((s) => (
          <StageRow
            // Re-seed when a stage's state or date changes elsewhere (the
            // timeline, MCP). Not on assignees: the picker stays open across
            // several picks, and each pick refreshes.
            key={`${s.stage}:${s.status}:${s.dueDate ? new Date(s.dueDate).getTime() : ""}`}
            taskId={taskId}
            stage={s}
            current={cur?.stage === s.stage}
            users={users}
            onSaved={onChanged}
          />
        ))}
      </ol>
    </div>
  );
}

function StageRow({
  taskId,
  stage,
  current,
  users,
  onSaved,
}: {
  taskId: string;
  stage: PcbStageLite;
  current: boolean;
  users: User[];
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<PcbStageState>(stage.status);
  const [assignees, setAssignees] = useState(stage.assignees.map((a) => a.id));
  const due = stage.dueDate ? new Date(stage.dueDate).toISOString().slice(0, 10) : "";
  const [draftDue, setDraftDue] = useState(due);

  const save = async (patch: StagePatch) => {
    const res = await updatePcbStage(taskId, stage.stage, patch);
    setError(res.error ?? null);
    if (!res.error) onSaved();
    return !res.error;
  };

  const late =
    current && !!stage.dueDate && new Date(stage.dueDate).getTime() < startOfTodayUtc();
  const dim = status === "skipped" ? "opacity-50" : "";

  return (
    <li className="py-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[8rem_7rem_minmax(0,1fr)_9rem]">
        <span className={`flex items-center gap-1.5 text-sm font-medium ${dim}`}>
          {current && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-indigo-500"
              title="Current stage"
              aria-label="Current stage"
            />
          )}
          <span className={status === "done" ? "text-neutral-400 line-through dark:text-neutral-500" : ""}>
            {PCB_STAGE_LABEL[stage.stage as PcbStageKey]}
          </span>
        </span>
        <FieldSelect
          value={status}
          options={STATE_OPTIONS}
          ariaLabel={`${PCB_STAGE_LABEL[stage.stage]} state`}
          onChange={async (v) => {
            const prev = status;
            setStatus(v as PcbStageState);
            if (!(await save({ status: v as PcbStageState }))) setStatus(prev);
          }}
        />
        <div className={`col-span-2 min-w-0 sm:col-span-1 ${dim}`}>
          <AssigneeSelect
            value={assignees}
            users={users}
            onChange={async (ids) => {
              const prev = assignees;
              setAssignees(ids);
              if (!(await save({ assigneeIds: ids }))) setAssignees(prev);
            }}
          />
        </div>
        <input
          type="date"
          aria-label={`${PCB_STAGE_LABEL[stage.stage]} due date`}
          value={draftDue}
          onChange={(e) => setDraftDue(e.target.value)}
          onBlur={() => {
            if (draftDue !== due) void save({ dueDate: draftDue });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setDraftDue(due);
          }}
          className={`col-span-2 sm:col-span-1 ${input} ${dim} ${late ? "border-red-400 text-red-600 dark:border-red-700 dark:text-red-400" : ""}`}
        />
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </li>
  );
}

function startOfTodayUtc(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** The Altium project link: a clickable link once set, with an edit button; an
 * input while empty or being edited. */
function AltiumField({
  taskId,
  value,
  onSaved,
}: {
  taskId: string;
  value: string | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const showLink = value && !editing && !error;

  const commit = async () => {
    if (draft.trim() === (value ?? "")) {
      setEditing(false);
      return;
    }
    const res = await updateAltiumUrl(taskId, draft);
    setError(res.error ?? null);
    if (!res.error) {
      setEditing(false);
      onSaved();
    }
  };

  return (
    <div>
      <span className={label}>Altium project</span>
      {showLink ? (
        <div className="mt-1 flex min-h-11 items-center gap-2 sm:min-h-0 sm:py-1">
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate text-sm text-blue-600 hover:underline dark:text-blue-400"
            title={value}
          >
            {value} ↗
          </a>
          <button
            type="button"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            className="shrink-0 text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          >
            Edit
          </button>
        </div>
      ) : (
        <input
          value={draft}
          type="url"
          placeholder="https://…"
          autoFocus={editing}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(value ?? "");
              setEditing(false);
            }
          }}
          className={`mt-1 ${input}`}
        />
      )}
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

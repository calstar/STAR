"use client";

import type { User } from "@prisma/client";
import { useEffect, useRef, useState } from "react";

import { AssigneeSelect } from "@/components/fields/AssigneeSelect";
import { FieldSelect } from "@/components/fields/FieldSelect";
import { createTask } from "@/lib/actions/tasks";
import { PRIORITY_BADGE } from "@/lib/tasks";
import { isValidDateInput } from "@/lib/validation";

// One task-create form for every context: a project detail page pins the
// project (`projectId`); a subteam detail page pins the subteam (`subteamId`)
// and offers a project picker (`projects`); the /tasks workspace offers both
// pickers. A pinned field becomes a hidden input; an offered field a dropdown.
export function NewTaskForm({
  projectId,
  projects,
  subteamId,
  users,
  subteams,
}: {
  projectId?: string;
  projects?: { id: string; label: string }[];
  subteamId?: string;
  users: User[];
  subteams?: { id: string; name: string }[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // Controlled so the custom dropdowns submit via hidden inputs; reset after
  // create (form.reset() only clears native fields, not React state).
  const [proj, setProj] = useState("");
  const [priority, setPriority] = useState("");
  const [assignees, setAssignees] = useState<string[]>([]);
  const [subteam, setSubteam] = useState("");
  // Project is required; the custom dropdown has no native `required`, so guard here.
  const [err, setErr] = useState<string | null>(null);
  // Below `sm` the form collapses to one "Add task" button; `open` shows it as
  // a bottom-sheet dialog. At sm+ the form is always inline and `open` is moot.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    titleRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const control =
    "min-h-11 sm:min-h-0 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm";

  return (
    <>
      {/* Mobile: the form collapses to a floating + button, positioned above
          the ViewDock (dock is ~3.5rem tall plus the safe-area inset). */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Add task"
          className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-neutral-900 text-white shadow-lg hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 sm:hidden"
        >
          <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
      {open && (
        <div
          aria-hidden
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[60] bg-black/40 sm:hidden"
        />
      )}
      {/* One form for both presentations: bottom sheet below `sm` when open,
          the usual inline card at sm+ (the sm: variants undo the sheet). */}
      <form
        ref={formRef}
        {...(open ? { role: "dialog", "aria-modal": true, "aria-label": "New task" } : {})}
        action={async (fd) => {
          if (!projectId && !proj) {
            setErr("Pick a project first.");
            return;
          }
          if (!isValidDateInput(String(fd.get("dueDate") ?? ""))) {
            setErr("Enter a valid due date with a 4-digit year.");
            return;
          }
          setErr(null);
          await createTask(fd);
          formRef.current?.reset();
          setProj("");
          setPriority("");
          setAssignees([]);
          setSubteam("");
          setOpen(false);
        }}
        className={`flex-col gap-2 border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 sm:static sm:z-auto sm:flex sm:max-h-none sm:flex-row sm:flex-wrap sm:items-center sm:overflow-visible sm:rounded-lg sm:border sm:p-3 sm:shadow-none ${
          open
            ? "fixed inset-x-0 bottom-0 z-[70] flex max-h-[85dvh] overflow-y-auto rounded-t-xl border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl"
            : "hidden"
        }`}
      >
        <div className="flex items-center justify-between sm:hidden">
          <h2 className="text-base font-semibold">New task</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="flex h-11 w-11 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>
      <input
        ref={titleRef}
        name="title"
        required
        placeholder="New task…"
        className={`w-full sm:w-auto sm:min-w-56 sm:flex-1 ${control}`}
      />

      {projectId ? (
        <input type="hidden" name="projectId" value={projectId} />
      ) : (
        <FieldSelect
          name="projectId"
          ariaLabel="Project"
          searchable
          placeholder="Project…"
          value={proj}
          onChange={setProj}
          options={(projects ?? []).map((p) => ({ value: p.id, label: p.label }))}
        />
      )}

      <FieldSelect
        name="priority"
        ariaLabel="Priority"
        searchable
        value={priority}
        onChange={setPriority}
        options={[
          { value: "", label: "Priority —" },
          { value: "low", label: "Low", badge: PRIORITY_BADGE.low },
          { value: "medium", label: "Medium", badge: PRIORITY_BADGE.medium },
          { value: "high", label: "High", badge: PRIORITY_BADGE.high },
        ]}
      />

      <AssigneeSelect
        name="assigneeIds"
        users={users}
        value={assignees}
        onChange={setAssignees}
      />

      {subteamId ? (
        <input type="hidden" name="subteamId" value={subteamId} />
      ) : (
        <FieldSelect
          name="subteamId"
          ariaLabel="Subteam"
          searchable
          value={subteam}
          onChange={setSubteam}
          options={[
            { value: "", label: "No subteam" },
            ...(subteams ?? []).map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      )}

      <input type="date" name="dueDate" min="1900-01-01" max="9999-12-31" className={control} aria-label="Due date" />
      <button
        type="submit"
        className="min-h-11 rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 sm:min-h-0"
      >
        Add task
      </button>
      {err && <p className="w-full text-sm text-red-600">{err}</p>}
      </form>
    </>
  );
}

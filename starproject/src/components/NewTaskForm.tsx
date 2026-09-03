"use client";

import type { User } from "@prisma/client";
import { useRef, useState } from "react";

import { AssigneeSelect } from "@/components/fields/AssigneeSelect";
import { FieldSelect } from "@/components/fields/FieldSelect";
import { createTask } from "@/lib/actions/tasks";
import { PRIORITY_BADGE } from "@/lib/tasks";

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
  // Controlled so the custom dropdowns submit via hidden inputs; reset after
  // create (form.reset() only clears native fields, not React state).
  const [proj, setProj] = useState("");
  const [priority, setPriority] = useState("");
  const [assignees, setAssignees] = useState<string[]>([]);
  const [subteam, setSubteam] = useState("");
  // Project is required; the custom dropdown has no native `required`, so guard here.
  const [err, setErr] = useState<string | null>(null);

  const control =
    "rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm";

  return (
    <form
      ref={formRef}
      action={async (fd) => {
        if (!projectId && !proj) {
          setErr("Pick a project first.");
          return;
        }
        setErr(null);
        await createTask(fd);
        formRef.current?.reset();
        setProj("");
        setPriority("");
        setAssignees([]);
        setSubteam("");
      }}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3"
    >
      <input
        name="title"
        required
        placeholder="New task…"
        className={`min-w-56 flex-1 ${control}`}
      />

      {projectId ? (
        <input type="hidden" name="projectId" value={projectId} />
      ) : (
        <FieldSelect
          name="projectId"
          ariaLabel="Project"
          placeholder="Project…"
          value={proj}
          onChange={setProj}
          options={(projects ?? []).map((p) => ({ value: p.id, label: p.label }))}
        />
      )}

      <FieldSelect
        name="priority"
        ariaLabel="Priority"
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
          value={subteam}
          onChange={setSubteam}
          options={[
            { value: "", label: "No subteam" },
            ...(subteams ?? []).map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      )}

      <input type="date" name="dueDate" className={control} aria-label="Due date" />
      <button
        type="submit"
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Add task
      </button>
      {err && <p className="w-full text-sm text-red-600">{err}</p>}
    </form>
  );
}

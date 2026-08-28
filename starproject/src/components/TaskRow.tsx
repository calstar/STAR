"use client";

import type { Task, User } from "@prisma/client";

import { deleteTask, updateTask } from "@/lib/actions/tasks";

const STATUS_OPTS: [string, string][] = [
  ["backlog", "Backlog"],
  ["todo", "To do"],
  ["in_progress", "In progress"],
  ["done", "Done"],
];
const PRIORITY_OPTS: [string, string][] = [
  ["", "—"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
];

// Submit the containing <form> whenever a control changes, so each inline edit
// persists immediately (and only sends its own field — see updateTask).
function submit(e: { currentTarget: { form: HTMLFormElement | null } }) {
  e.currentTarget.form?.requestSubmit();
}

export function TaskRow({
  task,
  users,
}: {
  task: Task & { assignee: User | null };
  users: User[];
}) {
  const due = task.dueDate
    ? new Date(task.dueDate).toISOString().slice(0, 10)
    : "";
  const cell = "px-2 py-1.5 align-middle";
  const control =
    "rounded border border-neutral-300 bg-white px-2 py-1 text-sm";

  return (
    <tr className="border-b border-neutral-100">
      <td className={`${cell} w-full`}>
        <form action={updateTask}>
          <input type="hidden" name="id" value={task.id} />
          <input
            name="title"
            defaultValue={task.title}
            onBlur={submit}
            className="w-full rounded border border-transparent px-2 py-1 text-sm hover:border-neutral-300 focus:border-neutral-400 focus:outline-none"
          />
        </form>
      </td>
      <td className={cell}>
        <form action={updateTask}>
          <input type="hidden" name="id" value={task.id} />
          <select
            name="status"
            defaultValue={task.status}
            onChange={submit}
            className={control}
          >
            {STATUS_OPTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </form>
      </td>
      <td className={cell}>
        <form action={updateTask}>
          <input type="hidden" name="id" value={task.id} />
          <select
            name="priority"
            defaultValue={task.priority ?? ""}
            onChange={submit}
            className={control}
          >
            {PRIORITY_OPTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </form>
      </td>
      <td className={cell}>
        <form action={updateTask}>
          <input type="hidden" name="id" value={task.id} />
          <select
            name="assigneeId"
            defaultValue={task.assigneeId ?? ""}
            onChange={submit}
            className={control}
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email}
              </option>
            ))}
          </select>
        </form>
      </td>
      <td className={cell}>
        <form action={updateTask}>
          <input type="hidden" name="id" value={task.id} />
          <input
            type="date"
            name="dueDate"
            defaultValue={due}
            onChange={submit}
            className={control}
          />
        </form>
      </td>
      <td className={cell}>
        <form action={deleteTask}>
          <input type="hidden" name="id" value={task.id} />
          <button className="rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50">
            Delete
          </button>
        </form>
      </td>
    </tr>
  );
}

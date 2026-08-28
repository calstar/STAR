"use client";

import { updateTask } from "@/lib/actions/tasks";

export function TitleInput({
  taskId,
  value,
  className,
}: {
  taskId: string;
  value: string;
  className?: string;
}) {
  return (
    <form action={updateTask}>
      <input type="hidden" name="id" value={taskId} />
      <input
        name="title"
        defaultValue={value}
        onBlur={(e) => e.currentTarget.form?.requestSubmit()}
        className={
          className ??
          "w-full rounded border border-transparent px-2 py-1 hover:border-neutral-300 focus:border-neutral-400 focus:outline-none"
        }
      />
    </form>
  );
}

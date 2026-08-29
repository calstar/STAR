import { updateTask } from "@/lib/actions/tasks";

/**
 * Save a single task field by calling the update action directly (no <form>).
 * Using a form action here would trigger React 19's automatic post-submit form
 * reset, which snaps the control back even though the value persisted.
 */
export function updateField(taskId: string, field: string, value: string) {
  const fd = new FormData();
  fd.set("id", taskId);
  fd.set(field, value);
  return updateTask(fd);
}

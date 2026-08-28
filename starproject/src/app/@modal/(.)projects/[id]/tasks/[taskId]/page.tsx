import { notFound } from "next/navigation";

import { TaskDetail } from "@/components/TaskDetail";
import { TaskModal } from "@/components/TaskModal";
import { getTaskDetailData } from "@/lib/task-detail";

export const dynamic = "force-dynamic";

// Root-level interceptor: opens the task as a modal when navigated to from any
// top-level page (e.g. the cross-project /tasks table), not just the board.
export default async function InterceptedTaskModalRoot({
  params,
}: {
  params: Promise<{ id: string; taskId: string }>;
}) {
  const { id, taskId } = await params;
  const data = await getTaskDetailData(id, taskId);
  if (!data) notFound();

  return (
    <TaskModal>
      <TaskDetail data={data} />
    </TaskModal>
  );
}

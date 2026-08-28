import { notFound } from "next/navigation";

import { TaskDetail } from "@/components/TaskDetail";
import { TaskModal } from "@/components/TaskModal";
import { getTaskDetailData } from "@/lib/task-detail";

export const dynamic = "force-dynamic";

// Intercepts /projects/[id]/tasks/[taskId] when navigated to from the board,
// rendering the detail inside a modal. Direct load / refresh hits the real page.
export default async function InterceptedTaskModal({
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

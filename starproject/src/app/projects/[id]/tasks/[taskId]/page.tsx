import { notFound } from "next/navigation";

import { ProjectView } from "@/components/ProjectView";
import { TaskDetail } from "@/components/TaskDetail";
import { TaskModal } from "@/components/TaskModal";
import { getTaskDetailData } from "@/lib/task-detail";

export const dynamic = "force-dynamic";

// A task URL renders the project board with the task open as a modal on top, so
// clicking a task and reloading a task URL both show the same thing. Closing the
// modal returns to the board.
export default async function TaskPage({
  params,
}: {
  params: Promise<{ id: string; taskId: string }>;
}) {
  const { id, taskId } = await params;
  const data = await getTaskDetailData(id, taskId);
  if (!data) notFound();

  return (
    <>
      <ProjectView id={id} view="board" />
      <TaskModal closeTo={`/projects/${id}`}>
        <TaskDetail data={data} />
      </TaskModal>
    </>
  );
}

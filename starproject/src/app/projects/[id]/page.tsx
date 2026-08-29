import { ProjectView, type ProjectViewMode } from "@/components/ProjectView";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { id } = await params;
  const { view: rawView } = await searchParams;
  const view: ProjectViewMode =
    rawView === "board" ? "board" : rawView === "gantt" ? "gantt" : "list";

  return <ProjectView id={id} view={view} />;
}

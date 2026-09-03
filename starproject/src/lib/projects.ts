/** Total task count for a project, including every subproject's tasks.
 *
 * A parent project's task count is the sum of all tasks under it: its own tasks
 * plus each subproject's tasks. Nesting is limited to a single level (a
 * subproject can't itself have subprojects — enforced in createProject), so the
 * total is simply the project's own count plus each child's count.
 *
 * `children` should already be filtered to the non-archived subprojects the
 * caller wants counted (matching how the project detail view aggregates tasks). */
export function projectTaskTotal(project: {
  _count: { tasks: number };
  children?: { _count: { tasks: number } }[];
}): number {
  const own = project._count.tasks;
  const sub = project.children?.reduce((sum, c) => sum + c._count.tasks, 0) ?? 0;
  return own + sub;
}

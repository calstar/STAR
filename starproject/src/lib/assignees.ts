/**
 * Assignee picker ordering: the people already on the task come first, so
 * taking someone off is one click at the top of the menu instead of a hunt
 * through the whole roster. Both groups keep the roster's own order (a stable
 * partition), so the menu reads the same as before apart from who is lifted.
 *
 * `pinned` is the selection *when the menu opened*, not the live one: if rows
 * re-sorted on every toggle, the row under the cursor would jump away as soon
 * as it was clicked. The picker snapshots it on open.
 */
export function selectedFirst<T extends { id: string }>(
  users: readonly T[],
  pinned: ReadonlySet<string>,
): { top: T[]; rest: T[] } {
  const top: T[] = [];
  const rest: T[] = [];
  for (const u of users) (pinned.has(u.id) ? top : rest).push(u);
  return { top, rest };
}

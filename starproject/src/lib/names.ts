/**
 * "Ada Lovelace" → "Ada L." — first name + last initial, to save space in task
 * displays (board cards, assignee pickers). Full names are shown elsewhere.
 * Falls back to a single-word name, then the email.
 */
export function shortName(
  name: string | null | undefined,
  email?: string | null,
): string {
  const full = (name ?? "").trim();
  if (!full) return email ?? "";
  const parts = full.split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

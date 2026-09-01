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

/**
 * The single source of truth for how a person's name is shown anywhere in the
 * app. A user-chosen `displayName` wins verbatim; otherwise we fall back to the
 * uniform "First L." short form. Accepts any user-like row that carries these
 * fields (e.g. a Prisma `User`, or a narrowed `{ name, email, displayName }`).
 */
export function displayNameOf(u: {
  displayName?: string | null;
  name?: string | null;
  email?: string | null;
}): string {
  const custom = (u.displayName ?? "").trim();
  return custom || shortName(u.name, u.email);
}

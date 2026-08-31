// Global admin allowlist for destructive operations (delete task/project/subteam).
// This is NOT per-project access control — everyone still views and edits
// everything; this only gates dangerous, hard-to-undo actions.
//
// EDIT THIS LIST to grant admin. Emails match the identity in X-Auth-Email
// (@berkeley.edu) / DEV_AUTH_EMAIL, compared case-insensitively.
// Future: source this from an env var or a small `admins` table.
export const ADMIN_EMAILS = [
  "aidanrickert@berkeley.edu",
  "tchang27@berkeley.edu",
  "aahilsyed72@berkeley.edu",
  "manank_doshi@berkeley.edu",
].map((e) => e.toLowerCase());

export function isAdmin(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

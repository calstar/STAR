// A role held by a list of emails: a seed list in code, plus addresses added at
// runtime, minus seeds someone removed (a tombstone, since a seed would
// otherwise come back from the code on every request). Used by the admin list
// (src/lib/admins.ts) and the PVP list (src/lib/pvp.ts). Lowercased throughout.

export function effectiveEmails(
  seed: readonly string[],
  added: readonly string[],
  removedSeeds: readonly string[],
): Set<string> {
  const removed = new Set(removedSeeds.map((e) => e.toLowerCase()));
  const out = new Set(seed.map((e) => e.toLowerCase()).filter((e) => !removed.has(e)));
  for (const e of added) out.add(e.toLowerCase());
  return out;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Email addresses as they arrive from sheets people typed by hand: "Foo@Gmail.com ",
// "dana\_smith@…" (markdown escaping from a Docs export), "k… whatever his
// email is", "p…@berkeley.efu". Pure, so the rules can be tested on real rows.

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Lowercased, trimmed, unescaped, de-mailto'd; "" when nothing is left. */
export function normalizeEmail(raw: string | null | undefined): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/\\([_*\\-])/g, "$1"); // Docs/markdown export escapes
  s = s.replace(/^mailto:/i, "");
  const angle = s.match(/<([^>]+)>/); // "Name <a@b.com>"
  if (angle) s = angle[1];
  s = s.replace(/[?,;.]+$/, ""); // "abc@berkeley.edu?" in the sponsor sheet
  return s.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

// Domains people mistype, and what they meant. A typo is flagged in the import
// preview and fixed only if the person accepts it.
const DOMAIN_FIXES: Record<string, string> = {
  "berkeley.efu": "berkeley.edu",
  "berkeley.edy": "berkeley.edu",
  "berkely.edu": "berkeley.edu",
  "berkeley.ed": "berkeley.edu",
  "berkleey.edu": "berkeley.edu",
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.con": "gmail.com",
  "gnail.com": "gmail.com",
  "yahooo.com": "yahoo.com",
  "yaho.com": "yahoo.com",
  "hotmial.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "outlok.com": "outlook.com",
  "icloud.co": "icloud.com",
};

/** The address with its domain corrected, or null when the domain looks fine. */
export function suggestFix(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const fixed = DOMAIN_FIXES[email.slice(at + 1)];
  return fixed ? `${email.slice(0, at)}@${fixed}` : null;
}

export type EmailCheck =
  | { ok: true; email: string; suggestion: string | null }
  | { ok: false; reason: string };

/** One cell → a usable address, or why not. */
export function checkEmail(raw: string | null | undefined): EmailCheck {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, reason: "empty" };
  if (/\s/.test(email)) return { ok: false, reason: `not an address: "${String(raw).trim()}"` };
  if (!isValidEmail(email)) return { ok: false, reason: `not an address: "${String(raw).trim()}"` };
  return { ok: true, email, suggestion: suggestFix(email) };
}

/**
 * Every address in a cell that may hold several: "a@x.com, b@y.com",
 * "a@x.com / b@y.com", newline-separated. Words around them are dropped.
 */
export function splitEmails(cell: string | null | undefined): string[] {
  const s = String(cell ?? "").replace(/\\([_*\\-])/g, "$1");
  const found = s.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g) ?? [];
  const out: string[] = [];
  for (const f of found) {
    const e = normalizeEmail(f);
    if (isValidEmail(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

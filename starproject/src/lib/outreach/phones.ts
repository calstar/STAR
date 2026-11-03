// Phone numbers as sheets hold them: "(650) 555-0199", "650.555.0199",
// "+1 650 555 0199", "6505550199 (cell)". Stored as E.164 ("+16505550199") so
// the same number typed two ways is one number, and links work on a phone.
// Pure, so the rules can be tested.

/** E.164 for a US/Canada number or an explicit +country number; null if it isn't one. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // Drop an extension ("x123", "ext. 4") and trailing words ("(cell)").
  const main = s.split(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i)[0];
  const plus = main.trim().startsWith("+");
  const digits = main.replace(/\D/g, "");
  if (plus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "+16505550199" → "(650) 555-0199"; other countries keep their + form. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export const telHref = (e164: string) => `tel:${e164}`;
/** An SMS link, optionally with a prefilled body (iOS and Android both read `body`). */
export const smsHref = (e164: string, body?: string) => `sms:${e164}${body ? `?&body=${encodeURIComponent(body)}` : ""}`;

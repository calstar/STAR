// Getting a list out of the CRM and into Gmail without the Gmail API: text for
// the clipboard, and https://mail.google.com compose links that open a filled-in
// message in the viewer's own inbox (authuser picks the account when they are
// signed in to several). Pure.

export type Recipient = { email: string; name?: string | null };

/** Gmail caps one message at 500 recipients; stay well under it. */
export const DEFAULT_BATCH = 400;
/** Browsers and Gmail accept long URLs, but past ~8k some proxies truncate them. */
export const MAX_URL = 8000;

export type ComposeInput = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  /** The Google account to open it in, e.g. the viewer's @berkeley.edu address. */
  authuser?: string | null;
};

export function gmailComposeUrl(c: ComposeInput): string {
  const p = new URLSearchParams();
  if (c.authuser) p.set("authuser", c.authuser);
  p.set("view", "cm");
  p.set("fs", "1");
  if (c.to?.length) p.set("to", c.to.join(","));
  if (c.cc?.length) p.set("cc", c.cc.join(","));
  if (c.bcc?.length) p.set("bcc", c.bcc.join(","));
  if (c.subject) p.set("su", c.subject);
  if (c.body) p.set("body", c.body);
  return `https://mail.google.com/mail/?${p.toString()}`;
}

/** A mailto: link, for anyone who doesn't use Gmail in the browser. */
export function mailtoUrl(c: ComposeInput): string {
  const p: string[] = [];
  if (c.cc?.length) p.push(`cc=${encodeURIComponent(c.cc.join(","))}`);
  if (c.bcc?.length) p.push(`bcc=${encodeURIComponent(c.bcc.join(","))}`);
  if (c.subject) p.push(`subject=${encodeURIComponent(c.subject)}`);
  if (c.body) p.push(`body=${encodeURIComponent(c.body)}`);
  return `mailto:${(c.to ?? []).map(encodeURIComponent).join(",")}${p.length ? `?${p.join("&")}` : ""}`;
}

/**
 * Split a list into BCC batches: at most `size` addresses each, and each
 * batch's compose link (with this subject and body) under MAX_URL.
 */
export function batches(
  emails: string[],
  opts: { size?: number; subject?: string; body?: string; authuser?: string | null; maxUrl?: number } = {},
): string[][] {
  const size = Math.max(1, opts.size ?? DEFAULT_BATCH);
  const maxUrl = opts.maxUrl ?? MAX_URL;
  const base = gmailComposeUrl({ subject: opts.subject, body: opts.body, authuser: opts.authuser, bcc: ["x"] }).length;
  const out: string[][] = [];
  let cur: string[] = [];
  let len = base;
  for (const e of emails) {
    const add = encodeURIComponent((cur.length ? "," : "") + e).length;
    if (cur.length && (cur.length >= size || len + add > maxUrl)) {
      out.push(cur);
      cur = [];
      len = base;
    }
    cur.push(e);
    len += encodeURIComponent((cur.length > 1 ? "," : "") + e).length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export type ClipboardStyle = "comma" | "lines" | "named";

/** "a@x.com, b@y.com" / one per line / "Ada Lovelace <a@x.com>, ...". */
export function clipboardText(recipients: Recipient[], style: ClipboardStyle = "comma"): string {
  if (style === "lines") return recipients.map((r) => r.email).join("\n");
  if (style === "named") {
    return recipients
      .map((r) => {
        const n = (r.name ?? "").trim().replace(/[",<>]/g, "");
        return n ? `${n} <${r.email}>` : r.email;
      })
      .join(", ");
  }
  return recipients.map((r) => r.email).join(", ");
}

/** Addresses once each, in first-seen order, ignoring case. */
export function uniqueEmails(emails: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of emails) {
    const k = (e ?? "").trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

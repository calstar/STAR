// Mail merge. A template is plain text with
//   {{field}}                 the value, or a "missing" mark when empty
//   {{field|fallback}}        the value, else the fallback ("there")
//   {{#field}}...{{/field}}   the inside only when field is set / true
//   {{^field}}...{{/field}}   the inside only when it is not
// so one renewal/cold template covers "sponsoring again" vs "sponsoring".
// Pure: the Compose page renders each recipient's preview with this, and the
// result is what goes into the Gmail compose link.

export type MergeVars = Record<string, string | boolean | number | null | undefined>;

/** The fields a template can use, with what they mean, for the cheat sheet. */
export const MERGE_FIELDS: { name: string; help: string }[] = [
  { name: "first_name", help: "Recipient's first name" },
  { name: "last_name", help: "Recipient's last name" },
  { name: "full_name", help: "First and last name" },
  { name: "email", help: "Recipient's address" },
  { name: "org", help: "Their organization" },
  { name: "ask", help: "What we're asking this sponsor for (deal)" },
  { name: "their_deliverables", help: "What they gave / give (deal)" },
  { name: "our_deliverables", help: "What we promised them (deal)" },
  { name: "project", help: "LE4, Caldera, Full Team (deal)" },
  { name: "season", help: "2026–27" },
  { name: "renewal", help: "Set for a returning sponsor: use with {{#renewal}}…{{/renewal}}" },
  { name: "last_gift", help: "Their most recent gift, e.g. $150.00" },
  { name: "referrer", help: "The STAR member who brought them in" },
  { name: "campaign_url", help: "The campaign page (campaign)" },
  { name: "sender_name", help: "Your name" },
  { name: "sender_first_name", help: "Your first name" },
  { name: "sender_email", help: "Your address" },
];

const isSet = (v: MergeVars[string]) => v !== undefined && v !== null && v !== false && v !== "" && v !== 0;

export type Rendered = { text: string; missing: string[] };

export function render(template: string, vars: MergeVars): Rendered {
  const missing = new Set<string>();
  // Sections first (innermost-first by repetition), so their insides merge too.
  let text = template;
  const section = /\{\{([#^])\s*([a-z_]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
  for (let guard = 0; guard < 10 && section.test(text); guard++) {
    section.lastIndex = 0;
    text = text.replace(section, (_m, kind: string, name: string, inner: string) =>
      (kind === "#") === isSet(vars[name]) ? inner : "",
    );
  }
  text = text.replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g, (_m, name: string, fallback?: string) => {
    const v = vars[name];
    if (isSet(v) && typeof v !== "boolean") return String(v);
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return `[${name}]`;
  });
  return { text, missing: [...missing] };
}

/** Every field a template refers to, for "this template needs a deal" checks. */
export function fieldsUsed(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*[#^/]?\s*([a-z_]+)/g)) out.add(m[1]);
  return [...out];
}

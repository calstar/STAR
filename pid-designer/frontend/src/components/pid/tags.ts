/**
 * Tags for newly placed symbols.
 *
 * A palette entry's label is a template -- `ROT_#`, `PT-HP_#` -- and the `#`
 * was never filled in. Every rotary valve dropped was tagged, literally,
 * `ROT_#`; the second one tripped the duplicate-tag check, and a drawing in
 * this repo has `HQD_#`, `PG_#`, `PR_#` and `ROT_#` saved as the names of real
 * hardware. A tag is what a solve, a report and a procedure all key on, so a
 * symbol has to land with one that is its own.
 *
 * The form follows the team's drawings: a hyphenated stem and a number,
 * `ROT-1`, `PT-HP-2`, `TK-1`. People rename most of them to something that
 * says what they do -- `MV-OX`, `TK-FU` -- and that is the point: the number
 * is a placeholder that is at least unique, not a naming scheme.
 */

/** `ROT_#` → `ROT`; `TK-#` → `TK`; a label with no `#` is its own stem. */
export function stemOf(template: string): string {
  return template.replace(/[-_]?#\s*$/, '');
}

/**
 * The next free tag for a template, given every tag already on the drawing.
 *
 * One past the highest number in use for that stem, never a gap. Filling a
 * gap would hand a deleted valve's tag to a new one, and a procedure written
 * against the old ROT-3 would then be about a different valve.
 */
export function numberTag(template: string, existing: Iterable<string>): string {
  const stem = stemOf(template);
  if (!template.includes('#')) return template;
  const re = new RegExp(`^${escape(stem)}-(\\d+)$`);
  let highest = 0;
  for (const tag of existing) {
    const m = re.exec(tag.trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `${stem}-${highest + 1}`;
}

/** Whether a tag is still an unfilled template: the bug this file fixes. */
export const isTemplateTag = (tag: string) => /#\s*$/.test(tag);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

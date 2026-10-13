// Clickable GFM task lists: a rendered checkbox knows where its list item starts
// in the source (react-markdown's position offsets), and this flips that item's
// "[ ]" / "[x]" in the markdown text.

// A list marker ("-", "*", "+", "1." or "1)") then the task box, at the start of
// the item. Leading spaces allowed in case an offset lands before the marker.
const TASK_ITEM = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/;

/** `text` with the task box of the list item starting at `offset` toggled, or
 * null when no task box starts there (the text is left alone). */
export function toggleTaskAt(text: string, offset: number): string | null {
  if (offset < 0 || offset > text.length) return null;
  const m = TASK_ITEM.exec(text.slice(offset));
  if (!m) return null;
  const at = offset + m[1].length;
  const next = m[2] === " " ? "x" : " ";
  return text.slice(0, at) + next + text.slice(at + 1);
}

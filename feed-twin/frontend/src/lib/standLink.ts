/**
 * A link that names a stand (`/?stand=<id>`) and what the page says when that
 * stand is not the one that opened.
 *
 * The stand provider reads the link once and drops it from the address; when
 * the stand is not on this server it opens what a link-less visit would. Its
 * own error line was the transient one every tick clears, so the fallback came
 * up with no word that the link had missed. The shell keeps the ask from first
 * paint and says it until dismissed.
 */

/** The stand id an address asks for, or null. */
export function askedStand(search: string): string | null {
  try {
    return new URLSearchParams(search).get('stand') || null;
  } catch {
    return null;
  }
}

/** What to say once the stand has landed (`landed`) if the one that opened is
 *  not the one asked for; '' while it is still opening, or when it opened. */
export function missedStand(asked: string | null, opened: { id: string } | null, landed: boolean): string {
  if (!asked || !landed || opened?.id === asked) return '';
  return `The link asked for the stand "${asked}", which is not on this server or could not be opened; this is what opens without one.`;
}

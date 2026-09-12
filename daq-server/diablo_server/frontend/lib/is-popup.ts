/**
 * True when the current document was opened as a popup (via window.open from
 * another page in this app). Popups are dedicated single-view windows — the tab
 * bar and the floating "open in popup" button are hidden in them.
 */
export function isPopupWindow(): boolean {
  return typeof window !== 'undefined' && !!window.opener;
}

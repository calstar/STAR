'use client'

import { useLocation } from 'react-router-dom';
import { useWindowManager } from './WindowManager';
import { navItemByPath } from '@/lib/nav-items';
import { isPopupWindow } from '@/lib/is-popup';

/** Full-bleed views that draw their own pop-out control instead of this floating one. */
const OWN_POPOUT_PATHS = ['/video'];

/**
 * Floating button (bottom-right) that pops the current view out into its own
 * window — handy for dedicating a TV to a single pane. Reuses WindowManager's
 * existing popup sizing/placement. Hidden inside popups (nothing to pop out).
 */
export default function OpenInPopupButton() {
  const { pathname, search } = useLocation();
  const { openWindow } = useWindowManager();

  if (isPopupWindow() || OWN_POPOUT_PATHS.includes(pathname)) return null;

  const item = navItemByPath(pathname);
  const name = item?.name ?? 'View';
  // Stable id per path so re-clicking focuses the existing popup instead of stacking.
  const id = `popout:${pathname}`;
  const url = `${pathname}${search}`;

  return (
    <button
      type="button"
      onClick={() => openWindow(id, name, url)}
      title={`Open “${name}” in a popup window`}
      className="ctl fixed bottom-5 right-5 z-40 h-8 gap-2 bg-black px-3 text-[10px] text-ink-2"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      </svg>
      Open in popup
    </button>
  );
}

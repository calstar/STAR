'use client'

import { useLocation } from 'react-router-dom';
import TopBar from './TopBar';
import TabBar from './TabBar';
import { isPopupWindow } from '@/lib/is-popup';

// Routes that render their own compact header and no tab bar (full-bleed views).
const SUPPRESS_TOPBAR_PATHS = ['/mobile', '/livestream'];

/**
 * The header, as feed-twin's: the brand and the views on one line, the stand's
 * vital signs on the next, then the strip every view keeps -- the transducers
 * as bars and the command stack, so the way out is one click from any page.
 */
export default function TopBarWrapper() {
  const { pathname } = useLocation();
  const suppress = SUPPRESS_TOPBAR_PATHS.some((p) => pathname === p || pathname?.startsWith(p + '/'));
  const isIpad = pathname === '/ipad' || pathname?.startsWith('/ipad/');

  if (suppress) return null;

  if (isIpad) {
    return (
      <div className="w-full flex-shrink-0 border-b border-line" style={{ height: '150px' }}>
        <div className="w-[125%] h-full origin-top-left" style={{ transform: 'scale(0.8)' }}>
          <TopBar />
        </div>
      </div>
    );
  }

  // Popups are dedicated single-view windows — keep the brand, drop the views.
  const showTabs = !isPopupWindow();

  return (
    <header className="relative z-30 flex-shrink-0 select-none border-b border-line bg-black">
      <TabBar nav={showTabs} />
      <TopBar />
    </header>
  );
}

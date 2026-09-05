'use client'

import { useLocation } from 'react-router-dom';
import TopBar from './TopBar';
import TabBar from './TabBar';
import { isPopupWindow } from '@/lib/is-popup';

// Routes that render their own compact header and no tab bar (full-bleed views).
const SUPPRESS_TOPBAR_PATHS = ['/mobile', '/livestream'];

export default function TopBarWrapper() {
  const { pathname } = useLocation();
  const suppress = SUPPRESS_TOPBAR_PATHS.some((p) => pathname === p || pathname?.startsWith(p + '/'));
  const isIpad = pathname === '/ipad' || pathname?.startsWith('/ipad/');

  if (suppress) return null;

  if (isIpad) {
    return (
      <div className="w-full bg-card border-b border-gray-800 flex-shrink-0" style={{ height: '150px' }}>
        <div className="w-[125%] h-full origin-top-left" style={{ transform: 'scale(0.8)' }}>
          <TopBar />
        </div>
      </div>
    );
  }

  // Popups are dedicated single-view windows — keep the TopBar, drop the tab bar.
  const showTabs = !isPopupWindow();

  return (
    <>
      <TopBar />
      {showTabs && <TabBar />}
    </>
  );
}

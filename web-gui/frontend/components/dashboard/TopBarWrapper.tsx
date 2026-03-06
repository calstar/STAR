'use client'

import { usePathname } from 'next/navigation';
import TopBar from './TopBar';

// Routes where the full desktop TopBar should be suppressed (they render their own compact header)
const SUPPRESS_TOPBAR_PATHS = ['/window/mobile-gui'];

export default function TopBarWrapper() {
  const pathname = usePathname();
  const suppress = SUPPRESS_TOPBAR_PATHS.some((p) => pathname === p || pathname?.startsWith(p + '/'));
  const isIpad = pathname === '/window/ipad' || pathname?.startsWith('/window/ipad/');

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

  return <TopBar />;
}

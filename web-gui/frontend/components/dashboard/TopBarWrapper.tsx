'use client'

import { usePathname } from 'next/navigation';
import TopBar from './TopBar';

// Routes where the full desktop TopBar should be suppressed (they render their own compact header)
const SUPPRESS_TOPBAR_PATHS = ['/window/mobile-gui'];

export default function TopBarWrapper() {
  const pathname = usePathname();
  const suppress = SUPPRESS_TOPBAR_PATHS.some((p) => pathname === p || pathname?.startsWith(p + '/'));
  if (suppress) return null;
  return <TopBar />;
}

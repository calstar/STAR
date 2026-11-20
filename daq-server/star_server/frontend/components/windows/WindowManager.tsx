'use client'

import { useState, useEffect } from 'react';

interface WindowReference {
  id: string;
  name: string;
  url: string;
  window: Window | null;
}

export function useWindowManager() {
  const [windows, setWindows] = useState<Map<string, WindowReference>>(new Map());

  const openWindow = (id: string, name: string, url: string) => {
    // Check if window already exists
    const existing = windows.get(id);
    if (existing?.window && !existing.window.closed) {
      existing.window.focus();
      return existing.window;
    }

    // Calculate position to avoid overlap - better grid layout
    // Arrange in a 2x2 grid pattern with spacing that scales with the viewport
    const gridCols = 2;
    const gridRows = 2;

    const viewportWidth =
      typeof window !== 'undefined'
        ? window.innerWidth || window.screen?.availWidth || 1920
        : 1920;
    const viewportHeight =
      typeof window !== 'undefined'
        ? window.innerHeight || window.screen?.availHeight || 1080
        : 1080;

    // Use a percentage of the available viewport so windows scale with screen size
    const width = Math.round(viewportWidth * 0.8);
    const height = Math.round(viewportHeight * 0.85);

    const spacingX = Math.round(viewportWidth * 0.02);
    const spacingY = Math.round(viewportHeight * 0.04);
    const offsetX = spacingX;
    const offsetY = spacingY;

    const col = windows.size % gridCols;
    const row = Math.floor(windows.size / gridCols) % gridRows;

    const availWidth =
      typeof window !== 'undefined'
        ? window.screen?.availWidth || viewportWidth
        : viewportWidth;
    const availHeight =
      typeof window !== 'undefined'
        ? window.screen?.availHeight || viewportHeight
        : viewportHeight;

    let left = offsetX + col * (width + spacingX);
    let top = offsetY + row * (height + spacingY);

    // Ensure windows stay fully on-screen even on smaller displays
    if (left + width > availWidth) {
      left = Math.max(0, availWidth - width);
    }
    if (top + height > availHeight) {
      top = Math.max(0, availHeight - height);
    }

    try {
      // Ensure URL is absolute - use current origin
      const absoluteUrl = url.startsWith('http') ? url : `${window.location.origin}${url.startsWith('/') ? url : '/' + url}`;
      console.log(`[WindowManager] Opening window: ${absoluteUrl}`);

      const newWindow = window.open(
        absoluteUrl,
        `window_${id}`,
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,toolbar=no,location=no,status=no`
      );

      if (!newWindow) {
        // Popup blocked - fallback to same window navigation
        console.warn(`[WindowManager] Popup blocked for ${name}, opening in same window`);
        window.location.href = url;
        return null;
      }

      if (newWindow.closed) {
        console.warn(`[WindowManager] Window was immediately closed for ${name}`);
        return null;
      }

      const windowRef: WindowReference = {
        id,
        name,
        url,
        window: newWindow,
      };

      setWindows((prev) => {
        const updated = new Map(prev);
        updated.set(id, windowRef);
        return updated;
      });

      // Monitor window close
      const checkClosed = setInterval(() => {
        if (newWindow.closed) {
          clearInterval(checkClosed);
          setWindows((prev) => {
            const updated = new Map(prev);
            updated.delete(id);
            return updated;
          });
        }
      }, 500);

      return newWindow;
    } catch (err) {
      console.error(`[WindowManager] Failed to open window ${name}:`, err);
      // Fallback to same window
      window.location.href = url;
      return null;
    }
  };

  const closeWindow = (id: string) => {
    const windowRef = windows.get(id);
    if (windowRef?.window && !windowRef.window.closed) {
      windowRef.window.close();
    }
    setWindows((prev) => {
      const updated = new Map(prev);
      updated.delete(id);
      return updated;
    });
  };

  const closeAllWindows = () => {
    windows.forEach((windowRef) => {
      if (windowRef.window && !windowRef.window.closed) {
        windowRef.window.close();
      }
    });
    setWindows(new Map());
  };

  return {
    windows: Array.from(windows.values()),
    openWindow,
    closeWindow,
    closeAllWindows,
  };
}

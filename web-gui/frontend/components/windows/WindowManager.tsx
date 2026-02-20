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

  const openWindow = (id: string, name: string, url: string, width: number = 1200, height: number = 800) => {
    // Check if window already exists
    const existing = windows.get(id);
    if (existing?.window && !existing.window.closed) {
      existing.window.focus();
      return existing.window;
    }

    // Calculate position to avoid overlap
    const left = (windows.size % 3) * 100 + 50;
    const top = (Math.floor(windows.size / 3) * 100) + 50;

    try {
      // Ensure URL is absolute
      const absoluteUrl = url.startsWith('http') ? url : `${window.location.origin}${url.startsWith('/') ? url : '/' + url}`;
      
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

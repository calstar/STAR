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

    // Calculate position to avoid overlap - better grid layout
    // Arrange in a 2x2 grid pattern with proper spacing
    const gridCols = 2;
    const gridRows = 2;
    const offsetX = 50;
    const offsetY = 50;
    const spacingX = 50;
    const spacingY = 50;
    
    const col = windows.size % gridCols;
    const row = Math.floor(windows.size / gridCols) % gridRows;
    const left = offsetX + col * (width + spacingX);
    const top = offsetY + row * (height + spacingY);

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

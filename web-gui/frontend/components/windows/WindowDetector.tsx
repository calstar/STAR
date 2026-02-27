'use client'

import { useEffect } from 'react';

/**
 * Component to detect if we're in a popup window and adjust UI accordingly
 */
export default function WindowDetector() {
  useEffect(() => {
    // If opened as popup, update document title
    if (window.opener) {
      // We're in a popup window
      const path = window.location.pathname;
      const viewName = path.split('/').pop() || 'Window';
      document.title = `${viewName.charAt(0).toUpperCase() + viewName.slice(1)} - Sensor System`;
    }
  }, []);

  return null;
}

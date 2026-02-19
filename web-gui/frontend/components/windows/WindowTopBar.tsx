'use client'

import { useEffect, useState } from 'react';

export default function WindowTopBar() {
  const [isPopup, setIsPopup] = useState(false);

  useEffect(() => {
    setIsPopup(!!window.opener);
  }, []);

  if (!isPopup) {
    return null; // Don't show in main window
  }

  return (
    <div className="bg-card border-b border-gray-700 p-2 flex items-center justify-between">
      <div className="text-sm font-semibold">
        {document.title.replace(' - Sensor System', '')}
      </div>
      <button
        onClick={() => window.close()}
        className="px-3 py-1 bg-red-600 rounded hover:bg-red-700 text-sm"
      >
        Close Window
      </button>
    </div>
  );
}

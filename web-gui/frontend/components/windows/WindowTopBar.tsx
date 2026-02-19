'use client'

import { useEffect, useState } from 'react';
import { useSensorStore } from '@/lib/store';

export default function WindowTopBar() {
  const [isPopup, setIsPopup] = useState(false);
  const [viewName, setViewName] = useState('');
  const currentState = useSensorStore((state) => state.currentState);
  const connectionStatus = useSensorStore((state) => state.connectionStatus);

  useEffect(() => {
    const popup = !!window.opener;
    setIsPopup(popup);
    if (popup) {
      const path = window.location.pathname;
      const raw = path.split('/').pop() || 'Window';
      setViewName(raw.charAt(0).toUpperCase() + raw.slice(1));
    }
  }, []);

  if (!isPopup) return null;

  const stateNames: Record<number, string> = {
    0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
    5: 'GN2 LOW PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
    9: 'OX PRESS', 10: 'OX VENT', 11: 'GN2 HIGH PRESS', 12: 'GN2 HIGH VENT',
    13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
  };
  const currentStateName = stateNames[currentState ?? 1] ?? 'IDLE';
  const isConnected = connectionStatus?.connected ?? false;

  return (
    <div className="bg-card border-b border-gray-800 px-4 py-2 flex items-center justify-between sticky top-0 z-50">
      <div className="flex items-center gap-4">
        <span className="text-xs font-bold tracking-widest text-blue-400 uppercase">
          DIABLO DAQ
        </span>
        <span className="text-gray-700">|</span>
        <span className="text-sm font-semibold text-text">{viewName}</span>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>STATE</span>
          <span className="font-mono font-bold text-text">{currentStateName}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs text-text-muted">{isConnected ? 'Connected' : 'Disconnected'}</span>
        </div>

        <button
          onClick={() => window.close()}
          className="px-3 py-1 bg-red-700 hover:bg-red-600 rounded text-xs font-semibold transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

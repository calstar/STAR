'use client'

import { useWindowManager } from './WindowManager';

interface WindowButtonProps {
  id: string;
  name: string;
  url: string;
  icon?: string;
  color?: string;
}

function WindowButton({ id, name, url, icon, color = 'bg-card' }: WindowButtonProps) {
  const { openWindow, windows } = useWindowManager();
  const isOpen = windows.some((w) => w.id === id && w.window && !w.window.closed);

  const handleClick = () => {
    openWindow(id, name, url, 1400, 900);
  };

  return (
    <button
      onClick={handleClick}
      className={`
        ${color} p-4 rounded-lg hover:opacity-80 transition-all
        border border-gray-700 hover:border-blue-500
        flex items-center gap-3 min-w-[200px]
        ${isOpen ? 'ring-2 ring-blue-500' : ''}
      `}
    >
      {icon && <span className="text-2xl">{icon}</span>}
      <div className="text-left">
        <div className="font-semibold">{name}</div>
        <div className="text-xs text-text-muted">
          {isOpen ? '● Open' : 'Click to open'}
        </div>
      </div>
    </button>
  );
}

export default function WindowLauncher() {
  const { closeAllWindows, windows } = useWindowManager();
  const openCount = windows.filter((w) => w.window && !w.window.closed).length;

  return (
    <div className="bg-card rounded-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Multi-Window Launcher</h2>
          <p className="text-sm text-text-muted mt-1">
            Open different views in separate windows
            {openCount > 0 && <span className="ml-2">({openCount} open)</span>}
          </p>
        </div>
        {openCount > 0 && (
          <button
            onClick={closeAllWindows}
            className="px-4 py-2 bg-red-600 rounded-lg hover:bg-red-700 text-sm"
          >
            Close All Windows
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <WindowButton
          id="fuel"
          name="FUEL System"
          url="/window/fuel"
          icon="⛽"
          color="bg-card border-fuel"
        />
        <WindowButton
          id="lox"
          name="LOX System"
          url="/window/lox"
          icon="🧊"
          color="bg-card border-lox"
        />
        <WindowButton
          id="copv"
          name="COPV System"
          url="/window/copv"
          icon="💨"
          color="bg-card border-gn2"
        />
        <WindowButton
          id="gse"
          name="GSE System"
          url="/window/gse"
          icon="🔧"
          color="bg-card border-gse-low"
        />
        <WindowButton
          id="raw"
          name="Raw Readouts"
          url="/window/raw"
          icon="📊"
          color="bg-card"
        />
        <WindowButton
          id="controls"
          name="Controls"
          url="/window/controls"
          icon="🎮"
          color="bg-card border-blue-500"
        />
        <WindowButton
          id="status"
          name="Status Tables"
          url="/window/status"
          icon="📋"
          color="bg-card"
        />
        <WindowButton
          id="config"
          name="Configuration"
          url="/window/config"
          icon="⚙️"
          color="bg-card border-yellow-500"
        />
        <WindowButton
          id="controller"
          name="Controller"
          url="/window/controller"
          icon="🎛️"
          color="bg-card border-purple-500"
        />
      </div>
    </div>
  );
}

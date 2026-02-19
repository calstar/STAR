'use client'

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import WindowDetector from '@/components/windows/WindowDetector';
import WindowTopBar from '@/components/windows/WindowTopBar';

// Import all page components
import FuelGraphsPage from '@/app/plots/fuel/page';
import LOXGraphsPage from '@/app/plots/lox/page';
import COPVGraphsPage from '@/app/plots/copv/page';
import GSEGraphsPage from '@/app/plots/gse/page';
import RawReadoutsPage from '@/app/plots/raw/page';
import AllPlotsPage from '@/app/plots/all/page';
import ControlsPage from '@/app/controls/page';
import StatusPage from '@/app/status/page';
import ConfigPage from '@/app/config/page';
import ControllerPage from '@/app/controller/page';
import CalibrationPage from '@/app/calibration/page';

const viewComponents: Record<string, React.ComponentType> = {
  fuel: FuelGraphsPage,
  lox: LOXGraphsPage,
  copv: COPVGraphsPage,
  gse: GSEGraphsPage,
  raw: RawReadoutsPage,
  all: AllPlotsPage,
  controls: ControlsPage,
  status: StatusPage,
  config: ConfigPage,
  calibration: CalibrationPage,
  controller: ControllerPage,
};

export default function WindowViewPage() {
  const params = useParams();
  const view = params?.view as string;

  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState = useSensorStore((state) => state.updateState);
  const updateConnectionStatus = useSensorStore((state) => state.updateConnectionStatus);
  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();

    // Sensor updates
    const unsubscribeSensor = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      updateSensor(payload as SensorUpdate);
    });

    // State-machine updates (needed by controls panel in popup windows)
    const unsubscribeState = ws.on(MessageType.STATE_UPDATE, (payload: unknown) => {
      updateState(payload as StateUpdate);
    });

    // Connection status — popup windows don't have TopBar, so update the store here
    const unsubscribeConn = ws.onConnectionStatus((status) => {
      updateConnectionStatus(status);
    });

    return () => {
      unsubscribeSensor();
      unsubscribeState();
      unsubscribeConn();
    };
  }, [ws, updateSensor, updateState, updateConnectionStatus]);

  const Component = viewComponents[view];

  if (!Component) {
    return (
      <main className="min-h-screen bg-background text-text p-8">
        <WindowDetector />
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold text-red-500">Invalid View</h1>
          <p className="text-text-muted">View &quot;{view}&quot; not found</p>
        </div>
      </main>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-text">
      <WindowDetector />
      <WindowTopBar />
      {/* flex-1 gives the page all remaining height after the topbar */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <Component />
      </div>
    </div>
  );
}

'use client'

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';
import WindowDetector from '@/components/windows/WindowDetector';
import WindowTopBar from '@/components/windows/WindowTopBar';

// Import all page components
import FuelGraphsPage from '@/app/plots/fuel/page';
import LOXGraphsPage from '@/app/plots/lox/page';
import COPVGraphsPage from '@/app/plots/copv/page';
import GSEGraphsPage from '@/app/plots/gse/page';
import RawReadoutsPage from '@/app/plots/raw/page';
import ControlsPage from '@/app/controls/page';
import StatusPage from '@/app/status/page';
import ConfigPage from '@/app/config/page';
import ControllerPage from '@/app/controller/page';

const viewComponents: Record<string, React.ComponentType> = {
  fuel: FuelGraphsPage,
  lox: LOXGraphsPage,
  copv: COPVGraphsPage,
  gse: GSEGraphsPage,
  raw: RawReadoutsPage,
  controls: ControlsPage,
  status: StatusPage,
  config: ConfigPage,
  controller: ControllerPage,
};

export default function WindowViewPage() {
  const params = useParams();
  const view = params?.view as string;
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const unsubscribe = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      updateSensor(payload as SensorUpdate);
    });
    return unsubscribe;
  }, [ws, updateSensor]);

  const Component = viewComponents[view];

  if (!Component) {
    return (
      <main className="min-h-screen bg-background text-text p-8">
        <WindowDetector />
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold text-red-500">Invalid View</h1>
          <p className="text-text-muted">View "{view}" not found</p>
        </div>
      </main>
    );
  }

  return (
    <>
      <WindowDetector />
      <WindowTopBar />
      <Component />
    </>
  );
}

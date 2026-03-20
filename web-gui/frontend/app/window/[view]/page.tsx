'use client'

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import WindowDetector from '@/components/windows/WindowDetector';

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
import UnifiedDashboardPage from '@/app/window/unified/page';
import BoardsPage from '@/app/boards/page';
import LCS_TCS_RTDPage from '@/app/plots/lcs-tcs-rtd/page';
import ChamberGraphsPage from '@/app/plots/chamber/page';
import SensorInfoPage from '@/app/sensor-info/page';
import MobileGUIPage from '@/app/window/mobile-gui/page';
import SolenoidCharacterizationPage from '@/app/plots/solenoid-characterization/page';
import EncodersPage from '@/app/encoders/page';

const viewComponents: Record<string, React.ComponentType> = {
  fuel: FuelGraphsPage,
  lox: LOXGraphsPage,
  copv: COPVGraphsPage,
  gse: GSEGraphsPage,
  raw: RawReadoutsPage,
  all: AllPlotsPage,
  controls: ControlsPage,
  controller: ControllerPage,
  status: StatusPage,
  boards: BoardsPage,
  config: ConfigPage,
  calibration: CalibrationPage,
  unified: UnifiedDashboardPage,
  'lcs-tcs-rtd': LCS_TCS_RTDPage,
  chamber: ChamberGraphsPage,
  'sensor-info': SensorInfoPage,
  'mobile-gui': MobileGUIPage,
  'solenoid-char': SolenoidCharacterizationPage,
  encoders: EncodersPage,
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
    const unsubscribeSensor = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      updateSensor(payload as SensorUpdate);
    });
    const unsubscribeState = ws.on(MessageType.STATE_UPDATE, (payload: unknown) => {
      updateState(payload as StateUpdate);
    });
    const unsubscribeConn = ws.onConnectionStatus((status) => {
      updateConnectionStatus(status);
    });
    return () => { unsubscribeSensor(); unsubscribeState(); unsubscribeConn(); };
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

  // TopBar is rendered by layout.tsx — just give the page remaining height
  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
      <WindowDetector />
      <Component />
    </div>
  );
}

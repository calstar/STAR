'use client'

import { useEffect, useMemo, useRef, useState } from 'react';
import DerivedTimeSeriesPlot, { type DerivedTimeSeriesPlotHandle } from '@/components/plots/DerivedTimeSeriesPlot';
import OscopeTriggerPlot from '@/components/plots/OscopeTriggerPlot';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate, BoardStatus, BoardStatusPayload } from '@/lib/types';

const RAW_TO_DEG = 360.0 / 4096.0;
const rawToDeg = (raw: number) => (raw & 0x0FFF) * RAW_TO_DEG;

const ENC_ENTITIES = ['ENC.CH1', 'ENC.CH2'];
const ENC_LABELS = ['Encoder 1', 'Encoder 2'];
const ENC_COLORS = ['#3B82F6', '#F97316'];

export default function EncodersPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState = useSensorStore((s) => s.updateState);
  const updateBoards = useSensorStore((s) => s.updateBoards);
  const boardsMap = useSensorStore((s) => s.boards as Record<number, BoardStatus>);
  const ws = getWebSocketClient();
  const [isPaused, setIsPaused] = useState(false);
  const plotRef = useRef<DerivedTimeSeriesPlotHandle>(null);

  const enc1Raw = useSensorValue('ENC.CH1', 'raw_angle');
  const enc2Raw = useSensorValue('ENC.CH2', 'raw_angle');
  const enc1Deg = enc1Raw != null ? rawToDeg(enc1Raw) : null;
  const enc2Deg = enc2Raw != null ? rawToDeg(enc2Raw) : null;

  const encoderBoard = useMemo(() => {
    const boards = Object.values(boardsMap ?? {});
    return boards.find((b) => b.type === 'ENCODER') ?? null;
  }, [boardsMap]);

  const connected = encoderBoard?.connected ?? false;
  const dataRateHz = encoderBoard?.frequencyHz;
  const dataRateStr =
    dataRateHz != null && isFinite(dataRateHz) ? `${dataRateHz.toFixed(1)} Hz` : '---';

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    const unsub3 = ws.on(MessageType.BOARD_STATUS_UPDATE, (p: unknown) => {
      const payload = p as BoardStatusPayload;
      if (payload?.boards) updateBoards(payload.boards as BoardStatus[]);
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [ws, updateSensor, updateState, updateBoards]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-auto p-4 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-violet-500 rounded-full" />
          <h1 className="text-base font-bold text-violet-400 tracking-wider">ENCODERS</h1>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-6 bg-card rounded-lg border border-gray-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-sm font-mono font-bold text-gray-200">
            {connected ? 'CONNECTED' : 'DISCONNECTED'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 uppercase tracking-wider">Data Rate</span>
          <span className="text-sm font-mono font-bold text-gray-200">{dataRateStr}</span>
        </div>
        {encoderBoard && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 uppercase tracking-wider">Board ID</span>
            <span className="text-sm font-mono text-gray-300">{encoderBoard.id}</span>
          </div>
        )}

        {/* Play / Pause / Reset zoom */}
        <div className="flex items-center gap-1 rounded border border-gray-700 bg-gray-900 px-2 py-1">
          <button
            type="button"
            onClick={() => setIsPaused(false)}
            className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors ${
              !isPaused ? 'bg-violet-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
            title="Resume live updates"
          >
            Play
          </button>
          <button
            type="button"
            onClick={() => setIsPaused(true)}
            className={`rounded px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors ${
              isPaused ? 'bg-amber-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
            title="Pause to zoom"
          >
            Pause
          </button>
          {isPaused && (
            <button
              type="button"
              onClick={() => plotRef.current?.resetZoom()}
              className="rounded px-3 py-1 text-xs font-bold uppercase tracking-wider text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200"
              title="Reset zoom to full range"
            >
              Reset zoom
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-8">
          <div className="text-center">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Encoder 1</div>
            <div className="text-lg font-mono font-bold" style={{ color: ENC_COLORS[0] }}>
              {enc1Deg != null ? `${enc1Deg.toFixed(1)}°` : '---'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Encoder 2</div>
            <div className="text-lg font-mono font-bold" style={{ color: ENC_COLORS[1] }}>
              {enc2Deg != null ? `${enc2Deg.toFixed(1)}°` : '---'}
            </div>
          </div>
        </div>
      </div>

      {/* Live plot */}
      <div className="flex-[2] min-h-[350px]">
        <DerivedTimeSeriesPlot
          ref={plotRef}
          title="Encoder Angles (Live)"
          entities={ENC_ENTITIES}
          component="raw_angle"
          transform={rawToDeg}
          colors={ENC_COLORS}
          labels={ENC_LABELS}
          yLabel="Angle (°)"
          windowSeconds={2}
          yRange={[0, 360]}
          yTicks={[0, 90, 180, 270, 360]}
          enablePlayPause
          isPaused={isPaused}
          onPauseChange={setIsPaused}
          showControls={false}
        />
      </div>

      {/* Oscilloscope trigger plot */}
      <div className="flex-shrink-0">
        <OscopeTriggerPlot />
      </div>
    </main>
  );
}

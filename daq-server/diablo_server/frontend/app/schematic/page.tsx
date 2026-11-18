'use client'

/**
 * Schematic: the stand's P&ID with what the DAQ reads on it.
 *
 * Read-only and never touched: the whole stand -- every page side by side --
 * fitted to the screen, nothing to click, pan or zoom. The drawing is the
 * picture feed-twin exported (`config/stand_pid.json`, served at
 * /api/stand-pid); this page only paints on it (lib/schematic.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import { useGetSensorValue, useSensorDataVersion } from '@/lib/store';
import { getApiBaseUrl } from '@/lib/websocket';
import { frameOf, overlayOf, parseStandPid, type StandPid } from '@/lib/schematic';

/** Overlay text, in stand pixels (the export draws two per flow unit). */
const READING_PX = 30;

export default function SchematicPage() {
  const [pid, setPid] = useState<StandPid | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    fetch(`${getApiBaseUrl()}/api/stand-pid`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({ error: `stand_pid.json could not be read (HTTP ${r.status}).` }));
        if (stale) return;
        if (!r.ok) {
          setError(body?.error ?? `HTTP ${r.status}`);
          return;
        }
        const parsed = parseStandPid(body);
        if ('error' in parsed) setError(parsed.error);
        else setPid(parsed.pid);
      })
      .catch((e) => !stale && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
  }, []);

  if (error) {
    return (
      <div className="p-6 text-sm text-red-400" role="alert">
        {error}
      </div>
    );
  }
  if (!pid) return <div className="p-6 text-sm text-gray-400">Loading the stand's P&amp;ID…</div>;
  return <Schematic pid={pid} />;
}

function Schematic({ pid }: { pid: StandPid }) {
  // Re-render on each flush (10 Hz); values are read at render time.
  useSensorDataVersion();
  const read = useGetSensorValue();
  const overlay = overlayOf(pid, frameOf(pid, read));
  // The drawing is a large string; hand it to the DOM once.
  const drawing = useMemo(() => ({ __html: pid.svg }), [pid.svg]);
  const viewBox = `0 0 ${pid.width} ${pid.height}`;

  return (
    <div className="relative h-full w-full select-none overflow-hidden" data-testid="schematic">
      <div
        className="absolute inset-0 [&>svg]:h-full [&>svg]:w-full"
        // The picture's own <svg> has a viewBox; sized to the box, it fits
        // and centres (preserveAspectRatio's default), as the overlay does.
        dangerouslySetInnerHTML={drawing}
      />
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={viewBox} aria-label="Live readings">
        {overlay.dim.map(([x, y, w, h], i) => (
          <rect key={i} x={x} y={y} width={w} height={h} fill="rgb(10 10 10 / 0.65)" />
        ))}
        {overlay.readings.map((r) => (
          <g key={r.symbol} data-reading={r.name}>
            <text
              x={r.x}
              y={r.y - READING_PX * 0.4}
              textAnchor="middle"
              fontFamily="ui-monospace, Menlo, monospace"
              fontSize={READING_PX}
              fontWeight={700}
              fill={r.live ? '#f8fafc' : '#6b7280'}
              stroke="#0a0a0a"
              strokeWidth={6}
              paintOrder="stroke"
            >
              {r.text}
            </text>
          </g>
        ))}
      </svg>
      <div className="absolute bottom-1 right-2 font-mono text-[11px] text-gray-500">
        {pid.drawing.diagram} · exported {pid.drawing.exported_at.slice(0, 16).replace('T', ' ')} · psig
      </div>
    </div>
  );
}

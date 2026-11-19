'use client'

/**
 * Schematic: the stand's P&ID with what the DAQ reads on it.
 *
 * Read-only and never touched: the whole stand -- every page side by side --
 * fitted to the screen, nothing to click, pan or zoom. The drawing is the
 * picture feed-twin exported (`config/stand_pid.json`, served at
 * /api/stand-pid); this page only paints on it (lib/schematic.ts).
 *
 * Small symbols, large readings: the whole of LE4 on a 1080p monitor is ~27 %
 * scale, where the drawing's own tags are a few pixels high. The drawing is
 * context; every reading, ring and badge is sized in *screen* pixels.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { commandEntityFor, peekSensor, useSensorDataVersion, useSensorStore } from '@/lib/store';
import { isBoardLiveTelemetryStale } from '@/lib/sensor-rate';
import { getApiBaseUrl } from '@/lib/websocket';
import {
  daqNamesOf,
  frameOf,
  lineStyles,
  valveStyles,
  overlayOf,
  parseStandPid,
  shade,
  type DaqName,
  type Frame,
  type FrameSource,
  type StandPid,
} from '@/lib/schematic';

export default function SchematicPage() {
  const [pid, setPid] = useState<StandPid | null>(null);
  const [names, setNames] = useState<Map<string, DaqName>>(new Map());
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
    // The running config: what the DAQ calls each valve and transducer, NO/NC, full scale.
    fetch(`${getApiBaseUrl()}/api/config/running`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !stale && d && setNames(daqNamesOf(d.config ?? d)))
      .catch(() => undefined);
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
  return <LiveSchematic pid={pid} names={names} />;
}

/** The view fed from the live store, at its 10 Hz flush. */
function LiveSchematic({ pid, names }: { pid: StandPid; names: Map<string, DaqName> }) {
  useSensorDataVersion();
  const boards = useSensorStore((s) => s.boards);
  const changes = useRef(new Map<string, { open: boolean | null; at: number }>());

  const src: FrameSource = {
    sample: (entity, component) => peekSensor(entity, component),
    valve: (roleEntity, ballValve) => {
      const cmd = peekSensor(commandEntityFor(roleEntity) ?? roleEntity, 'actuator_state_commanded');
      const cal = roleEntity.replace(/^ACT\./, 'ACT_Cal.');
      const fresh = (s: ReturnType<typeof peekSensor>) =>
        s.value !== null && s.ageMs !== null && s.ageMs <= s.staleAfterMs ? s.value : null;
      return {
        open: cmd.value === null ? null : cmd.value === 1,
        ageMs: cmd.ageMs,
        staleAfterMs: cmd.staleAfterMs,
        currentA: ballValve ? null : fresh(peekSensor(cal, 'current_a')),
        positionPct: ballValve ? fresh(peekSensor(cal, 'position_pct')) : null,
      };
    },
    boardOffline: (id) => {
      const b = boards?.[id];
      if (!b) return false;
      return isBoardLiveTelemetryStale(b) || !(b.operational ?? b.connected);
    },
    sinceChange: (name, open) => {
      const now = Date.now();
      const seen = changes.current.get(name);
      if (!seen || seen.open !== open) {
        changes.current.set(name, { open, at: now });
        return 0;
      }
      return now - seen.at;
    },
  };
  return <SchematicView pid={pid} names={names} frame={frameOf(pid, names, src)} />;
}

/** Screen pixels: reading text, and the badge/ring stroke. */
const READING_PX = 17;
const SMALL_PX = 12;
/** Drawn line width on screen, so a section's shade can be seen at a whole-stand fit. */
const LINE_PX = 3;
/** The export draws the canvas at 2 stand pixels per flow unit (pid-designer exportImage SCALE),
 *  and a line's own units are flow units. */
const STAND_PX_PER_LINE_UNIT = 2;

const READING_FILL: Record<string, string> = {
  live: '#f8fafc',
  stale: '#9ca3af',
  none: '#6b7280',
  unknown: '#f59e0b',
};

/**
 * The drawing with a frame painted on it. Pure: a frame from the store, a
 * recording or a test all draw the same way.
 */
export function SchematicView({ pid, names, frame }: { pid: StandPid; names: Map<string, DaqName>; frame: Frame }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1920, h: 1080 });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Stand pixels per screen pixel, as the fitted drawing is drawn ("meet").
  const k = Math.min(size.w / pid.width, size.h / pid.height) || 1;
  const px = (screen: number) => screen / k;

  const overlay = overlayOf(pid, frame, names, { lineHeight: px(READING_PX * 1.25) });
  const drawing = useMemo(() => ({ __html: pid.svg }), [pid.svg]);
  const css = `${lineStyles(overlay.lines, px(LINE_PX) / STAND_PX_PER_LINE_UNIT)}\n${valveStyles(overlay.rings)}`;
  const problems = [
    ...overlay.health.unknown.map((n) => `"${n}" is on the drawing's DAQ box but not in the DAQ config`),
    ...overlay.health.disagree.map((n) => `NO/NC: ${n}; the DAQ's is shown`),
  ];

  return (
    <div
      ref={box}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', userSelect: 'none', background: '#0a0a0a' }}
      data-testid="schematic"
    >
      <style>{css}</style>
      <div
        style={{ position: 'absolute', inset: 0 }}
        className="[&>svg]:h-full [&>svg]:w-full"
        // The picture's own <svg> has a viewBox; sized to the box, it fits and
        // centres (preserveAspectRatio's default), exactly as the overlay does.
        dangerouslySetInnerHTML={drawing}
      />
      <svg
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        viewBox={`0 0 ${pid.width} ${pid.height}`}
        aria-label="Live readings"
      >
        {overlay.dim.map(([x, y, w, h], i) => (
          <rect key={`d${i}`} x={x} y={y} width={w} height={h} fill="rgb(10 10 10 / 0.6)" />
        ))}
        {overlay.offline.map(([x, y, w, h], i) => (
          <rect key={`o${i}`} x={x} y={y} width={w} height={h} fill="rgb(75 85 99 / 0.55)" />
        ))}
        {overlay.rings.map((r) => (
          <g key={r.symbol} data-ring={r.name}>
            {/* The valve's own shape carries its state (valveStyles); this
                transparent hit area keeps the tooltip. */}
            <circle cx={r.cx} cy={r.cy} r={r.r} fill="transparent" stroke="none" style={{ pointerEvents: 'all' }}>
              <title>{`${r.name}: ${r.open === null ? 'no state' : r.open ? 'open' : 'shut'}${r.mismatch ? ` — ${r.mismatch}` : ''}`}</title>
            </circle>
            {r.mismatch && (
              <g data-mismatch={r.name}>
                <circle cx={r.cx + r.r * 0.7} cy={r.cy - r.r * 0.7} r={px(9)} fill="#f59e0b" stroke="#0a0a0a" strokeWidth={px(2)} />
                <text x={r.cx + r.r * 0.7} y={r.cy - r.r * 0.7 + px(4.5)} textAnchor="middle" fontSize={px(13)} fontWeight={800} fill="#0a0a0a" fontFamily="ui-monospace, Menlo, monospace">!</text>
              </g>
            )}
            {(r.position || r.disagree) && (
              <text
                x={r.cx}
                y={r.labelY}
                textAnchor="middle"
                fontSize={px(SMALL_PX)}
                fontFamily="ui-monospace, Menlo, monospace"
                fill={r.disagree ? '#f59e0b' : '#e5e7eb'}
                stroke="#0a0a0a"
                strokeWidth={px(3)}
                paintOrder="stroke"
              >
                {[r.position, r.disagree].filter(Boolean).join(' · ')}
              </text>
            )}
          </g>
        ))}
        {overlay.readings.map((r) => (
          <text
            key={r.symbol}
            data-reading={r.name}
            data-state={r.state}
            x={r.x}
            y={r.y - px(5)}
            textAnchor="middle"
            fontFamily="ui-monospace, Menlo, monospace"
            fontSize={px(READING_PX)}
            fontWeight={700}
            fill={READING_FILL[r.state]}
            stroke="#0a0a0a"
            strokeWidth={px(4)}
            paintOrder="stroke"
          >
            {r.text}
            {r.note && <title>{`${r.name}: ${r.note}`}</title>}
          </text>
        ))}
        {overlay.splits.map((s, i) => (
          <text key={`s${i}`} x={s.x} y={s.y} fontSize={px(SMALL_PX)} fill="#f59e0b" fontFamily="ui-monospace, Menlo, monospace" stroke="#0a0a0a" strokeWidth={px(3)} paintOrder="stroke">
            {s.text}
          </text>
        ))}
      </svg>

      {problems.length > 0 && (
        <div
          role="status"
          style={{ position: 'absolute', top: 8, left: 8, maxWidth: 560, padding: '6px 10px', background: 'rgb(10 10 10 / 0.85)', border: '1px solid #f59e0b', borderRadius: 4, color: '#fbbf24', font: '12px ui-monospace, Menlo, monospace' }}
        >
          {problems.slice(0, 6).map((p) => <div key={p}>{p}</div>)}
          {problems.length > 6 && <div>…and {problems.length - 6} more</div>}
        </div>
      )}

      <div style={{ position: 'absolute', left: 8, bottom: 6, color: '#9ca3af', font: '11px ui-monospace, Menlo, monospace', background: 'rgb(10 10 10 / 0.85)', padding: '4px 8px', borderRadius: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>0</span>
          <span style={{ display: 'inline-block', width: 140, height: 8, background: `linear-gradient(to right, ${[0, 0.3, 0.6, 0.85, 1].map(shade).join(', ')})` }} />
          <span>limit</span>
          <span style={{ marginLeft: 10, borderTop: '2px dashed #6b7280', width: 24, display: 'inline-block' }} />
          <span>no transducer</span>
        </div>
        {overlay.legend.map((l) => (
          <div key={l.section}>
            {l.section}: {l.source}
          </div>
        ))}
        <div>other sections: their transducers' full scale</div>
        {overlay.health.unplaced.length > 0 && (
          <div title={overlay.health.unplaced.join(', ')}>
            {overlay.health.unplaced.length} DAQ channel(s) not on the drawing
          </div>
        )}
      </div>

      <div style={{ position: 'absolute', right: 8, bottom: 6, color: '#6b7280', font: '11px ui-monospace, Menlo, monospace' }}>
        {pid.drawing.diagram} · drawing {pid.drawing.sha256.slice(0, 8)} · exported {pid.drawing.exported_at.slice(0, 16).replace('T', ' ')} · psig
      </div>
    </div>
  );
}

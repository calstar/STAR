import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';

interface TankFillVisualizerProps {
  label: string;
  mass: number;
  maxMass: number;
  fluidColor: string;
  onChange: (kg: number) => void;
  /** Internal radius [m] from config — with heightM drives side-view proportions (diameter : height) */
  radiusM?: number | null;
  /** Internal cylindrical height [m] from config */
  heightM?: number | null;
  /** When set (e.g. side-by-side row), fixed pixel size so tanks scale relative to each other */
  pixelSize?: { width: number; height: number } | null;
  /** Tank internal volume [m³] from config — liquid L ↔ kg uses this vs max fill */
  tankVolumeM3?: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

let _idCounter = 0;

const LEGACY_VIEW_W = 80;
const LEGACY_VIEW_H = 200;
const LEGACY_TANK_PATH = [
  'M 40 0',
  'A 37 25 0 0 1 77 25',
  'L 77 175',
  'A 37 25 0 0 1 3 175',
  'L 3 25',
  'A 37 25 0 0 1 40 0',
  'Z',
].join(' ');

export const TankFillVisualizer: React.FC<TankFillVisualizerProps> = ({
  label,
  mass,
  maxMass,
  fluidColor,
  onChange,
  radiusM,
  heightM,
  pixelSize,
  tankVolumeM3,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  const [kgStr, setKgStr] = useState(() => mass.toFixed(2));
  const [lStr, setLStr] = useState(() => {
    const vf =
      typeof tankVolumeM3 === 'number' && Number.isFinite(tankVolumeM3) && tankVolumeM3 > 0
        ? tankVolumeM3 * 1000
        : null;
    return vf !== null && maxMass > 0 ? ((mass / maxMass) * vf).toFixed(2) : '';
  });
  const [focusedField, setFocusedField] = useState<'kg' | 'l' | null>(null);
  const [clipId] = useState(() => `tankClip-${++_idCounter}`);

  const volFullL =
    typeof tankVolumeM3 === 'number' && Number.isFinite(tankVolumeM3) && tankVolumeM3 > 0
      ? tankVolumeM3 * 1000
      : null;

  const hasGeom =
    typeof radiusM === 'number' &&
    typeof heightM === 'number' &&
    radiusM > 0 &&
    heightM > 0;

  const geom = useMemo(() => {
    if (!hasGeom) {
      return {
        mode: 'legacy' as const,
        vbW: LEGACY_VIEW_W,
        vbH: LEGACY_VIEW_H,
        pxW: 80,
        pxH: 200,
        stroke: 1.5,
        handleR: 6,
      };
    }
    const diameterM = 2 * radiusM!;
    const vbW = 100;
    const vbH = (100 * heightM!) / diameterM;
    const dOverH = diameterM / heightM!;

    const MAX_PX_H = 200;
    const MAX_PX_W = 140;
    let pxW: number;
    let pxH: number;
    if (
      pixelSize &&
      pixelSize.width > 0 &&
      pixelSize.height > 0 &&
      Number.isFinite(pixelSize.width) &&
      Number.isFinite(pixelSize.height)
    ) {
      pxW = pixelSize.width;
      pxH = pixelSize.height;
    } else {
      pxW = MAX_PX_H * dOverH;
      pxH = MAX_PX_H;
      if (pxW > MAX_PX_W) {
        pxW = MAX_PX_W;
        pxH = MAX_PX_W / dOverH;
      }
    }

    const stroke = clamp(Math.max(vbW, vbH) * 0.006, 0.35, 2.5);
    const handleR = clamp(Math.min(vbW, vbH) * 0.035, 2.5, 8);
    const domeRx = Math.min(vbW / 2, vbH / 2);

    return {
      mode: 'proportional' as const,
      vbW,
      vbH,
      pxW,
      pxH,
      stroke,
      handleR,
      domeRx,
    };
  }, [hasGeom, radiusM, heightM, pixelSize]);

  useEffect(() => {
    if (focusedField === 'kg') return;
    setKgStr(mass.toFixed(2));
  }, [mass, focusedField]);

  useEffect(() => {
    if (focusedField === 'l') return;
    if (volFullL !== null && maxMass > 0) {
      setLStr(((mass / maxMass) * volFullL).toFixed(2));
    } else {
      setLStr('');
    }
  }, [mass, focusedField, volFullL, maxMass]);

  const fillFraction = maxMass > 0 ? clamp(mass / maxMass, 0, 1) : 0;
  const fillPct = (fillFraction * 100).toFixed(1);
  const ullagePct = ((1 - fillFraction) * 100).toFixed(1);
  const ullageLiters =
    volFullL !== null ? volFullL * (1 - fillFraction) : null;

  const fillY = geom.vbH * (1 - fillFraction);
  const fillHeight = geom.vbH * fillFraction;
  const margin = geom.mode === 'proportional' ? Math.min(geom.vbW, geom.vbH) * 0.02 : 4;
  const handleY = clamp(fillY, margin, geom.vbH - margin);

  const commitMass = useCallback(
    (m: number) => {
      const mClamped = maxMass > 0 ? clamp(m, 0, maxMass) : clamp(m, 0, Infinity);
      onChange(mClamped);
    },
    [maxMass, onChange]
  );

  const updateFromClientY = useCallback(
    (clientY: number) => {
      if (!svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const y = clientY - rect.top;
      const fraction = clamp(1 - y / rect.height, 0, 1);
      const newMass = maxMass > 0 ? fraction * maxMass : fraction * 100;
      onChange(newMass);
    },
    [maxMass, onChange]
  );

  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      setDragging(true);
      updateFromClientY(e.clientY);
      e.preventDefault();
    },
    [updateFromClientY]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging) return;
      updateFromClientY(e.clientY);
    },
    [dragging, updateFromClientY]
  );

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, handleMouseMove, handleMouseUp]);

  const handleKgChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const s = e.target.value;
    setKgStr(s);
    const val = parseFloat(s);
    if (!isNaN(val) && val >= 0) {
      commitMass(val);
    }
  };

  const handleLChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (volFullL === null || maxMass <= 0) return;
    const s = e.target.value;
    setLStr(s);
    const val = parseFloat(s);
    if (!isNaN(val) && val >= 0) {
      const v = clamp(val, 0, volFullL);
      const m = (v / volFullL) * maxMass;
      commitMass(m);
    }
  };

  const colWidth = Math.max(188, Math.ceil(geom.pxW));

  return (
    <div className="flex flex-col items-center gap-2 shrink-0" style={{ width: colWidth }}>
      <span className="text-xs font-semibold text-gray-300 text-center leading-tight">
        {label}
      </span>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${geom.vbW} ${geom.vbH}`}
        width={geom.pxW}
        height={geom.pxH}
        style={{ cursor: 'ns-resize', display: 'block', userSelect: 'none' }}
        onMouseDown={handleSvgMouseDown}
      >
        {geom.mode === 'proportional' ? (
          <>
            <defs>
              <clipPath id={clipId}>
                <rect x={0} y={0} width={geom.vbW} height={geom.vbH} rx={geom.domeRx} ry={geom.domeRx} />
              </clipPath>
            </defs>
            <rect
              x={0}
              y={0}
              width={geom.vbW}
              height={geom.vbH}
              rx={geom.domeRx}
              ry={geom.domeRx}
              fill="#1f2937"
            />
            {fillFraction < 1 && (
              <rect
                x={0}
                y={0}
                width={geom.vbW}
                height={fillY}
                fill="#374151"
                opacity={0.6}
                clipPath={`url(#${clipId})`}
              />
            )}
            {fillFraction > 0 && (
              <rect
                x={0}
                y={fillY}
                width={geom.vbW}
                height={fillHeight}
                fill={fluidColor}
                opacity={0.75}
                clipPath={`url(#${clipId})`}
              />
            )}
            <rect
              x={0}
              y={0}
              width={geom.vbW}
              height={geom.vbH}
              rx={geom.domeRx}
              ry={geom.domeRx}
              fill="none"
              stroke="#6b7280"
              strokeWidth={geom.stroke}
            />
            {fillFraction > 0 && fillFraction < 1 && (
              <line
                x1={geom.vbW * 0.06}
                y1={fillY}
                x2={geom.vbW * 0.94}
                y2={fillY}
                stroke="white"
                strokeWidth={geom.stroke}
                opacity={0.7}
                clipPath={`url(#${clipId})`}
              />
            )}
            {fillFraction > 0 && fillFraction < 1 && (
              <circle
                cx={geom.vbW / 2}
                cy={handleY}
                r={geom.handleR}
                fill="white"
                opacity={0.9}
                stroke="#374151"
                strokeWidth={geom.stroke * 0.8}
                style={{ cursor: 'ns-resize' }}
              />
            )}
          </>
        ) : (
          <>
            <defs>
              <clipPath id={clipId}>
                <path d={LEGACY_TANK_PATH} />
              </clipPath>
            </defs>
            <path d={LEGACY_TANK_PATH} fill="#1f2937" stroke="none" />
            {fillFraction < 1 && (
              <rect
                x={0}
                y={0}
                width={LEGACY_VIEW_W}
                height={fillY}
                fill="#374151"
                opacity={0.6}
                clipPath={`url(#${clipId})`}
              />
            )}
            {fillFraction > 0 && (
              <rect
                x={0}
                y={fillY}
                width={LEGACY_VIEW_W}
                height={fillHeight}
                fill={fluidColor}
                opacity={0.75}
                clipPath={`url(#${clipId})`}
              />
            )}
            <path d={LEGACY_TANK_PATH} fill="none" stroke="#6b7280" strokeWidth={1.5} />
            {fillFraction > 0 && fillFraction < 1 && (
              <line
                x1={4}
                y1={fillY}
                x2={76}
                y2={fillY}
                stroke="white"
                strokeWidth={1.5}
                opacity={0.7}
                clipPath={`url(#${clipId})`}
              />
            )}
            {fillFraction > 0 && fillFraction < 1 && (
              <circle
                cx={40}
                cy={handleY}
                r={6}
                fill="white"
                opacity={0.9}
                stroke="#374151"
                strokeWidth={1.5}
                style={{ cursor: 'ns-resize' }}
              />
            )}
          </>
        )}
      </svg>

      <div className="w-full flex items-center justify-center gap-1.5 text-sm">
        <div className="relative flex-1 min-w-0">
          <input
            type="number"
            min={0}
            max={maxMass > 0 ? maxMass : undefined}
            step={0.01}
            value={kgStr}
            onChange={handleKgChange}
            onFocus={() => setFocusedField('kg')}
            onBlur={() => {
              setFocusedField(null);
              setKgStr(mass.toFixed(2));
            }}
            aria-label={`${label} liquid mass kilograms`}
            className="w-full text-center bg-gray-700 border border-gray-600 rounded px-1 py-0.5 pr-6 text-white focus:outline-none focus:border-blue-400 tabular-nums"
          />
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">
            kg
          </span>
        </div>
        <span className="text-gray-500 shrink-0 select-none" aria-hidden>
          |
        </span>
        <div className="relative flex-1 min-w-0">
          <input
            type="number"
            min={0}
            max={volFullL ?? undefined}
            step={0.01}
            value={lStr}
            onChange={handleLChange}
            onFocus={() => setFocusedField('l')}
            onBlur={() => {
              setFocusedField(null);
              if (volFullL !== null && maxMass > 0) {
                setLStr(((mass / maxMass) * volFullL).toFixed(2));
              }
            }}
            disabled={volFullL === null || maxMass <= 0}
            aria-label={`${label} liquid volume liters`}
            className="w-full text-center bg-gray-700 border border-gray-600 rounded px-1 py-0.5 pr-5 text-white focus:outline-none focus:border-blue-400 tabular-nums disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">
            L
          </span>
        </div>
      </div>

      <div className="text-xs text-gray-400 text-center leading-relaxed w-full">
        <div className="whitespace-nowrap">
          Fill:{' '}
          <span className="font-semibold tabular-nums" style={{ color: fluidColor }}>
            {fillPct}%
          </span>
        </div>
        <div className="mt-1">
          <div className="text-gray-500">Ullage:</div>
          <div className="font-semibold tabular-nums text-gray-300">
            {ullagePct}% / {ullageLiters !== null ? `${ullageLiters.toFixed(2)} L` : '—'}
          </div>
        </div>
        {maxMass > 0 && (
          <div
            className="text-[10px] text-gray-500 whitespace-nowrap pt-1 mt-1 border-t border-gray-600/50"
            title="Fill % is mass ÷ this value (tank volume × fluid density from config)."
          >
            100% = {maxMass.toFixed(2)} kg
          </div>
        )}
      </div>
    </div>
  );
};

'use client'

/**
 * The ASI's two feed lines and torch as one diagram (P&ID ASI V1 topology):
 *
 *   PR ── PT up ── RV ── run valve ── PT down ── RV ── QD ──┐
 *                                                          ASI ── throat
 *   PR ── PT up ── RV ── run valve ── PT down ── RV ── QD ──┘   TC-1
 *
 * Values come in as props, so the Test tab draws the stand and the Twin tab draws
 * a simulated instant with the same picture.
 */

import { reliefMargin } from '@/lib/asi/checks';
import type { AsiModel, LineId } from '@/lib/asi/settings';
import { ASI_COLORS, fmt } from './AsiParts';

export interface LineView {
  upPsig: number | null;
  dnPsig: number | null;
  /** 0 shut .. 1 open; null unknown. */
  valve: number | null;
  /** Vent solenoids [before run valve, after]: 0 shut .. 1 open; null unknown. */
  vents?: [number | null, number | null];
}

export interface AsiSchematicProps {
  model: AsiModel;
  gox: LineView;
  ch4: LineView;
  pcPsia?: number | null;
  of?: number | null;
  lit?: boolean | null;
  tcC?: number | null;
  /** Shown in the ASI box's corner: "LIVE", "SIM t=0.32 s". */
  caption?: string;
}

const STATUS_COLOR = { ok: '#4ade80', warn: '#e5b53a', over: '#f87171', none: '#4d4d4d' } as const;

function Line({ id, y, model, view, toAsiY }: { id: LineId; y: number; model: AsiModel; view: LineView; toAsiY: number }) {
  const l = model[id];
  const color = id === 'gox' ? ASI_COLORS.gox : ASI_COLORS.ch4;
  const name = id === 'gox' ? 'GOx' : 'CH4';
  const valveColor = view.valve === null ? '#4d4d4d' : view.valve > 0.5 ? '#22c55e' : '#ef4444';
  const reliefs = l.reliefs.map((r, i) => {
    const sameSideBefore = l.reliefs.slice(0, i).filter((q) => q.location === r.location).length;
    const x = (r.location === 'upstream' ? 250 : 520) + sameSideBefore * 46;
    const p = r.location === 'upstream' ? view.upPsig : view.dnPsig;
    return { r, x, m: reliefMargin(p, r.setPsig) };
  });
  const flip = id === 'ch4' ? 1 : -1; // reliefs branch away from the other line
  return (
    <g>
      <text x={14} y={y - 22} className="fill-current" style={{ fill: color }} fontSize={12} fontWeight={700} fontFamily="var(--font-mono)">{name}</text>
      {/* Main run */}
      <path d={`M 70 ${y} H 640 V ${toAsiY} H 700`} stroke={color} strokeWidth={2} fill="none" />
      {/* Regulator */}
      <rect x={30} y={y - 14} width={40} height={28} fill="#0b0b0b" stroke={color} />
      <text x={50} y={y + 4} textAnchor="middle" fontSize={9} fill="#bdbdbd" fontFamily="var(--font-mono)">{l.tags.regulator}</text>
      <text x={50} y={y + 28} textAnchor="middle" fontSize={9} fill="#7a7a7a" fontFamily="var(--font-mono)">{l.supplyPsig} psig</text>
      {/* PT up */}
      <Pt x={160} y={y} tag={l.tags.upstreamPt} value={view.upPsig} color={color} />
      {/* Run valve (bowtie) */}
      <path d={`M 360 ${y - 11} L 382 ${y} L 360 ${y + 11} Z M 404 ${y - 11} L 382 ${y} L 404 ${y + 11} Z`} fill={valveColor} stroke="#ededed" strokeWidth={0.8} />
      <text x={382} y={y - 17} textAnchor="middle" fontSize={9} fill="#bdbdbd" fontFamily="var(--font-mono)">{l.tags.valve} · #{l.valveConnector}</text>
      <text x={382} y={y + 26} textAnchor="middle" fontSize={9} fill={valveColor} fontFamily="var(--font-mono)">
        {view.valve === null ? '—' : view.valve >= 0.999 ? 'OPEN' : view.valve <= 0.001 ? 'SHUT' : `${Math.round(view.valve * 100)} %`}
      </text>
      {/* PT down */}
      <Pt x={460} y={y} tag={l.tags.downstreamPt} value={view.dnPsig} color={color} />
      {/* Reliefs */}
      {reliefs.map(({ r, x, m }) => (
        <g key={r.name}>
          <path d={`M ${x} ${y} V ${y + flip * 26}`} stroke={color} strokeWidth={1.5} />
          <path d={`M ${x - 8} ${y + flip * 26} L ${x + 8} ${y + flip * 26} L ${x} ${y + flip * 40} Z`} fill={STATUS_COLOR[m.status]} />
          <text x={x} y={y + flip * 52 + (flip > 0 ? 4 : 0)} textAnchor="middle" fontSize={9} fill="#bdbdbd" fontFamily="var(--font-mono)">{r.name}</text>
          <text x={x} y={y + flip * 63 + (flip > 0 ? 4 : 0)} textAnchor="middle" fontSize={8.5} fill={STATUS_COLOR[m.status]} fontFamily="var(--font-mono)">
            {r.setPsig}{m.status !== 'none' ? ` · ${Math.round(m.frac * 100)}%` : ''}
          </text>
        </g>
      ))}
      {/* Vent solenoids, on the opposite side from the reliefs */}
      {l.vents.map((v, i) => {
        const x = v.location === 'upstream' ? 305 : 565;
        const pos = view.vents?.[i] ?? null;
        const c = pos === null ? '#4d4d4d' : pos > 0.5 ? '#22c55e' : '#7a7a7a';
        const yy = y - flip * 30;
        return (
          <g key={v.name}>
            <path d={`M ${x} ${y} V ${yy}`} stroke={color} strokeWidth={1.5} />
            <path d={`M ${x - 9} ${yy - 7} L ${x} ${yy} L ${x - 9} ${yy + 7} Z M ${x + 9} ${yy - 7} L ${x} ${yy} L ${x + 9} ${yy + 7} Z`} fill={c} stroke="#ededed" strokeWidth={0.6} />
            <path d={`M ${x + 9} ${yy} H ${x + 22}`} stroke="#4d4d4d" strokeDasharray="2 2" />
            <text x={x} y={yy - flip * 14 + (flip < 0 ? 4 : 0)} textAnchor="middle" fontSize={8.5} fill="#bdbdbd" fontFamily="var(--font-mono)">
              {v.name} · #{v.connector}
            </text>
            <text x={x} y={yy - flip * 25 + (flip < 0 ? 4 : 0)} textAnchor="middle" fontSize={8.5} fill={c} fontFamily="var(--font-mono)">
              {pos === null ? 'vent —' : pos > 0.5 ? 'VENTING' : 'vent shut'}
            </text>
          </g>
        );
      })}
      {/* QD */}
      <rect x={604} y={y - 8} width={20} height={16} fill="#0b0b0b" stroke="#7a7a7a" />
      <text x={614} y={y - 13} textAnchor="middle" fontSize={8.5} fill="#7a7a7a" fontFamily="var(--font-mono)">{l.tags.qd}</text>
    </g>
  );
}

function Pt({ x, y, tag, value, color }: { x: number; y: number; tag: string; value: number | null; color: string }) {
  return (
    <g>
      <path d={`M ${x} ${y} V ${y - 22}`} stroke={color} strokeWidth={1.5} />
      <circle cx={x} cy={y - 34} r={12} fill="#0b0b0b" stroke={color} />
      <text x={x} y={y - 31} textAnchor="middle" fontSize={8} fill="#bdbdbd" fontFamily="var(--font-mono)">PT</text>
      <text x={x + 18} y={y - 40} fontSize={9} fill="#7a7a7a" fontFamily="var(--font-mono)">{tag}</text>
      <text x={x + 18} y={y - 27} fontSize={12} fontWeight={700} fill="#ededed" fontFamily="var(--font-mono)">
        {fmt(value, 0)}<tspan fontSize={8.5} fill="#7a7a7a"> psig</tspan>
      </text>
    </g>
  );
}

export default function AsiSchematic({ model, gox, ch4, pcPsia, of, lit, tcC, caption }: AsiSchematicProps) {
  const yG = 70;
  const yC = 250;
  return (
    <svg viewBox="0 0 900 330" className="h-auto w-full" role="img" aria-label="ASI feed lines and torch">
      <Line id="gox" y={yG} model={model} view={gox} toAsiY={135} />
      <Line id="ch4" y={yC} model={model} view={ch4} toAsiY={185} />
      {/* ASI body */}
      <rect x={700} y={110} width={130} height={100} fill={lit ? '#2a1405' : '#0b0b0b'} stroke={lit ? ASI_COLORS.pc : '#7a7a7a'} strokeWidth={lit ? 2 : 1} />
      <text x={765} y={128} textAnchor="middle" fontSize={11} fontWeight={700} fill="#ededed" fontFamily="var(--font-mono)">ASI-1</text>
      <text x={765} y={150} textAnchor="middle" fontSize={13} fontWeight={700} fill={ASI_COLORS.pc} fontFamily="var(--font-mono)">
        {pcPsia == null ? 'Pc —' : `${fmt(pcPsia, 0)} psia`}
      </text>
      <text x={765} y={167} textAnchor="middle" fontSize={10} fill="#bdbdbd" fontFamily="var(--font-mono)">
        {of == null || !Number.isFinite(of) ? 'O/F —' : `O/F ${fmt(of, 2)}`}
      </text>
      <text x={765} y={184} textAnchor="middle" fontSize={10} fontWeight={700} fill={lit ? ASI_COLORS.pc : '#4d4d4d'} fontFamily="var(--font-mono)">
        {lit == null ? '' : lit ? 'LIT' : 'NOT LIT'}
      </text>
      {caption && <text x={826} y={205} textAnchor="end" fontSize={8.5} fill="#7a7a7a" fontFamily="var(--font-mono)">{caption}</text>}
      {/* Throat / exit */}
      <path d="M 830 150 L 850 156 L 850 164 L 830 170" fill="none" stroke="#7a7a7a" />
      <path d="M 852 160 H 890" stroke={lit ? ASI_COLORS.pc : '#4d4d4d'} strokeWidth={lit ? 3 : 1} strokeDasharray={lit ? undefined : '3 3'} />
      <text x={870} y={150} textAnchor="middle" fontSize={8.5} fill="#7a7a7a" fontFamily="var(--font-mono)">Ø{model.throatDia_mm}</text>
      {/* TC-1 in the body */}
      <path d="M 765 210 V 232" stroke={ASI_COLORS.tc} strokeWidth={1.5} />
      <circle cx={765} cy={244} r={12} fill="#0b0b0b" stroke={ASI_COLORS.tc} />
      <text x={765} y={247} textAnchor="middle" fontSize={8} fill="#bdbdbd" fontFamily="var(--font-mono)">TC</text>
      <text x={783} y={241} fontSize={9} fill="#7a7a7a" fontFamily="var(--font-mono)">TC-1 (body, 1 mm from bore)</text>
      <text x={783} y={256} fontSize={12} fontWeight={700} fill="#ededed" fontFamily="var(--font-mono)">
        {fmt(tcC, 0)}<tspan fontSize={8.5} fill="#7a7a7a"> °C</tspan>
      </text>
    </svg>
  );
}

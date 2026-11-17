'use client'

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ReferenceArea } from 'recharts';
import { MODEL_NOTES, cvToCdA_mm2, holeCdA_mm2, useAsiSettings, type AsiModel, type LineConfig, type LineId, type ReliefConfig, type VentConfig } from '@/lib/asi/settings';
import { NumField, Panel, fmt } from './AsiParts';

function LineEditor({ id, line, onChange }: { id: LineId; line: LineConfig; onChange: (l: LineConfig) => void }) {
  const set = <K extends keyof LineConfig>(k: K, v: LineConfig[K]) => onChange({ ...line, [k]: v });
  const setVent = (i: 0 | 1, v: VentConfig) => {
    const vents = [...line.vents] as [VentConfig, VentConfig];
    vents[i] = v;
    onChange({ ...line, vents });
  };
  const setRelief = (i: 0 | 1, r: ReliefConfig) => {
    const reliefs = [...line.reliefs] as [ReliefConfig, ReliefConfig];
    reliefs[i] = r;
    onChange({ ...line, reliefs });
  };
  return (
    <Panel title={id === 'gox' ? 'GOx line' : 'CH4 line'}>
      <div className="grid grid-cols-1 gap-x-6 xl:grid-cols-2">
        <div>
          <NumField label={`Regulator ${line.tags.regulator}`} unit="psig" value={line.supplyPsig} onChange={(v) => set('supplyPsig', v)} note={MODEL_NOTES.supplyPsig} />
          <NumField label="Supply CdA" unit="mm²" value={line.supplyCdA_mm2} onChange={(v) => set('supplyCdA_mm2', v)} note={MODEL_NOTES.supplyCdA_mm2} />
          <NumField label="Upstream volume" unit="cm³" value={line.upstreamVolume_cc} onChange={(v) => set('upstreamVolume_cc', v)} note={MODEL_NOTES.upstreamVolume_cc} />
          <NumField label="Run valve CdA (pneumatic)" unit="mm²" value={line.valveCdA_mm2} onChange={(v) => set('valveCdA_mm2', v)} note={`${MODEL_NOTES.valveCdA_mm2} (Cv 0.4 = ${cvToCdA_mm2(0.4).toFixed(1)} mm²)`} />
          <NumField label="Run valve open (pneumatic)" unit="ms" value={line.valveOpenMs} onChange={(v) => set('valveOpenMs', v)} note={MODEL_NOTES.valveOpenMs} />
          <NumField label="Run valve close (pneumatic)" unit="ms" value={line.valveCloseMs} onChange={(v) => set('valveCloseMs', v)} note={MODEL_NOTES.valveCloseMs} />
          <NumField label="Downstream volume" unit="cm³" value={line.downstreamVolume_cc} onChange={(v) => set('downstreamVolume_cc', v)} note={MODEL_NOTES.downstreamVolume_cc} />
          <NumField label="Hole Ø" unit="mm" value={line.holeDia_mm} onChange={(v) => set('holeDia_mm', v)} note={MODEL_NOTES.holeDia_mm} />
          <NumField label="Hole Cd" value={line.holeCd} onChange={(v) => set('holeCd', v)} note={MODEL_NOTES.holeCd} />
          <div className="py-0.5 text-right font-mono text-[10px] text-ink-3">hole CdA {fmt(holeCdA_mm2(line), 3)} mm²</div>
          <NumField label="Gas temperature" unit="K" value={line.gasTempK} onChange={(v) => set('gasTempK', v)} note={MODEL_NOTES.gasTempK} />
        </div>
        <div className="mt-2 xl:mt-0">
          {line.reliefs.map((r, i) => (
            <div key={i} className="mb-2 border-l border-line pl-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <input
                  value={r.name}
                  onChange={(e) => setRelief(i as 0 | 1, { ...r, name: e.target.value })}
                  className="w-24 border border-line-strong bg-black px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none"
                />
                <select
                  value={r.location}
                  onChange={(e) => setRelief(i as 0 | 1, { ...r, location: e.target.value as ReliefConfig['location'] })}
                  className="border border-line-strong bg-black px-1 py-0.5 font-mono text-[11px] text-ink"
                >
                  <option value="upstream">upstream of valve</option>
                  <option value="downstream">downstream of valve</option>
                </select>
              </div>
              <NumField label="Set" unit="psig" value={r.setPsig} onChange={(v) => setRelief(i as 0 | 1, { ...r, setPsig: v })} note={MODEL_NOTES.setPsig} />
              <NumField label="Full-lift CdA" unit="mm²" value={r.fullCdA_mm2} onChange={(v) => setRelief(i as 0 | 1, { ...r, fullCdA_mm2: v })} note={MODEL_NOTES.fullCdA_mm2} />
              <NumField label="Accumulation" unit="%" value={r.accumulationPct} onChange={(v) => setRelief(i as 0 | 1, { ...r, accumulationPct: v })} note={MODEL_NOTES.accumulationPct} />
            </div>
          ))}
          {line.vents.map((v, i) => (
            <div key={`v${i}`} className="mb-2 border-l border-line pl-2">
              <div className="mb-1 font-mono text-[11px] text-ink-2" title={MODEL_NOTES.vents}>
                Vent {v.name} · PDB #{v.connector} · {v.location === 'upstream' ? 'before' : 'after'} run valve · NC <span className="text-ink-4">ⓘ</span>
              </div>
              <NumField label="Open CdA" unit="mm²" value={v.cdA_mm2} onChange={(x) => setVent(i as 0 | 1, { ...v, cdA_mm2: x })} note={MODEL_NOTES.ventCdA_mm2} />
              <NumField label="Open / close" unit="ms" value={v.openMs} onChange={(x) => setVent(i as 0 | 1, { ...v, openMs: x, closeMs: x })} note={MODEL_NOTES.ventMs} />
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export default function AsiModelEditor() {
  const { settings, setModel, resetModel } = useAsiSettings();
  const m = settings.model;
  const set = <K extends keyof AsiModel>(k: K, v: AsiModel[K]) => setModel({ ...m, [k]: v });
  const th = m.thermal;
  const setTh = <K extends keyof AsiModel['thermal']>(k: K, v: AsiModel['thermal'][K]) => setModel({ ...m, thermal: { ...th, [k]: v } });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl font-mono text-[11px] leading-relaxed text-ink-3">
          Defaults are the ASI V1 P&ID and the 2026-10-07 design point. Hover ⓘ for where each number came from;
          anything marked [assume] wants a measurement. Saved in this browser only.
        </p>
        <button type="button" className="ctl px-3 py-1 text-[11px]" onClick={resetModel}>Reset to design point</button>
      </div>
      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
        <LineEditor id="gox" line={m.gox} onChange={(l) => set('gox', l)} />
        <LineEditor id="ch4" line={m.ch4} onChange={(l) => set('ch4', l)} />
      </div>
      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
        <Panel title="Torch">
          <NumField label="Throat Ø" unit="mm" value={m.throatDia_mm} onChange={(v) => set('throatDia_mm', v)} note={MODEL_NOTES.throatDia_mm} />
          <NumField label="c* efficiency" value={m.cstarEff} onChange={(v) => set('cstarEff', v)} note={MODEL_NOTES.cstarEff} />
          <NumField label="Exit back pressure" unit="psia" value={m.backPressurePsia} onChange={(v) => set('backPressurePsia', v)} note={MODEL_NOTES.backPressurePsia} />
          <NumField label="O/F min (lights)" value={m.ofMin} onChange={(v) => set('ofMin', v)} note={MODEL_NOTES.ofMin} />
          <NumField label="O/F max" value={m.ofMax} onChange={(v) => set('ofMax', v)} note={MODEL_NOTES.ofMax} />
          <NumField label="Light gate Pc" unit="psia" value={m.gatePcPsia} onChange={(v) => set('gatePcPsia', v)} note={MODEL_NOTES.gatePcPsia} />
          <NumField label="Light gate within" unit="ms" value={m.gateMs} onChange={(v) => set('gateMs', v)} note={MODEL_NOTES.gateMs} />
          <NumField label="Burn cap" unit="s" value={m.burnCapS} onChange={(v) => set('burnCapS', v)} note={MODEL_NOTES.burnCapS} />
        </Panel>
        <Panel title="Copper & TC-1">
          <NumField label="Copper k" unit="W/m·K" value={th.wallK} onChange={(v) => setTh('wallK', v)} note={MODEL_NOTES.wallK} />
          <NumField label="Copper ρ·cp" unit="MJ/m³K" value={th.rhoCp_MJ} onChange={(v) => setTh('rhoCp_MJ', v)} note={MODEL_NOTES.rhoCp_MJ} />
          <NumField label="Reference ṁ" unit="g/s" value={th.mdotRef_gs} onChange={(v) => setTh('mdotRef_gs', v)} note={MODEL_NOTES.mdotRef_gs} />
          <NumField label="h at TC station" unit="W/m²K" value={th.hChamber} onChange={(v) => setTh('hChamber', v)} note={MODEL_NOTES.hChamber} />
          <NumField label="Body t_eff" unit="mm" value={th.bodyTEff_mm} onChange={(v) => setTh('bodyTEff_mm', v)} note={MODEL_NOTES.bodyTEff_mm} />
          <NumField label="TC depth" unit="mm" value={th.tcDepth_mm} onChange={(v) => setTh('tcDepth_mm', v)} note={MODEL_NOTES.tcDepth_mm} />
          <NumField label="TC probe lag" unit="s" value={th.tcTauS} onChange={(v) => setTh('tcTauS', v)} note={MODEL_NOTES.tcTauS} />
          <NumField label="h at throat" unit="W/m²K" value={th.hThroat} onChange={(v) => setTh('hThroat', v)} note={MODEL_NOTES.hThroat} />
          <NumField label="Neck t_eff" unit="mm" value={th.neckTEff_mm} onChange={(v) => setTh('neckTEff_mm', v)} note={MODEL_NOTES.neckTEff_mm} />
          <NumField label="Neck limit" unit="K" value={th.neckLimitK} onChange={(v) => setTh('neckLimitK', v)} note={MODEL_NOTES.neckLimitK} />
        </Panel>
      </div>
    </div>
  );
}

// ── Chart ────────────────────────────────────────────────────────────────────

export interface ChartSeries { key: string; name: string; color: string; dashed?: boolean; yAxis?: 'left' | 'right' }

export function AsiChart({ data, x, xLabel, series, yLabel, yRightLabel, refX, refBand, height = 220 }: {
  /** Rows keyed by `x` and each series key; other fields are ignored. */
  data: object[];
  x: string;
  xLabel?: string;
  series: ChartSeries[];
  yLabel?: string;
  yRightLabel?: string;
  refX?: { x: number; label: string; color?: string }[];
  refBand?: { x1: number; x2: number; label: string };
  height?: number;
}) {
  const hasRight = series.some((s) => s.yAxis === 'right');
  return (
    <div style={{ height }} className="w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: hasRight ? 4 : 12, left: 0, bottom: 2 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1c1c1c" />
          <XAxis dataKey={x} type="number" domain={['dataMin', 'dataMax']} stroke="#7a7a7a" fontSize={10}
            tickFormatter={(v: number) => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0))}
            label={xLabel ? { value: xLabel, position: 'insideBottomRight', offset: -2, fontSize: 10, fill: '#7a7a7a' } : undefined} />
          <YAxis yAxisId="left" stroke="#7a7a7a" fontSize={10} width={46}
            label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', fontSize: 10, fill: '#7a7a7a' } : undefined} />
          {hasRight && (
            <YAxis yAxisId="right" orientation="right" stroke="#7a7a7a" fontSize={10} width={46}
              label={yRightLabel ? { value: yRightLabel, angle: 90, position: 'insideRight', fontSize: 10, fill: '#7a7a7a' } : undefined} />
          )}
          <Tooltip
            contentStyle={{ backgroundColor: '#0b0b0b', border: '1px solid #333', fontSize: 11, fontFamily: 'var(--font-mono)' }}
            labelFormatter={(v) => `${xLabel ?? x} ${typeof v === 'number' ? v.toFixed(3) : v}`}
            formatter={(v) => (typeof v === 'number' ? v.toFixed(2) : String(v))}
          />
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} />
          {refBand && <ReferenceArea yAxisId="left" x1={refBand.x1} x2={refBand.x2} fill="#ffffff" fillOpacity={0.04} label={{ value: refBand.label, fontSize: 9, fill: '#7a7a7a', position: 'insideTop' }} />}
          {refX?.map((r) => (
            <ReferenceLine key={r.label} yAxisId="left" x={r.x} stroke={r.color ?? '#5a5a5a'} strokeDasharray="4 3"
              label={{ value: r.label, fontSize: 9, fill: r.color ?? '#7a7a7a', position: 'top' }} />
          ))}
          {series.map((s) => (
            <Line key={s.key} yAxisId={s.yAxis ?? 'left'} type="linear" dataKey={s.key} name={s.name} stroke={s.color}
              strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} strokeWidth={1.6} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

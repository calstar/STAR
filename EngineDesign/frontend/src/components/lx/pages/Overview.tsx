import { useMemo, useState, type ReactNode } from 'react';
import type { LayerXResult } from '../../../api/layerx';
import { fmt } from '../../layerx/format';
import { MiniSpark } from '../charts/MiniSpark';
import { Hero } from '../hero/Hero';
import { useTimeStore } from '../time/hooks';
import { formatT } from '../time/markers';
import { ledgerOf, limitKindOf, resolveRef, trippedOf, type LedgerEntry } from '../contract';
import { Badge, Button, Figure, MarginBar, NotComputed, Panel, STATUS_WORD, marginScale } from '../ui';
import { useUnits, type Quantity, type Units } from '../units';
import { displaySpec, figureDelta, verdictLine, type GradedLimit, type RunData } from '../useRunData';
import type { LayerXJob } from '../useLayerXJob';
import { Hint, InfoRow, StatusRow, type Theme } from './kit';
import { spanText } from './side';

/**
 * Overview asks "Will it work?": the verdict and the figures that matter, every graded limit as a
 * margin bar (worst first; a click puts the cursor on its worst moment), what the design assumed
 * against what the feed delivered, and the hardware at the cursor.
 */

export interface PageProps {
  data: RunData;
  /** The compared run's data, when one is picked. */
  vs: RunData | null;
  vsLabel: string | null;
  job: LayerXJob;
  theme: Theme;
}

function useBars(limits: readonly GradedLimit[], u: Units) {
  return useMemo(() => limits.map((l) => {
    const s = u.scale(l.kind);
    const spec = displaySpec(l.spec, s.to);
    const value = l.value === null ? null : s.to(l.value);
    const text = l.text(u);
    return { l, text, scale: marginScale(spec, value, { trackPx: 260 }) };
  }), [limits, u]);
}

function Verdict({ data, vs, vsLabel }: Pick<PageProps, 'data' | 'vs' | 'vsLabel'>) {
  const u = useUnits();
  const f = data.figures;
  const r = vs?.figures ?? null;
  const verdict = verdictLine(data.limits, data.checks);
  const tripped = trippedOf(data.result);
  // A trip stops the burn where it is: that is the verdict, whatever the margins say.
  const line = tripped ? { status: 'bad' as const, title: 'The stand tripped' } : verdict;
  const which = tripped
    ? [`${tripped.label || tripped.vessel} at ${u.fmt(u.p(tripped.p_psia))}, over the ${u.fmt(u.p(tripped.mawp_psia))} it trips at, at ${formatT(tripped.t)}; the burn stopped there`]
    : [...data.limits.filter((l) => !l.info), ...data.checks]
      .filter((x) => x.status !== 'ok' && x.status === line.status)
      .map((x) => `${x.label} ${x.text ? x.text(u).value : (x as { value: string }).value}`);
  const q = {
    thrust: u.f(f.meanThrustN), burn: u.time(f.burnTime), impulse: u.impulse(f.impulseNs),
    apogee: u.alt(f.apogeeM), of: u.of(f.ofMean), bottle: u.p(f.bottleEndPsia, 'gauge'),
  };
  const rq = r ? {
    thrust: u.f(r.meanThrustN), burn: u.time(r.burnTime), impulse: u.impulse(r.impulseNs),
    apogee: u.alt(r.apogeeM), of: u.of(r.ofMean), bottle: u.p(r.bottleEndPsia, 'gauge'),
  } : null;
  const flown = f.apogeeM !== null;
  return (
    <Panel ariaLabel="Verdict" className="lg:col-span-12">
      <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1" role={line.status === 'bad' ? 'alert' : 'status'}>
        <Badge status={line.status} size="lg">{line.title}</Badge>
        {which.length > 0 && <span className="lx-num min-w-0 truncate text-[12px] text-[var(--lx-text-2)]" title={which.join(' · ')}>{which.join(' · ')}</span>}
        {vsLabel && (
          <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--lx-text-3)]">
            <span aria-hidden className="inline-block h-px w-4 bg-[var(--lx-ghost)]" />vs {vsLabel}
          </span>
        )}
      </div>
      <div className="grid gap-x-8 gap-y-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(10.5rem, 1fr))' }}>
        <Figure label="Mean thrust" termKey="thrust" size="lg" q={q.thrust} delta={figureDelta(q.thrust, rq?.thrust ?? null, 'pct')}
                sub={spanText(u, u.f(f.minThrustN), u.f(f.peakThrustN))} />
        <Figure label="Burn time" termKey="burnTime" size="lg" q={q.burn} delta={figureDelta(q.burn, rq?.burn ?? null)} sub={f.dryWords} />
        <Figure label="Total impulse" termKey="totalImpulse" size="lg" q={q.impulse} delta={figureDelta(q.impulse, rq?.impulse ?? null, 'pct')}
                sub={`${u.fmt(u.m(f.burnedKg))} burned`} />
        {flown
          ? <Figure label="Apogee" termKey="apogee" size="lg" q={q.apogee} delta={figureDelta(q.apogee, rq?.apogee ?? null, 'pct')} sub="AGL, flown" />
          : <Figure label="O/F" termKey="of" size="lg" q={q.of} delta={figureDelta(q.of, rq?.of ?? null)} sub={`${u.fmt(u.of(f.ofMin))} – ${u.fmt(u.of(f.ofMax))}`} />}
        <Figure label="Bottle at burnout" termKey="bottleFill" size="lg" q={q.bottle} delta={figureDelta(q.bottle, rq?.bottle ?? null)}
                sub={f.bottleMarginPsi !== null ? `${u.fmt(u.gap(f.bottleMarginPsi))} over lockup` : undefined} />
      </div>
    </Panel>
  );
}

/** Bars shown before "Show all": every limit that is not ok, and the closest of the rest. */
const FIRST = 8;

function Limits({ data }: { data: RunData }) {
  const u = useUnits();
  const store = useTimeStore();
  const graded = useMemo(() => data.limits.filter((l) => !l.info), [data.limits]);
  const info = useMemo(() => data.limits.filter((l) => l.info), [data.limits]);
  const bars = useBars(graded, u);
  const [all, setAll] = useState(false);
  const firstN = Math.max(FIRST, bars.filter((b) => b.l.status !== 'ok').length);
  const shown = all ? bars : bars.slice(0, firstN);
  const okChecks = data.checks.filter((c) => c.status === 'ok').length;
  const hidden = bars.length - shown.length + (all ? 0 : info.length + okChecks);
  return (
    <Panel title="Limits" right={<span>worst first · click to jump</span>} className="lg:col-span-7">
      <div className="-mx-2 space-y-0.5">
        {shown.map(({ l, text, scale }) => (
          <MarginBar key={l.key} label={l.label} value={text.value} status={l.status} scale={scale} limitText={text.limit}
                     termKey={l.termKey} hint={l.hint}
                     worstText={l.worstT !== null ? `${l.worstWord === 'at' || l.worstWord === 'worst' ? '' : `${l.worstWord} `}at ${formatT(l.worstT)}` : undefined}
                     onJump={l.worstT !== null ? () => store.focus(l.worstT as number, l.focusKey) : undefined} />
        ))}
        {data.checks.filter((c) => all || c.status !== 'ok').map((c) => {
          const t = c.text ? c.text(u) : { value: c.value, limit: c.limit };
          return <StatusRow key={c.key} status={c.status} label={c.label} value={t.value} limit={t.limit} hint={c.hint} />;
        })}
        {all && info.map((l) => <InfoRow key={l.key} label={l.label} value={l.text(u).value} hint={l.hint}
                                         note={l.worstT !== null ? `at ${formatT(l.worstT)}` : undefined} />)}
      </div>
      {(hidden > 0 || all) && (
        <div className="mt-2 flex">
          <Button variant="bare" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? 'Show the closest only' : `Show all ${bars.length + info.length + data.checks.length}`}
          </Button>
        </div>
      )}
      <span className="sr-only">{bars.filter((b) => b.l.status !== 'ok').length} of {bars.length} limits {STATUS_WORD.warn.toLowerCase()} or worse</span>
    </Panel>
  );
}

// ------------------------------------------------------------------ design assumed -> feed delivers

interface LedgerRow {
  key: string;
  label: ReactNode;
  design: string;
  delivered: string;
  spark?: { t: readonly number[]; values: readonly (number | null)[]; color: string; band?: { lo: number; hi: number } | null };
}

const range = (vs: readonly (number | null | undefined)[]): [number, number] | null => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vs) if (v !== null && v !== undefined && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return Number.isFinite(lo) ? [lo, hi] : null;
};

function rangeText(u: Units, r: [number, number] | null, q: (x: number) => Quantity): string {
  if (!r) return '—';
  const a = q(r[0]);
  const b = q(r[1]);
  return u.fmt(a) === u.fmt(b) ? u.fmt(a) : `${u.fmt({ ...a, unit: '' })} – ${u.fmt(b)}`;
}

/** The ledger's units as printed: the backend writes them in ASCII. */
const UNIT_TEXT: Record<string, string> = { 'mm^2': 'mm²', 'm^2': 'm²', 'kg/m^3': 'kg/m³', 'N s': 'N·s' };

/** Decimals for a plain number with its own unit: about three significant figures. */
const plainDigits = (x: number) => { const a = Math.abs(x); return a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3; };

/** A backend ledger row in the page's units: the unit says what quantity it is. */
function serverRow(res: LayerXResult, e: LedgerEntry, u: Units): LedgerRow {
  const raw = (e.unit ?? '').trim();
  const asciiUnit = raw in UNIT_TEXT;
  // ηc* and the nozzle efficiency read as percentages, as on the Engine page.
  const kindKey = /eta|efficiency/.test(e.key) ? `${e.key}_frac` : e.key;
  const { kind, toModel, suffix } = limitKindOf({ key: kindKey, unit: asciiUnit ? 'x' : raw === '-' ? '' : raw });
  const s = u.scale(kind);
  const unitText = asciiUnit ? UNIT_TEXT[raw] : suffix;
  const plain = asciiUnit || !!suffix;
  const f = (x: number | null | undefined, unit = true): string => {
    if (x === null || x === undefined || !Number.isFinite(x)) return '—';
    if (plain) return `${fmt(x, plainDigits(x))}${unit && unitText ? `\u00a0${unitText}` : ''}`;
    return u.fmt({ value: s.to(toModel(x)), unit: unit ? s.unit : '', digits: s.digits });
  };
  const lo = e.delivered?.min;
  const hi = e.delivered?.max;
  const delivered = lo === null || lo === undefined || hi === null || hi === undefined ? f(e.delivered?.mean)
    : f(lo) === f(hi) ? f(lo) : `${f(lo, false)} – ${f(hi)}`;
  const ref = resolveRef(res, e.series_ref);
  const design = e.design_value === null || e.design_value === undefined ? null : plain ? e.design_value : toModel(e.design_value);
  const words = { yes: 'The burn replaced the design value', partly: 'The burn replaced it in part', no: 'Still the design value' } as const;
  const note = [e.replaced ? words[e.replaced] : '', e.note].filter(Boolean).join('. ');
  return {
    key: e.key, label: note ? <Hint text={note}>{e.label}</Hint> : e.label, design: f(e.design_value), delivered,
    spark: ref ? { t: ref.t, values: ref.values.map((v) => (v === null ? null : plain ? v : toModel(v))), color: '--lx-text', band: design !== null ? { lo: design, hi: design } : null } : undefined,
  };
}

/** What the ledger shows before "Show all": GUI-SPEC's six (tank pressure, feed loss, O/F, ΔP/Pc, At, ηc*), each side, and Pc. */
const LEDGER_FIRST = ['tank_pressure_ox', 'tank_pressure_fuel', 'feed_loss_ox', 'feed_loss_fuel', 'of', 'stiffness_ox', 'stiffness_fuel', 'pc', 'throat_area', 'eta_cstar'];

function Ledger({ data }: { data: RunData }) {
  const u = useUnits();
  const [all, setAll] = useState(false);
  const server = useMemo(() => ledgerOf(data.result), [data.result]);
  const first = useMemo(() => (server ? LEDGER_FIRST.map((k) => server.find((e) => e.key === k)).filter((e): e is LedgerEntry => !!e) : []), [server]);
  const rows = useMemo<LedgerRow[]>(() => {
    const res = data.result;
    if (server) return (all || first.length < 3 ? server : first).map((e) => serverRow(res, e, u));
    const d = (res.provenance.derived ?? {}) as Record<string, unknown>;
    const ref = res.provenance.engine_reference;
    const out: LedgerRow[] = [];
    const lockup = typeof d.target_lockup_psia === 'number' ? d.target_lockup_psia : null;
    const tanks = [...data.cols.tankO, ...data.cols.tankF].filter((_, i) => data.firing[i % data.t.length]);
    out.push({
      key: 'tank', label: 'Tank pressure', design: lockup !== null ? u.fmt(u.p(lockup)) : '—',
      delivered: rangeText(u, range(tanks), (x) => u.p(x)),
      spark: { t: data.t, values: data.cols.tankO, color: '--lx-lox', band: lockup !== null ? { lo: lockup, hi: lockup } : null },
    });
    const sides = res.feed_fit?.sides;
    for (const side of ['oxidizer', 'fuel'] as const) {
      const s = side === 'oxidizer' ? res.series.ox : res.series.fuel;
      const loss = s.outlet_psia.map((o, i) => (data.firing[i] ? o - s.inlet_psia[i] : null));
      const design = sides?.[side]?.line_loss_design_psi;
      if (!range(loss)) continue;
      out.push({
        key: `loss-${side}`, label: `${side === 'oxidizer' ? 'LOX' : 'Fuel'} feed loss`,
        design: design !== undefined ? u.fmt(u.dp(design)) : '—', delivered: rangeText(u, range(loss), (x) => u.dp(x)),
        spark: { t: data.t, values: loss, color: side === 'oxidizer' ? '--lx-lox' : '--lx-fuel', band: design !== undefined ? { lo: design, hi: design } : null },
      });
    }
    out.push({
      key: 'of', label: 'O/F', design: ref?.MR !== undefined ? u.fmt(u.of(ref.MR)) : '—', delivered: rangeText(u, range(data.cols.of), (x) => u.of(x)),
      spark: { t: data.t, values: data.cols.of, color: '--lx-text', band: ref?.MR !== undefined ? { lo: ref.MR, hi: ref.MR } : null },
    });
    const b = data.band.oxidiser ?? data.band.fuel;
    out.push({
      key: 'stiff', label: 'Injector ΔP/Pc', design: b ? `${u.fmt({ ...u.pct(b[0]), unit: '' })} – ${u.fmt(u.pct(b[1]))}` : '—',
      delivered: rangeText(u, range([...data.cols.stiffO, ...data.cols.stiffF]), (x) => u.pct(x)),
      spark: { t: data.t, values: data.cols.stiffO, color: '--lx-lox', band: b ? { lo: b[0], hi: b[1] } : null },
    });
    const dv = res.delivered;
    if (dv?.throat_area_ratio?.length) {
      const growth = dv.throat_area_ratio.map((x) => (Number.isFinite(x) ? x - 1 : null));
      out.push({
        key: 'at', label: 'Throat area', design: 'as built', delivered: rangeText(u, range(growth), (x) => u.pct(x)),
        spark: { t: dv.t, values: growth, color: '--lx-hot', band: { lo: 0, hi: 0 } },
      });
    }
    const eta = (res.replay as unknown as { eta_cstar?: (number | null)[]; t?: number[] } | undefined);
    if (eta?.eta_cstar?.length && eta.t) {
      out.push({
        key: 'eta', label: 'ηc*', design: ref?.eta_cstar !== undefined ? u.fmt(u.pct(ref.eta_cstar)) : '—',
        delivered: rangeText(u, range(eta.eta_cstar), (x) => u.pct(x)),
        spark: { t: eta.t, values: eta.eta_cstar, color: '--lx-hot', band: ref?.eta_cstar !== undefined ? { lo: ref.eta_cstar, hi: ref.eta_cstar } : null },
      });
    }
    return out;
  }, [data, u, server, first, all]);
  return (
    <Panel title="Design assumed → feed delivers" className="lg:col-span-5">
      <table className="w-full table-fixed border-collapse text-[12px]">
        <colgroup><col /><col className="w-[5.75rem]" /><col className="w-[8.75rem]" /><col className="w-[56px]" /></colgroup>
        <thead>
          <tr className="text-[11px] text-[var(--lx-text-3)]">
            <th scope="col" className="pb-1.5 text-left font-normal"><span className="sr-only">Quantity</span></th>
            <th scope="col" className="pb-1.5 pr-2 text-right font-normal">Design</th>
            <th scope="col" className="pb-1.5 pr-2 text-right font-normal">Over the burn</th>
            <th scope="col" className="pb-1.5 font-normal"><span className="sr-only">Trace</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-[var(--lx-line)]">
              <th scope="row" className="truncate py-1.5 pr-2 text-left font-normal text-[var(--lx-text-2)]">{r.label}</th>
              <td className="lx-num truncate py-1.5 pr-2 text-right text-[var(--lx-text-2)]" title={r.design}>{r.design}</td>
              <td className="lx-num truncate py-1.5 pr-2 text-right text-[var(--lx-text)]" title={r.delivered}>{r.delivered}</td>
              <td className="py-1.5">{r.spark && <MiniSpark t={r.spark.t} values={r.spark.values} color={r.spark.color} band={r.spark.band} width={52} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {server && server.length > first.length && first.length >= 3 && (
        <div className="mt-2 flex">
          <Button variant="bare" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? 'Show the main ones only' : `Show all ${server.length}`}
          </Button>
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ the hero

/** The hero (lx/hero: schematic + engine section, GUI-SPEC "Hero"), or a placeholder with no steps. */
function HeroSlot({ data }: { data: RunData }) {
  if (!data.t.length) return <Panel title="Feed system and engine" className="lg:col-span-12"><NotComputed /></Panel>;
  return (
    <div className="min-w-0 lg:col-span-12">
      <Hero result={data.result} drawingId={data.result.provenance.drawing.id} />
    </div>
  );
}

export function Overview({ data, vs, vsLabel }: PageProps) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <Verdict data={data} vs={vs} vsLabel={vsLabel} />
      <Limits data={data} />
      <Ledger data={data} />
      <HeroSlot data={data} />
    </div>
  );
}

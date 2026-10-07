/**
 * What the engine did: the last burn totalled, its traces, and why the O/F
 * came out where it did.
 *
 * The burn is totalled by the library (`feedtwin.session.report`) the same way
 * Layer X totals one, so the two tools can be compared number for number. And
 * the page says which engine fired: EngineDesign's, through its engine card,
 * or feedtwin's simplified stand-in -- the difference was ~5 % in thrust and
 * ~10 % in Isp on LE4, and it is never something to find out afterwards.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  buildCard,
  channelColor,
  fixed,
  getFreshness,
  hasCard,
  refreshArtifact,
  type Burn,
  type EngineCardInfo,
  type Freshness,
} from '../api';
import { BalancePanel } from '../components/BalancePanel';
import { DaqPlot, type Channel } from '../components/DaqPlot';
import { useStand } from '../stand';

/** Injector stiffness (dp / Pc) below this is soft: the feed system, not the
 *  face, is setting the flow. The library's own rule (SOFT_STIFFNESS). */
const SOFT = 0.2;

/** Engine channels plotted per panel, never two units on one axis. */
const PANELS: { unit: string; label: string; minSpan: number }[] = [
  { unit: 'N', label: 'Thrust (N)', minSpan: 100 },
  { unit: 'O/F', label: 'O/F', minSpan: 0.5 },
  { unit: 'kg/s', label: 'Mass flow (kg/s)', minSpan: 0.5 },
];

export function Engine() {
  const { model, history, burns, where, artifacts, refresh, pick, restart } = useStand();
  const engine = artifacts.find((a) => a.id === where.engine) ?? null;

  if (!model) return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  if (!engine || Object.keys(model.engine).length === 0) {
    return (
      <p className="p-6 text-sm text-text-muted">
        No engine on this stand: the chamber is a fixed pressure and nothing burns.{' '}
        <Link to="/library" className="text-blue-400 hover:underline">
          Pick an engine in Library
        </Link>
        .
      </p>
    );
  }

  const list = burns?.burns ?? [];
  const last = list.length ? list[list.length - 1] : null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
      <EngineHeader
        name={engine.name}
        id={engine.id}
        source={engine.source}
        card={hasCard(engine) ? (engine.card as EngineCardInfo) : null}
        model={String(model.engine.engine_model ?? '')}
        why={String(model.engine.why ?? '')}
        onChanged={async (id) => {
          await refresh();
          if (id && id !== engine.id) pick('engine', id);
          else restart();
        }}
      />

      {last ? (
        <BurnPanel burn={last} />
      ) : (
        <div className="bg-card rounded-lg border border-gray-800 px-4 py-6 text-center text-[13px] text-text-muted">
          No burn yet. Fire from the Console and the burn is totalled here.
        </div>
      )}

      {last && history && <BurnPlots burn={last} />}

      {list.length > 1 && <EarlierBurns burns={list} />}

      {history?.balance && (
        <div className="bg-card rounded-lg border border-gray-800">
          <h2 className="border-b border-gray-800 px-4 py-2.5 caps">
            Mixture ratio
            <span className="ml-2 font-normal normal-case tracking-normal text-gray-600">
              the half the injector owns, and the half the stand does
            </span>
          </h2>
          <BalancePanel balance={history.balance} />
        </div>
      )}
    </div>
  );
}

function EngineHeader({
  name,
  id,
  source,
  card,
  model,
  why,
  onChanged,
}: {
  name: string;
  id: string;
  source: string;
  card: EngineCardInfo | null;
  model: string;
  why: string;
  onChanged: (id: string) => Promise<void>;
}) {
  const [fresh, setFresh] = useState<Freshness | null>(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setFresh(null);
    getFreshness(id).then(setFresh).catch(() => setFresh(null));
  }, [id]);

  const act = async (label: string, run: () => Promise<{ artifact: { id: string }; card_error?: string }>) => {
    setWorking(label);
    setError('');
    try {
      const result = await run();
      if (result.card_error) setError(result.card_error);
      await onChanged(result.artifact.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking('');
    }
  };

  const isCard = model === 'card';
  return (
    <div className="bg-card flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-gray-800 px-4 py-3">
      <div className="min-w-0">
        <div className="caps text-[10px]">Engine</div>
        <div className="truncate text-[15px] font-semibold" title={`${id}\nfrom ${source}`}>
          {name}
        </div>
      </div>

      {isCard && card ? (
        <span
          className="rounded bg-emerald-900/40 px-2 py-0.5 text-[11px] font-semibold text-emerald-300"
          title={
            `EngineDesign's injector and chamber, tabulated (an engine card). The same engine Layer X fires.\n` +
            `Worst error against EngineDesign: ${(card.card_error * 100).toFixed(2)} %\n` +
            `Centred on ${fixed(card.card_center_psia, 0)} psia, sampled at ${fixed(card.card_ambient_pa / 1000, 2)} kPa ambient\n` +
            `Built ${new Date(card.card_built * 1000).toLocaleString()}`
          }
        >
          EngineDesign card
        </span>
      ) : (
        <span
          className="rounded bg-amber-900/50 px-2 py-0.5 text-[11px] font-semibold text-amber-300"
          title={
            why === 'cold flow'
              ? 'A cold flow burns nothing: the engine is an orifice per side.'
              : "feedtwin's simplified engine: an orifice per side and c* straight off the CEA table, no manifold, " +
                "mixing or nozzle losses. On LE4 it read ~5 % low in thrust and ~10 % high in Isp against EngineDesign."
          }
        >
          {why === 'cold flow' ? 'Cold flow' : 'Simplified engine'}
        </span>
      )}

      {fresh?.tracked && fresh.current === false && (
        <span className="rounded bg-amber-900/50 px-2 py-0.5 text-[11px] text-amber-300" title={fresh.detail}>
          Changed in EngineDesign
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {fresh?.tracked && fresh.current === false && (
          <button
            type="button"
            disabled={Boolean(working)}
            onClick={() => void act('refresh', () => refreshArtifact(id))}
            title="Pull EngineDesign's working copy again, with its card. The old copy stays in Library."
            className="rounded bg-blue-600 px-3 py-1 text-[12px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {working === 'refresh' ? 'Pulling…' : 'Pull the current design'}
          </button>
        )}
        {/* A stale copy is pulled again, not tabulated: its card would be last month's engine. */}
        {!isCard && why !== 'cold flow' && fresh?.current !== false && (
          <button
            type="button"
            disabled={Boolean(working)}
            onClick={() => void act('card', () => buildCard(id))}
            title="Ask EngineDesign to tabulate this engine (5-15 s). The stand then restarts firing it."
            className="rounded bg-gray-700 px-3 py-1 text-[12px] font-semibold text-white hover:bg-gray-600 disabled:opacity-50"
          >
            {working === 'card' ? 'Building…' : 'Build EngineDesign card'}
          </button>
        )}
      </div>
      {error && <p className="w-full text-[12px] text-red-400">{error}</p>}
    </div>
  );
}

function Tile({ label, value, unit, places, hint, color }: {
  label: string;
  value: number;
  unit: string;
  places: number;
  hint?: string;
  color?: string;
}) {
  return (
    <div className="min-w-[110px] flex-1" title={hint}>
      <div className="caps text-[10px]">{label}</div>
      <div className="font-mono text-xl font-bold tabular-nums" style={{ color: color ?? '#e2e2e2' }}>
        {fixed(value, places)}
        {unit && <span className="ml-1 text-[11px] font-normal text-text-muted">{unit}</span>}
      </div>
    </div>
  );
}

function Row({ label, value, hint, bad }: { label: string; value: string; hint?: string; bad?: boolean }) {
  return (
    <tr title={hint}>
      <td className="py-1 pr-4 text-text-muted">{label}</td>
      <td className={`py-1 text-right font-mono tabular-nums ${bad ? 'text-amber-300' : ''}`}>{value}</td>
    </tr>
  );
}

function BurnPanel({ burn }: { burn: Burn }) {
  const soft = (s: number) => s > 0 && s < SOFT;
  return (
    <div className="bg-card rounded-lg border border-gray-800">
      <h2 className="flex items-baseline gap-2 border-b border-gray-800 px-4 py-2.5 caps">
        {burn.burning ? 'Burning' : 'Last burn'}
        <span className="font-normal normal-case tracking-normal text-gray-600">
          T+{fixed(burn.start_s, 2)} to {fixed(burn.end_s, 2)} s on the stand clock
        </span>
      </h2>
      <div className="flex flex-wrap gap-4 px-4 py-3">
        <Tile label="Impulse" value={burn.impulse_Ns} unit="N·s" places={0} />
        <Tile label="Mean thrust" value={burn.thrust_mean_N} unit="N" places={0} hint="Impulse over burn time." />
        <Tile label="Burn time" value={burn.duration_s} unit="s" places={2} />
        <Tile label="Chamber" value={burn.pc_mean_psi} unit="psig" places={0} color={channelColor('PC')}
          hint="Time-weighted mean chamber pressure." />
        <Tile label="O/F" value={burn.of_mean} unit="" places={3} color={channelColor('O/F')}
          hint="LOX burned over fuel burned." />
        <Tile label="Isp" value={burn.isp_s} unit="s" places={1} color="#27AE60"
          hint="Delivered: impulse over the weight of propellant burned." />
      </div>
      <div className="grid gap-x-8 border-t border-gray-800 px-4 py-2 text-[12.5px] md:grid-cols-2">
        <table className="w-full">
          <tbody>
            <Row label="Thrust, min / peak" value={`${fixed(burn.thrust_min_N, 0)} / ${fixed(burn.thrust_peak_N, 0)} N`}
              hint="Minimum at full flow (valves open, before tail-off); peak over the burn." />
            <Row label="Chamber, min / max" value={`${fixed(burn.pc_min_psi, 0)} / ${fixed(burn.pc_max_psi, 0)} psig`} />
            <Row label="O/F range" value={`${fixed(burn.of_min, 3)} – ${fixed(burn.of_max, 3)}`} hint="At full flow." />
            <Row label="c*" value={`${fixed(burn.cstar_mps, 0)} m/s`} hint="Mass-weighted mean." />
            <Row
              label="Injector stiffness, LOX / fuel"
              value={`${fixed(burn.stiffness_oxidiser_min, 3)} / ${fixed(burn.stiffness_fuel_min, 3)}`}
              hint={`Lowest dp_injector / Pc at full flow. Below ${SOFT} the feed system, not the face, sets the flow.`}
              bad={soft(burn.stiffness_oxidiser_min) || soft(burn.stiffness_fuel_min)}
            />
            {burn.extrapolated_steps > 0 && (
              <Row label="Outside the combustion table" value={`${burn.extrapolated_steps} of ${burn.steps} steps`} bad
                hint="The chamber was asked about an O/F or flow its table does not cover; those steps are clamped." />
            )}
          </tbody>
        </table>
        <table className="w-full">
          <tbody>
            <Row label="Burned, LOX / fuel" value={`${fixed(burn.oxidiser_kg, 2)} / ${fixed(burn.fuel_kg, 2)} kg`} />
            {burn.tanks.map((t) => (
              <Row
                key={t.id}
                label={`${t.label} at Fire / lowest`}
                value={`${fixed(t.start_psi, 0)} / ${fixed(t.min_psi, 0)} psig · ${fixed(t.start_kg, 2)} → ${fixed(t.end_kg, 2)} kg`}
                hint="Tank pressure when Fire was commanded, and its lowest at full flow; liquid at Fire and at the end. An ullage left sitting in Ready with its press valve shut sags before Fire."
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BurnPlots({ burn }: { burn: Burn }) {
  const { history } = useStand();
  const window = useMemo(() => {
    if (!history) return null;
    const from = burn.start_s - 0.5;
    const to = burn.end_s + 0.5;
    const idx = history.times_s.map((t, i) => (t >= from && t <= to ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) return null;
    return {
      times: idx.map((i) => history.times_s[i]),
      channels: history.channels.filter((c) => c.id.startsWith('engine.')),
      idx,
    };
  }, [history, burn.start_s, burn.end_s]);
  if (!window) return null;
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {PANELS.map((panel) => {
        const shown = window.channels
          .filter((c) => c.unit === panel.unit)
          .map((c): Channel => ({
            key: c.id,
            tag: c.tag,
            values: window.idx.map((i) => c.values[i]),
            color: channelColor(c.tag),
          }));
        if (!shown.length) return null;
        return (
          <div key={panel.unit} className="bg-card h-[240px] rounded-lg border border-gray-800 p-3">
            <DaqPlot times={window.times} channels={shown} yLabel={panel.label} minSpan={panel.minSpan} fill />
          </div>
        );
      })}
    </div>
  );
}

function EarlierBurns({ burns }: { burns: Burn[] }) {
  return (
    <div className="bg-card rounded-lg border border-gray-800">
      <h2 className="border-b border-gray-800 px-4 py-2.5 caps">
        Burns in this session
      </h2>
      <table className="w-full text-[12.5px]">
        <thead className="text-text-muted">
          <tr>
            {['Start (s)', 'Burn (s)', 'Impulse (N·s)', 'Thrust (N)', 'Chamber (psig)', 'O/F', 'Isp (s)'].map((h) => (
              <th key={h} className="px-4 py-1.5 text-right font-semibold first:text-left">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {[...burns].reverse().map((b) => (
            <tr key={b.start_s} className="border-t border-gray-800/60">
              <td className="px-4 py-1">{fixed(b.start_s, 2)}</td>
              <td className="px-4 py-1 text-right">{fixed(b.duration_s, 2)}</td>
              <td className="px-4 py-1 text-right">{fixed(b.impulse_Ns, 0)}</td>
              <td className="px-4 py-1 text-right">{fixed(b.thrust_mean_N, 0)}</td>
              <td className="px-4 py-1 text-right">{fixed(b.pc_mean_psi, 0)}</td>
              <td className="px-4 py-1 text-right">{fixed(b.of_mean, 3)}</td>
              <td className="px-4 py-1 text-right">{fixed(b.isp_s, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


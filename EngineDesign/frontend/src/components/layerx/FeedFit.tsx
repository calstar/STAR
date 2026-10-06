import { useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import type { EngineConfig } from '../../api/client';
import { updateConfig } from '../../api/client';
import type { FeedFit } from '../../api/layerx';
import { Hint } from '../Hint';
import { fmt, LOX, FUEL } from './format';

/**
 * The drawing's feed against the one the injector was sized with (engine/layerx/feedfit.py), and
 * the button that writes the drawing's into the design. The design sizes the injector at lockup
 * less one K per side; the drawing's tank sits below lockup while firing and its lines are not that
 * K. Written in, Layer 1 sizes the injector against the pressure the injector will actually see.
 */

type Row = { label: string; hint: string; get: (s: NonNullable<FeedFit['sides']>['oxidizer']) => string };

const ROWS: Row[] = [
  { label: 'Regulator set', hint: 'Lockup: the tank pressure with nothing flowing. The design calls this the tank pressure.',
    get: (s) => `${fmt(s.lockup_psia, 1)} psia` },
  { label: 'Tank while firing', hint: 'The burn’s settled mean: lockup less the regulator’s droop and the press line’s loss. The worst moment is in brackets.',
    get: (s) => `${fmt(s.tank_firing_psia, 1)} psia (worst ${s.supply_deficit_worst_psi >= 0 ? '−' : '+'}${fmt(Math.abs(s.supply_deficit_worst_psi), 0)})` },
  { label: 'Line loss, drawing / design', hint: 'Tank to line exit at the same flow: through the drawing’s lines, valves and fittings, and through the design’s feed_system.',
    get: (s) => `${fmt(s.line_loss_psi, 1)} / ${fmt(s.line_loss_design_psi, 1)} psi` },
  { label: 'Injector inlet, actual / design', hint: 'What the injector sees in this burn, and what the design sized it for.',
    get: (s) => `${fmt(s.manifold_psia, 1)} / ${fmt(s.manifold_design_psia, 1)} psia` },
];

export function FeedFitSummary({ fit }: { fit: FeedFit }) {
  if (!fit.available || !fit.sides) return <span>{fit.error ?? 'not fitted'}</span>;
  const { oxidizer: o, fuel: f } = fit.sides;
  return <>{fmt(o.manifold_gap_psi, 1)} psi LOX, {fmt(f.manifold_gap_psi, 1)} psi fuel vs the design</>;
}

export function FeedFitView({ fit, runId, onConfigUpdated, designMoved = false, whatIf = false, designSha = null }: {
  fit: FeedFit; runId: string; onConfigUpdated?: (config: EngineConfig) => void; designMoved?: boolean; whatIf?: boolean;
  /** The design this burn was made on: the server refuses the write if it is no longer the live one. */
  designSha?: string | null;
}) {
  const readOnly = useReadOnly();
  const [state, setState] = useState<'idle' | 'writing' | 'written'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (!fit.available || !fit.sides) return <div className="text-[13px] text-[var(--color-text-muted)]">{fit.error ?? 'No feed fit.'}</div>;
  const sides = [['oxidizer', LOX], ['fuel', FUEL]] as const;

  const write = async () => {
    if (!fit.design_update) return;
    setState('writing');
    setError(null);
    const update = JSON.parse(JSON.stringify(fit.design_update)) as NonNullable<FeedFit['design_update']>;
    for (const side of Object.values(update.feed_system)) side.derived_from.run = runId;
    const r = await updateConfig(update as unknown as Partial<EngineConfig>, designSha);
    if (r.error) { setError(r.error); setState('idle'); return; }
    if (r.data?.config) onConfigUpdated?.(r.data.config);
    setState('written');
  };

  return (
    <div className="space-y-5">
      <table className="w-full max-w-3xl text-[12px] tabular-nums">
        <thead>
          <tr className="text-left text-[var(--color-text-muted)]">
            <th className="py-1 font-normal" />
            {sides.map(([k, color]) => <th key={k} className="py-1 font-normal text-right" style={{ color }}>{fit.sides![k].label}</th>)}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label} className="border-t border-[var(--color-border)]/50">
              <td className="py-1 text-[var(--color-text-secondary)]"><Hint text={row.hint}>{row.label}</Hint></td>
              {sides.map(([k]) => <td key={k} className="py-1 text-right text-[var(--color-text-primary)]">{row.get(fit.sides![k])}</td>)}
            </tr>
          ))}
          <tr className="border-t border-[var(--color-border)]">
            <td className="py-1.5 text-[var(--color-text-primary)]">Difference</td>
            {sides.map(([k]) => {
              const g = fit.sides![k].manifold_gap_psi;
              return <td key={k} className="py-1.5 text-right font-medium" style={{ color: Math.abs(g) > 5 ? 'var(--color-warning)' : 'var(--color-text-primary)' }}
                         title={Math.abs(g) > 5 ? 'More than 5 psi apart: the design does not see the drawing\'s feed.' : undefined}>
                {Math.abs(g) > 5 ? '! ' : ''}{g >= 0 ? '+' : ''}{fmt(g, 1)} psi</td>;
            })}
          </tr>
          <tr className="border-t border-[var(--color-border)]/50">
            <td className="py-1 text-[var(--color-text-secondary)]">K0 in the design</td>
            {sides.map(([k]) => <td key={k} className="py-1 text-right text-[var(--color-text-secondary)]">{fmt(fit.sides![k].K0_design, 3)}</td>)}
          </tr>
          <tr className="border-t border-[var(--color-border)]/50">
            <td className="py-1 text-[var(--color-text-primary)]">
              <Hint text="The K0 that reproduces this burn's manifold pressure at its flow: the drawing's lines plus the tank's sag below lockup, in velocity heads. The exit loss stays the design's K_exit.">
                K0 from this burn
              </Hint>
            </td>
            {sides.map(([k]) => {
              const s = fit.sides![k];
              return (
                <td key={k} className="py-1 text-right font-medium text-[var(--color-text-primary)]">
                  <Hint align="right" text={`${fmt(s.K_line, 3)} lines + ${fmt(s.K_supply, 3)} tank sag`}><span>{fmt(s.K0, 3)}</span></Hint>
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={write} disabled={readOnly || designMoved || whatIf || state !== 'idle' || !fit.design_update}
                title={readOnly ? 'Check the design out to change it.' : whatIf ? 'Fitted to what-if holes, not the design’s: write the holes first, then burn again.'
                  : designMoved ? 'The design has changed since this burn; run it again first.' : undefined}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40">
          {state === 'written' ? 'Written' : state === 'writing' ? 'Writing…' : 'Write K0 from this burn into the design'}
        </button>
        <Hint text={`Sets feed_system K0 per side ${fit.flown ? '(as flown)' : '(on the pad)'}, recording this drawing and run. Layer 1 and Forward mode use it; Layer X burns don't change.`}>
          <span className="text-[12px] text-[var(--color-text-muted)]">
            {state === 'written' ? 'Now re-run Layer 1 to resize the injector, then burn again.' : 'then re-run Layer 1'}
          </span>
        </Hint>
        {error && <span className="text-[12px] text-[var(--color-danger)]">{error}</span>}
      </div>
    </div>
  );
}

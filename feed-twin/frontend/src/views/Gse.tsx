/**
 * GSE controls: what the crew sets by hand at the cart.
 *
 * Two hand-loaded regulators, as knobs. The high-press regulator sets what
 * the GSE fills the COPV to; the dome control regulator loads the dome on the
 * tank regulator, and the tanks lock up at the dome plus the 1092-50's
 * spring bias. Under each knob is the gauge the operator would look at to see
 * what the setting did. Turn the dome knob past what the tanks are rated for
 * and the stand will tell you -- once.
 *
 * Below the regulators: the rest of the cart, which is not on the drawing
 * yet -- how fast it charges, and the LOX dewar that pushes the load in.
 * The model switches moved to the Configuration tab with everything else
 * the twin assumes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CHARGE_KNOB, DOME_KNOB, type LiveKnob, type StandSetup } from '../api';
import Knob from '../components/Knob';
import { useStand } from '../stand';

/** The knobs turn continuously; the stand hears about it a few times a
 *  second. Enough to feel live, not enough to flood the command channel. */
const COMMIT_MS = 120;

function useCommitted(value: number, commit: (v: number) => void): [number, (v: number) => void] {
  const [shown, setShown] = useState(value);
  const timer = useRef<number | null>(null);
  const latest = useRef(value);
  useEffect(() => {
    if (timer.current === null) setShown(value);
  }, [value]);
  const set = useCallback(
    (v: number) => {
      setShown(v);
      latest.current = v;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        commit(latest.current);
      }, COMMIT_MS);
    },
    [commit],
  );
  return [shown, set];
}

function Number_({
  label,
  value,
  unit,
  step,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="caps text-[11px]">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <input
          type="number"
          value={value}
          step={step}
          min={0}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          className="w-24 rounded-md border border-gray-700 bg-black/60 px-2 py-1.5 font-mono text-sm tabular-nums text-white focus:border-blue-500 focus:outline-none"
        />
        <span className="text-[11px] text-text-muted">{unit}</span>
      </span>
    </label>
  );
}

/** A knob from the drawing's hookup: turns the regulators linked to it. */
function HookupKnob({ knob, disabled }: { knob: LiveKnob; disabled: boolean }) {
  const { turnKnob } = useStand();
  const commit = useCallback((v: number) => turnKnob(knob.id, v), [turnKnob, knob.id]);
  const [value, setValue] = useCommitted(knob.psig, commit);
  return (
    <span title={`Sets ${knob.regulators.join(', ') || 'nothing yet'}`}>
      <Knob
        label={knob.label}
        value={value}
        min={knob.low}
        max={knob.high}
        step={5}
        unit="psig"
        onChange={setValue}
        disabled={disabled}
      />
    </span>
  );
}

export function Gse() {
  const { live, setup, setSetup, locked: readOnly } = useStand();
  const set = (patch: Partial<StandSetup>) => setSetup(patch);
  const commitDome = useCallback((v: number) => setSetup({ dome: v }), [setSetup]);
  const commitHigh = useCallback((v: number) => setSetup({ copv_target: v }), [setSetup]);
  const [dome, setDome] = useCommitted(setup.dome, commitDome);
  const [high, setHigh] = useCommitted(setup.copv_target, commitHigh);
  // Tripped, or a stand you have not taken: where the knobs sit is saved with
  // the stand, so turning them is changing it.
  const locked = Boolean(live?.tripped) || readOnly;
  const chargeKnob = live?.knobs?.find((k) => k.id === CHARGE_KNOB);

  const reading = (pattern: RegExp) => {
    if (!live) return undefined;
    const tag = Object.keys(live.pressure_psi).find((t) => pattern.test(t));
    return tag ? { label: tag, value: live.pressure_psi[tag] } : undefined;
  };
  const bottle = live?.bottles[0];
  const lox = live?.tanks.find((t) => t.side === 'lox');
  const tankMawp = 1000; // psig, the drawing's estimate for both tanks

  return (
    <div className="flex flex-col gap-4 p-4">
      <section>
        <h2 className="mb-1 caps">
          Hand-loaded regulators
        </h2>
        <div className="bg-card flex flex-wrap items-start justify-around gap-8 rounded-xl border border-gray-800 px-6 py-5">
          <Knob
            label={chargeKnob?.label ?? 'COPV fill (built-in)'}
            value={high}
            min={0}
            max={6000}
            step={50}
            unit="psig"
            onChange={setHigh}
            disabled={locked}
            redline={4500}
            actual={
              bottle
                ? { label: `${bottle.label} reads`, value: bottle.pressure_psi }
                : reading(/HI|HIGH/i)
            }
          />
          {/* A knob that sets nothing on this drawing is not on the panel. */}
          {(live?.knobs?.length ?? 0) === 0 ||
          live?.knobs?.some((k) => k.id === DOME_KNOB && k.regulators.length > 0) ? (
            <Knob
              label={live?.knobs?.find((k) => k.id === DOME_KNOB)?.label ?? 'Dome control regulator'}
              value={dome}
              min={0}
              max={1000}
              step={5}
              unit="psig"
              onChange={setDome}
              disabled={locked}
              redline={tankMawp - 50}
              actual={reading(/REG/i) ?? reading(/UP/i)}
            />
          ) : null}
          {(live?.knobs ?? [])
            .filter((k) => k.id !== DOME_KNOB && k.id !== CHARGE_KNOB && k.regulators.length > 0)
            .map((k) => (
              <HookupKnob key={k.id} knob={k} disabled={locked} />
            ))}
        </div>
        <p className="mt-1 text-[11px] text-text-muted">
          {chargeKnob
            ? `COPV fill sets ${chargeKnob.regulators.join(', ')} on the drawing. `
            : "COPV fill is the twin's own GSE fill (no fill regulator on the drawing). "}
          Which regulator each other knob turns is set on the{' '}
          <Link to="/hookup" className="text-blue-400 hover:underline">
            Hookup
          </Link>{' '}
          page.
        </p>
      </section>

      <section>
        <h2 className="mb-1 caps">
          The cart
        </h2>
        <fieldset
          disabled={locked}
          className="bg-card m-0 flex min-w-0 flex-wrap items-end gap-5 rounded-xl border border-gray-800 px-4 py-3 disabled:opacity-60"
        >
          <Number_ label="COPV charge" value={setup.copv_fill_s} unit="s" step={5} onChange={(copv_fill_s) => set({ copv_fill_s })} />
          <Number_ label="Fuel load" value={setup.fuel_fill_s} unit="s" step={5} onChange={(fuel_fill_s) => set({ fuel_fill_s })} />
          <span title="What pushes the LOX load in. The load is the dewar less the tank, through the fill line; while the wall is warm it all boils into the ullage and the tank climbs until the vent carries it. 0: a fixed-rate load over the LOX load time.">
            <Number_ label="LOX dewar" value={setup.dewar_psi} unit="psig" step={5} onChange={(dewar_psi) => set({ dewar_psi })} />
          </span>
          {setup.dewar_psi > 0 ? (
            <span title="Everything on the fill line that is not tube -- in practice how far the dewar valve is open. 0.013 is what tops LE4 out at 30 psig during the chill.">
              <Number_ label="Dewar valve" value={setup.dewar_fill_cv} unit="Cv" step={0.001} onChange={(dewar_fill_cv) => set({ dewar_fill_cv })} />
            </span>
          ) : (
            <Number_ label="LOX load" value={setup.tank_fill_s} unit="s" step={10} onChange={(tank_fill_s) => set({ tank_fill_s })} />
          )}
          {lox && setup.dewar_psi > 0 ? (
            <span className="pb-1.5 font-mono text-[12px] tabular-nums text-text-muted">
              {lox.label} {lox.pressure_psi.toFixed(1)} psig · pouring {(lox.fill_flow_g_s ?? 0).toFixed(1)} g/s
              {lox.chilling ? ' · chilling' : ''}
            </span>
          ) : null}
          <label
            className="flex items-center gap-2 pb-1.5 text-[12px] text-text"
            title="Off: the bottle starts empty and GN2 High Press charges it from the cart. On: it arrives full and cold, like a cylinder filled hours ago."
          >
            <input
              type="checkbox"
              checked={setup.bottle_delivered}
              onChange={(e) => set({ bottle_delivered: e.target.checked })}
              className="accent-blue-500"
            />
            Bottle arrives full
          </label>
        </fieldset>
      </section>

    </div>
  );
}

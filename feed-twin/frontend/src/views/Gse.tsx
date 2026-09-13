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
 * yet -- how fast it loads and charges. The model switches moved to the
 * Configuration tab with everything else the twin assumes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StandSetup } from '../api';
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
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
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

export function Gse() {
  const { live, setup, setSetup } = useStand();
  const set = (patch: Partial<StandSetup>) => setSetup(patch);
  const commitDome = useCallback((v: number) => setSetup({ dome: v }), [setSetup]);
  const commitHigh = useCallback((v: number) => setSetup({ copv_target: v }), [setSetup]);
  const [dome, setDome] = useCommitted(setup.dome, commitDome);
  const [high, setHigh] = useCommitted(setup.copv_target, commitHigh);
  const locked = Boolean(live?.tripped);

  const reading = (pattern: RegExp) => {
    if (!live) return undefined;
    const tag = Object.keys(live.pressure_psi).find((t) => pattern.test(t));
    return tag ? { label: tag, value: live.pressure_psi[tag] } : undefined;
  };
  const bottle = live?.bottles[0];
  const tankMawp = 1000; // psig, the drawing's estimate for both tanks

  return (
    <div className="flex flex-col gap-4 p-4">
      <section>
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wider text-text-muted">
          Hand-loaded regulators
        </h2>
        <div className="bg-card flex flex-wrap items-start justify-around gap-8 rounded-xl border border-gray-800 px-6 py-5">
          <Knob
            label="GSE high press regulator"
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
          <Knob
            label="Dome control regulator"
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
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wider text-text-muted">
          The cart
        </h2>
        <div className="bg-card flex flex-wrap items-end gap-5 rounded-xl border border-gray-800 px-4 py-3">
          <Number_ label="COPV charge" value={setup.copv_fill_s} unit="s" step={5} onChange={(copv_fill_s) => set({ copv_fill_s })} />
          <Number_ label="Fuel load" value={setup.fuel_fill_s} unit="s" step={5} onChange={(fuel_fill_s) => set({ fuel_fill_s })} />
          <Number_ label="LOX load" value={setup.tank_fill_s} unit="s" step={10} onChange={(tank_fill_s) => set({ tank_fill_s })} />
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
        </div>
      </section>

    </div>
  );
}

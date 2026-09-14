/**
 * Where the mixture ratio came from.
 *
 * The whole panel is built around one identity: O/F is the face ratio times the
 * feed term, exactly. So the layout leads with that product written out, then
 * shows the pressure budget that produced the second factor. Reading top to
 * bottom answers the question an operator actually has — *which of these do I
 * change* — rather than restating a number the readout strip already shows.
 *
 * The budget bar is the point of the panel. A leg is drawn as the pressure it
 * spends: plumbing first, injector last, to scale against the same total. When
 * the injector slice is a sliver next to the line slice, the line is the meter,
 * and that reads instantly in a way "stiffness 7%" does not.
 */

import type { Balance, Leg } from '../api';
import { fixed } from '../api';

/** Fallback floor, for an engine config that states no band of its own. The
 *  classic pressure-fed rule of thumb; see feedtwin.engine.balance. */
const SOFT = 0.2;

const OX = 'var(--fluid-oxidizer)';
const FUEL = 'var(--fluid-fuel)';

function Term({
  value,
  label,
  note,
  decimals = 2,
}: {
  value: number;
  label: string;
  note: string;
  decimals?: number;
}) {
  return (
    <div className="min-w-0">
      <div className="num text-[26px] leading-none tracking-tight">
        {fixed(value, decimals)}
      </div>
      <div className="mt-1 text-[12px] text-[var(--muted)]">{label}</div>
      <div className="text-[11.5px] leading-snug text-[var(--dim)]">{note}</div>
    </div>
  );
}

function Budget({ leg, color, name }: { leg: Leg; color: string; name: string }) {
  const total = leg.feed_loss_psi + leg.injector_dp_psi;
  const injectorShare = total > 0 ? (leg.injector_dp_psi / total) * 100 : 0;
  // The engine's own band where the config states one, the rule of thumb
  // otherwise. "under 20%" is an opinion; "under what this engine was
  // optimised to" is the config talking.
  const floor = leg.band_min > 0 ? leg.band_min : SOFT;
  const soft = leg.stiffness > 0 && leg.stiffness < floor;
  const stiff = leg.band_max > 0 && leg.stiffness > leg.band_max;

  return (
    <div className="grid grid-cols-[64px_1fr] items-center gap-x-3 gap-y-1">
      <span className="text-[12px]" style={{ color }}>
        {name}
      </span>

      <div className="flex h-3 overflow-hidden rounded-[2px] bg-[var(--lift)]">
        {/* Plumbing then injector, in flow order, so the eye reads the bar the
            way the propellant travels. A 2px gap keeps the two fills from
            reading as one. */}
        <div
          title={`${fixed(leg.feed_loss_psi, 0)} psi in lines, valves and fittings`}
          style={{
            width: `${100 - injectorShare}%`,
            background: 'var(--edge-strong)',
            marginRight: 2,
          }}
        />
        <div
          title={`${fixed(leg.injector_dp_psi, 0)} psi across the injector face`}
          style={{ width: `${injectorShare}%`, background: color }}
        />
      </div>

      <span />
      <div className="num flex flex-wrap items-baseline gap-x-3 text-[11.5px] text-[var(--dim)]">
        <span>{fixed(leg.feed_loss_psi, 0)} psi plumbing</span>
        <span style={{ color }}>{fixed(leg.injector_dp_psi, 0)} psi injector</span>
        <span
          style={{ color: soft || stiff ? 'var(--warn)' : 'var(--dim)' }}
          title={
            leg.band_min > 0
              ? `Designed to ${fixed(leg.band_min * 100, 0)}–${fixed(
                  leg.band_max * 100,
                  0,
                )}% of chamber pressure`
              : 'No band in the engine config; 20% rule of thumb'
          }
        >
          {fixed(leg.stiffness * 100, 0)}% stiff
          {leg.band_min > 0 &&
            ` of ${fixed(leg.band_min * 100, 0)}–${fixed(leg.band_max * 100, 0)}`}
          {soft ? ' — soft' : stiff ? ' — over' : ''}
        </span>
        <span>{fixed(leg.mdot_kg_s, 3)} kg/s</span>
        <span>{fixed(leg.velocity_m_s, 1)} m/s</span>
      </div>
    </div>
  );
}

export function BalancePanel({ balance }: { balance: Balance }) {
  const off =
    balance.design_ratio > 0 && Math.abs(balance.design_error) > 0.05;

  return (
    <div className="flex flex-col gap-4 overflow-auto p-3">
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] text-[var(--muted)]">Mixture ratio</span>
          {balance.design_ratio > 0 && (
            <span
              className="num text-[11.5px]"
              style={{ color: off ? 'var(--warn)' : 'var(--ok)' }}
            >
              {balance.design_error > 0 ? '+' : ''}
              {fixed(balance.design_error * 100, 0)}% against a design of{' '}
              {fixed(balance.design_ratio, 2)}
            </span>
          )}
        </div>

        {/* The identity, written as an equation. Two terms and a product, with
            the owner of each named under it. */}
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-start gap-3">
          <Term
            value={balance.face_ratio}
            label="face ratio"
            note="Cd·A·√ρ on each side. The engine designer's number — it does not move when the plumbing does."
          />
          <span className="num pt-1 text-[18px] text-[var(--dim)]">×</span>
          <Term
            value={balance.feed_term}
            label="feed term"
            note="√(Δp_ox / Δp_fuel). Everything the stand contributes. One when both legs drop the same."
          />
          <span className="num pt-1 text-[18px] text-[var(--dim)]">=</span>
          <Term
            value={balance.mixture_ratio}
            label="delivered O/F"
            note="What the chamber actually sees."
          />
        </div>
      </div>

      <div className="border-t border-[var(--edge)] pt-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[12px] text-[var(--muted)]">
            Pressure budget, tank outlet to chamber
          </span>
          <span className="num text-[11.5px] text-[var(--dim)]">
            chamber {fixed(balance.chamber_psi, 0)} psi
          </span>
        </div>
        <div className="flex flex-col gap-3">
          <Budget leg={balance.oxidiser} color={OX} name="oxidiser" />
          <Budget leg={balance.fuel} color={FUEL} name="fuel" />
        </div>
      </div>

      {balance.notes.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-[var(--edge)] pt-3">
          {balance.notes.map((note) => (
            <li
              key={note}
              className="text-[12.5px] leading-snug text-[var(--muted)]"
            >
              {note}
            </li>
          ))}
        </ul>
      )}

      {Math.abs(balance.trim_psi) > 1 && (
        <p className="text-[12px] leading-snug text-[var(--dim)]">
          A first step: {balance.trim_psi > 0 ? 'raise' : 'lower'} the fuel
          injector drop by{' '}
          <span className="num">{fixed(Math.abs(balance.trim_psi), 0)} psi</span>{' '}
          and this face lands on {fixed(balance.design_ratio, 2)}. Computed at
          the present flow, so the true figure is a little higher — the plumbing
          takes more at the higher rate too.
        </p>
      )}
    </div>
  );
}

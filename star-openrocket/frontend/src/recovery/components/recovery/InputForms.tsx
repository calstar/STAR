/**
 * Vehicle, site, hardware and sweep inputs. PLAN.md §11.3.
 *
 * These are grouped in one file because each is a short flat form over the
 * same primitives; the devices list is the one that earns its own module.
 */

import { useEffect, useState } from 'react'
import type { StationPad } from '../../api/client'
import { getStationPad } from '../../api/client'
import type { DesignSource, InputSources, TempProfile, UiConfig, UiSite, Vehicle } from '../../types/schema'
import type { SweepParam } from '../../types/schema'
import type { Kind } from '../../../lib/units/quantities'
import type { LapseTable, PadNormals } from '../../lib/climatology'
import { SOURCES } from '../../lib/climatology'
import { Badge, Card, Field, Info, NumberInput, Select, Stat, UnitInput } from '../ui'
import { airframeBand, monthName } from '../../lib/units'
import { useUnits } from '../../../lib/units/unitsContext'

const grid = 'grid grid-cols-2 gap-3'

/** The corner values one swept parameter contributes. Mirrors
 *  `SweepParam.bounds` in schema.py: equal bounds are a pin worth one run, not
 *  two identical ones, so the corner count shown here matches what the backend
 *  actually executes. */
function bounds(p: SweepParam, axial: number, broadside: number): number[] {
  const [lo, hi] = p.key === 'CdS_body' ? [axial, broadside] : [p.min, p.max]
  return lo === hi ? [lo] : [lo, hi]
}

/** The "from ascent design" toggle under the mass / apogee inputs. Disabled
 *  until the design has a value to offer (a built model / a flight run). */
function DesignLink({ checked, available, label, onChange }: {
  checked: boolean
  available: boolean
  label: string
  onChange: (c: boolean) => void
}) {
  return (
    <label
      className={`mt-1 flex items-center gap-1.5 text-2xs ${
        available
          ? 'cursor-pointer text-[var(--color-text-secondary)]'
          : 'cursor-not-allowed text-[var(--color-text-muted)] opacity-60'
      }`}
      title={available ? 'Use the value from the ascent design' : 'Run a flight / build a model first'}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!available}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  )
}

export function VehicleForm({ value, onChange, design, sources, onSourcesChange }: {
  value: Vehicle
  onChange: (v: Vehicle) => void
  design: DesignSource
  sources: InputSources
  onSourcesChange: (s: InputSources) => void
}) {
  const { num } = useUnits()
  const set = <K extends keyof Vehicle>(k: K, v: Vehicle[K]) =>
    onChange({ ...value, [k]: v })

  return (
    <Card title="Vehicle">
      <div className={grid}>
        {/* Display units on screen, SI on the wire. PLAN.md §1.1 keeps SI
            internal and converts at the I/O boundary only; UnitInput is that
            boundary, so the state below these widgets is still kg and metres
            whatever the Units tab says. The conversions are exact, so a value
            typed here reads back unchanged. Nothing restates the SI underneath
            -- a second copy of every number is noise, not reassurance.

            Mass and apogee can be typed in or pulled from the ascent design
            (CAD structure + spent motor; Flight Dynamics apogee). While a
            from-design toggle is on the field is read-only and RecoveryTab keeps
            it synced to the design value. */}
        <Field label="Descending mass" kind="mass">
          <UnitInput value={value.m} onChange={(v) => set('m', v ?? 0)}
                     kind="mass" min={0} disabled={sources.massFromDesign} />
          <DesignLink
            checked={sources.massFromDesign}
            available={design.massKg != null}
            onChange={(c) => onSourcesChange({ ...sources, massFromDesign: c })}
            label={design.massKg != null
              ? `from design (${num(design.massKg, 'mass')})`
              : 'from design — build a model first'}
          />
        </Field>
        <Field label="Apogee" kind="altitude" hint="above ground level">
          <UnitInput value={value.h_a} onChange={(v) => set('h_a', v ?? 0)}
                     kind="altitude" step={100} min={0} disabled={sources.apogeeFromDesign} />
          <DesignLink
            checked={sources.apogeeFromDesign}
            available={design.apogee != null}
            onChange={(c) => onSourcesChange({ ...sources, apogeeFromDesign: c })}
            label={design.apogee != null
              ? `from design (${num(design.apogee, 'altitude')})`
              : 'from design — run a flight first'}
          />
        </Field>
        {/* Lateral (sideways) airspeed at apogee, from a weathercocked ascent.
            Feeds the coupled descent: it raises the drogue opening load and curves
            the drift track, then relaxes to the wind. From-design fills both the
            speed and the bearing from the RocketPy velocity at apogee. */}
        <Field label="Lateral velocity at apogee" kind="speed" hint="sideways airspeed the drogue sees">
          <UnitInput value={value.v_lat ?? 0} onChange={(v) => set('v_lat', v ?? 0)}
                     kind="speed" min={0} disabled={sources.lateralFromDesign} />
          <DesignLink
            checked={sources.lateralFromDesign}
            available={design.lateralVelocity != null}
            onChange={(c) => onSourcesChange({ ...sources, lateralFromDesign: c })}
            label={design.lateralVelocity != null
              ? `from design (${num(design.lateralVelocity, 'speed')})`
              : 'from design — run a flight first'}
          />
        </Field>
        <Field label="Lateral bearing" hint="deg toward (0=N, 90=E)">
          <NumberInput value={value.v_lat_dir ?? 0} onChange={(v) => set('v_lat_dir', v ?? 0)}
                       min={0} max={360} step={5} disabled={sources.lateralFromDesign} />
        </Field>
        <Field label="Airframe diameter" kind="length">
          <UnitInput value={value.d_body} onChange={(v) => set('d_body', v ?? 0)}
                     kind="length" min={0} />
        </Field>
        <Field label="Airframe length" kind="length">
          <UnitInput value={value.l_body} onChange={(v) => set('l_body', v ?? 0)}
                     kind="length" step={1} min={0} />
        </Field>

        {/* Airframe drag area is DERIVED, not entered. eqs (14)/(15) from the
            diameter and length above, and §6.4 does not permit collapsing the
            axial/broadside band to a single value -- it is 36x in the input
            and 2.1x on the design load. Shown read-only so the number is
            visible without being editable. */}
        <Field label="Airframe drag area" kind="area" wide>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="axial" kind="area"
                  value={num(airframeBand(value.d_body, value.l_body)[0], 'area', 5)} />
            <Stat label="broadside" kind="area"
                  value={num(airframeBand(value.d_body, value.l_body)[1], 'area', 5)} />
          </div>
          {/* Which of the two the reader is actually looking at, stated where
              the two numbers are. Both appear, so without this the loads below
              could plausibly belong to either -- and they differ by 2.1x. */}
          <p className="font-prose mt-1.5 text-xs leading-snug text-[var(--color-text-muted)]">
            From diameter and length. The{' '}
            <span className="text-[var(--color-text-secondary)]">axial</span>{' '}
            bound is the default; the corner sweep runs both.
          </p>
        </Field>
      </div>

      {/* The (z0, v0) early-deployment override is deliberately NOT offered
          here. §4.0: "early deployment is a load check, not a trajectory" --
          with the vehicle still climbing, v_s passes through zero during
          filling, so freezing it is a sign error rather than an
          approximation; s_f = n*D0 was calibrated as a descent distance; the
          tau^j law was fitted to canopies trailing a descending vehicle; and
          a 1-D point mass cannot represent the vehicle arcing over into its
          own canopy. A pair of boxes labelled "start velocity" invites
          exactly the run the model cannot do, and it would return numbers
          that look ordinary.

          The right form of the question is inverted -- eq (37) gives the
          maximum survivable deployment speed per device and eq (56) converts
          it to a time before apogee -- and that wants its own read-only
          panel, not two inputs. Until it exists, the fields stay off.

          `Vehicle.z0`/`v0` remain on the wire and in the schema, sent as
          null, so restoring this is a UI change only. */}
    </Card>
  )
}

export function SiteForm({ value, onChange, lapseByMonth, padNormals }: {
  value: UiSite
  onChange: (v: UiSite) => void
  lapseByMonth: LapseTable
  padNormals: PadNormals
}) {
  const { q, num, lab } = useUnits()
  const set = <K extends keyof UiSite>(k: K, v: UiSite[K]) =>
    onChange({ ...value, [k]: v })

  /**
   * Resolve every month-dependent field in one update.
   *
   * The month drives two independent things -- the measured lapse rate, and
   * the monthly-normal pad state -- and the wire format records neither
   * choice, only the resulting numbers. So they have to be recomputed
   * together on any change to the source, the station, the profile or the
   * month. Splitting this into per-field setters is how a run ends up with
   * January's pressure and July's lapse rate, which is an atmosphere that
   * never existed and which nothing downstream can detect.
   *
   * The lapse table is K/km; the schema wants K/m.
   */
  const apply = (patch: Partial<UiSite>) => {
    const next = { ...value, ...patch }
    const lapseRow = lapseByMonth?.[next.month]
    const padRow = padNormals?.[next.station]?.[next.month]
    onChange({
      ...next,
      lapse: next.profile === 'measured' && lapseRow
        ? lapseRow.L / 1000
        : null,
      // Only this source is month-driven. A barometer reading and a METAR are
      // both left exactly as they arrived.
      ...(next.source === 'climatology' && padRow
        ? { T_pad: padRow.T, p_pad: padRow.p }
        : {}),
    })
  }

  const setProfile = (profile: TempProfile, month = value.month) =>
    apply({ profile, month })

  const measured = value.profile === 'measured'
  const lapseRec = lapseByMonth?.[value.month]
  const normal = value.source === 'climatology'
  const padRec = padNormals?.[value.station]?.[value.month]
  // Both month-driven controls, so the month picker is shown for either.
  const monthly = measured || normal

  const isa = value.source === 'isa'
  // Only a pad barometer produces numbers the user actually measured. ISA
  // computes them, and a station observation or a monthly normal resolves
  // them; in all of those cases the fields must be locked: an editable box
  // holding a value nobody typed invites a number that claims a provenance
  // it does not have.
  const locked = value.source !== 'barometer'

  // Keyed by "source|station" so a stale response cannot land on a newer
  // selection, and so "which selection is this answer for" is answerable
  // without a second state field.
  const [station, setStation] = useState<{
    key: string
    error: string | null
    info: StationPad | null
  } | null>(null)

  const stationKey = `${value.source}|${value.station}`

  // Resolve from the station whenever METAR is selected or the station
  // changes. The conversions -- lapse-transferring temperature across the
  // elevation gap, and inverting the altimeter setting -- happen in the
  // backend, never here, so there is one implementation of the pad state.
  //
  // Every setState here is inside the promise callback, never in the effect
  // body: a synchronous set during an effect is an immediate second render,
  // and the react-hooks lint rule rejects it. Both states that used to need
  // one -- "loading" and "cleared" -- are derived below instead.
  useEffect(() => {
    if (value.source !== 'metar') return
    const key = stationKey
    let cancelled = false
    getStationPad(value.station).then((res) => {
      if (cancelled) return
      if (res.data) {
        setStation({ key, error: null, info: res.data })
        onChange({ ...value, T_pad: res.data.T_pad, p_pad: res.data.p_pad })
      } else {
        // Leave T_pad/p_pad alone on failure. Silently falling back to ISA
        // would present computed numbers as observed ones.
        setStation({ key, error: res.error ?? 'lookup failed', info: null })
      }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.source, value.station])

  // Derived, not stored: an answer counts only if it is for the current
  // selection, and anything else while METAR is selected is still in flight.
  const current = station?.key === stationKey ? station : null
  const stationLoading = value.source === 'metar' && current === null

  return (
    <Card
      title="Site"
      right={<Badge tone={isa ? 'warning' : 'success'}>
        {isa ? 'defaults' : 'measured'}
      </Badge>}
    >
      <div className={grid}>
        <Field
          label="Pressure source"
          wide
          hint={value.source === 'metar'
            ? 'the observation issued in the last hour - no month applies'
            : undefined}
        >
          <Select value={value.source} onChange={(v) => apply({ source: v })}
                  options={SOURCES} />
        </Field>

        {(value.source === 'metar' || normal) && (
          <Field label="Station" wide>
            <Select
              value={value.station}
              onChange={(v) => apply({ station: v })}
              options={[
                // Great-circle to the pad. Stored in metres so the distance
                // unit applies; see site-climatology/README for the survey.
                { value: 'KNID', label: `KNID - China Lake (${num(39_000, 'distance')} ${lab('distance')})` },
                { value: 'KEDW', label: `KEDW - Edwards AFB (${num(50_000, 'distance')} ${lab('distance')})` },
                { value: 'KMHV', label: `KMHV - Mojave (${num(45_000, 'distance')} ${lab('distance')})` },
              ]}
            />
          </Field>
        )}

        <Field
          label="Temperature profile"
          wide
          hint={measured
            ? (lapseByMonth
                ? 'lapse rate measured from 10 years of soundings'
                : 'climatology unavailable - using the standard column')
            : 'slope inferred from the pad temperature alone'}
        >
          <Select
            value={value.profile}
            onChange={(v) => setProfile(v)}
            options={[
              { value: 'standard', label: 'ISA standard column' },
              { value: 'measured', label: 'Measured - soundings by month' },
            ]}
          />
        </Field>

        {/* One month for both. Whichever of the two month-driven choices is
            active, this is the field that drives it, so the pad state and the
            lapse rate can never come from different seasons. */}
        {monthly && (
          <Field
            label="Month"
            wide
            hint={[
              // lapseRec.L is K/km already; `lapse` is stored K/m, hence /1000.
              measured && (lapseRec
                ? `lapse ${q(lapseRec.L / 1000, 'lapse')} from ${lapseRec.n} ascents`
                : 'no soundings for that month'),
              normal && (padRec
                ? `pad state from ${padRec.n.toLocaleString('en-US')} observations`
                : 'no record for that month'),
            ].filter(Boolean).join(' · ')}
          >
            <Select
              value={String(value.month)}
              onChange={(v) => apply({ month: Number(v) })}
              options={Array.from({ length: 12 }, (_, i) => {
                const r = lapseByMonth?.[i + 1]
                return {
                  value: String(i + 1),
                  label: measured && r
                    ? `${monthName(i + 1)} - ${q(r.L / 1000, 'lapse')}`
                    : monthName(i + 1),
                }
              })}
            />
          </Field>
        )}

        <Field
          label="Pad temperature"
          kind="temperature"
          hint={isa ? undefined
                : normal
                  ? `${value.station} ${monthName(value.month)} mean, daytime hours`
                  : value.source === 'metar'
                    // temp_c arrives from the backend in °C, so it is converted
                    // to K before display like every other stored value.
                    ? (current?.info
                        ? `${current.info.station} ${q(current.info.temp_c + 273.15, 'temperature')}, carried across the ${q(-current.info.gap_m, 'altitude')} elevation gap`
                        : stationLoading ? 'resolving…' : (current?.error ?? 'not resolved'))
                    : 'measured at the pad'}
        >
          <UnitInput value={isa ? null : value.T_pad}
                     onChange={(v) => set('T_pad', v)}
                     kind="temperature" disabled={locked}
                     placeholder={isa ? 'ISA'
                       : stationLoading ? 'resolving…' : 'measured'} />
        </Field>

        <Field
          label="Pad pressure"
          kind="pressure"
          hint={isa ? undefined
                : normal
                  ? `${value.station} ${monthName(value.month)} mean, reduced to the pad`
                  : value.source === 'metar'
                    ? 'inverted from the altimeter setting - never the setting itself'
                    : 'station pressure, not an altimeter setting'}
        >
          <UnitInput value={isa ? null : value.p_pad}
                     onChange={(v) => set('p_pad', v)}
                     kind="pressure" disabled={locked}
                     placeholder={isa ? 'standard'
                       : stationLoading ? 'resolving…' : 'measured'} />
        </Field>

        {value.source === 'metar' && current?.error && (
          <Field wide label="">
            <Info>{`Could not resolve ${value.station}: ${current.error}. Temperature and pressure are unchanged - pick another source rather than trusting these.`}</Info>
          </Field>
        )}
        {value.source === 'metar' && current?.info?.maintenance_flag && (
          <Field wide label="">
            <Info>{`${current.info.station} is flagging that it needs maintenance. The observation is usable but treat it with caution.`}</Info>
          </Field>
        )}
      </div>

    </Card>
  )
}

/**
 * Which corners the sweep visits, and over what bounds.
 *
 * The airframe attitude row is **derived and locked**, unlike every other row.
 * Its bounds are eqs (14)/(15) evaluated on the vehicle above, and the same
 * §6.4 argument that keeps `CdS_body` off the `Vehicle` schema applies here:
 * the axial/broadside band is 36x in the input and 2.1x on the design load,
 * the single largest term in the model, and an editable field is an invitation
 * to narrow it to whichever number looks reasonable. Letting it be typed here
 * would reintroduce through the back door exactly what the derived field
 * closed off.
 *
 * The checkbox still works. Turning the row off means "report the axial bound
 * only", which is a legitimate thing to ask for -- what §6.4 forbids is
 * silently narrowing the band while claiming to have run it, and that is a
 * property of the bounds, not of whether this particular run sweeps them.
 *
 * The bounds are computed at render from the current vehicle rather than
 * stored, so editing the airframe diameter moves them. Stored copies went
 * stale the moment anyone touched the geometry.
 */
export function SweepForm({ value, onChange, vehicle }: {
  value: SweepParam[]
  onChange: (v: SweepParam[]) => void
  vehicle: Vehicle
}) {
  const { num, dec, lab } = useUnits()
  const update = (i: number, patch: Partial<SweepParam>) =>
    onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  const [axial, broadside] = airframeBand(vehicle.d_body, vehicle.l_body)

  // A pinned parameter (min === max) is one corner, not two -- matching
  // `SweepParam.bounds` on the Python side, so the count shown is the count
  // the backend runs.
  const corners = value
    .filter((p) => p.enabled)
    .reduce((n, p) => n * (bounds(p, axial, broadside).length), 1)
  const on = value.filter((p) => p.enabled).length

  return (
    <Card
      title="Corner sweep"
      subtitle="Endpoints only, not a sample."
      right={
        <Badge tone={corners > 64 ? 'warning' : 'neutral'}>
          {on} params → {corners} corners
        </Badge>
      }
    >
      <div className="space-y-2">
        {value.map((p, i) => {
          const derived = p.key === 'CdS_body'
          const [lo, hi] = derived ? [axial, broadside] : [p.min, p.max]
          return (
            <div key={p.key} className="flex items-center gap-2">
              <span className="w-6 shrink-0">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  title={derived
                    ? 'Off runs the axial bound only. Both attitudes matter - the band is 2.1x on the design load.'
                    : undefined}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                  className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                />
              </span>
              <span className={`flex-1 truncate text-xs ${p.enabled ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}>
                {p.label}
                {derived && (
                  <Info>
                    Derived from the airframe diameter and length,
                    so it tracks the vehicle and cannot disagree with it. Not editable:
                    this band is the largest single term in the model, and narrowing it
                    by hand is the one error the derived drag area exists to prevent.
                  </Info>
                )}
              </span>
              {derived ? (
                <span className={`flex w-[13.5rem] items-center justify-end gap-2 text-xs ${p.enabled ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-text-muted)] opacity-60'}`}
                      title="Axial and broadside bounds, derived from the vehicle - locked, not editable">
                  <span>{p.kind ? num(lo, p.kind, 5) : dec(lo, 5)}</span>
                  <span className="text-[var(--color-text-muted)]">…</span>
                  <span>{p.kind ? num(hi, p.kind, 5) : dec(hi, 5)}</span>
                </span>
              ) : (
                <>
                  {/* `step="any"` on both, overriding the registry: these are
                      bounds on an uncertainty band, not a measurement, so
                      snapping them to a spinner increment would be the wrong
                      kind of help. */}
                  <div className="w-24">
                    <Bound value={p.min} kind={p.kind} disabled={!p.enabled}
                           onChange={(v) => update(i, { min: v })} />
                  </div>
                  <span className="text-xs text-[var(--color-text-muted)]">…</span>
                  <div className="w-24">
                    <Bound value={p.max} kind={p.kind} disabled={!p.enabled}
                           onChange={(v) => update(i, { max: v })} />
                  </div>
                </>
              )}
              <span className="w-16 shrink-0 text-2xs text-[var(--color-text-muted)]">
                {p.kind ? lab(p.kind) : p.unit}
              </span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/** One end of a sweep bound. Rows with a `kind` convert; the dimensionless
 *  ones (Cx, n) and the one in seconds (delay) are shown as stored. */
function Bound({ value, kind, disabled, onChange }: {
  value: number
  kind?: Kind
  disabled: boolean
  onChange: (v: number) => void
}) {
  return kind
    ? <UnitInput value={value} kind={kind} step="any" disabled={disabled}
                 onChange={(v) => onChange(v ?? 0)} />
    : <NumberInput value={value} step="any" disabled={disabled}
                   onChange={(v) => onChange(v ?? 0)} />
}

/** Everything at once, in the order §11.3 lists it. */
export function InputColumn({ ui, onChange, design }: {
  ui: UiConfig
  onChange: (v: UiConfig) => void
  design: DesignSource
}) {
  return (
    <div className="space-y-4">
      <VehicleForm value={ui.vehicle} onChange={(v) => onChange({ ...ui, vehicle: v })}
                   design={design} sources={ui.sources}
                   onSourcesChange={(s) => onChange({ ...ui, sources: s })} />
      {/* The Site atmosphere moved to the top-level Environment tab (shared with the
          ascent). SweepForm is NOT here either: the corner bounds only affect the
          Corners tab, so they live with the sweep they control -- and keeping them off
          this column means editing them cannot trigger a simulate re-run. */}
    </div>
  )
}

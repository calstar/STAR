/**
 * What the study varies, and over what values.
 *
 * Two shapes, because the two kinds of question are different. A continuous
 * parameter -- deploy altitude, mass -- is a `linear` grid: start, stop, and
 * how many points, both ends included. A discrete one -- which canopy, solid
 * cloth or slotted -- is a `list`, because there is nothing halfway between an
 * Iris 48 and an Iris 60 and interpolating four correlated vendor fields would
 * invent a parachute nobody sells.
 *
 * Everything typed here is in the user's chosen units and stored SI, through
 * `UnitInput` -- the same boundary every other form in the app crosses.
 */

import { useEffect, useState } from 'react'
import { useReadOnly } from '@stardesign-ui'
import type { CatalogDevice, VendorCount } from '../../api/client'
import { getStationPad, listVendors, searchDevices } from '../../api/client'
import type {
  PadSource, UiConfig, UiSite, UiStudyAxis, WireCanopy, WirePad,
} from '../../types/schema'
import type { PadClimatology } from '../../lib/climatology'
import { SOURCES, usePadClimatology } from '../../lib/climatology'
import {
  MAX_RUNS, STUDY_VARS, axisKind, axisValues, isSiteKey, runCount, studyVar,
} from '../../lib/study'
import { monthName } from '../../lib/units'
import { useUnits } from '../../../lib/units/unitsContext'
import {
  Badge, Button, Card, Info, NumberInput, Select, TextInput, UnitInput,
} from '../ui'

let axisUid = 0
const nextUid = () => `a${(axisUid += 1)}`

/** The config value a new axis should be seeded from, so its first grid
 *  brackets something real instead of starting at zero. */
function currentValue(ui: UiConfig, key: string, device: string | null): number {
  if (studyVar(key)?.scope === 'vehicle') {
    return (ui.vehicle as unknown as Record<string, number>)[key] ?? 1
  }
  const d = ui.devices.find((x) => x.name === device)
  if (!d) return 1
  if (key === 'trigger') return d.trigger.value
  return (d as unknown as Record<string, number>)[key] ?? 1
}

export function AxisEditor({ ui, onChange }: {
  ui: UiConfig
  onChange: (v: UiConfig) => void
}) {
  const axes = ui.study
  // The same reduction the Site form resolves a run's pad state from, so a
  // month compared here and the same month selected there are one number.
  const clim = usePadClimatology()
  const set = (next: UiStudyAxis[]) => onChange({ ...ui, study: next })
  const patch = (uid: string, p: Partial<UiStudyAxis>) =>
    set(axes.map((a) => (a.uid === uid ? { ...a, ...p } : a)))

  const runs = runCount(axes)
  const over = runs > MAX_RUNS

  const add = () => {
    // Default to the canopy swap on the largest device: it is the question the
    // tab exists to answer, so it should take one click rather than two menus.
    const main = ui.devices.reduce(
      (a, b) => (b.CdS > a.CdS ? b : a), ui.devices[0])
    set([...axes, {
      uid: nextUid(), key: 'canopy', device: main?.name ?? null,
      enabled: true, mode: 'list',
      start: null, stop: null, points: null, values: null, canopies: [],
      pads: null,
    }])
  }

  return (
    <Card
      title="Sweeps"
      subtitle="Sweeps combine multiplicatively: every combination of values across all sweeps is run."
      right={
        <Badge tone={over ? 'danger' : runs > 1 ? 'accent' : 'neutral'}>
          {axes.filter((a) => a.enabled).length} sweeps → {runs} design{runs === 1 ? '' : 's'}
        </Badge>
      }
    >
      {axes.length === 0 ? (
        <p className="font-prose text-xs leading-relaxed text-[var(--color-text-muted)]">
          No sweeps yet. Add one to compare designs.
        </p>
      ) : (
        <div className="space-y-3">
          {axes.map((a) => (
            <AxisRow
              key={a.uid}
              axis={a}
              ui={ui}
              clim={clim}
              onPatch={(p) => patch(a.uid, p)}
              onRemove={() => set(axes.filter((x) => x.uid !== a.uid))}
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <Button onClick={add} variant="secondary">+ Add sweep</Button>
        {over && (
          <span className="text-xs text-red-300">
            {runs} designs is over the limit of {MAX_RUNS} - drop a sweep or use
            fewer points.
          </span>
        )}
      </div>
    </Card>
  )
}

function AxisRow({ axis, ui, clim, onPatch, onRemove }: {
  axis: UiStudyAxis
  ui: UiConfig
  clim: PadClimatology
  onPatch: (p: Partial<UiStudyAxis>) => void
  onRemove: () => void
}) {
  // Gated on the design's checkout: no token, no editing.
  const readOnly = useReadOnly()
  const meta = studyVar(axis.key)
  const kind = axisKind(axis, ui.devices)
  const values = axisValues(axis)
  const onSite = isSiteKey(axis.key)

  /** Switching variable rebuilds the grid rather than keeping the old numbers.
   *  Carrying a 152–457 range from a deploy altitude over to a canopy mass
   *  would silently ask for 400 kg of nylon. */
  const retarget = (key: string, device: string | null) => {
    const v = studyVar(key)
    const listOnly = v?.listOnly ?? false
    const cur = currentValue(ui, key, device)
    const site = isSiteKey(key)
    onPatch({
      key,
      device: v?.scope === 'device' ? device : null,
      mode: listOnly ? 'list' : 'linear',
      start: listOnly ? null : cur,
      stop: listOnly ? null : (cur * 1.5 || 1),
      points: listOnly ? null : 5,
      // Exactly one payload is non-null, and the backend rejects any axis
      // carrying two -- see `StudyAxis._check`. `j` is the list-only key whose
      // values ARE numbers, so it is the one that keeps `values`.
      values: listOnly && key !== 'canopy' && !site ? [] : null,
      canopies: key === 'canopy' ? [] : null,
      pads: site ? [] : null,
    })
  }

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={axis.enabled}
          disabled={readOnly}
          onChange={(e) => onPatch({ enabled: e.target.checked })}
          title="Off leaves this variable at its configured value"
          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
        />

        <div className="w-56">
          <Select
            value={axis.key}
            onChange={(k) => retarget(k, axis.device ?? ui.devices[0]?.name ?? null)}
            options={STUDY_VARS.map((v) => ({
              value: v.key,
              label: v.scope === 'device' ? v.label
                : `${v.scope === 'vehicle' ? 'Vehicle' : 'Site'} · ${v.label}`,
            }))}
          />
        </div>

        {/* Per-device variables need a target. Named, not indexed: it is what
            the table column says, and an index would retarget silently when a
            device is removed. */}
        {meta?.scope === 'device' && (
          <div className="w-32">
            <Select
              value={axis.device ?? ''}
              onChange={(d) => retarget(axis.key, d)}
              options={ui.devices.map((d) => ({ value: d.name, label: d.name }))}
            />
          </div>
        )}

        {!meta?.listOnly && (
          <div className="flex overflow-hidden rounded border border-[var(--color-border)]">
            {(['linear', 'list'] as const).map((m) => (
              <button
                key={m}
                type="button"
                disabled={readOnly}
                onClick={() => onPatch({
                  mode: m,
                  start: m === 'linear' ? (axis.start ?? currentValue(ui, axis.key, axis.device)) : null,
                  stop: m === 'linear' ? (axis.stop ?? null) : null,
                  points: m === 'linear' ? (axis.points ?? 5) : null,
                  values: m === 'list' ? (axis.values ?? []) : null,
                })}
                className={`px-2.5 py-1.5 text-xs transition-colors ${
                  axis.mode === m
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}

        {meta && <Info>{meta.help}</Info>}

        <span className="ml-auto flex items-center gap-2">
          <span className="text-2xs text-[var(--color-text-muted)]">
            {values.length} point{values.length === 1 ? '' : 's'}
          </span>
          <Button onClick={onRemove} variant="danger">remove</Button>
        </span>
      </div>

      <div className={`mt-3 ${axis.enabled ? '' : 'opacity-50'}`}>
        {axis.key === 'canopy' ? (
          <CanopyPicker
            chosen={axis.canopies ?? []}
            onChange={(c) => onPatch({ canopies: c })}
          />
        ) : axis.key === 'pad_source' ? (
          <PadSourcePicker
            chosen={axis.pads ?? []}
            site={ui.site}
            clim={clim}
            onChange={(p) => onPatch({ pads: p })}
          />
        ) : axis.key === 'pad_month' ? (
          <PadMonthPicker
            chosen={axis.pads ?? []}
            site={ui.site}
            clim={clim}
            onChange={(p) => onPatch({ pads: p })}
          />
        ) : axis.mode === 'linear' ? (
          <LinearFields axis={axis} kind={kind} onPatch={onPatch} />
        ) : (
          <ValueTiles
            values={axis.values ?? []}
            kind={kind}
            integer={meta?.integer ?? false}
            onChange={(v) => onPatch({ values: v })}
          />
        )}
      </div>

      {axis.key === 'canopy' && (
        /* The one thing about a canopy swap that is invisible and matters:
           `solver.integrate` takes body mass as total less every canopy mass,
           so a heavier canopy makes the body lighter rather than the vehicle
           heavier. Anyone who wants the other behaviour sweeps mass too. */
        <p className="mt-2 text-2xs text-[var(--color-text-muted)]">
          Canopy mass comes out of the descending mass, so a bigger chute does
          not raise the total on its own. Add a mass sweep if it should.
        </p>
      )}

      {onSite && (
        /* The one thing about a pad-state axis that is invisible and matters:
           it moves the air, not the vehicle. Every point re-fits eq (7) from
           its own pad state, so the numbers below are the same rocket in
           different atmospheres. */
        <p className="mt-2 text-2xs text-[var(--color-text-muted)]">
          Each point re-fits the atmosphere from its own pad state - same
          vehicle, different air. Thinner air means a faster descent and a
          harder landing on the same canopy.
        </p>
      )}
    </div>
  )
}

/**
 * The pad states already picked, as removable tiles.
 *
 * Shared by both site pickers because a `WirePad` reads the same either way:
 * the three numbers are what got compared, and showing them is what stops a
 * label like "KNID Mar" from being taken on trust. A null field is printed as
 * the word rather than left blank -- "standard" is a choice about the
 * atmosphere, and a blank cell reads as missing data.
 */
function PadTiles({ chosen, onChange }: {
  chosen: WirePad[]
  onChange: (v: WirePad[]) => void
}) {
  // Gated on the design's checkout: no token, no editing.
  const readOnly = useReadOnly()
  const { num, lab } = useUnits()
  if (!chosen.length) return null

  return (
    <div className="flex flex-wrap gap-1.5">
      {chosen.map((p, i) => (
        <span
          key={p.label}
          className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs"
        >
          <span className="text-[var(--color-text-primary)]">{p.label}</span>
          <span className="text-2xs text-[var(--color-text-muted)]">
            {p.T_pad === null ? 'standard T' : `${num(p.T_pad, 'temperature')} ${lab('temperature')}`}
            {' · '}
            {p.p_pad === null ? 'standard p' : `${num(p.p_pad, 'pressure')} ${lab('pressure')}`}
            {p.lapse !== null && ` · ${num(p.lapse, 'lapse')} ${lab('lapse')}`}
          </span>
          <button
            type="button"
            disabled={readOnly}
            onClick={() => onChange(chosen.filter((_, j) => j !== i))}
            aria-label={`Remove ${p.label}`}
            className="text-[var(--color-text-muted)] hover:text-red-300"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

/** The lapse rate every point of a pad-SOURCE axis carries.
 *
 *  The pressure source and the temperature profile are independent choices --
 *  §11.3 offers four of the first and two of the second -- so an axis that
 *  varied both would answer neither question. Every point takes the profile
 *  the Setup tab has now, which makes the comparison one-variable: only where
 *  T_pad and p_pad came from differs. */
const siteLapse = (site: UiSite) =>
  site.profile === 'measured' ? site.lapse : null

/**
 * Compare the four ways of knowing the pad state.
 *
 * Each option resolves to three numbers when it is added, and those numbers
 * are what travel -- see `WirePad`. Two of the four can fail to resolve and
 * both failures are honest ones worth showing rather than hiding: a barometer
 * reading nobody typed, and a METAR nobody answered. Neither may fall back to
 * the standard column, which would put ISA on screen under another name.
 */
function PadSourcePicker({ chosen, site, clim, onChange }: {
  chosen: WirePad[]
  site: UiSite
  clim: PadClimatology
  onChange: (v: WirePad[]) => void
}) {
  const [busy, setBusy] = useState<PadSource | null>(null)
  const [error, setError] = useState<string | null>(null)

  const label = (src: PadSource) => {
    const name = SOURCES.find((s) => s.value === src)?.label ?? src
    // The station is part of the identity for the two that have one: "monthly
    // normal" alone does not say whose record, and the axis may well compare
    // the same source at two stations.
    return src === 'climatology' ? `${site.station} ${monthName(site.month)} normal`
      : src === 'metar' ? `${site.station} METAR`
      : name
  }

  const has = (src: PadSource) => chosen.some((p) => p.label === label(src))

  /** Null when this source cannot produce numbers right now, with the reason.
   *  METAR is absent here because it is the one that needs a request. */
  const resolve = (src: PadSource): WirePad | string => {
    if (src === 'isa') {
      // Both null, exactly as `toWireConfig` sends them: "let the backend
      // compute it" rather than a number the UI guessed.
      return { label: label(src), T_pad: null, p_pad: null, lapse: siteLapse(site) }
    }
    if (src === 'barometer') {
      if (site.source !== 'barometer' || site.T_pad === null || site.p_pad === null) {
        return 'set the Setup tab to a pad barometer and type the reading first'
      }
      return {
        label: label(src), T_pad: site.T_pad, p_pad: site.p_pad,
        lapse: siteLapse(site),
      }
    }
    const row = clim.padNormals?.[site.station]?.[site.month]
    if (!row) return 'no monthly record for that station and month'
    return {
      label: label(src), T_pad: row.T, p_pad: row.p, lapse: siteLapse(site),
    }
  }

  const add = async (src: PadSource) => {
    setError(null)
    if (src === 'metar') {
      setBusy(src)
      const res = await getStationPad(site.station)
      setBusy(null)
      if (!res.data) {
        // No fallback. An observation that was never read is not an
        // observation, and labelling the standard column as one would be the
        // single most misleading thing this picker could do.
        setError(`could not resolve ${site.station}: ${res.error ?? 'lookup failed'}`)
        return
      }
      const { observed, T_pad, p_pad } = res.data
      onChange([...chosen, {
        label: label(src), T_pad, p_pad, lapse: siteLapse(site),
      }])
      if (p_pad === null) {
        setError(`${site.station} reported no usable altimeter setting - that `
          + 'point runs on the standard column pressure.')
      } else if (observed) {
        setError(null)
      }
      return
    }
    const got = resolve(src)
    if (typeof got === 'string') { setError(got); return }
    onChange([...chosen, got])
  }

  return (
    <div className="space-y-2">
      <PadTiles chosen={chosen} onChange={onChange} />

      <div className="flex flex-wrap gap-1.5">
        {SOURCES.map((s) => {
          const already = has(s.value)
          const why = s.value === 'metar' ? null : resolve(s.value)
          const blocked = typeof why === 'string' ? why : null
          return (
            <Button
              key={s.value}
              onClick={() => void add(s.value)}
              variant={already ? 'ghost' : 'secondary'}
              disabled={already || busy !== null || blocked !== null}
              title={blocked ?? undefined}
            >
              {already ? `${s.label} ✓`
                : busy === s.value ? `${s.label} - resolving…`
                : s.label}
            </Button>
          )
        })}
      </div>

      {error && (
        <p className="font-prose text-2xs leading-relaxed text-amber-300">{error}</p>
      )}

      <p className="text-2xs text-[var(--color-text-muted)]">
        Resolved when added, and the numbers are what travel - a station or
        month changed afterwards on the Setup tab does not move a point already
        here. Every point takes the temperature profile the Setup tab has now,
        so only the pressure source differs.
      </p>
    </div>
  )
}

/** Every month of the station record, in calendar order. */
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

/**
 * Compare seasons of one station's monthly normals.
 *
 * The same machinery as the source picker under a different question, so the
 * points are `WirePad` too -- but the selection is rebuilt from the twelve
 * buttons on every click rather than appended to, which is what keeps the
 * study in calendar order however the user clicks around. Months belonging to
 * a station that is no longer selected are kept, at the end, rather than
 * silently dropped: they are real points somebody chose.
 */
function PadMonthPicker({ chosen, site, clim, onChange }: {
  chosen: WirePad[]
  site: UiSite
  clim: PadClimatology
  onChange: (v: WirePad[]) => void
}) {
  // Gated on the design's checkout: no token, no editing.
  const readOnly = useReadOnly()
  const label = (m: number) => `${site.station} ${monthName(m)}`
  const mine = new Set(MONTHS.map(label))

  const padFor = (m: number): WirePad | null => {
    const row = clim.padNormals?.[site.station]?.[m]
    if (!row) return null
    const lapse = clim.lapseByMonth?.[m]
    return {
      label: label(m),
      T_pad: row.T,
      p_pad: row.p,
      // The lapse table is K/km; the schema wants K/m. Same conversion the
      // Site form does, and only when the profile asks for a measured slope --
      // otherwise the backend does its own eq (7) re-fit.
      lapse: site.profile === 'measured' && lapse ? lapse.L / 1000 : null,
    }
  }

  const selected = MONTHS.filter((m) => chosen.some((p) => p.label === label(m)))
  const foreign = chosen.filter((p) => !mine.has(p.label))

  const toggle = (m: number) => {
    const next = selected.includes(m)
      ? selected.filter((x) => x !== m)
      : [...selected, m].sort((a, b) => a - b)
    onChange([
      ...next.map(padFor).filter((p): p is WirePad => p !== null),
      ...foreign,
    ])
  }

  const missing = !clim.padNormals

  return (
    <div className="space-y-2">
      <PadTiles chosen={chosen} onChange={onChange} />

      <div className="flex flex-wrap gap-1">
        {MONTHS.map((m) => {
          const on = selected.includes(m)
          const row = clim.padNormals?.[site.station]?.[m]
          return (
            <button
              key={m}
              type="button"
              onClick={() => toggle(m)}
              disabled={!row || readOnly}
              title={row
                ? `${row.n.toLocaleString('en-US')} observations`
                : `no ${site.station} record for that month`}
              className={`rounded border px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
                on
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-text-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)]'
              }`}
            >
              {monthName(m).slice(0, 3)}
            </button>
          )
        })}
      </div>

      <p className="text-2xs text-[var(--color-text-muted)]">
        {missing
          ? 'The station record has not loaded - no months can be resolved.'
          : <>
              {site.station}, from the same record the Setup tab resolves a
              monthly normal from.{' '}
              {site.profile === 'measured'
                ? 'The measured lapse rate moves with the month too, so each point is one season of air.'
                : 'The temperature profile is set to the standard column, so only the pad state moves - switch it to Measured on the Setup tab for the seasonal lapse rate as well.'}
            </>}
      </p>
    </div>
  )
}

function LinearFields({ axis, kind, onPatch }: {
  axis: UiStudyAxis
  kind?: ReturnType<typeof axisKind>
  onPatch: (p: Partial<UiStudyAxis>) => void
}) {
  const { lab } = useUnits()
  const box = (value: number | null, set: (v: number | null) => void) =>
    kind
      ? <UnitInput value={value} onChange={set} kind={kind} disabled={!axis.enabled} />
      : <NumberInput value={value} onChange={set} step="any" disabled={!axis.enabled} />

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
          from {kind && `(${lab(kind)})`}
        </span>
        <div className="w-28">{box(axis.start, (v) => onPatch({ start: v }))}</div>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
          to {kind && `(${lab(kind)})`}
        </span>
        <div className="w-28">{box(axis.stop, (v) => onPatch({ stop: v }))}</div>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]"
              title="Both ends included: 5 points from 800 to 2000 gives 800, 1100, 1400, 1700, 2000.">
          points
        </span>
        <div className="w-20">
          <NumberInput
            value={axis.points} onChange={(v) => onPatch({ points: v })}
            step={1} min={1} disabled={!axis.enabled}
          />
        </div>
      </label>
    </div>
  )
}

/**
 * Type a value, press Enter, it becomes a tile. Backspace on an empty box
 * removes the last one.
 *
 * The tiles are the point: a list typed into one comma-separated text field is
 * unreviewable, and a mistyped separator silently halves the study.
 */
function ValueTiles({ values, kind, integer, onChange }: {
  values: number[]
  kind?: ReturnType<typeof axisKind>
  integer: boolean
  onChange: (v: number[]) => void
}) {
  // Gated on the design's checkout: no token, no editing.
  const readOnly = useReadOnly()
  const { val, si, num, lab, dec } = useUnits()
  const [draft, setDraft] = useState('')

  const commit = () => {
    const typed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(typed)) return
    // Typed in the display unit, stored SI -- the same boundary UnitInput
    // crosses, done by hand because this is not a single bound input.
    const value = kind ? si(typed, kind) : typed
    onChange([...values, integer ? Math.round(value) : value])
    setDraft('')
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((v, i) => (
        <span
          key={i}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
        >
          {kind ? num(v, kind) : dec(v, 4)}
          <button
            type="button"
            disabled={readOnly}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            aria-label={`Remove ${kind ? val(v, kind) : v}`}
            className="text-[var(--color-text-muted)] hover:text-red-300"
          >
            ×
          </button>
        </span>
      ))}
      <div className="w-32">
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          disabled={readOnly}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            if (e.key === 'Backspace' && draft === '' && values.length) {
              onChange(values.slice(0, -1))
            }
          }}
          onBlur={commit}
          placeholder={`value${kind ? ` (${lab(kind)})` : ''} ⏎`}
          className="w-full rounded border border-dashed border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>
    </div>
  )
}

/**
 * Pick several canopies from the catalogue.
 *
 * Leads with a vendor filter because comparing chutes is nearly always
 * comparing within one line, and the catalogue is six manufacturers deep. The
 * chosen rows become tiles carrying their vendor numbers -- see `WireCanopy`
 * for why the values travel rather than the SKU.
 */
function CanopyPicker({ chosen, onChange }: {
  chosen: WireCanopy[]
  onChange: (v: WireCanopy[]) => void
}) {
  // Gated on the design's checkout: no token, no editing.
  const readOnly = useReadOnly()
  const { num, lab } = useUnits()
  const [q, setQ] = useState('')
  const [vendor, setVendor] = useState('')
  const [rows, setRows] = useState<CatalogDevice[]>([])
  const [vendors, setVendors] = useState<VendorCount[]>([])

  useEffect(() => {
    listVendors().then((res) => setVendors(res.data ?? []))
  }, [])

  useEffect(() => {
    let live = true
    const id = setTimeout(() => {
      searchDevices(q, vendor).then((res) => { if (live) setRows(res.data ?? []) })
    }, 150) // debounce; the endpoint scans the CSV per keystroke otherwise
    return () => { live = false; clearTimeout(id) }
  }, [q, vendor])

  const has = (sku: string) => chosen.some((c) => c.label.endsWith(`(${sku})`))
  const add = (r: CatalogDevice) => {
    if (has(r.sku)) return
    onChange([...chosen, {
      // The SKU is in the label so two same-named sizes stay distinguishable
      // and `has()` has something exact to match on.
      label: `${r.name} (${r.sku})`,
      CdS: r.CdS, D0: r.D0, m_c: r.m_c, j: r.j,
    }])
  }

  return (
    <div className="space-y-2">
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((c, i) => (
            <span
              key={c.label}
              className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs"
            >
              <span className="text-[var(--color-text-primary)]">{c.label}</span>
              <span className="text-2xs text-[var(--color-text-muted)]">
                {num(c.CdS, 'area')} {lab('area')} · {num(c.m_c, 'mass')} {lab('mass')}
              </span>
              <button
                disabled={readOnly}
                type="button"
                onClick={() => onChange(chosen.filter((_, j) => j !== i))}
                aria-label={`Remove ${c.label}`}
                className="text-[var(--color-text-muted)] hover:text-red-300"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <div className="w-44">
          <Select
            value={vendor}
            onChange={setVendor}
            options={[
              { value: '', label: 'All vendors' },
              ...vendors.map((v) => ({
                value: v.vendor, label: `${v.vendor} (${v.count})`,
              })),
            ]}
          />
        </div>
        <div className="flex-1">
          <TextInput value={q} onChange={setQ} placeholder="search - e.g. iris 48" />
        </div>
      </div>

      {/* Scrolls in a fixed window: the catalogue is ~120 rows and rendering
          them inline pushed the rest of the editor off screen. */}
      <div className="max-h-44 overflow-y-auto rounded border border-[var(--color-border)]">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[var(--color-bg-secondary)] text-2xs uppercase text-[var(--color-text-muted)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-1 pl-2 pr-2 font-medium">device</th>
              <th className="py-1 pr-2 text-right font-medium">CdS</th>
              <th className="py-1 pr-2 text-right font-medium">D0</th>
              <th className="py-1 pr-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="py-2 text-center text-[var(--color-text-muted)]">
                No matches.
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.sku} className="border-b border-[var(--color-border)]/50">
                <td className="py-1.5 pl-2 pr-2">
                  <span className="text-[var(--color-text-primary)]">{r.name}</span>
                  <div className="text-2xs text-[var(--color-text-muted)]">
                    {r.vendor} · {r.sku}
                  </div>
                </td>
                <td className="py-1.5 pr-2 text-right">{num(r.CdS, 'area')}</td>
                <td className="py-1.5 pr-2 text-right">{num(r.D0, 'length')}</td>
                <td className="py-1.5 pr-2 text-right">
                  <Button
                    onClick={() => add(r)}
                    variant={has(r.sku) ? 'ghost' : 'secondary'}
                    disabled={has(r.sku)}
                  >
                    {has(r.sku) ? 'added' : 'add'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

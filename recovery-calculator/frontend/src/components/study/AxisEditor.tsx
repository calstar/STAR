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
import type { CatalogDevice, VendorCount } from '../../api/client'
import { listVendors, searchDevices } from '../../api/client'
import type { UiConfig, UiStudyAxis, WireCanopy } from '../../types/schema'
import {
  MAX_RUNS, STUDY_VARS, axisKind, axisValues, runCount, studyVar,
} from '../../lib/study'
import { useUnits } from '../../lib/unitsContext'
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
    }])
  }

  return (
    <Card
      title="Sweeps"
      subtitle="Each sweep is one variable and the values it takes. Two sweeps make a grid — every combination is run."
      right={
        <Badge tone={over ? 'danger' : runs > 1 ? 'accent' : 'neutral'}>
          {axes.filter((a) => a.enabled).length} sweeps → {runs} design{runs === 1 ? '' : 's'}
        </Badge>
      }
    >
      {axes.length === 0 ? (
        <p className="font-prose text-xs leading-relaxed text-[var(--color-text-muted)]">
          No sweeps yet. Add one to compare designs — the obvious first question
          is a canopy swap: pick three or four chutes and see what each does to
          impact energy.
        </p>
      ) : (
        <div className="space-y-3">
          {axes.map((a) => (
            <AxisRow
              key={a.uid}
              axis={a}
              ui={ui}
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
            {runs} designs is over the limit of {MAX_RUNS} — drop a sweep or use
            fewer points.
          </span>
        )}
      </div>
    </Card>
  )
}

function AxisRow({ axis, ui, onPatch, onRemove }: {
  axis: UiStudyAxis
  ui: UiConfig
  onPatch: (p: Partial<UiStudyAxis>) => void
  onRemove: () => void
}) {
  const meta = studyVar(axis.key)
  const kind = axisKind(axis, ui.devices)
  const values = axisValues(axis)

  /** Switching variable rebuilds the grid rather than keeping the old numbers.
   *  Carrying a 152–457 range from a deploy altitude over to a canopy mass
   *  would silently ask for 400 kg of nylon. */
  const retarget = (key: string, device: string | null) => {
    const v = studyVar(key)
    const listOnly = v?.listOnly ?? false
    const cur = currentValue(ui, key, device)
    onPatch({
      key,
      device: v?.scope === 'device' ? device : null,
      mode: listOnly ? 'list' : 'linear',
      start: listOnly ? null : cur,
      stop: listOnly ? null : (cur * 1.5 || 1),
      points: listOnly ? null : 5,
      values: listOnly && key !== 'canopy' ? [] : null,
      canopies: key === 'canopy' ? [] : null,
    })
  }

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={axis.enabled}
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
              label: v.scope === 'vehicle' ? `Vehicle · ${v.label}` : v.label,
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
          <TextInput value={q} onChange={setQ} placeholder="search — e.g. iris 48" />
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

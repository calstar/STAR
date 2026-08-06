/**
 * The device cards and the catalog picker.
 *
 * PLAN.md §11.3 calls the picker the highest-value control in the application,
 * and the reason is specific: it removes the §4.1 trap by construction. Fruity
 * Chutes' published `area_projected` EXCLUDES the spill hole, so anyone who
 * recomputes S_p as pi*D^2/4 and multiplies by the vendor's Cd overstates CdS
 * by 3.2%. Nobody who picks a row can make that mistake.
 *
 * So an overridden field keeps showing the vendor value it replaced. Losing
 * the badge is the point -- it should feel like giving something up.
 */

import { useEffect, useState } from 'react'
import type { CatalogDevice } from '../../api/client'
import { searchDevices } from '../../api/client'
import type { TriggerKind, UiDevice } from '../../types/schema'
import { blankDevice } from '../../lib/serialise'
import { Badge, Band, Button, Card, Field, NumberInput, Select, TextInput, Toggle, UnitInput } from '../ui'
import { G0 } from '../../lib/units'
import { useUnits } from '../../lib/unitsContext'

/** The four fields a catalog pick fills in. Must stay in step with
 *  `CatalogProvenance.values` in the schema types. */
type CatalogField = 'CdS' | 'D0' | 'm_c' | 'j'

export function DeviceList({ devices, onChange }: {
  devices: UiDevice[]
  onChange: (v: UiDevice[]) => void
}) {
  const update = (uid: string, patch: Partial<UiDevice>) =>
    onChange(devices.map((d) => (d.uid === uid ? { ...d, ...patch } : d)))

  const remove = (uid: string) => onChange(devices.filter((d) => d.uid !== uid))

  const add = () => onChange([...devices, blankDevice(`device ${devices.length + 1}`)])

  return (
    <Card
      title={`Devices (${devices.length})`}
      right={<Button onClick={add} variant="secondary">+ Add device</Button>}
    >
      {devices.length === 0 && (
        <p className="font-prose text-xs text-[var(--color-text-muted)]">
          At least one device is required.
        </p>
      )}

      <div className="space-y-3">
        {devices.map((d, i) => (
          <DeviceCard
            key={d.uid}
            device={d}
            index={i}
            count={devices.length}
            onChange={(patch) => update(d.uid, patch)}
            onRemove={() => remove(d.uid)}
          />
        ))}
      </div>

    </Card>
  )
}

function DeviceCard({ device, index, count, onChange, onRemove }: {
  device: UiDevice
  index: number
  count: number
  onChange: (patch: Partial<UiDevice>) => void
  onRemove: () => void
}) {
  const [picking, setPicking] = useState(false)
  const { q, dec, lab } = useUnits()

  const set = <K extends keyof UiDevice>(k: K, v: UiDevice[K]) => onChange({ [k]: v } as Partial<UiDevice>)

  /** Typing over a catalog-filled field strips the badge but keeps the vendor
   *  number, so the card can keep showing what was replaced. */
  const setCatalogField = (k: CatalogField, v: number) => {
    const patch: Partial<UiDevice> = { [k]: v } as Partial<UiDevice>
    if (device.catalog && !device.catalog.overridden.includes(k)
        && device.catalog.values[k] !== v) {
      patch.catalog = {
        ...device.catalog,
        overridden: [...device.catalog.overridden, k],
      }
    }
    onChange(patch)
  }

  const applyCatalog = (row: CatalogDevice) => {
    onChange({
      name: device.name === 'device' || /^device \d+$/.test(device.name)
        ? row.name : device.name,
      CdS: row.CdS, D0: row.D0, m_c: row.m_c, j: row.j,
      catalog: {
        sku: row.sku, vendor: row.vendor,
        values: { CdS: row.CdS, D0: row.D0, m_c: row.m_c, j: row.j },
        overridden: [],
      },
    })
    setPicking(false)
  }

  const badge = (k: CatalogField) => {
    if (!device.catalog) return undefined
    const overridden = device.catalog.overridden.includes(k)
    const vendor = device.catalog.values[k]
    if (overridden) {
      return (
        <span className="text-amber-400/80">
          overrides {device.catalog.vendor} {dec(vendor, 4)}
        </span>
      )
    }
    return <span className="text-blue-400/80">from {device.catalog.sku}</span>
  }

  // Filling distance, and the descent speed at line stretch (v_s) below which
  // the infinite-mass opening figure stops being an upper bound. Nothing to do
  // with the snatch load, which is driven by v_rel -- see eq (34).
  const s_f = device.n * device.D0
  const v_floor = Math.sqrt(G0 * s_f)

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
      {/* The whole bar toggles, not just the caret -- a 12px chevron is a mean
          click target. The name field and the action buttons sit inside it, so
          they stopPropagation rather than being moved out; keeping them on one
          row is the point of the bar. */}
      <header
        onClick={() => set('collapsed', !device.collapsed)}
        className="flex cursor-pointer select-none items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 hover:bg-[var(--color-bg-secondary)]/60"
        title={device.collapsed ? 'Expand' : 'Collapse'}
      >
        <span className="text-xs text-[var(--color-text-muted)]">
          {device.collapsed ? '▸' : '▾'}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]"
              title="List position only. Deployment order is set by each device's trigger, not by this.">
          {index + 1}
        </span>
        <div className="w-44" onClick={(e) => e.stopPropagation()}>
          <TextInput value={device.name} onChange={(v) => set('name', v)} />
        </div>
        {device.catalog && (
          <Badge tone={device.catalog.overridden.length ? 'warning' : 'accent'}
                 title={`${device.catalog.vendor} ${device.catalog.sku}`}>
            {device.catalog.sku}
          </Badge>
        )}
        <span
          className="ml-auto flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-2xs text-[var(--color-text-muted)]">
            CdS {q(device.CdS, 'area', 3)} · {device.trigger.kind === 'ALTITUDE'
              ? q(device.trigger.value, 'altitude')
              : `t+${dec(device.trigger.value, 1)} s`}
          </span>
          <Button onClick={onRemove} variant="danger" disabled={count <= 1}
                  title={count <= 1 ? 'At least one device is required' : 'Remove'}>
            ✕
          </Button>
        </span>
      </header>

      {!device.collapsed && (
        <div className="space-y-5 p-3">
          <div className="flex items-center gap-2">
            <Button onClick={() => setPicking((p) => !p)} variant="primary">
              {picking ? 'Close catalog' : 'Pick from catalog'}
            </Button>
            {device.catalog && (
              <Button onClick={() => set('catalog', null)} variant="ghost"
                      title="Forget the catalog link; keeps current values">
                Detach
              </Button>
            )}
          </div>

          {picking && <CatalogPicker onPick={applyCatalog} />}

          <FieldGroup label="Drag and geometry">
            <Field label="Drag area (CdS)" kind="area" hint={badge('CdS')}>
              <UnitInput value={device.CdS} kind="area"
                         onChange={(v) => setCatalogField('CdS', v ?? 0)} />
            </Field>
            <Field label="Nominal diameter (D0)" kind="length" hint={badge('D0')}>
              <UnitInput value={device.D0} kind="length"
                         onChange={(v) => setCatalogField('D0', v ?? 0)} />
            </Field>
            <Field label="Canopy, lines and bag (m_c)" kind="mass" hint={badge('m_c')}>
              <UnitInput value={device.m_c} kind="mass"
                         onChange={(v) => setCatalogField('m_c', v ?? 0)} />
            </Field>
            <Field label="Area growth exponent (j)" hint={badge('j')}>
              <Select
                value={String(device.j)}
                onChange={(v) => setCatalogField('j', Number(v))}
                options={[
                  { value: '2', label: '2 - solid cloth' },
                  { value: '1', label: '1 - slotted' },
                ]}
              />
            </Field>
          </FieldGroup>

          {/* Neither of these is a vendor datum and neither has ever been
              measured for this hardware. PLAN.md §15.3 records n as "swept
              6-12, never measured" and §15.4 records Cx as "[1.2, 1.8],
              unmeasured -- the dominant term". Presenting them as ordinary
              numeric inputs implies a precision nobody has, so they show as
              BANDS by default, with the value the nominal run uses.

              The corner sweep (§11.9) covers both ranges regardless, so
              typing a number here only moves the nominal case -- it does not
              narrow anything.

              Unlock is deliberate friction: §14 item 4 says one instrumented
              flight collapses every band in §11 into measured numbers, and
              that is the only thing that should turn these into inputs. */}
          <FieldGroup label="Inflation (unmeasured, estimated bands)">
            <Field label="Filling constant (n)" unit="diameters"
                   hint={device.measured
                     ? `measured - filling distance ${q(s_f, 'length')}`
                     : 'Hardcoded default.'}>
              {device.measured
                ? <NumberInput value={device.n} step={0.5} min={0.1}
                               onChange={(v) => set('n', v ?? 8)} />
                : <Band low={6} high={12} value={device.n} unit="" />}
            </Field>
            <Field label="Opening force coefficient (Cx)"
                   hint={device.measured
                     ? 'measured from flight data'
                     : 'Hardcoded default.'}>
              {device.measured
                ? <NumberInput value={device.Cx} step={0.05} min={1}
                               onChange={(v) => set('Cx', v ?? 1.8)} />
                : <Band low={1.2} high={1.8} value={device.Cx} unit="" />}
            </Field>
            <Field wide label="">
              <Toggle
                checked={device.measured}
                onChange={(v) => set('measured', v)}
                label="I have flight data for this canopy"
              />
            </Field>
          </FieldGroup>

          <FieldGroup label="Deployment">
            <Field label="Trigger">
              <Select
                value={device.trigger.kind}
                onChange={(v) => set('trigger', { ...device.trigger, kind: v as TriggerKind })}
                options={[
                  { value: 'ALTITUDE', label: 'Altitude' },
                  { value: 'TIME', label: 'Time after apogee' },
                ]}
              />
            </Field>
            {/* Shares the `altitude` unit with the apogee on the vehicle
                card, deliberately: altimeters are set in one unit and the two
                numbers are read against each other, so letting them differ
                invites the wrong comparison. The stored trigger is metres
                whichever unit is chosen. */}
            <Field
              label={device.trigger.kind === 'ALTITUDE'
                ? 'Deploy altitude (z_d)' : 'Time after apogee (t_a)'}
              unit={device.trigger.kind === 'ALTITUDE'
                ? `${lab('altitude')} AGL` : 's'}
            >
              {device.trigger.kind === 'ALTITUDE' ? (
                <UnitInput
                  value={device.trigger.value}
                  kind="altitude"
                  min={0}
                  onChange={(v) => set('trigger', { ...device.trigger, value: v ?? 0 })}
                />
              ) : (
                <NumberInput
                  value={device.trigger.value}
                  step={0.1}
                  min={0}
                  onChange={(v) => set('trigger', { ...device.trigger, value: v ?? 0 })}
                />
              )}
            </Field>
            <Field
              label="Charge to line stretch (dt)"
              unit="s"
              wide
              hint={device.delay === 0
                ? 'free-packed. Bagged is 0.3–1.0 s - not a rounding term: +55% on drogue load at 0.5 s.'
                : 'bagged'}
            >
              <NumberInput value={device.delay} step={0.05} min={0}
                           onChange={(v) => set('delay', v ?? 0)} />
            </Field>
          </FieldGroup>

          <FieldGroup label="Harness">
            <Field
              label="Harness stiffness (k_eff)"
              kind="stiffness"
              hint={device.k_eff === null
                ? 'empty - snatch load is skipped entirely'
                : undefined}
            >
              <UnitInput value={device.k_eff} kind="stiffness"
                         onChange={(v) => set('k_eff', v)}
                         placeholder="empty - skip snatch" />
            </Field>
            <Field
              label="Separation velocity (v_rel)"
              kind="speed"
              hint="at line stretch, not the descent speed"
            >
              <UnitInput value={device.v_rel} kind="speed" min={0}
                         onChange={(v) => set('v_rel', v ?? 0)} />
            </Field>
          </FieldGroup>

          <p className="text-2xs text-[var(--color-text-muted)]"
             title="If v_s at line stretch falls below this, the infinite-mass opening figure stops being an upper bound and errs low.">
            Validity floor{' '}
            <span className="text-[var(--color-text-secondary)]">{q(v_floor, 'speed')}</span>
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * A titled group of fields inside a device card.
 *
 * The heading has to outrank the field labels sitting a few pixels below it.
 * It was once the `text-2xs` muted treatment the *table column headers* use --
 * right for a column label above its own data, wrong here, because it made a
 * section heading dimmer and smaller than the fields it introduced and the
 * hierarchy read upside down. Weight and letter-case alone were not enough
 * either, at the same size and colour tier.
 *
 * So it differs on every axis available: the brightest text tier against the
 * fields' secondary one, an accent tick anchoring the left edge, and a rule
 * under the full width so the heading visibly spans the group it opens.
 *
 * That rule is a bottom border rather than a flex spacer beside the label. A
 * spacer lands mid-heading the moment the text wraps, which "Inflation --
 * unmeasured bands, not data" does at this width.
 */
function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div data-field-group>
      <h4 className="mb-3 flex items-center gap-2 border-b border-[var(--color-border)] pb-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">
        <span aria-hidden
              className="h-3.5 w-0.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
        {label}
      </h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  )
}

function CatalogPicker({ onPick }: { onPick: (d: CatalogDevice) => void }) {
  const { num, lab } = useUnits()
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CatalogDevice[]>([])
  const [stub, setStub] = useState(false)

  useEffect(() => {
    let live = true
    const id = setTimeout(() => {
      searchDevices(q).then((res) => {
        if (!live) return
        setRows(res.data ?? [])
        setStub(!!res.stub)
      })
    }, 150) // debounce; the real endpoint scans a CSV per keystroke otherwise
    return () => { live = false; clearTimeout(id) }
  }, [q])

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex-1">
          <TextInput value={q} onChange={setQ} placeholder="search - e.g. iris 48" />
        </div>
        {stub && (
          <Badge tone="warning" title="The backend device endpoint is not up; this is a four-row placeholder, not the catalog.">
            placeholder list
          </Badge>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="py-2 text-center text-xs text-[var(--color-text-muted)]">
          No matches.
        </p>
      ) : (
        // The catalog is ~120 rows. Rendering them all inline pushed the rest
        // of the form off screen, so the list scrolls in a fixed window of
        // about five rows and the header stays put while it does.
        <div className="max-h-[13.5rem] overflow-y-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[var(--color-bg-secondary)] text-2xs uppercase text-[var(--color-text-muted)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-1 pr-2 font-medium">device</th>
              {/* These headers used to be bare symbols with unitless numbers
                  under them. A unit that can change has to be stated. */}
              <th className="py-1 pr-2 text-right font-medium">CdS ({lab('area')})</th>
              <th className="py-1 pr-2 text-right font-medium">D0 ({lab('length')})</th>
              <th className="py-1 pr-2 text-right font-medium">m_c ({lab('mass')})</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sku} className="border-b border-[var(--color-border)]/50">
                <td className="py-1.5 pr-2">
                  <span className="text-[var(--color-text-primary)]">{r.name}</span>
                  {r.manual && (
                    <Badge tone="warning" title="Hand-entered, not from a vendor scrape.">
                      manual
                    </Badge>
                  )}
                  <div className="text-2xs text-[var(--color-text-muted)]">
                    {r.vendor} · {r.sku}
                  </div>
                </td>
                <td className="py-1.5 pr-2 text-right">{num(r.CdS, 'area', 3)}</td>
                <td className="py-1.5 pr-2 text-right">{num(r.D0, 'length', 3)}</td>
                <td className="py-1.5 pr-2 text-right">{num(r.m_c, 'mass', 3)}</td>
                <td className="py-1.5 text-right">
                  <Button onClick={() => onPick(r)} variant="secondary">Use</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}

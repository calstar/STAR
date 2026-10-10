/**
 * The Ejection & Pins tab: shear pins, ejection charges and avionics-bay vent
 * holes for each separation joint.
 *
 * Replaces the mastersheets' `4) Ejection Charges & Shear Pin` and `5) Vent Hole
 * Sizing`. A joint is sized from what it has to hold, not from a chosen
 * pressure: the pins hold the largest load that tries to open it (drag
 * separation at burnout, trapped bay pressure, the drogue's opening load) at
 * their weakest, and the charge shears them at their strongest. The physics is
 * physics/ejection.py; this file only collects inputs and renders the result.
 *
 * Inputs live on `ui.ejection`, so they save and version with the design.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  DesignSource, EjectionInputs, EjectionResult, JointResult, PinSpec, UiConfig, UiJoint,
} from '../../types/schema'
import { getPinCatalog, runEjection } from '../../api/client'
import { blankJoint, toEjectionRequest } from '../../lib/serialise'
import { useUnits } from '../../../lib/units/unitsContext'
import {
  Badge, Button, Card, Empty, Field, NumberInput, PageHeader, Select, Stat, TextInput,
  Toggle, UnitInput, WarningsCard,
} from '../ui'

function ColumnHeader({ children }: { children: ReactNode }) {
  return (
    <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
      {children}
    </h2>
  )
}

const ROLES: { value: UiJoint['role']; label: string }[] = [
  { value: 'drogue', label: 'Drogue' },
  { value: 'main', label: 'Main' },
  { value: 'other', label: 'Other' },
]

const LOAD_LABEL: Record<JointResult['governing'], string> = {
  drag: 'drag separation',
  trapped: 'trapped pressure',
  drogue: 'drogue opening',
  none: 'nothing',
}

/** 13/64, 1/4, 3/16: an n/64 reduced, the way a drill index reads. */
function sixtyFourths(n: number): string {
  let num = n
  let den = 64
  while (num % 2 === 0 && den > 1) { num /= 2; den /= 2 }
  return den === 1 ? `${num}` : `${num}/${den}`
}

export function EjectionPanel({ ui, onChange, design }: {
  ui: UiConfig
  onChange: (u: UiConfig) => void
  design: DesignSource
}) {
  const fromDesign = ui.sources.burnoutFromDesign
  const dragMissing = fromDesign && design.burnoutDrag == null
  const ej = ui.ejection
  const set = (patch: Partial<EjectionInputs>) => onChange({ ...ui, ejection: { ...ej, ...patch } })
  const setJoint = (i: number, patch: Partial<UiJoint>) =>
    set({ joints: ej.joints.map((j, k) => (k === i ? { ...j, ...patch } : j)) })

  const [catalog, setCatalog] = useState<PinSpec[]>([])
  useEffect(() => {
    getPinCatalog().then((res) => { if (res.data) setCatalog(res.data) })
  }, [])

  const [result, setResult] = useState<EjectionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const body = toEjectionRequest(ui)
  const key = JSON.stringify(body)
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    const id = setTimeout(() => {
      setRunning(true)
      runEjection(body).then((res) => {
        if (mine !== seq.current) return
        setRunning(false)
        if (res.data) { setResult(res.data); setError(null) }
        else { setError(res.error ?? 'ejection sizing failed'); setResult(null) }
      })
    }, 250)
    return () => clearTimeout(id)
    // `key` stands in for the request body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <div className="space-y-4">
      <PageHeader title="Ejection & Pins">
        Shear pins, black powder and vent holes for each separation joint. The pins hold the
        largest load that tries to open the joint before its charge fires; the charge then
        shears them with margin.
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[440px_1fr]">
        <div className="space-y-4">
          <ColumnHeader>Inputs</ColumnHeader>

          <Card title="Loads" subtitle="What tries to open a joint before its charge fires.">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Toggle checked={fromDesign}
                        onChange={(v) => onChange({ ...ui, sources: { ...ui.sources, burnoutFromDesign: v } })}
                        label="Burnout mass and drag from the ascent (Flight Dynamics)" />
              </div>
              <Field label="Mass at burnout" kind="mass"
                     hint={fromDesign
                       ? (design.burnoutMass == null ? 'No model loaded yet.' : 'Whole vehicle, from the ascent.')
                       : 'Whole vehicle, for drag separation.'}>
                <UnitInput kind="mass" min={0} value={ej.m_burnout} disabled={fromDesign}
                           onChange={(v) => set({ m_burnout: v ?? 0 })} />
              </Field>
              <Field label="Drag at burnout" kind="force"
                     hint={dragMissing
                       ? 'Run Flight Dynamics to fill this. Its airframe drag is a stub Cd(Mach) curve.'
                       : fromDesign ? 'From the Flight Dynamics run (stub Cd(Mach) curve).' : 'Whole vehicle, at peak drag.'}>
                <UnitInput kind="force" min={0} value={ej.D_burnout} disabled={fromDesign}
                           onChange={(v) => set({ D_burnout: v ?? 0 })} />
              </Field>
              <div className="col-span-2 space-y-2">
                <Toggle checked={ej.trapped_pressure}
                        onChange={(v) => set({ trapped_pressure: v })}
                        label="Trapped pressure: bays are sealed at pad pressure to apogee" />
                <Toggle checked={ej.dual_separation}
                        onChange={(v) => set({ dual_separation: v })}
                        label="Dual separation: drogue opening pulls on the main joint" />
              </div>
              <Field label="Hold safety factor" unit="×"
                     hint="On the pins' weakest strength.">
                <NumberInput value={ej.sf_hold} min={1} step={0.1}
                             onChange={(v) => set({ sf_hold: v ?? 0 })} />
              </Field>
              <Field label="Ejection safety factor" unit="×"
                     hint="On the pins' strongest strength.">
                <NumberInput value={ej.sf_eject} min={1} step={0.1}
                             onChange={(v) => set({ sf_eject: v ?? 0 })} />
              </Field>
            </div>
          </Card>

          {ej.joints.map((j, i) => (
            <Card key={i} title={j.name || `Joint ${i + 1}`}
                  right={
                    <Button variant="ghost" onClick={() =>
                      set({ joints: ej.joints.filter((_, k) => k !== i) })}>
                      Remove
                    </Button>
                  }>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name">
                  <TextInput value={j.name} onChange={(v) => setJoint(i, { name: v })} />
                </Field>
                <Field label="Opens for">
                  <Select value={j.role} options={ROLES}
                          onChange={(v) => setJoint(i, { role: v })} />
                </Field>
                <Field label="Bay inner diameter" kind="length">
                  <UnitInput kind="length" min={0} value={j.bay_id}
                             onChange={(v) => setJoint(i, { bay_id: v ?? 0 })} />
                </Field>
                <Field label="Bay free length" kind="length"
                       hint="The volume the charge fills.">
                  <UnitInput kind="length" min={0} value={j.bay_length}
                             onChange={(v) => setJoint(i, { bay_length: v ?? 0 })} />
                </Field>
                <Field label="Mass forward of joint" kind="mass" wide
                       hint="Everything ahead of the pins: nose cone, bays, canopies.">
                  <UnitInput kind="mass" min={0} value={j.m_forward}
                             onChange={(v) => setJoint(i, { m_forward: v ?? 0 })} />
                </Field>
              </div>
            </Card>
          ))}
          <Button onClick={() =>
            set({ joints: [...ej.joints, blankJoint(`Joint ${ej.joints.length + 1}`, 'other')] })}>
            Add joint
          </Button>

          <Card title="Avionics bay vent holes"
                subtitle="Static ports for the barometric altimeters.">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Inner diameter" kind="length">
                <UnitInput kind="length" min={0} value={ej.vent.bay_id}
                           onChange={(v) => set({ vent: { ...ej.vent, bay_id: v ?? 0 } })} />
              </Field>
              <Field label="Length" kind="length">
                <UnitInput kind="length" min={0} value={ej.vent.bay_length}
                           onChange={(v) => set({ vent: { ...ej.vent, bay_length: v ?? 0 } })} />
              </Field>
              <Field label="Holes" unit="count">
                <NumberInput value={ej.vent.n_holes} min={1} step={1}
                             onChange={(v) => set({ vent: { ...ej.vent, n_holes: Math.max(1, Math.round(v ?? 1)) } })} />
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <ColumnHeader>Outputs</ColumnHeader>
          <EjectionResults result={result} error={error} running={running}
                           catalog={catalog} chosen={ej.joints.map((j) => j.pin)}
                           onChoose={(i, pin) => setJoint(i, { pin })} />
        </div>
      </div>
    </div>
  )
}

function EjectionResults({ result, error, running, catalog, chosen, onChoose }: {
  result: EjectionResult | null; error: string | null; running: boolean
  catalog: PinSpec[]
  /** Each joint's chosen pin key, by index; null while undecided. */
  chosen: (string | null)[]
  onChoose: (joint: number, pin: string | null) => void
}) {
  const { num, q, lab } = useUnits()

  if (error) {
    return <Card title="Joints"><Empty>{error}. Ejection sizing needs the backend running.</Empty></Card>
  }
  if (!result) {
    return <Card title="Joints"><Empty>{running ? 'Computing…' : 'Computing ejection sizing…'}</Empty></Card>
  }

  const c = result.conditions
  const warnings = [...result.warnings, ...result.joints.flatMap((j) => j.warnings.map((w) => `${j.name}: ${w}`))]

  return (
    <>
      <Card title="Conditions"
            subtitle={`Trapped pressure is taken at apogee, ${q(c.h_apogee, 'altitude')} AGL: every joint has to hold it until its own charge fires.`}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Pad pressure" value={num(c.p_pad, 'pressure')} kind="pressure" />
          <Stat label="Apogee pressure" value={num(c.p_apogee, 'pressure')} kind="pressure" />
          <Stat label="Drogue opening" kind="force"
                value={c.drogue ? num(c.drogue.F, 'force') : '—'}
                hint={c.drogue ? `${c.drogue.device}, ${c.drogue.basis}, nominal axial run` : 'Not applied'} />
          <Stat label="Descending mass" value={num(c.m_descending, 'mass')} kind="mass" />
        </div>
      </Card>

      <WarningsCard warnings={warnings} />

      {result.joints.map((j, i) => (
        <Card key={i} title={j.name}
              subtitle={`Pins hold ${q(j.F_hold, 'force')}, set by ${LOAD_LABEL[j.governing]}. Pick the pin you will fit.`}
              right={<Badge tone="accent">{j.role}</Badge>}>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <LoadRow label="Drag separation" value={j.F_drag} active={j.governing === 'drag'} />
            <LoadRow label="Trapped pressure" value={j.F_trapped} active={j.governing === 'trapped'} />
            <LoadRow label="Drogue opening" value={j.F_drogue} active={j.governing === 'drogue'} />
          </div>
          <PinTable joint={j} chosen={chosen[i] ?? null}
                    onChoose={(pin) => onChoose(i, pin)} />
        </Card>
      ))}

      {result.vent && (
        <Card title="Avionics bay vent holes" subtitle={result.sources.vent}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label={`Each of ${result.vent.n_holes} holes`}
                  value={num(result.vent.d, 'smallLength')} kind="smallLength" />
            <Stat label="Nearest drill" value={sixtyFourths(result.vent.d_64ths)} unit="in" />
            <Stat label="Bay volume" value={num(result.vent.volume, 'volume')} kind="volume" />
          </div>
        </Card>
      )}

      {catalog.length > 0 && (
        <Card title="Pin strengths"
              subtitle="Pins are counted at the weakest, charges at the strongest. Replace with your own shear test.">
          <ul className="space-y-1 text-xs text-[var(--color-text-secondary)]">
            {catalog.map((p) => (
              <li key={p.key}>
                <span className="text-[var(--color-text-primary)]">{p.label}</span>{' '}
                <span className="font-num">{num(p.F_min, 'force')}–{num(p.F_max, 'force')} {lab('force')}</span>
                {' '}— {p.source}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="px-1 text-2xs leading-snug text-[var(--color-text-muted)]">
        Black powder: {result.sources.black_powder}. Assumes complete combustion in a sealed
        bay, so it is a starting load for ground testing, not a final one. Trapped pressure
        would also help the charge; that help is ignored.
      </p>
    </>
  )
}

function LoadRow({ label, value, active }: { label: string; value: number; active: boolean }) {
  const { num } = useUnits()
  return <Stat label={label} kind="force" tone={active ? 'warning' : undefined}
               value={num(value, 'force')} />
}

/** Every catalog pin for one joint: how many it takes and what charge shears
 *  them. The chosen row is the one the team fits; the rest stay for comparison. */
function PinTable({ joint, chosen, onChoose }: {
  joint: JointResult
  chosen: string | null
  onChoose: (pin: string | null) => void
}) {
  const { num, lab, dec } = useUnits()
  const th = 'px-2 py-1.5 text-left text-2xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]'
  const td = 'px-2 py-1.5 font-num'
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-[var(--color-border)]">
          <th className={th}>Pin</th>
          <th className={th}>Pins needed</th>
          <th className={th}>Hold margin</th>
          <th className={th}>Ejection pressure ({lab('pressure')})</th>
          <th className={th}>Bulkhead force ({lab('force')})</th>
          <th className={th}>Black powder ({lab('charge')})</th>
          <th className={th} />
        </tr>
      </thead>
      <tbody>
        {joint.options.map((o) => {
          const picked = o.key === chosen
          return (
            <tr key={o.key}
                className={`border-b border-[var(--color-border)] ${picked ? 'bg-emerald-500/10' : ''}`}>
              <td className="px-2 py-1.5 text-[var(--color-text-primary)]">{o.label}</td>
              <td className={`${td} text-lg`}>{o.n_pins}</td>
              <td className={td}>{o.hold_margin === null ? '—' : `${dec(o.hold_margin, 2)}×`}</td>
              <td className={`${td} ${o.high_pressure ? 'text-amber-400' : ''}`}
                  title={o.high_pressure ? 'Above 25 psi: check the bulkheads and airframe too' : undefined}>
                {num(o.P_eject, 'pressure')}
              </td>
              <td className={td}>{num(o.F_eject, 'force')}</td>
              <td className={`${td} ${picked ? 'text-green-400' : ''}`}>{num(o.m_bp, 'charge')}</td>
              <td className="px-2 py-1.5 text-right">
                <Button variant={picked ? 'primary' : 'secondary'}
                        onClick={() => onChoose(picked ? null : o.key)}>
                  {picked ? 'Chosen' : 'Use'}
                </Button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

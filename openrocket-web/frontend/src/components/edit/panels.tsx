/**
 * The per-type tab contents, after OpenRocket 24.12's configdialog/*Config.java.
 * Labels are messages.properties' strings.
 */
import type { ReactNode } from 'react'
import { Check, Combo, Group, Spinner } from '../swing'
import {
  AutoCheck, CheckField, ComboField, MaterialCombo, MaterialGroup, NumField, PlacementGroup, Row, Rows, Spacer, useEdit,
} from './fields'
import { bool, isAuto, motorMount, num, str } from '../../lib/params'
import { useUnits } from '../../workbench/units'
import { DEPLOY_EVENTS, IGNITION_EVENTS, SEPARATION_EVENTS, normEvent } from '../../lib/flightconfig'
import { FreeformShape } from './FreeformShape'

const DEG = Math.PI / 180

export const SHAPES = [
  { value: 'conical', label: 'Conical' },
  { value: 'ogive', label: 'Ogive' },
  { value: 'ellipsoid', label: 'Ellipsoid' },
  { value: 'power', label: 'Power series' },
  { value: 'parabolic', label: 'Parabolic series' },
  { value: 'haack', label: 'Haack series' },
]

// Shape.*.desc1 (nose cones) / desc2 (transitions)
const DESC: Record<string, [string, string]> = {
  conical: ['A conical nose cone has a profile of a triangle.', 'A conical transition has straight sides.'],
  ogive: [
    'An ogive nose cone has a profile that is a segment of a circle.  The shape parameter value 1 produces a <b>tangent ogive</b>, which has a smooth transition to the body tube, values less than 1 produce <b>secant ogives</b>.',
    'An ogive transition has a profile that is a segment of a circle.  The shape parameter value 1 produces a <b>tangent ogive</b>, which has a smooth transition to the body tube at the aft end, values less than 1 produce <b>secant ogives</b>.',
  ],
  ellipsoid: [
    'An ellipsoidal nose cone has a profile of a half-ellipse with major axes of lengths 2&times;<i>Length</i> and <i>Diameter</i>.',
    'An ellipsoidal transition has a profile of a half-ellipse with major axes of lengths 2&times;<i>Length</i> and <i>Diameter</i>.  If the transition is not clipped, then the profile is extended at the center by the corresponding radius.',
  ],
  power: [
    'A power series nose cone has a profile of <i>Radius</i>&nbsp;&times;&nbsp;(<i>x</i>&nbsp;/&nbsp;<i>Length</i>)<sup><i>k</i></sup> where <i>k</i> is the shape parameter.  For <i>k</i>=0.5 this is a <b>&frac12;-power</b> or <b>parabolic</b> nose cone, for <i>k</i>=0.75 a <b>&frac34;-power</b>, and for <i>k</i>=1 a <b>conical</b> nose cone.',
    'A power series transition has a profile of <i>Radius</i>&nbsp;&times;&nbsp;(<i>x</i>&nbsp;/&nbsp;<i>Length</i>)<sup><i>k</i></sup> where <i>k</i> is the shape parameter.  For <i>k</i>=0.5 the transition is <b>&frac12;-power</b> or <b>parabolic</b>, for <i>k</i>=0.75 a <b>&frac34;-power</b>, and for <i>k</i>=1 <b>conical</b>.',
  ],
  parabolic: [
    'A parabolic series nose cone has a profile of a parabola.  The shape parameter defines the segment of the parabola to utilize.  The shape parameter 1.0 produces a <b>full parabola</b> which is tangent to the body tube, 0.75 produces a <b>3/4 parabola</b>, 0.5 procudes a <b>1/2 parabola</b> and 0 produces a <b>conical</b> nose cone.',
    'A parabolic series transition has a profile of a parabola.  The shape parameter defines the segment of the parabola to utilize.  The shape parameter 1.0 produces a <b>full parabola</b> which is tangent to the body tube at the aft end, 0.75 produces a <b>3/4 parabola</b>, 0.5 procudes a <b>1/2 parabola</b> and 0 produces a <b>conical</b> transition.',
  ],
  haack: [
    'The Haack series nose cones are designed to minimize drag.  The shape parameter 0 produces an <b>LD-Haack</b> or <b>Von Karman</b> nose cone, which minimizes drag for fixed length and diameter, while a value of 0.333 produces an <b>LV-Haack</b> nose cone, which minimizes drag for fixed length and volume.',
    'The Haack series <i>nose cones</i> are designed to minimize drag.  These transition shapes are their equivalents, but do not necessarily produce optimal drag for transitions.  The shape parameter 0 produces an <b>LD-Haack</b> or <b>Von Karman</b> shape, while a value of 0.333 produces an <b>LV-Haack</b> shape.',
  ],
}

/** Shape parameter range per shape (Transition.Shape.min/maxParameter). */
const PARAM_RANGE: Record<string, [number, number] | null> = {
  conical: null,
  ogive: [0, 1],
  ellipsoid: null,
  power: [0, 1],
  parabolic: [0, 1],
  haack: [0, 1 / 3],
}

function Desc({ html, style }: { html: string; style?: React.CSSProperties }) {
  return <div className="orw-desc" style={style} dangerouslySetInnerHTML={{ __html: html }} />
}

function Cols({ children, gap = 46 }: { children: ReactNode; gap?: number }) {
  return <div style={{ display: 'flex', gap, alignItems: 'flex-start' }}>{children}</div>
}

// ── Nose cone & transition ──────────────────────────────────────────────

export function NoseConeGeneral() {
  const e = useEdit()
  const shape = str(e.c.params, 'shape', 'ogive')
  const range = PARAM_RANGE[shape]
  const r = num(e.c.params, 'aftradius', 0.025)
  return (
    <Cols gap={46}>
      <Rows>
        <Row label="Nose cone shape:">
          <ComboField k="shape" options={SHAPES} fallback="ogive" />
        </Row>
        <Row label="Shape parameter:">
          <NumField k="shapeparameter" kind="none" min={range?.[0] ?? 0} max={range?.[1] ?? 1} slider={range ?? [0, 1]} disabled={!range} width={64} />
        </Row>
        <Spacer />
        <Row label="Length:">
          <NumField k="length" />
        </Row>
        <Row label="Base diameter:" sub={<AutoCheck k="aftradius" />}>
          <NumField k="aftradius" scale={2} slider={[0, 0.25]} />
        </Row>
        <Row label="Wall thickness:" sub={<CheckField k="filled" label="Filled" title="Makes this component solid instead of hollow." />}>
          <NumField k="thickness" max={r} disabled={bool(e.c.params, 'filled')} slider={[0, Math.max(0.01, r)]} />
        </Row>
        <Spacer />
        <Row label={<CheckField k="isflipped" label="Flip to tail cone" title="Flips the nose cone direction to a tail cone." />}>
          <span />
        </Row>
      </Rows>
      <div style={{ width: 372, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Desc html={DESC[shape]?.[0] ?? ''} style={{ minHeight: 80 }} />
        <MaterialGroup />
      </div>
    </Cols>
  )
}

export function TransitionGeneral() {
  const e = useEdit()
  const shape = str(e.c.params, 'shape', 'conical')
  const range = PARAM_RANGE[shape]
  return (
    <Cols gap={46}>
      <Rows>
        <Row label="Transition shape:" sub={<CheckField k="clipped" label="Clipped" title="Changes the transition end tangency point from rounded to sharp." />}>
          <ComboField k="shape" options={SHAPES} fallback="conical" />
        </Row>
        <Row label="Shape parameter:">
          <NumField k="shapeparameter" kind="none" min={range?.[0] ?? 0} max={range?.[1] ?? 1} slider={range ?? [0, 1]} disabled={!range} width={64} />
        </Row>
        <Row label="Length:">
          <NumField k="length" />
        </Row>
        <Row label="Fore diameter:" sub={<AutoCheck k="foreradius" />}>
          <NumField k="foreradius" scale={2} slider={[0, 0.25]} />
        </Row>
        <Row label="Aft diameter:" sub={<AutoCheck k="aftradius" />}>
          <NumField k="aftradius" scale={2} slider={[0, 0.25]} />
        </Row>
        <Row label="Wall thickness:" sub={<CheckField k="filled" label="Filled" title="Makes this component solid instead of hollow." />}>
          <NumField k="thickness" disabled={bool(e.c.params, 'filled')} slider={[0, 0.01]} />
        </Row>
      </Rows>
      <div style={{ width: 372, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Desc html={DESC[shape]?.[1] ?? ''} style={{ minHeight: 80 }} />
        <MaterialGroup />
      </div>
    </Cols>
  )
}

export function ShoulderTab() {
  const e = useEdit()
  const ends = e.c.type === 'transition' ? (['fore', 'aft'] as const) : (['aft'] as const)
  return (
    <div style={{ display: 'flex', gap: 24 }}>
      {ends.map((end) => (
        <Group key={end} title={end === 'fore' ? 'Fore shoulder' : 'Aft shoulder'} style={{ padding: '6px 12px 14px' }}>
          <Rows style={{ marginTop: 6 }}>
            <Row label="Diameter:">
              <NumField k={`${end}shoulderradius`} scale={2} slider={[0, 0.25]} />
            </Row>
            <Row label="Length:">
              <NumField k={`${end}shoulderlength`} slider={[0, 0.2]} />
            </Row>
            <Row label="Thickness:" sub={<CheckField k={`${end}shouldercapped`} label="End capped" title="Whether the end of the shoulder is capped." />}>
              <NumField k={`${end}shoulderthickness`} slider={[0, 0.01]} />
            </Row>
          </Rows>
        </Group>
      ))}
    </div>
  )
}

// ── Tubes ────────────────────────────────────────────────────────────────

/** Inner diameter shown as 2(r - t); editing it sets the thickness. */
function InnerDiameter({ rKey, tKey }: { rKey: string; tKey: string }) {
  const e = useEdit()
  const r = isAuto(e.c.params[rKey]) ? (e.resolved(rKey) ?? num(e.c.params, rKey)) : num(e.c.params, rKey)
  const t = num(e.c.params, tKey)
  return (
    <Spinner
      value={Math.max(0, r - t)}
      kind="length"
      scale={2}
      min={0}
      max={r}
      slider={[0, Math.max(0.05, r)]}
      disabled={bool(e.c.params, 'filled')}
      onChange={(ri) => e.set(tKey, Math.max(0, r - ri))}
      ariaLabel="innerdiameter"
    />
  )
}

export function BodyTubeGeneral() {
  const e = useEdit()
  const r = isAuto(e.c.params.radius) ? (e.resolved('radius') ?? num(e.c.params, 'radius')) : num(e.c.params, 'radius')
  return (
    <Cols gap={38}>
      <Rows>
        <Row label="Length:">
          <NumField k="length" slider={[0, Math.max(0.6, num(e.c.params, 'length') * 1.2)]} />
        </Row>
        <Row label="Outer diameter:" sub={<AutoCheck k="radius" />}>
          <NumField k="radius" scale={2} slider={[0, 0.25]} />
        </Row>
        <Row label="Inner diameter:">
          <InnerDiameter rKey="radius" tKey="thickness" />
        </Row>
        <Row label="Wall thickness:" sub={<CheckField k="filled" label="Filled" title="Changes the body tube from a hollow tube to a solid rod." />}>
          <NumField k="thickness" max={r} disabled={bool(e.c.params, 'filled')} slider={[0, 0.01]} />
        </Row>
      </Rows>
      <div style={{ width: 366 }}>
        <MaterialGroup />
      </div>
    </Cols>
  )
}

export function MotorTab() {
  const e = useEdit()
  const mm = motorMount(e.c.params)
  const set = (patch: Record<string, unknown>) => e.set('motormount', { ...(mm ?? {}), ...patch })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Check
        label="This component is a motor mount"
        checked={!!mm}
        onChange={(on) => e.set('motormount', on ? { ignitionevent: 'automatic', ignitiondelay: 0, overhang: 0 } : undefined)}
      />
      <Rows>
        <Row label="Motor overhang:">
          <Spinner value={mm?.overhang ?? 0} kind="length" min={-1} disabled={!mm} slider={[-0.05, 0.05]} onChange={(v) => set({ overhang: v })} />
        </Row>
        <Row label="Ignition at:">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Combo
              value={normEvent(mm?.ignitionevent, 'automatic')}
              disabled={!mm}
              style={{ width: 300 }}
              onChange={(v) => set({ ignitionevent: v })}
              options={IGNITION}
            />
            plus
            <Spinner value={mm?.ignitiondelay ?? 0} kind="none" min={0} disabled={!mm} width={60} onChange={(v) => set({ ignitiondelay: v })} />
            seconds
          </span>
        </Row>
      </Rows>
      <div style={{ color: '#555', fontSize: 13 }}>The motors are chosen per flight configuration in the Motors &amp; Configuration tab.</div>
    </div>
  )
}

// .ork names (OpenRocketSaver.enumToXMLName): `ejectioncharge`, not `ejection`.
export const IGNITION = IGNITION_EVENTS.map(({ value, label }) => ({ value, label }))

export function ThicknessRingGeneral({ autoOuter, motor }: { autoOuter?: boolean; motor?: boolean }) {
  return (
    <Cols gap={38}>
      <Rows>
        <Row label="Length:">
          <NumField k="length" slider={[0, 0.3]} />
        </Row>
        <Row label="Outer diameter:" sub={autoOuter ? <AutoCheck k="outerradius" /> : undefined}>
          <NumField k="outerradius" scale={2} slider={[0, 0.2]} />
        </Row>
        <Row label="Inner diameter:">
          <InnerDiameter rKey="outerradius" tKey="thickness" />
        </Row>
        <Row label="Wall thickness:">
          <NumField k="thickness" slider={[0, 0.01]} />
        </Row>
        {motor && <Spacer />}
      </Rows>
      <div style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <PlacementGroup />
        <MaterialGroup finish={false} />
      </div>
    </Cols>
  )
}

export function RadiusRingGeneral({ inner }: { inner: boolean }) {
  return (
    <Cols gap={38}>
      <Rows>
        <Row label={inner ? 'Thickness:' : 'Thickness:'}>
          <NumField k="length" slider={[0, 0.02]} />
        </Row>
        <Row label="Outer diameter:" sub={<AutoCheck k="outerradius" />}>
          <NumField k="outerradius" scale={2} slider={[0, 0.2]} />
        </Row>
        {inner && (
          <Row label="Inner diameter:" sub={<AutoCheck k="innerradius" />}>
            <NumField k="innerradius" scale={2} slider={[0, 0.2]} />
          </Row>
        )}
        <Spacer />
        <Row label="Instance Count:">
          <NumField k="instancecount" kind="none" min={1} slider={null} width={60} fallback={1} />
        </Row>
        <Row label="Instance Separation:">
          <NumField k="instanceseparation" slider={null} />
        </Row>
      </Rows>
      <div style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <PlacementGroup />
        <MaterialGroup finish={false} />
      </div>
    </Cols>
  )
}

export function RadialTab() {
  const e = useEdit()
  return (
    <Rows>
      <Row label="Radial distance:">
        <NumField k="radialposition" slider={[0, 0.1]} />
      </Row>
      <Row label="Radial direction:">
        <NumField k="radialdirection" kind="angle" min={-Math.PI} max={Math.PI} slider={[-Math.PI, Math.PI]} />
      </Row>
      <Row>
        <button
          type="button"
          className="orw-btn"
          onClick={() => e.setParams((p) => ({ ...p, radialposition: 0, radialdirection: 0 }), 'radial')}
        >
          Reset
        </button>
      </Row>
    </Rows>
  )
}

// ── Fins ─────────────────────────────────────────────────────────────────

const CROSS = [
  { value: 'square', label: 'Square' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'airfoil', label: 'Airfoil' },
]

function FinCommonRight() {
  return (
    <div style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PlacementGroup fallback="bottom">
        <Row label="Fin rotation:">
          <NumField k="angleoffset" kind="angle" min={-Math.PI} max={Math.PI} slider={[-Math.PI, Math.PI]} />
        </Row>
      </PlacementGroup>
      <MaterialGroup />
      <Group title="Root Fillets" style={{ padding: '6px 8px 12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Fillet radius:
            <NumField k="filletradius" slider={[0, 0.02]} />
          </span>
          <span style={{ marginTop: 6 }}>Fillet material:</span>
          <MaterialCombo k="filletmaterial" type="bulk" width={306} />
        </div>
      </Group>
    </div>
  )
}

function FinCountCant() {
  return (
    <>
      <Row label="Number of fins:">
        <NumField k="fincount" kind="none" min={1} max={8} slider={null} width={64} fallback={3} />
      </Row>
      <Row label="Fin cant:">
        <NumField k="cant" kind="angle" min={-15 * DEG} max={15 * DEG} slider={[-15 * DEG, 15 * DEG]} />
      </Row>
    </>
  )
}

function FinSection() {
  return (
    <>
      <Spacer />
      <Row label="Fin cross section:">
        <ComboField k="crosssection" options={CROSS} fallback="square" />
      </Row>
      <Row label="Thickness:">
        <NumField k="thickness" slider={[0, 0.01]} />
      </Row>
    </>
  )
}

export function TrapezoidGeneral() {
  const e = useEdit()
  const h = num(e.c.params, 'height', 0.03)
  const sw = num(e.c.params, 'sweeplength', 0.025)
  return (
    <Cols gap={52}>
      <Rows style={{ rowGap: 12 }}>
        <FinCountCant />
        <Row label="Root chord:">
          <NumField k="rootchord" slider={[0, 0.2]} />
        </Row>
        <Row label="Tip chord:">
          <NumField k="tipchord" slider={[0, 0.2]} />
        </Row>
        <Row label="Height:">
          <NumField k="height" slider={[0, 0.2]} />
        </Row>
        <Row label="Sweep length:">
          <NumField k="sweeplength" min={-Infinity} slider={[-0.1, 0.1]} />
        </Row>
        <Row label="Sweep angle:">
          <Spinner
            value={Math.atan2(sw, h)}
            kind="angle"
            min={-80 * DEG}
            max={80 * DEG}
            slider={[-80 * DEG, 80 * DEG]}
            onChange={(a) => e.set('sweeplength', h * Math.tan(a))}
            ariaLabel="sweepangle"
          />
        </Row>
        <FinSection />
      </Rows>
      <FinCommonRight />
    </Cols>
  )
}

export function EllipticalGeneral() {
  return (
    <Cols gap={52}>
      <Rows>
        <FinCountCant />
        <Row label="Root chord:">
          <NumField k="rootchord" slider={[0, 0.2]} />
        </Row>
        <Row label="Height:">
          <NumField k="height" slider={[0, 0.2]} />
        </Row>
        <FinSection />
      </Rows>
      <FinCommonRight />
    </Cols>
  )
}

export function FreeformGeneral() {
  return (
    <Cols gap={52}>
      <Rows>
        <FinCountCant />
        <FinSection />
      </Rows>
      <FinCommonRight />
    </Cols>
  )
}

export { FreeformShape }

export function TubeFinGeneral() {
  return (
    <Cols gap={38}>
      <Rows>
        <Row label="Number of fins:">
          <NumField k="fincount" kind="none" min={1} slider={null} width={64} fallback={6} />
        </Row>
        <Row label="Length:">
          <NumField k="length" slider={[0, 0.2]} />
        </Row>
        <Row label="Outer diameter:" sub={<AutoCheck k="outerradius" />}>
          <NumField k="outerradius" scale={2} slider={[0, 0.1]} />
        </Row>
        <Row label="Inner diameter:">
          <InnerDiameter rKey="outerradius" tKey="thickness" />
        </Row>
        <Row label="Thickness:">
          <NumField k="thickness" slider={[0, 0.01]} />
        </Row>
      </Rows>
      <div style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <PlacementGroup fallback="bottom">
          <Row label="Fin rotation:">
            <NumField k="angleoffset" kind="angle" min={-Math.PI} max={Math.PI} slider={[-Math.PI, Math.PI]} />
          </Row>
        </PlacementGroup>
        <MaterialGroup />
      </div>
    </Cols>
  )
}

export function LaunchLugGeneral() {
  const e = useEdit()
  const r = num(e.c.params, 'radius', 0.005)
  return (
    <Cols gap={38}>
      <Rows>
        <Row label="Length:">
          <NumField k="length" slider={[0, 0.1]} />
        </Row>
        <Row label="Outer diameter:">
          <NumField k="radius" scale={2} slider={[0, 0.04]} />
        </Row>
        <Row label="Inner diameter:">
          <InnerDiameter rKey="radius" tKey="thickness" />
        </Row>
        <Row label="Thickness:">
          <NumField k="thickness" max={r} slider={[0, 0.005]} />
        </Row>
        <Spacer />
        <Row label="Instance Count:">
          <NumField k="instancecount" kind="none" min={1} slider={null} width={60} fallback={1} />
        </Row>
        <Row label="Instance Separation:">
          <NumField k="instanceseparation" slider={null} />
        </Row>
      </Rows>
      <div style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <PlacementGroup fallback="middle">
          <Row label="Rotation:">
            <NumField k="angleoffset" kind="angle" min={-Math.PI} max={Math.PI} slider={[-Math.PI, Math.PI]} />
          </Row>
        </PlacementGroup>
        <MaterialGroup />
      </div>
    </Cols>
  )
}

export function RailButtonGeneral() {
  return (
    <Cols gap={38}>
      <Rows>
        <Row label="Outer Diameter:">
          <NumField k="outerdiameter" slider={[0, 0.03]} />
        </Row>
        <Row label="Inner Diameter:">
          <NumField k="innerdiameter" slider={[0, 0.03]} />
        </Row>
        <Row label="Base Height:">
          <NumField k="baseheight" slider={[0, 0.01]} />
        </Row>
        <Row label="Flange Height:">
          <NumField k="flangeheight" slider={[0, 0.01]} />
        </Row>
        <Row label="Total Height (excl. screw):">
          <NumField k="totalheight" slider={[0, 0.03]} />
        </Row>
        <Row label="Screw Height:">
          <NumField k="screwheight" slider={[0, 0.03]} />
        </Row>
        <Spacer />
        <Row label="Instance Count:">
          <NumField k="instancecount" kind="none" min={1} slider={null} width={60} fallback={1} />
        </Row>
        <Row label="Instance Separation:">
          <NumField k="instanceseparation" slider={null} />
        </Row>
      </Rows>
      <div style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <PlacementGroup fallback="middle">
          <Row label="Rotation:">
            <NumField k="angleoffset" kind="angle" min={-Math.PI} max={Math.PI} slider={[-Math.PI, Math.PI]} />
          </Row>
        </PlacementGroup>
        <MaterialGroup />
      </div>
    </Cols>
  )
}

// ── Mass objects ─────────────────────────────────────────────────────────

const MASS_TYPES = [
  { value: 'masscomponent', label: 'Mass Component' },
  { value: 'altimeter', label: 'Altimeter' },
  { value: 'flightcomputer', label: 'Flight Computer' },
  { value: 'deploymentcharge', label: 'Deployment Charge' },
  { value: 'tracker', label: 'Tracker' },
  { value: 'payload', label: 'Payload' },
  { value: 'recoveryhardware', label: 'Recovery Hardware' },
  { value: 'battery', label: 'Battery' },
]

function PackedRows({ autoRadius = true }: { autoRadius?: boolean }) {
  return (
    <>
      <Row label="Packed length:">
        <NumField k="packedlength" slider={[0, 0.2]} />
      </Row>
      <Row label="Packed diameter:" sub={autoRadius ? <AutoCheck k="packedradius" /> : undefined}>
        <NumField k="packedradius" scale={2} slider={[0, 0.1]} />
      </Row>
    </>
  )
}

export function MassComponentGeneral() {
  const e = useEdit()
  const u = useUnits()
  const m = num(e.c.params, 'mass')
  const L = num(e.c.params, 'packedlength', 0.025)
  const r = num(e.c.params, 'packedradius', 0.0125)
  const vol = Math.PI * r * r * L
  return (
    <Cols gap={46}>
      <Rows>
        <Row label="Mass type:">
          <ComboField k="masscomponenttype" options={MASS_TYPES} fallback="masscomponent" />
        </Row>
        <Row label="Mass:">
          <NumField k="mass" kind="mass" slider={[0, Math.max(0.1, m * 2)]} />
        </Row>
        <Row label="Approximate density:">
          <span style={{ display: 'flex', alignItems: 'center' }}>
            <span className="orw-field" style={{ width: 92, display: 'inline-flex', alignItems: 'center', background: 'var(--or-bg)' }}>
              {vol > 0 ? u.fmt('bulkDensity', m / vol).split(' ')[0] : '—'}
            </span>
            <span className="orw-unit">{u.label('bulkDensity')}</span>
          </span>
        </Row>
        <Row label="Length:">
          <NumField k="packedlength" slider={[0, 0.2]} />
        </Row>
        <Row label="Diameter:" sub={isAuto(e.c.params.packedradius) ? <AutoCheck k="packedradius" /> : undefined}>
          <NumField k="packedradius" scale={2} slider={[0, 0.1]} />
        </Row>
      </Rows>
      <div style={{ width: 380 }}>
        <PlacementGroup />
      </div>
    </Cols>
  )
}

export function ShockCordGeneral() {
  return (
    <Cols gap={46}>
      <Rows>
        <Row label="Shock cord length:">
          <NumField k="cordlength" slider={[0, 2]} />
        </Row>
        <Row label="Shock cord material:">
          <MaterialCombo k="material" type="line" width={300} />
        </Row>
      </Rows>
      <div style={{ width: 380 }}>
        <PlacementGroup>
          <PackedRows />
        </PlacementGroup>
      </div>
    </Cols>
  )
}

const DEPLOY = DEPLOY_EVENTS.map(({ value, label }) => ({ value, label }))

function Deployment() {
  const e = useEdit()
  const ev = normEvent(str(e.c.params, 'deployevent', 'ejection'), 'ejection')
  return (
    <Group title="Deployment" style={{ padding: '6px 8px 12px' }}>
      <Rows style={{ marginTop: 4 }}>
        <Row label="Deploys at: ⁺">
          <ComboField k="deployevent" options={DEPLOY} fallback="ejection" width={272} />
        </Row>
        <Row label={<span style={{ display: 'block', textAlign: 'right' }}>plus</span>}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <NumField k="deploydelay" kind="none" slider={null} />
            seconds
          </span>
        </Row>
        <Row label={<span style={{ color: ev === 'altitude' ? undefined : 'var(--or-disabled-text)' }}>Altitude:⁺</span>}>
          <NumField k="deployaltitude" kind="altitude" disabled={ev !== 'altitude'} slider={[0, 1000]} />
        </Row>
      </Rows>
      <div style={{ fontSize: 12, marginTop: 10 }}>⁺ This parameter can be overridden in each flight configuration.</div>
    </Group>
  )
}

/** Parachute/streamer drag coefficient: auto stores {auto, value}; Reset returns to auto. */
function CdField() {
  const e = useEdit()
  const v = e.c.params.cd
  const a = isAuto(v) ? v : { auto: false, value: typeof v === 'number' ? v : 0.8 }
  const shown = a.auto ? (e.resolved('cd') ?? a.value) : a.value
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Spinner value={shown} min={0} width={70} step={0.05} onChange={(x) => e.set('cd', { auto: false, value: x })} ariaLabel="cd" />
      <button type="button" className="orw-btn" onClick={() => e.set('cd', { auto: true, value: shown })}>
        Reset
      </button>
    </span>
  )
}

export function ParachuteGeneral() {
  return (
    <Cols gap={30}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, width: 412 }}>
        <Group title="Canopy" style={{ padding: '6px 8px 12px' }}>
          <Rows style={{ marginTop: 4 }}>
            <Row label="Diameter:">
              <NumField k="diameter" slider={[0, 0.6]} />
            </Row>
          </Rows>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            <span>Material:</span>
            <MaterialCombo k="material" type="surface" width={394} />
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span>
                Drag coefficient C<sub>D</sub>:
              </span>
              <CdField />
            </span>
          </div>
        </Group>
        <Group title="Shroud lines" style={{ padding: '6px 8px 12px', width: 390 }}>
          <Rows style={{ marginTop: 4 }}>
            <Row label="Number of lines:">
              <NumField k="linecount" kind="none" min={0} slider={null} width={64} fallback={6} />
            </Row>
            <Row label="Line length:">
              <NumField k="linelength" slider={[0, 0.6]} />
            </Row>
          </Rows>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            <span>Material:</span>
            <MaterialCombo k="linematerial" type="line" width={372} />
          </div>
        </Group>
      </div>
      <div style={{ width: 372, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <PlacementGroup>
          <PackedRows />
        </PlacementGroup>
        <Deployment />
      </div>
    </Cols>
  )
}

export function StreamerGeneral() {
  const e = useEdit()
  const u = useUnits()
  const L = num(e.c.params, 'striplength', 0.5)
  const W = num(e.c.params, 'stripwidth', 0.05)
  return (
    <Cols gap={30}>
      <Rows>
        <Row label="Strip length:">
          <NumField k="striplength" slider={[0, 2]} />
        </Row>
        <Row label="Strip width:">
          <NumField k="stripwidth" slider={[0, 0.2]} />
        </Row>
        <Row label="Strip area:">
          <span>{u.fmt('area', L * W)}</span>
        </Row>
        <Row label="Aspect ratio:">
          <span>{W > 0 ? (L / W).toFixed(2) : '—'}</span>
        </Row>
        <Row label="Material:">
          <MaterialCombo k="material" type="surface" width={300} />
        </Row>
        <Row label={<span>Drag coefficient C<sub>D</sub>:</span>}>
          <CdField />
        </Row>
      </Rows>
      <div style={{ width: 372, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <PlacementGroup>
          <PackedRows />
        </PlacementGroup>
        <Deployment />
      </div>
    </Cols>
  )
}

// ── Assemblies and the rocket ────────────────────────────────────────────

const SEPARATION = SEPARATION_EVENTS.map(({ value, label }) => ({ value, label }))

export function SeparationTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span>Select when this stage separates:</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ComboField k="separationevent" options={SEPARATION} fallback="ejection" width={300} />
        plus
        <NumField k="separationdelay" kind="none" slider={null} />
        seconds
      </span>
    </div>
  )
}

export function PodGeneral() {
  return (
    <Cols gap={38}>
      <Rows>
        <Row label="Number of Copies:">
          <NumField k="instancecount" kind="none" min={1} slider={null} width={60} fallback={2} />
        </Row>
        <Row label="Radial Distance:">
          <NumField k="radiusoffset" min={-Infinity} slider={[0, 0.2]} />
        </Row>
        <Row label="Angle:">
          <NumField k="angleoffset" kind="angle" min={-Math.PI} max={Math.PI} slider={[-Math.PI, Math.PI]} />
        </Row>
      </Rows>
      <div style={{ width: 380 }}>
        <PlacementGroup fallback="bottom" />
      </div>
    </Cols>
  )
}

export function RocketGeneral() {
  const e = useEdit()
  const text = (k: string, multi?: boolean) =>
    multi ? (
      <textarea className="orw-field" rows={4} style={{ width: 460 }} value={str(e.c.params, k)} onChange={(ev) => e.set(k, ev.target.value)} />
    ) : (
      <input className="orw-field" style={{ width: 460 }} value={str(e.c.params, k)} onChange={(ev) => e.set(k, ev.target.value)} />
    )
  return (
    <Rows>
      <Row label="Designer:">{text('designer')}</Row>
      <Row label="Design type:">
        <ComboField
          k="designtype"
          fallback="original"
          options={[
            { value: 'original', label: 'Original design' },
            { value: 'kit', label: 'Kit' },
            { value: 'other', label: 'Other' },
          ]}
        />
      </Row>
      <Row label="Comments:">{text('comment', true)}</Row>
      <Row label="Revision history:">{text('revision', true)}</Row>
    </Rows>
  )
}

// ── Override & Comment (RocketComponentConfig) ───────────────────────────

export function OverrideTab() {
  const e = useEdit()
  const a = e.analysis?.components.find((r) => r.id === e.c.id)
  const p = e.c.params
  const has = (k: string) => typeof p[k] === 'number'
  const row = (key: string, sub: string, label: ReactNode, kind: 'mass' | 'length' | 'none', current: number, slider: [number, number]) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 240 }}>
          <Check label={label} checked={has(key)} onChange={(on) => e.set(key, on ? current : undefined)} />
        </span>
        <Spinner
          value={has(key) ? (p[key] as number) : current}
          kind={kind}
          min={kind === 'length' ? -Infinity : 0}
          disabled={!has(key)}
          slider={slider}
          onChange={(v) => e.set(key, v)}
          ariaLabel={key}
        />
      </span>
      <span style={{ paddingLeft: 24 }}>
        <Check label="Override for all subcomponents" checked={bool(p, sub)} disabled={!has(key)} onChange={(v) => e.set(sub, v)} />
      </span>
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 700 }}>
      {row('overridemass', 'overridesubcomponentsmass', 'Override mass:', 'mass', a?.mass ?? 0, [0, Math.max(0.1, (a?.mass ?? 0) * 3)])}
      {row('overridecg', 'overridesubcomponentscg', 'Override center of gravity CG:', 'length', a ? a.cgx - a.x : 0, [0, Math.max(0.1, a?.length ?? 0.1)])}
      {row('overridecd', 'overridesubcomponentscd', <span>Override coefficient of drag C<sub>D</sub>:</span>, 'none', a?.cd ?? 0, [0, 1])}
      <div style={{ fontSize: 13, color: '#333', lineHeight: 1.45 }}>
        The overridden mass and center of gravity does not include motors.
        <br />
        The center of gravity is measured from the front end of the {e.c.name}.
      </div>
    </div>
  )
}

export function CommentTab() {
  const e = useEdit()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%' }}>
      <span>Comments on the {e.c.name}:</span>
      <textarea
        className="orw-field"
        style={{ flex: 1, minHeight: 200, width: '100%' }}
        value={str(e.c.params, 'comment')}
        onChange={(ev) => e.set('comment', ev.target.value || undefined)}
      />
    </div>
  )
}

export function AppearanceTab() {
  return (
    <div style={{ color: '#666' }}>
      Appearance (paint, decals) is carried through the document untouched; editing it is not part of this milestone.
    </div>
  )
}

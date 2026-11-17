/**
 * OpenRocket's ComponentConfigDialog: "Component name" + preset combo + Parts
 * Library on top, the type's tabs, and "Component mass: x" with Cancel / OK
 * at the bottom. Edits apply live (each field one undo step); Cancel puts the
 * component back as it was when the dialog opened, or removes it if it was
 * just added -- RocketComponentConfig's "undo adding / discard changes".
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Analysis, Component, ComponentType, MaterialDb, ParamValue, Params, RocketDocument } from '../../types'
import { Tabs, Window } from '../swing'
import { EditCtx, type EditCtxValue } from './fields'
import * as P from './panels'
import { useUnits } from '../../workbench/units'

type Tab = { id: string; label: string; body: ReactNode; disabled?: boolean }

const HAS_PRESETS: ReadonlySet<ComponentType> = new Set([
  'nosecone', 'bodytube', 'transition', 'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock',
  'launchlug', 'railbutton', 'parachute', 'streamer',
])

const WIDTH: Partial<Record<ComponentType, number>> = {
  nosecone: 768, transition: 790, bodytube: 731, trapezoidfinset: 816, ellipticalfinset: 816, freeformfinset: 816,
  parachute: 850, streamer: 850, rocket: 680, stage: 640,
}

function tabsFor(c: Component): Tab[] {
  const common = (extra: Tab[] = []): Tab[] => [
    ...extra,
    { id: 'override', label: 'Override', body: <P.OverrideTab /> },
    { id: 'appearance', label: 'Appearance', body: <P.AppearanceTab /> },
    { id: 'comment', label: 'Comment', body: <P.CommentTab /> },
  ]
  switch (c.type) {
    case 'rocket':
      return [{ id: 'general', label: 'General', body: <P.RocketGeneral /> }]
    case 'stage':
      return common([{ id: 'separation', label: 'Separation', body: <P.SeparationTab /> }])
    case 'parallelstage':
      return common([
        { id: 'general', label: 'General', body: <P.PodGeneral /> },
        { id: 'separation', label: 'Separation', body: <P.SeparationTab /> },
      ])
    case 'podset':
      return common([{ id: 'general', label: 'General', body: <P.PodGeneral /> }])
    case 'nosecone':
      return common([
        { id: 'general', label: 'General', body: <P.NoseConeGeneral /> },
        { id: 'shoulder', label: 'Shoulder', body: <P.ShoulderTab /> },
      ])
    case 'transition':
      return common([
        { id: 'general', label: 'General', body: <P.TransitionGeneral /> },
        { id: 'shoulder', label: 'Shoulder', body: <P.ShoulderTab /> },
      ])
    case 'bodytube':
      return common([
        { id: 'general', label: 'General', body: <P.BodyTubeGeneral /> },
        { id: 'motor', label: 'Motor', body: <P.MotorTab /> },
      ])
    case 'trapezoidfinset':
      return common([
        { id: 'general', label: 'General', body: <P.TrapezoidGeneral /> },
        { id: 'tabs', label: 'Fin tabs', body: <FinTabsStub />, disabled: false },
      ])
    case 'ellipticalfinset':
      return common([
        { id: 'general', label: 'General', body: <P.EllipticalGeneral /> },
        { id: 'tabs', label: 'Fin tabs', body: <FinTabsStub /> },
      ])
    case 'freeformfinset':
      return common([
        { id: 'general', label: 'General', body: <P.FreeformGeneral /> },
        { id: 'shape', label: 'Shape', body: <P.FreeformShape /> },
        { id: 'tabs', label: 'Fin tabs', body: <FinTabsStub /> },
      ])
    case 'tubefinset':
      return common([{ id: 'general', label: 'General', body: <P.TubeFinGeneral /> }])
    case 'launchlug':
      return common([{ id: 'general', label: 'General', body: <P.LaunchLugGeneral /> }])
    case 'railbutton':
      return common([{ id: 'general', label: 'General', body: <P.RailButtonGeneral /> }])
    case 'innertube':
      return common([
        { id: 'general', label: 'General', body: <P.ThicknessRingGeneral /> },
        { id: 'motor', label: 'Motor', body: <P.MotorTab /> },
        { id: 'radial', label: 'Radial position', body: <P.RadialTab /> },
      ])
    case 'tubecoupler':
      return common([{ id: 'general', label: 'General', body: <P.ThicknessRingGeneral autoOuter /> }])
    case 'engineblock':
      return common([{ id: 'general', label: 'General', body: <P.ThicknessRingGeneral autoOuter /> }])
    case 'centeringring':
      return common([{ id: 'general', label: 'General', body: <P.RadiusRingGeneral inner /> }])
    case 'bulkhead':
      return common([{ id: 'general', label: 'General', body: <P.RadiusRingGeneral inner={false} /> }])
    case 'masscomponent':
      return common([
        { id: 'general', label: 'General', body: <P.MassComponentGeneral /> },
        { id: 'radial', label: 'Radial position', body: <P.RadialTab /> },
      ])
    case 'shockcord':
      return common([
        { id: 'general', label: 'General', body: <P.ShockCordGeneral /> },
        { id: 'radial', label: 'Radial position', body: <P.RadialTab /> },
      ])
    case 'parachute':
      return common([
        { id: 'general', label: 'General', body: <P.ParachuteGeneral /> },
        { id: 'radial', label: 'Radial position', body: <P.RadialTab /> },
      ])
    case 'streamer':
      return common([
        { id: 'general', label: 'General', body: <P.StreamerGeneral /> },
        { id: 'radial', label: 'Radial position', body: <P.RadialTab /> },
      ])
  }
}

function FinTabsStub() {
  return <div style={{ color: '#666' }}>Through-the-wall fin tabs are carried through the document; editing them is not part of this milestone.</div>
}

export function ComponentConfigDialog({
  c, doc, analysis, materials, resolved, onParams, onRename, onCancel, onClose, isNew,
}: {
  c: Component
  doc: RocketDocument
  analysis: Analysis | null
  materials: MaterialDb | null
  resolved: Record<string, Record<string, number>> | undefined
  onParams: (id: string, fn: (p: Params) => Params, key: string) => void
  onRename: (id: string, name: string) => void
  onCancel: () => void
  onClose: () => void
  isNew: boolean
}) {
  const u = useUnits()
  const tabs = useMemo(() => tabsFor(c), [c])
  const [tab, setTab] = useState<string>(tabs[0].id)
  const active = tabs.find((t) => t.id === tab) ?? tabs[0]
  const row = analysis?.components.find((r) => r.id === c.id)
  const isFin = c.type === 'trapezoidfinset' || c.type === 'ellipticalfinset' || c.type === 'freeformfinset'

  const ctx: EditCtxValue = {
    c,
    doc,
    analysis,
    materials,
    set: (key: string, value: ParamValue | undefined) =>
      onParams(
        c.id,
        (p) => {
          const n = { ...p }
          if (value === undefined) delete n[key]
          else n[key] = value
          return n
        },
        key,
      ),
    setParams: (fn, key) => onParams(c.id, fn, key),
    resolved: (key) => resolved?.[c.id]?.[key],
  }

  const name = c.type === 'rocket' ? 'Design name:' : 'Component name:'
  return (
    <Window
      title={`${c.type === 'rocket' ? 'Rocket' : c.name} configuration`}
      onClose={onClose}
      initial={{ x: 336, y: 220 }}
      width={WIDTH[c.type] ?? 800}
    >
      <EditCtx.Provider value={ctx}>
        <div style={{ padding: '8px 6px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{name}</span>
          <input
            className="orw-field"
            style={{ flex: 1 }}
            value={c.name}
            onChange={(e) => onRename(c.id, e.target.value)}
            onFocus={(e) => e.target.select()}
            autoFocus
            aria-label="Component name"
          />
          {HAS_PRESETS.has(c.type) && (
            <>
              <select className="orw-field italic" style={{ width: 216 }} value="custom" onChange={() => {}} aria-label="Preset">
                <option value="custom">Custom</option>
              </select>
              <button type="button" className="orw-btn" disabled title="The component preset database is not part of this milestone">
                Parts Library
              </button>
            </>
          )}
        </div>
        <Tabs tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} active={active.id} onChange={setTab} className="small" style={{ margin: '10px 6px 0', borderBottomColor: '#d6d6d6' }} />
        <div style={{ padding: '10px 12px 6px', minHeight: 290 }} key={c.id + active.id}>
          {active.body}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px 12px' }}>
          <span className="orw-info-icon" aria-hidden>
            i
          </span>
          <span style={{ marginLeft: 22, fontSize: 13, whiteSpace: 'nowrap' }} title="OpenRocket 24.12 mass model">
            {c.type === 'rocket' ? '' : `Component mass: ${row ? u.fmt('mass', row.mass) : '—'}`}
          </span>
          <span style={{ flex: 1 }} />
          {isFin && (
            <>
              <button type="button" className="orw-btn" disabled>
                Split fins
              </button>
              <button type="button" className="orw-btn" disabled>
                Convert to freeform
              </button>
              <button type="button" className="orw-btn" disabled>
                Export to SVG
              </button>
              <span style={{ width: 24 }} />
            </>
          )}
          <button type="button" className="orw-btn" style={{ minWidth: 72 }} onClick={onCancel} title={isNew ? 'Undo adding this component' : 'Discard the changes made in this dialog'}>
            Cancel
          </button>
          <button type="button" className="orw-btn default" style={{ minWidth: 72 }} onClick={onClose}>
            OK
          </button>
        </div>
      </EditCtx.Provider>
    </Window>
  )
}

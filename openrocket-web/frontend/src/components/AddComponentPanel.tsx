/**
 * "Add new component" -- OpenRocket's ComponentAddButtons: four groups of big
 * icon buttons, each enabled only where rules.ts (OpenRocket's isCompatible
 * and the button classes' addition rules) allows it under the selection.
 */
import type { Component, ComponentType } from '../types'
import { addTarget } from '../lib/rules'
import { componentIcon } from '../workbench/icons'

// Labels: messages.properties compaddbuttons.* (with their \n line breaks).
export const ADD_GROUPS: { title: string; items: { type: ComponentType; label: string }[] }[] = [
  {
    title: 'Assembly Components',
    items: [
      { type: 'stage', label: 'Stage' },
      { type: 'parallelstage', label: 'Boosters' },
      { type: 'podset', label: 'Pods' },
    ],
  },
  {
    title: 'Body Components and Fin Sets',
    items: [
      { type: 'nosecone', label: 'Nose Cone' },
      { type: 'bodytube', label: 'Body Tube' },
      { type: 'transition', label: 'Transition' },
      { type: 'trapezoidfinset', label: 'Trapezoidal' },
      { type: 'ellipticalfinset', label: 'Elliptical' },
      { type: 'freeformfinset', label: 'Freeform' },
      { type: 'tubefinset', label: 'Tube Fins' },
      { type: 'railbutton', label: 'Rail Button' },
      { type: 'launchlug', label: 'Launch Lug' },
    ],
  },
  {
    title: 'Inner Components',
    items: [
      { type: 'innertube', label: 'Inner Tube' },
      { type: 'tubecoupler', label: 'Tube Coupler' },
      { type: 'centeringring', label: 'Centering\nRing' },
      { type: 'bulkhead', label: 'Bulkhead' },
      { type: 'engineblock', label: 'Engine\nBlock' },
    ],
  },
  {
    title: 'Mass Components',
    items: [
      { type: 'parachute', label: 'Parachute' },
      { type: 'streamer', label: 'Streamer' },
      { type: 'shockcord', label: 'Shock Cord' },
      { type: 'masscomponent', label: 'Mass\nComponent' },
    ],
  },
]

export function AddComponentPanel({
  root, selected, onAdd, style,
}: {
  root: Component
  selected: Component | null
  onAdd: (type: ComponentType) => void
  style?: React.CSSProperties
}) {
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, ...style }}>
      <div style={{ fontWeight: 600, position: 'absolute', top: -2, left: 5, background: 'var(--or-bg)', padding: '0 1px', zIndex: 1 }}>
        Add new component
      </div>
      <div className="orw-addpanel" style={{ flex: 1, marginTop: 7, padding: '10px 0 10px 8px' }}>
        {ADD_GROUPS.map((g, gi) => (
          <div key={g.title} style={{ marginTop: gi === 0 ? 0 : 18 }}>
            <div style={{ marginBottom: 6 }}>{g.title}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
              {g.items.map((it) => {
                const enabled = addTarget(root, selected, it.type) !== null
                return (
                  <button
                    key={it.type}
                    type="button"
                    className="orw-addbtn"
                    disabled={!enabled}
                    onClick={() => onAdd(it.type)}
                    data-testid={`add-${it.type}`}
                  >
                    <img src={componentIcon(it.type, 'large') ?? ''} alt="" style={{ width: 50, height: 40 }} />
                    <span>{it.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

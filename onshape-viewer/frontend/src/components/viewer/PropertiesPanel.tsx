/**
 * Properties sidebar.
 *
 * The counterpart to the parts tree on the left: what the tree picks, this
 * describes. It is a sidebar rather than a card floating over the viewport
 * because the numbers here are read alongside the model rather than glanced at
 * -- an overlay would sit on top of the geometry it is describing, and it moved
 * whenever the selection changed size.
 *
 * Nothing here is editable. Mass, volume and centroid all come from the B-rep
 * via the API at build time; the only derived quantity is the estimated mass of
 * a part Onshape had no material for, which follows the density in the header.
 */

import type { Part } from '../../types'
import { centreOfMass, formatMass, formatMetres } from '../../lib/cm'
import { Row } from './Row'

interface Props {
  /** The current selection, in list order. */
  selected: Part[]
  visibleKeys: Set<string>
  /** Assumed density, for parts with no material of their own. */
  density: number
}

export function PropertiesPanel({ selected, visibleKeys, density }: Props) {
  if (selected.length === 0) {
    return (
      <Shell>
        <p className="px-3 py-4 text-sm text-slate-500">
          Nothing selected. Click a part in the list or in the model; shift or ctrl click to
          select several.
        </p>
      </Shell>
    )
  }

  if (selected.length === 1) {
    const part = selected[0]
    const hidden = !visibleKeys.has(part.key)

    return (
      <Shell>
        <div className="border-b border-slate-800 px-3 py-2">
          <h3 className="truncate font-semibold text-cyan-300" title={part.name}>
            {part.name}
          </h3>
          {hidden && <p className="mt-0.5 text-xs text-amber-300">Hidden — excluded from the CM</p>}
        </div>

        <Section title="Mass">
          <Row label="Mass" value={formatMass(part.mass)} small />
          <Row
            label="Material"
            value={part.material?.name ?? `none — assumed ${density} kg/m³`}
            small
          />
          <Row
            label="Density"
            value={`${(part.material?.density ?? density).toFixed(0)} kg/m³`}
            small
          />
          <Row label="Volume" value={`${(part.volume * 1e6).toFixed(1)} cm³`} small />
        </Section>

        <Section title="Centre of mass">
          <Row label="x" value={formatMetres(part.centroidWorld[0])} small />
          <Row label="y" value={formatMetres(part.centroidWorld[1])} small />
          <Row label="z" value={formatMetres(part.centroidWorld[2])} small highlight />
        </Section>

        <Section title="Identity">
          <Row label="Part ID" value={part.partId} small />
          <Row label="Instance" value={part.instanceId} small />
          {part.occurrencePath.length > 0 && (
            <Row label="Occurrence" value={part.occurrencePath.join(' / ')} small />
          )}
          {part.configuration && <Row label="Configuration" value={part.configuration} small />}
          {part.isStandardContent && <Row label="Source" value="Standard content" small />}
          {!part.hasGeometry && <Row label="Geometry" value="none tessellated" small />}
        </Section>

        {part.materialDefaulted && (
          <p className="m-3 rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-300">
            Estimated: no material assigned in Onshape. Its centroid is integrated from the mesh
            rather than reported by the API.
          </p>
        )}
      </Shell>
    )
  }

  const cm = centreOfMass(selected)
  const hidden = selected.filter((part) => !visibleKeys.has(part.key)).length
  const estimated = selected.filter((part) => part.materialDefaulted).length

  return (
    <Shell>
      <div className="border-b border-slate-800 px-3 py-2">
        <h3 className="font-semibold text-cyan-300">{selected.length} parts selected</h3>
      </div>

      <Section title="Selection">
        <Row label="Combined mass" value={formatMass(cm.mass)} small />
        <Row label="CM x" value={formatMetres(cm.centroid[0])} small />
        <Row label="CM y" value={formatMetres(cm.centroid[1])} small />
        <Row label="CM z" value={formatMetres(cm.centroid[2])} small highlight />
        <Row label="Hidden" value={`${hidden} of ${selected.length}`} small />
        {estimated > 0 && (
          <Row label="Estimated mass" value={`${estimated} parts · ${formatMass(cm.massDefaulted)}`} small />
        )}
      </Section>

      <div className="border-t border-slate-800">
        <ul className="text-xs">
          {selected.map((part) => (
            <li
              key={part.key}
              className="flex items-center justify-between gap-2 px-3 py-1 odd:bg-slate-900/40"
            >
              <span
                className={`truncate ${
                  visibleKeys.has(part.key) ? 'text-slate-300' : 'text-slate-600 line-through'
                }`}
                title={part.name}
              >
                {part.name}
              </span>
              <span className="shrink-0 tabular-nums text-slate-500">{formatMass(part.mass)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center border-b border-slate-700 px-3 py-2">
        <span className="text-base font-semibold text-slate-200">Properties</span>
      </div>
      {/* One scroll region for the whole body: a long selection list and a
          part with every identity field both overflow the same way. */}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-slate-800 px-3 py-2">
      <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h4>
      <div className="space-y-0.5">{children}</div>
    </section>
  )
}

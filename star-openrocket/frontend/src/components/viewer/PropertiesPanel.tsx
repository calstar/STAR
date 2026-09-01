/**
 * Properties sidebar.
 *
 * The counterpart to the parts tree on the left: what the tree picks, this
 * describes. It is a sidebar rather than a card floating over the viewport
 * because the numbers here are read alongside the model rather than glanced at
 * -- an overlay would sit on top of the geometry it is describing, and it moved
 * whenever the selection changed size.
 *
 * Everything above "User properties" comes from the B-rep via the API and is
 * read-only. Below it is the one place a user can contradict Onshape, and only
 * for mass: a part with no material assigned has no mass at all, and rather
 * than inventing a density for it the viewer leaves it weightless and lets
 * someone type the real number in. The centroid is unaffected either way --
 * it is a geometric centroid, which is where the mass sits under uniform
 * density regardless of what that density is.
 */

import { useDisabled } from '@stardesign-ui'
import { useEffect, useState } from 'react'

import type { Part, PartOverride } from '../../types'
import { centreOfMass } from '../../lib/cm'
import { useUnits } from '../../lib/units/unitsContext'
import { MATERIAL_CATALOG, MATERIALS_BY_KEY } from '../../lib/materials'
import { displayName } from '../../lib/names'
import { STATUS_TEXT, massStatus } from '../../lib/status'
import { Row } from './Row'

interface Props {
  /** The current selection, in list order. */
  selected: Part[]
  visibleKeys: Set<string>
  overrides: Map<string, PartOverride>
  onOverrideChange: (key: string, override: PartOverride | null) => void
}

/**
 * The Properties tab body. No header or scroll container of its own -- the
 * InspectorPanel that hosts it owns the tab strip and the one scroll region.
 */
export function PropertiesPanel({ selected, visibleKeys, overrides, onOverrideChange }: Props) {
  if (selected.length === 0) {
    return (
      <p className="px-3 py-4 text-[var(--color-text-muted)]">
        Nothing selected. Click a part in the list or in the model; shift or ctrl click to
        select several.
      </p>
    )
  }

  if (selected.length === 1) {
    const part = selected[0]
    return (
      <PartProperties
        // Remounts on a new selection, so the mass field cannot carry a
        // half-typed value from the previous part.
        key={part.key}
        part={part}
        hidden={!visibleKeys.has(part.key)}
        override={overrides.get(part.key) ?? null}
        onOverrideChange={onOverrideChange}
      />
    )
  }

  return <Selection selected={selected} visibleKeys={visibleKeys} />
}

function PartProperties({
  part,
  hidden,
  override,
  onOverrideChange,
}: {
  part: Part
  hidden: boolean
  override: PartOverride | null
  onOverrideChange: (key: string, override: PartOverride | null) => void
}) {
  const { q, lab, si, forInput } = useUnits()
  // Mass and material overrides are part of the design, so they need the
  // checkout. Nothing else in this panel is editable.
  const readOnly = useDisabled()
  const overridden = override?.massOverridden ?? false
  // The material the user picked from the catalog, if any. It sets the mass
  // (via density x volume, in App) but leaves Onshape's own material in place --
  // hence kept separate from `part.material` so the dropdown can still label the
  // Onshape option with the original alloy.
  const chosen = override?.material ? MATERIALS_BY_KEY[override.material] ?? null : null
  const materialKey = override?.material ?? 'onshape'

  // Held as text, not a number: a controlled number input that round-trips
  // through parseFloat eats the keystroke in "0." and cannot be cleared. The
  // text is in the CHOSEN mass unit; it converts to SI kg on commit.
  const [draft, setDraft] = useState(() =>
    override?.mass != null ? forInput(override.mass, 'mass') : '',
  )

  useEffect(() => {
    if (!overridden) setDraft('')
  }, [overridden])

  const commit = (text: string) => {
    setDraft(text)
    const value = Number(text)
    const valid = text.trim() !== '' && Number.isFinite(value) && value >= 0
    onOverrideChange(part.key, {
      material: override?.material ?? null,
      massOverridden: true,
      mass: valid ? si(value, 'mass') : null,
    })
  }

  // Picking a material and typing a mass are two ways to set the same number, so
  // choosing one clears the other. "onshape" hands the part back to its own
  // material, which means dropping the override entirely.
  const selectMaterial = (key: string) => {
    if (key === 'onshape') {
      onOverrideChange(part.key, null)
      return
    }
    onOverrideChange(part.key, { material: key, massOverridden: false, mass: null })
  }

  const toggleOverride = (next: boolean) => {
    if (!next) {
      // Fall back to the chosen material's mass if there is one, otherwise let
      // the part return to Onshape.
      onOverrideChange(
        part.key,
        chosen ? { material: chosen.key, massOverridden: false, mass: null } : null,
      )
      return
    }
    // Seeded with whatever mass the part already has -- Onshape's, or the one a
    // chosen material gave it -- so overriding starts from its real value.
    const seed = part.mass > 0 ? part.mass : null
    setDraft(seed != null ? forInput(seed, 'mass') : '')
    onOverrideChange(part.key, {
      material: override?.material ?? null,
      massOverridden: true,
      mass: seed,
    })
  }

  const shown = displayName(part)
  // Onshape's own material (for the dropdown's first option); what to show in the
  // Material/Density rows is the chosen one when there is one.
  const material = part.material
  const displayMaterial = chosen ?? material
  const status = massStatus(part, overridden || chosen != null)

  return (
    <>
      <div className="border-b border-[var(--color-border)] px-3 py-2">
        <h3 className="truncate text-base font-semibold text-[var(--color-accent)]" title={part.name}>
          {shown.name}
        </h3>
        {/* The same colour the part carries in the tree and in the model, so
            the legend never has to be looked up. */}
        <p className={`mt-0.5 text-sm ${STATUS_TEXT[status] || 'text-[var(--color-text-muted)]'}`}>
          {status === 'unassigned' && 'No mass — not in the centre of mass'}
          {status === 'assigned' && 'Mass assigned here, not by Onshape'}
          {status === 'overridden' && "Onshape's mass overridden here"}
          {status === 'weighed' && 'Mass from Onshape'}
        </p>
        {hidden && <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Hidden — excluded from the CM</p>}
      </div>

      <Section title="Mass">
        <Row
          label="Mass"
          value={part.mass > 0 ? q(part.mass, 'mass') : 'none'}
          highlight={overridden}
        />
        <Row label="Material" value={displayMaterial?.name ?? 'none assigned'} />
        {displayMaterial && (
          <Row label="Density" value={q(displayMaterial.density, 'density')} />
        )}
        <Row label="Volume" value={q(part.volume, 'volume')} />
      </Section>

      <Section title="Centre of mass">
        <Row label="x" value={q(part.centroidWorld[0], 'length')} />
        <Row label="y" value={q(part.centroidWorld[1], 'length')} />
        <Row label="z" value={q(part.centroidWorld[2], 'length')} highlight />
      </Section>

      <Section title="User properties">
        <label className="mb-2 block">
          <span className="mb-1 block text-sm text-[var(--color-text-muted)]">Material</span>
          <select
            // Onshape's own material sits first; the catalog alloys below it
            // apply their density to the part's volume. Overriding the mass by
            // hand makes the material irrelevant, so it greys out rather than
            // sitting there implying it still applies.
            disabled={overridden || readOnly}
            value={materialKey}
            onChange={(event) => selectMaterial(event.target.value)}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:border-[var(--color-border)] disabled:text-[var(--color-text-muted)]"
          >
            <option value="onshape">
              {material ? `${material.name} (Onshape)` : 'None assigned (Onshape)'}
            </option>
            {MATERIAL_CATALOG.map((option) => (
              <option key={option.key} value={option.key}>
                {option.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 py-1 text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={overridden}
            disabled={readOnly}
            onChange={(event) => toggleOverride(event.target.checked)}
            className="accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          />
          Override mass
        </label>

        <label className="mt-1 block">
          <span
            className={`mb-1 block text-sm ${overridden ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-muted)]'}`}
          >
            Mass ({lab('mass')})
          </span>
          <input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            disabled={!overridden || readOnly}
            value={draft}
            placeholder={overridden ? 'enter a mass' : '—'}
            onChange={(event) => commit(event.target.value)}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-left tabular-nums text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:border-[var(--color-border)] disabled:bg-[var(--color-bg-secondary)]/40 disabled:text-[var(--color-text-muted)]"
          />
        </label>

        {overridden && override?.mass == null && (
          <p className="mt-2 text-xs text-red-400">
            No mass entered — this part still contributes nothing to the centre of mass.
          </p>
        )}
      </Section>

      {part.materialDefaulted && !overridden && !chosen && (
        <p className="m-3 rounded bg-red-500/15 px-2 py-1 text-sm text-red-300">
          No material assigned in Onshape, so this part has no mass and is left out of the centre
          of mass. Pick a material or override the mass above to include it.
        </p>
      )}
    </>
  )
}

function Selection({ selected, visibleKeys }: { selected: Part[]; visibleKeys: Set<string> }) {
  const { q } = useUnits()
  const cm = centreOfMass(selected)
  const hidden = selected.filter((part) => !visibleKeys.has(part.key)).length

  return (
    <>
      <div className="border-b border-[var(--color-border)] px-3 py-2">
        <h3 className="text-base font-semibold text-[var(--color-accent)]">{selected.length} parts selected</h3>
      </div>

      <Section title="Selection">
        <Row label="Combined mass" value={q(cm.mass, 'mass')} />
        <Row label="CM x" value={q(cm.centroid[0], 'length')} />
        <Row label="CM y" value={q(cm.centroid[1], 'length')} />
        <Row label="CM z" value={q(cm.centroid[2], 'length')} highlight />
        <Row label="Hidden" value={`${hidden} of ${selected.length}`} />
        {cm.masslessCount > 0 && (
          <Row label="Without mass" value={`${cm.masslessCount} of ${selected.length}`} />
        )}
      </Section>

      <div className="border-t border-[var(--color-border)]">
        <ul className="text-sm">
          {selected.map((part) => (
            <li
              key={part.key}
              className="flex items-center justify-between gap-2 px-3 py-1.5 odd:bg-[var(--color-bg-secondary)]/40"
            >
              <span
                className={`truncate ${
                  visibleKeys.has(part.key) ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-text-muted)] line-through'
                }`}
                title={part.name}
              >
                {displayName(part).name}
              </span>
              <span
                className={`shrink-0 tabular-nums ${
                  part.mass > 0 ? 'text-[var(--color-text-muted)]' : 'text-red-400/80'
                }`}
              >
                {part.mass > 0 ? q(part.mass, 'mass') : 'no mass'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-[var(--color-border)] px-3 py-2">
      <h4 className="mb-1 text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
        {title}
      </h4>
      <div className="space-y-0.5">{children}</div>
    </section>
  )
}

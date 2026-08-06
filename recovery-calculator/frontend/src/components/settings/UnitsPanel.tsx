/**
 * The Units tab: one row per physical quantity, showing the unit it renders
 * in everywhere.
 *
 * Rows are labelled by the unit SYMBOL, not by "metric"/"imperial" -- the
 * question a user is actually answering is "do I want pounds or kilograms",
 * and naming the system makes them translate twice. It also puts the current
 * unit on screen without opening the dropdown.
 *
 * Grouped rather than listed alphabetically, because the groups are how the
 * choices cluster in practice: someone working in feet and pounds wants the
 * whole first group imperial and probably nothing else.
 */

import { KINDS, PRECISION_LIMITS, QUANTITIES } from '../../lib/quantities'
import type { Kind, System } from '../../lib/quantities'
import { useUnits } from '../../lib/unitsContext'
import { Button, Card, Select } from '../ui'

const GROUPS: { title: string; kinds: Kind[] }[] = [
  {
    title: 'Vehicle and geometry',
    kinds: ['altitude', 'length', 'area', 'mass', 'distance'],
  },
  {
    title: 'Motion and loads',
    kinds: ['speed', 'accel', 'force', 'stiffness', 'energy'],
  },
  {
    title: 'Atmosphere',
    kinds: ['pressure', 'temperature', 'tempDelta', 'density', 'lapse'],
  },
]

/** For the rows whose name does not carry its own explanation. */
const HELP: Partial<Record<Kind, string>> = {
  altitude: 'Apogee, deployment altitudes, the trajectory chart and the '
    + 'sounding profile.',
  length: 'Airframe diameter and length, canopy nominal diameter.',
  distance: 'How far the observing stations are from the pad.',
  tempDelta: 'Temperature DIFFERENCES - the sounding profile’s error against '
    + 'the eq (7) line, for instance. Separate from Temperature because a '
    + 'difference converts by the ratio alone: 1 K is 1.8 °F, not 33.8 °F.',
  lapse: 'How fast temperature falls with height. Stored per metre; K/km is '
    + 'already a display convention.',
  stiffness: 'Series harness stiffness k_eff, which drives the snatch load.',
}

// Every kind belongs to exactly one group. Checked here rather than trusted,
// because a kind added to the registry and forgotten here would simply have no
// control -- an invisible failure, not a broken build.
const GROUPED = new Set(GROUPS.flatMap((g) => g.kinds))
const UNGROUPED = KINDS.filter((k) => !GROUPED.has(k))

export function UnitsPanel() {
  const { prefs, setKind, setAll, save } = useUnits()

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card
        title="Units"
        subtitle="Applies throughout app immediately, affects display not physics"
        right={
          <div className="flex shrink-0 gap-1">
            <Button onClick={() => setAll('metric')}>All metric</Button>
            <Button onClick={() => setAll('imperial')}>All imperial</Button>
          </div>
        }
      >
        <div className="space-y-5">
          <PrecisionGroup />

          {GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">
                <span aria-hidden
                      className="h-3.5 w-0.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
                {group.title}
              </h3>
              <div className="mt-2 space-y-1.5">
                {group.kinds.map((kind) => (
                  <UnitRow key={kind} kind={kind} value={prefs[kind]}
                           onChange={(s) => setKind(kind, s)} />
                ))}
              </div>
            </div>
          ))}

          {UNGROUPED.length > 0 && (
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-amber-400">
                Ungrouped
              </h3>
              <div className="space-y-1.5">
                {UNGROUPED.map((kind) => (
                  <UnitRow key={kind} kind={kind} value={prefs[kind]}
                           onChange={(s) => setKind(kind, s)} />
                ))}
              </div>
            </div>
          )}
        </div>

        <p className="mt-5 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
          <SaveNote state={save} />
        </p>
      </Card>
    </div>
  )
}

/**
 * How much detail every number shows.
 *
 * Above the unit rows because it governs all of them, and two controls rather
 * than one because either bound alone is wrong. A decimal cap is what makes a
 * converted value readable -- switch mass to kg and the box would otherwise
 * read 5.669904625 -- but a cap alone renders a 0.0048 m² drag area as "0.00".
 * The significant-figure floor sits under it and wins where they conflict.
 */
function PrecisionGroup() {
  const { precision, setPrecision } = useUnits()
  const range = (lo: number, hi: number) =>
    Array.from({ length: hi - lo + 1 }, (_, i) => ({
      value: String(lo + i), label: String(lo + i),
    }))
  const { maxDecimals: dec, minSigFigs: sig } = PRECISION_LIMITS

  return (
    <div>
      <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">
        <span aria-hidden
              className="h-3.5 w-0.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
        Precision
      </h3>
      <p className="font-prose mb-3 text-xs text-[var(--color-text-muted)]">
        Bounds, not targets - a number that is naturally coarser stays coarser,
        and the minimum wins where the two disagree.
      </p>
      <div className="space-y-1.5">
        <PrecisionRow
          name="Decimal places (max)"
          help="What stops a converted value reading 5.669904625. Never applies to digits left of the point, so a pad pressure can never read 101,330."
          value={precision.maxDecimals}
          options={range(dec.min, 6)}
          onChange={(maxDecimals) => setPrecision({ maxDecimals })}
        />
        <PrecisionRow
          name="Significant figures (min)"
          help="What stops a small number reading 0.00. Overrides the decimal cap: at max 2 an airframe drag area of 0.005690 m² still reads 0.0057."
          value={precision.minSigFigs}
          options={range(sig.min, sig.max)}
          onChange={(minSigFigs) => setPrecision({ minSigFigs })}
        />
      </div>
    </div>
  )
}

function PrecisionRow({ name, help, value, options, onChange }: {
  name: string
  help: string
  value: number
  options: { value: string; label: string }[]
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-3" data-precision-row={name}>
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)]"
            title={help}>
        {name}
      </span>
      <span className="w-20 shrink-0" />
      <div className="w-32 shrink-0">
        <Select value={String(value)} options={options}
                onChange={(v) => onChange(Number(v))} />
      </div>
    </div>
  )
}

function UnitRow({ kind, value, onChange }: {
  kind: Kind
  value: System
  onChange: (s: System) => void
}) {
  const q = QUANTITIES[kind]
  return (
    <div className="flex items-center gap-3" data-unit-row={kind}>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-secondary)]"
            title={HELP[kind]}>
        {q.name}
      </span>
      {/* The SI unit the wire carries, so it is visible that choosing a
          different one changes the display and nothing else. Wide enough for
          `kg/m³` on one line -- at w-16 it wrapped and the row grew. */}
      <span className="w-20 shrink-0 whitespace-nowrap text-right text-xs text-[var(--color-text-muted)]">
        SI: {q.si}
      </span>
      <div className="w-32 shrink-0">
        <Select
          value={value}
          onChange={onChange}
          options={[
            { value: 'metric' as System, label: q.metric.label },
            { value: 'imperial' as System, label: q.imperial.label },
          ]}
        />
      </div>
    </div>
  )
}

/** Honest about the one state that can fail. Preferences are saved to
 *  `.gui-settings.json` through the backend; with no backend the browser still
 *  remembers them, but only for this browser on this machine. */
function SaveNote({ state }: { state: ReturnType<typeof useUnits>['save'] }) {
  if (state === 'saving') return <>Saving…</>
  if (state === 'offline') {
    return (
      <span className="text-amber-300/90">
        Backend unreachable - remembered in this browser only, not written to{' '}
        <code>.gui-settings.json</code>.
      </span>
    )
  }
  if (state === 'saved') return <>Saved to <code>.gui-settings.json</code>.</>
  return <>Saved automatically to <code>.gui-settings.json</code>, and reloaded next time.</>
}

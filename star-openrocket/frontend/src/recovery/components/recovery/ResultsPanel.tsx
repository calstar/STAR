/**
 * Results: the case selector, the summary, the flight history and the loads.
 *
 * PLAN.md §11.5 specifies a dropdown that badges any failing case "so a
 * failure cannot be missed by never opening the menu". This implements it as a
 * always-visible segmented control instead, which satisfies that requirement
 * more strongly -- there is no menu to leave unopened. The badging rule is
 * unchanged.
 *
 * The §11.5 point that drives the layout: each case fails in a DIFFERENT
 * category, so no single number covers them. Case 1 is structurally the
 * gentlest but drifts 2.7x as far; case 2 loads nothing but lands at 17x the
 * energy; case 3 is 17x the load. A summary that showed only max tension would
 * call case 2 the safest run of the four. So every case shows all four metrics
 * and marks which one is ITS category.
 */

import { useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { CASE_IDS, CASE_META } from '../../types/schema'
import type { CaseId, CaseResult, Result } from '../../types/schema'
import { STUB_SHA } from '../../api/fixture'
import { Badge, Button, Card, Empty, Stat, StubBanner, WarningsCard } from '../ui'
import { AXIS, CHANNELS, GRID, MARGIN, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, axisLabel } from '../chartTheme'
import type { Channel } from '../chartTheme'
import { useUnits } from '../../../lib/units/unitsContext'

export function ResultsPanel({ result, running, error }: {
  result: Result | null
  running: boolean
  error: string | null
}) {
  const [active, setActive] = useState<CaseId>('nominal')
  const [channel, setChannel] = useState<Channel>('z')
  const { num, q, dur } = useUnits()

  // Nothing computed yet (first run, or before any run) is the only state with
  // no height to preserve, so a full-panel message is fine here.
  if (!result) {
    return (
      <Card title="Results">
        {error ? (
          <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2">
            <p className="font-prose text-xs leading-relaxed text-red-200">{error}</p>
          </div>
        ) : (
          <Empty>{running ? 'Running…' : 'Press Run to simulate.'}</Empty>
        )}
      </Card>
    )
  }

  const cur = result.cases[active]
  const isStub = result.git_sha === STUB_SHA

  return (
    <div className="space-y-4">
      {/* Recompute is live-on-edit, so the previous result stays on screen while
          a fresher one is computed -- swapping it for a "Running…" card would
          collapse the column and jump the page. This status line is always
          present at a fixed height so toggling its text shifts nothing; it
          carries the recompute note, or an error, without dropping the numbers
          the error would replace. */}
      <div className="flex h-4 items-center text-2xs text-[var(--color-text-muted)]">
        {error ? (
          <span className="truncate text-red-300">{error}</span>
        ) : running ? (
          <span>Updating…</span>
        ) : null}
      </div>
      {isStub && (
        <StubBanner>
          <strong>Placeholder numbers - the backend is not running.</strong>{' '}
          Start it with <code>./dev.sh</code>. Nothing here is computed.
        </StubBanner>
      )}

      <CaseSelector result={result} active={active} onChange={setActive} />

      <Card
        title={`${CASE_META[active].label} summary`}
        subtitle={CASE_META[active].detail}
      >
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {/* The tone highlights, in yellow, whichever figure this case is
              chosen to stress -- a drift case flags its descent time, an impact
              case its landing speed and energy, a structural case its peak
              load. It is a "look here", not a pass/fail: no threshold is
              compared, so it never turns red. Nominal stresses nothing in
              particular and highlights nothing. */}
          <Stat
            label="Descent time"
            value={dur(cur.descent_time)}
            tone={CASE_META[active].category === 'drift' ? 'warning' : undefined}
            hint="Drift scales with this."
          />
          <Stat
            label="Impact velocity"
            value={num(cur.impact_velocity, 'speed')} kind="speed"
            tone={CASE_META[active].category === 'impact' ? 'warning' : undefined}
          />
          <Stat
            label="Impact energy"
            value={num(cur.impact_ke, 'energy')} kind="energy"
            tone={CASE_META[active].category === 'impact' ? 'warning' : undefined}
            hint={`Equivalent to a ${q(cur.h_equiv, 'altitude', 1)} drop`}
          />
          {/* The unfactored eq (36) max -- the load the hardware actually sees.
              No safety factor is applied and no allowable is compared: a
              pass/fail verdict is intentionally deferred to a future update. */}
          <Stat
            label="Max load"
            value={num(cur.F_peak_max, 'force')} kind="force"
            hint="The governing load to size to: the largest of every device's F_p,inf bound, its snatch load, and its numerical peak F_num."
            tone={CASE_META[active].category === 'structure' ? 'warning' : undefined}
          />
        </div>
      </Card>

      <Card
        title="Flight history"
        subtitle={active === 'nominal' ? undefined : "Nominal and the selected case, overlaid."}
        right={
          <div className="flex flex-wrap gap-1">
            {CHANNELS.map((c) => (
              <Button
                key={c.key}
                onClick={() => setChannel(c.key)}
                variant={channel === c.key ? 'primary' : 'ghost'}
               action>
                {c.label}
              </Button>
            ))}
          </div>
        }
      >
        <TrajectoryChart result={result} active={active} channel={channel} />
      </Card>

      <LoadsTable c={cur} />
      <EventsTable c={cur} />
      <PadStateCard result={result} />

      {/* Last, not first. These are caveats on numbers the reader has now
          seen, and leading with them pushed the actual results below the
          fold. Nothing here blocks a run -- warnings travel as data and the
          run happens regardless -- so they belong at the end. */}
      <WarningsCard warnings={result.warnings} />
    </div>
  )
}

function CaseSelector({ result, active, onChange }: {
  result: Result
  active: CaseId
  onChange: (c: CaseId) => void
}) {
  const { q, dec } = useUnits()
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {CASE_IDS.map((id) => {
        const c = result.cases[id]
        const meta = CASE_META[id]
        const on = id === active
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={`rounded-lg border px-3 py-2 text-left transition-colors
              ${on ? 'border-[var(--color-accent)] bg-[var(--color-bg-secondary)]'
                   : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 hover:border-[var(--color-text-muted)]'}`}
          >
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: meta.colour }} />
              <span className={`text-sm ${on ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
                {meta.label}
              </span>
            </div>
            <div className="font-num mt-1.5 flex gap-3 text-sm text-[var(--color-text-muted)]">
              <span>{dec(c.descent_time, 0)} s</span>
              <span>{q(c.impact_velocity, 'speed', 1)}</span>
              {/* Unfactored, to match the summary Stat -- the chip and the
                  card must not name the same quantity with different numbers. */}
              <span>{q(c.F_peak_max, 'force')}</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Which events get a rule, and which of those carry the text.
 *
 * Every event still gets its dotted line -- the sequence is the point. But the
 * label goes only on the FIRST event of each device, so a cluster of three
 * events milliseconds apart reads as one annotated group rather than three
 * labels on top of each other. Ground and apogee are unlabelled: the axes
 * already say where they are.
 */
function eventRules(c: CaseResult) {
  const labelled = new Set<string>()
  return c.events
    .filter((e) => e.kind !== 'start')
    .map((e) => {
      const key = e.device ?? e.kind
      const first = e.device !== null && !labelled.has(key)
      if (first) labelled.add(key)
      return { ...e, label: first ? e.device : null }
    })
}

function TrajectoryChart({ result, active, channel }: {
  result: Result
  active: CaseId
  channel: Channel
}) {
  const { val, lab, dec } = useUnits()
  const meta = CHANNELS.find((c) => c.key === channel)!
  const nominal = result.cases.nominal
  const cur = result.cases[active]
  // Convert the DATA, not just the label: the ticks, the tooltip and the axis
  // domain all have to agree, and only one of them reads the label.
  const show = (si: number) => val(si, meta.kind)
  const unit = lab(meta.kind) + (meta.suffix ?? '')

  // Merge on t so both cases share one x axis. They end at different times,
  // which is exactly the comparison worth seeing for case 1.
  const byT = new Map<number, Record<string, number | null>>()
  for (const s of nominal.trajectory) {
    byT.set(s.t, { t: s.t, nominal: show(s[channel]), selected: null })
  }
  for (const s of cur.trajectory) {
    const row = byT.get(s.t) ?? { t: s.t, nominal: null, selected: null }
    row.selected = show(s[channel])
    byT.set(s.t, row)
  }
  const data = [...byT.values()].sort((a, b) => (a.t as number) - (b.t as number))
  const showNominal = active !== 'nominal'

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="t" type="number" {...AXIS}
            domain={[0, 'dataMax']}
            tickFormatter={(v: number) => dec(v, 0)}
            label={axisLabel('t (s)')}
          />
          <YAxis
            {...AXIS} width={70}
            tickFormatter={(v: number) => Math.abs(v) >= 1000
              // The `k` form is a magnitude abbreviation for a crowded
              // axis, not a precision choice, so it keeps its one decimal.
              ? (v / 1000).toFixed(1) + 'k'
              : dec(v, channel === 'CdS_tot' ? 2 : 0)}
            label={axisLabel(`${meta.label} (${unit})`, -90)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={(v: number) => `t = ${dec(Number(v), 2)} s`}
            formatter={(v: number | string, name: string) =>
              [`${dec(Number(v), 2)} ${unit}`, name]}
          />
          {/* Top-aligned: a bottom legend sits exactly where the "t (s)"
              axis label goes and the two overprint. */}
          <Legend verticalAlign="top" height={24}
                  wrapperStyle={{ fontSize: 11 }} />

          {showNominal && (
            <Line
              dataKey="nominal" name="nominal"
              stroke={CASE_META.nominal.colour} strokeWidth={1}
              strokeDasharray="4 3" dot={false} connectNulls
              isAnimationActive={false}
            />
          )}
          <Line
            dataKey="selected" name={CASE_META[active].label}
            stroke={CASE_META[active].colour} strokeWidth={2}
            dot={false} connectNulls isAnimationActive={false}
          />

          {/* A full-height dotted rule per event rather than a dot on the
              curve: the event TIME is what is worth reading, and a marker
              pinned to one series vanishes the moment you switch channel.

              Only the first rule of each device is labelled. A charge, its
              line stretch and its inflation land within a few hundred
              milliseconds of each other, so labelling all three overprinted
              into an unreadable smear. One horizontal "drogue" over the group
              is enough -- which rule is the charge and which the line stretch
              reads straight off the order. */}
          {eventRules(cur).map((e) => (
            <ReferenceLine
              key={`${e.t}-${e.device ?? ''}-${e.kind}`}
              x={e.t}
              stroke="#9fb0c4"
              strokeDasharray="2 3"
              strokeWidth={1}
              label={e.label ? {
                value: e.label,
                // Inside the plot area, so it clears the top legend.
                position: 'insideTopLeft',
                fill: '#cbd5e1',
                fontSize: 12,
                offset: 6,
              } : undefined}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function LoadsTable({ c }: { c: CaseResult }) {
  const { q, dec } = useUnits()
  return (
    <Card
      title="Opening loads"
      subtitle="Per device. F_num is the integrated peak and the load to size to; F_p,inf and F_p,fin are the analytic Pflanz figures. Hover a column for detail."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-1.5 pr-3 font-medium">Device</th>
              {/* NOT "snatch velocity", which this was called until it sat next
                  to the snatch load and the two read as cause and effect. They
                  are unrelated: v_s is the freestream descent speed and drives
                  the OPENING load through q_s, while the snatch load is
                  v_rel * sqrt(k_eff * mu) (eq 34) and contains no v_s at all. */}
              <th className="py-1.5 pr-3 text-right font-medium"
                  title="Descent speed at line stretch, frozen at that instant. Drives the opening load through the dynamic pressure q_s. It is NOT what causes the snatch load.">
                Speed at stretch (v_s)
              </th>
              <th className="py-1.5 pr-3 text-right font-medium">Fill time (t_f)</th>
              <th className="py-1.5 pr-3 text-right font-medium" title="Ballistic parameter">Ballistic (A)</th>
              <th className="py-1.5 pr-3 text-right font-medium" title="Finite-mass reduction factor">Reduction (X1)</th>
              <th className="py-1.5 pr-3 text-right font-medium"
                  title="Pflanz infinite-mass opening bound. Gravity-free; a conservative upper bound only while above the validity floor.">
                F<sub>p,inf</sub>
              </th>
              <th className="py-1.5 pr-3 text-right font-medium"
                  title="Pflanz finite-mass expected opening load, F_p,inf * X1. Also gravity-free.">
                F<sub>p,fin</sub>
              </th>
              <th className="py-1.5 pr-3 text-right font-medium text-[var(--color-text-primary)]"
                  title="Numerical peak cord tension from the integrated trajectory - includes gravity and airframe drag. The physical peak, and the load to size to.">
                F<sub>num</sub>
              </th>
              <th className="py-1.5 text-right font-medium"
                  title="Line-stretch shock: v_rel * sqrt(k_eff * mu). Driven by v_rel, the separation velocity between body and canopy, and the harness stiffness k_eff - both set per device. The descent speed v_s does not enter it.">
                Snatch load (F_s)
              </th>
            </tr>
          </thead>
          <tbody className="text-[var(--color-text-secondary)]">
            {c.device_loads.map((d) => (
              <tr key={d.device} className="border-b border-[var(--color-border)]/50">
                <td className="py-1.5 pr-3 text-[var(--color-text-primary)]">
                  {d.device}
                  {d.below_validity_floor && (
                    <Badge tone="danger" title="Deploys too slowly for F_p,inf to stay a bound — the real peak can be higher. Use F_num.">
                      below floor
                    </Badge>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right">{q(d.v_s, 'speed')}</td>
                <td className="py-1.5 pr-3 text-right">{dec(d.t_fill, 3)} s</td>
                <td className="py-1.5 pr-3 text-right">{dec(d.A, 3)}</td>
                <td className="py-1.5 pr-3 text-right">{dec(d.X1, 3)}</td>
                <td className="py-1.5 pr-3 text-right">{q(d.F_inf, 'force')}</td>
                <td className="py-1.5 pr-3 text-right">{q(d.F_peak, 'force')}</td>
                <td className="py-1.5 pr-3 text-right text-[var(--color-text-primary)]">
                  {d.F_num === null ? '—' : q(d.F_num, 'force')}
                </td>
                <td className="py-1.5 text-right">
                  {d.F_snatch === null
                    ? <span className="text-[var(--color-text-muted)]">no k_eff</span>
                    : q(d.F_snatch, 'force')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function EventsTable({ c }: { c: CaseResult }) {
  const { q, dec } = useUnits()
  return (
    <Card title="Sequence" subtitle={undefined}>
      <div className="overflow-x-auto">
        {/* No device column: every device event is labelled "<name> charge",
            "<name> line stretch", "<name> inflated" (backend/serialise.py), so
            the name is already in the Event cell. */}
        <table className="w-full min-w-[440px] text-left text-xs">
          <thead className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-1.5 pr-3 font-medium">Time</th>
              <th className="py-1.5 pr-3 font-medium">Event</th>
              <th className="py-1.5 pr-3 text-right font-medium">Altitude</th>
              <th className="py-1.5 text-right font-medium">Velocity</th>
            </tr>
          </thead>
          <tbody className="text-[var(--color-text-secondary)]">
            {c.events.map((e, i) => (
              <tr key={i} className="border-b border-[var(--color-border)]/50">
                <td className="py-1.5 pr-3 text-[var(--color-text-primary)]">
                  {dec(e.t, 2)} s
                </td>
                <td className="py-1.5 pr-3">{e.label}</td>
                <td className="py-1.5 pr-3 text-right">{q(e.z, 'altitude')}</td>
                <td className="py-1.5 text-right">{q(e.v, 'speed')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function PadStateCard({ result }: { result: Result }) {
  const { num, q, dec } = useUnits()
  const p = result.pad
  return (
    <Card
      title="Resolved pad state"
      subtitle={undefined}
      right={<Badge tone="neutral">{p.source}</Badge>}
    >
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Pad pressure (p_pad)" value={num(p.p_pad, 'pressure')} kind="pressure" />
        <Stat label="Pad temperature (T_pad)" value={num(p.T_pad, 'temperature')} kind="temperature" />
        <Stat label="Pad density (rho)" value={num(p.rho_pad, 'density')} kind="density" />
        {/* `lapse` is stored K per METRE; the registry owns the /1000 that
            three separate sites used to do inline. */}
        <Stat label="Lapse rate (L)" value={num(p.lapse, 'lapse', 3)} kind="lapse" />
      </div>
      {result.body_drag_band && (
        <p className="font-prose mt-3 text-xs leading-relaxed text-[var(--color-text-secondary)]">
          Airframe drag run both ways: axial{' '}
          <span className="text-[var(--color-text-primary)]">
            {q(result.body_drag_band.axial, 'area', 5)}
          </span>{' '}
          and broadside{' '}
          <span className="text-[var(--color-text-primary)]">
            {q(result.body_drag_band.broadside, 'area', 4)}
          </span>
          , a {dec(result.body_drag_band.broadside / result.body_drag_band.axial, 1)}×
          spread. Loads shown are the axial bound, which is the conservative one.
        </p>
      )}
    </Card>
  )
}

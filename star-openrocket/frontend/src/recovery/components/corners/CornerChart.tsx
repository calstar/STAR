/**
 * One line per corner, over the whole descent.
 *
 * The sweep's scalars say *how bad* the worst corner is; this says *why*. A
 * drogue that opens a second late and a broadside airframe produce the same
 * F_design from visibly different flights, and the difference between "it
 * opened low" and "it opened fast" is only legible against time.
 *
 * The drawing itself lives in `TrajectoryOverlay`, shared with the Sweep tab.
 * What is specific to corners is here: which lines are named, in what colour,
 * and how a corner is written.
 */

import type { SweepCorner, SweepResult } from '../../api/client'
import type { Channel } from '../chartTheme'
import { colourFor } from '../chartTheme'
import { TrajectoryOverlay } from '../TrajectoryOverlay'
import type { OverlaySeries } from '../TrajectoryOverlay'
import { cornerLabel } from '../../lib/corners'
import { useUnits } from '../../../lib/units/unitsContext'
import { Empty } from '../ui'

/** Wider than the results chart. It is the point of the tab, and 32 overlaid
 *  descents need the vertical room to separate. */
const HEIGHT = 'h-[30rem]'

export function CornerChart({ corners, nominal, selectedIds, channel, showContext, deployAlts }: {
  corners: SweepCorner[]
  /** The un-perturbed run, always drawn. */
  nominal: SweepResult['nominal']
  /** In selection order -- that order IS the colour assignment. */
  selectedIds: string[]
  channel: Channel
  showContext: boolean
  /** Device trigger altitudes, for the horizontal markers on the z channel. */
  deployAlts: { name: string; z: number }[]
}) {
  const { num } = useUnits()
  const withTraj = corners.filter((c) => c.trajectory?.length)

  if (!withTraj.length) {
    return (
      <div className={HEIGHT}>
        <Empty>No flight histories in this response - re-run the sweep.</Empty>
      </div>
    )
  }

  const toSeries = (c: SweepCorner): OverlaySeries => ({
    id: c.id,
    label: cornerLabel(c.corner, c.attitude, num),
    colour: colourFor(selectedIds, c.id),
    muted: !selectedIds.includes(c.id),
    trajectory: c.trajectory!,
  })

  const selected = selectedIds
    .map((id) => withTraj.find((c) => c.id === id))
    .filter((c): c is SweepCorner => c !== undefined)
  const context = showContext
    ? withTraj.filter((c) => !selectedIds.includes(c.id))
    : []
  // Selected painted last, so they land on top of the context layer.
  const drawn = [...context, ...selected].map(toSeries)

  if (!drawn.length) {
    return (
      <div className={HEIGHT}>
        <Empty>Select a corner below to plot it.</Empty>
      </div>
    )
  }

  return (
    <TrajectoryOverlay
      series={drawn}
      nominal={nominal.trajectory}
      nominalLabel="nominal (unswept)"
      channel={channel}
      refLines={deployAlts.map((d) => ({ name: d.name, y: d.z }))}
      className={HEIGHT}
    />
  )
}

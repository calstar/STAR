/**
 * One line per design, on one set of axes.
 *
 * The table below says what each design *scores*; this says what each one
 * *does*. Two canopies that land at the same impact velocity can get there
 * completely differently -- one riding a drogue down for a minute, the other
 * opening high and floating -- and only the trajectory shows that.
 *
 * No legend here, unlike the Corners chart. Twenty entries above the plot is a
 * third of the vertical space spent on a key that the table repeats two inches
 * lower, with the metrics attached. The table is the legend.
 */

import type { StudyPoint, StudyResult } from '../../api/client'
import type { Channel } from '../chartTheme'
import { CONTEXT_COLOUR, studyColour } from '../chartTheme'
import { TrajectoryOverlay } from '../TrajectoryOverlay'
import type { OverlaySeries } from '../TrajectoryOverlay'
import { Empty } from '../ui'

const HEIGHT = 'h-[30rem]'

export function StudyChart({ points, nominal, hidden, channel, showContext, refLines }: {
  points: StudyPoint[]
  /** The unstudied config, always drawn as the reference. */
  nominal: StudyResult['nominal']
  /** Ids the user has unticked. Hidden rather than selected, because the
   *  default is to show the whole family and prune from there. */
  hidden: string[]
  channel: Channel
  /** Draw the hidden designs in the anonymous grey instead of dropping them. */
  showContext: boolean
  /** Device trigger altitudes, in SI. Empty for any device whose trigger is
   *  itself being swept -- see StudyPanel. */
  refLines: { name: string; y: number }[]
}) {
  const withTraj = points.filter((p) => p.trajectory?.length)

  if (!withTraj.length) {
    return (
      <div className={HEIGHT}>
        <Empty>No flight histories in this response — re-run the sweep.</Empty>
      </div>
    )
  }

  // Colour by POSITION in the study, not by position among the visible lines:
  // hiding a design must not repaint the others, or two screenshots of the same
  // study disagree about which line is which.
  const toSeries = (p: StudyPoint, i: number): OverlaySeries => {
    const off = hidden.includes(p.id)
    return {
      id: p.id,
      label: Object.values(p.values).join(' · '),
      colour: off ? CONTEXT_COLOUR : studyColour(i),
      muted: off,
      trajectory: p.trajectory!,
    }
  }

  const all = withTraj.map(toSeries)
  const shown = all.filter((s) => !s.muted)
  const context = showContext ? all.filter((s) => s.muted) : []
  // Context first so the chosen lines land on top of it.
  const drawn = [...context, ...shown]

  if (!drawn.length) {
    return (
      <div className={HEIGHT}>
        <Empty>Every design is hidden — tick one in the table below.</Empty>
      </div>
    )
  }

  return (
    <TrajectoryOverlay
      series={drawn}
      nominal={nominal.trajectory}
      nominalLabel="current config"
      channel={channel}
      refLines={refLines}
      legend={false}
      className={HEIGHT}
    />
  )
}

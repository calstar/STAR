/**
 * Three models on one set of axes.
 *
 * Unlike Corners and Sweep there is no reference line here, because there is no
 * reference: "which of these three is right" is the open question the tab
 * exists to pose. All three are peers, so all three get an identity colour and
 * the legend stays on -- three entries is a key, not the wall of twenty that
 * made the Sweep chart drop its own.
 *
 * The mastersheet is drawn dashed. Its curve is a closed form under a
 * terminal-velocity assumption rather than an integration, so it is a different
 * kind of object from the other two and should not read as the same one.
 */

import type { CrossModel, CrossModelResult } from '../../api/client'
import type { Channel } from '../chartTheme'
import { TrajectoryOverlay } from '../TrajectoryOverlay'
import type { OverlaySeries } from '../TrajectoryOverlay'
import { Empty } from '../ui'
import { MODEL_COLOUR, MODEL_ORDER } from './models'

const HEIGHT = 'h-[34rem]'

/** What the channel is called in a sentence. */
const CHANNEL_NOUN: Partial<Record<Channel, string>> = {
  F_T: 'an opening load',
  a: 'an acceleration',
  z: 'an altitude history',
  v: 'a velocity history',
  CdS_tot: 'a total drag area',
}

/** Why a given model is silent on a given channel. Per model AND per channel,
 *  because the two absences have completely different causes and saying the
 *  wrong one is worse than saying nothing. */
const REASON: Partial<Record<CrossModel, Partial<Record<Channel, string>>>> = {
  openrocket: {
    F_T: 'OpenRocket has no opening-force calculation at all - only a warning above 20 m/s.',
  },
  mastersheet: {
    F_T: 'The mastersheet gives one load per canopy rather than a history; those are in the table below.',
    a: 'The mastersheet assumes terminal velocity, so it has no acceleration.',
  },
}

export function CrosscheckChart({ models, channel, refLines }: {
  models: Record<CrossModel, CrossModelResult>
  channel: Channel
  refLines: { name: string; y: number }[]
}) {
  const present = MODEL_ORDER.filter((id) => models[id]?.trajectory?.length)

  /**
   * Models with nothing to say on THIS channel: every sample null.
   *
   * They are dropped from the series rather than drawn as an empty line, so
   * the legend does not advertise a colour the reader will then hunt for. The
   * note underneath names them and says why, which is the part that actually
   * carries the finding.
   */
  const silent = present.filter((id) =>
    models[id].trajectory.every(
      (p) => p[channel] === null || p[channel] === undefined))

  const drawn = present.filter((id) => !silent.includes(id))

  const series: OverlaySeries[] = drawn.map((id) => ({
    id,
    label: models[id].label,
    colour: MODEL_COLOUR[id],
    trajectory: models[id].trajectory,
    dashed: id === 'mastersheet',
  }))

  /**
   * Dots on the points a model actually reports.
   *
   * The mastersheet's line is reconstructed by re-entering its own closed form
   * at altitudes its authors never evaluated. That is legitimate but it is not
   * a cell anybody designed against, and without the dots a reader will take
   * every point on the smooth curve for a reported one. Only the mastersheet
   * has this - the other two integrate every sample they draw.
   */
  for (const id of drawn) {
    const reported = models[id].reported
    if (!reported?.length) continue
    const visible = reported.filter(
      (p) => p[channel] !== null && p[channel] !== undefined)
    if (!visible.length) continue
    series.push({
      id: `${id}__reported`,
      label: `${models[id].label} (reported)`,
      colour: MODEL_COLOUR[id],
      trajectory: visible,
      markersOnly: true,
    })
  }

  if (!series.length) {
    return (
      <div className={HEIGHT}>
        <Empty>
          {silent.length
            ? 'None of the three models computes this quantity.'
            : 'No trajectories in this response.'}
        </Empty>
      </div>
    )
  }

  const hasMarkers = series.some((s) => s.markersOnly)

  return (
    <div className="space-y-2">
      <TrajectoryOverlay
        series={series}
        nominal={undefined}
        channel={channel}
        refLines={refLines}
        legend
        className={HEIGHT}
      />
      {hasMarkers && (
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          <span className="text-[var(--color-text-primary)]">
            Dots are the mastersheet's own numbers
          </span>{' '}
          (each deployment and the landing); the line is the trajectory its
          descent-time formula implies. Freeze the speed at deployment and the
          sheet's descent time comes out 13% short.
          {channel === 'v' && (
            <>
              {' '}
              <span className="text-amber-300">
                The dots do not sit on the line, and that is the finding.
              </span>{' '}
              Its velocity cells and its descent-time formula use different
              elevation conventions, 7% apart.
            </>
          )}
        </p>
      )}
      {silent.length > 0 && (
        <p className="text-xs leading-relaxed text-amber-300/90">
          <span className="text-amber-300">
            Not on this chart:{' '}
            {silent.map((id) => models[id].label).join(', ')}.
          </span>{' '}
          {silent.length > 1 ? 'Neither' : 'It'} computes{' '}
          {CHANNEL_NOUN[channel] ?? 'this quantity'}, so{' '}
          {silent.length > 1 ? 'they are' : 'it is'} left out of the legend
          rather than drawn as a line along zero - an absence, not a
          measurement.{' '}
          {silent.map((id) => REASON[id]?.[channel]).filter(Boolean).join(' ')}
        </p>
      )}
    </div>
  )
}

/**
 * Model identity for the Cross-check tab.
 *
 * Separate from the components for the same reason `chartTheme.ts` is: the
 * react-refresh lint rule requires a file to export only components, and both
 * the chart and the table need these.
 */

import type { CrossModel } from '../../api/client'
import { CORNER_COLOURS } from '../chartTheme'

/**
 * Fixed, never cycled.
 *
 * Three models is three colours and the assignment must not move between
 * renders, or two screenshots of the same comparison disagree about which line
 * is which. Drawn from CORNER_COLOURS rather than STUDY_COLOURS because these
 * are unordered categories -- OpenRocket has no position relative to the
 * mastersheet -- which is the same reason the Corners tab uses them.
 */
export const MODEL_COLOUR: Record<CrossModel, string> = {
  ours: CORNER_COLOURS[0],        // blue
  openrocket: CORNER_COLOURS[1],  // orange
  mastersheet: CORNER_COLOURS[2], // aqua
}

/** Ours first: the other two are being compared *to* it. */
export const MODEL_ORDER: CrossModel[] = ['ours', 'openrocket', 'mastersheet']

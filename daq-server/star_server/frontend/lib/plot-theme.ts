/**
 * How a plot's frame draws, shared by every uPlot here and matching
 * feed-twin's DaqPlot: a hairline grid and small grey monospace ticks, so the
 * traces are the brightest thing on the canvas.
 */
export const AXIS_STROKE = '#7a7a7a';
export const AXIS_GRID = { show: true, stroke: '#1c1c1c', width: 1 } as const;
export const AXIS_TICKS = { show: true, stroke: '#2a2a2a', width: 1 } as const;
export const AXIS_FONT = '11px "SF Mono", ui-monospace, Menlo, monospace';

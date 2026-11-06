/**
 * Video layouts: the presets' geometry, and how the stand layout (config/video.json) and an
 * operator's own changes (this browser only) combine into what a screen shows.
 *
 * No imports on purpose: the backend's tests import PRESET_SLOT_COUNTS to hold it equal to
 * the server's LAYOUT_PRESETS, so the two can never disagree about how many slots a preset has.
 */

export const PRESET_SLOT_COUNTS = { auto: 0, '1x1': 1, '2x2': 4, '3x3': 9, '1+5': 6, '1+7': 8 } as const;
export type LayoutPreset = keyof typeof PRESET_SLOT_COUNTS;
export const PRESETS = Object.keys(PRESET_SLOT_COUNTS) as LayoutPreset[];

export const PRESET_LABELS: Record<LayoutPreset, string> = {
  auto: 'Auto',
  '1x1': '1',
  '2x2': '2×2',
  '3x3': '3×3',
  '1+5': '1+5',
  '1+7': '1+7',
};

export interface VideoLayout {
  preset: LayoutPreset;
  slots: (string | null)[];
}

/** A slot's place on the grid (0-based), and whether it is the big one. */
export interface Cell {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  /** Large slots play a stream's main URL; small ones its low-res URL when it has one. */
  large: boolean;
}

export interface Geometry {
  cols: number;
  rows: number;
  cells: Cell[];
}

function evenGrid(n: number, largeWhenAlone: boolean): Geometry {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cells: Cell[] = Array.from({ length: n }, (_, i) => ({
    col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1, large: largeWhenAlone && n === 1,
  }));
  return { cols, rows, cells };
}

/** One large cell (size `big`) top-left of a `size`×`size` grid, the rest around it. */
function onePlus(size: number, big: number): Geometry {
  const cells: Cell[] = [{ col: 0, row: 0, colSpan: big, rowSpan: big, large: true }];
  for (let r = 0; r < big; r++) cells.push({ col: big, row: r, colSpan: 1, rowSpan: 1, large: false });
  for (let c = 0; c <= big; c++) cells.push({ col: c, row: big, colSpan: 1, rowSpan: 1, large: false });
  return { cols: size, rows: size, cells };
}

/** The grid for a preset. 'auto' needs the number of streams it is laying out. */
export function geometry(preset: LayoutPreset, autoCount = 0): Geometry {
  switch (preset) {
    case '1x1': return evenGrid(1, true);
    case '2x2': return evenGrid(4, false);
    case '3x3': return evenGrid(9, false);
    case '1+5': return onePlus(3, 2);
    case '1+7': return onePlus(4, 3);
    default: return evenGrid(autoCount, true);
  }
}

/** The stream in each slot. 'auto' is every stream in list order. */
export function resolveSlots(layout: VideoLayout, streamIds: string[]): (string | null)[] {
  if (layout.preset === 'auto') return [...streamIds];
  const known = new Set(streamIds);
  return Array.from({ length: PRESET_SLOT_COUNTS[layout.preset] }, (_, i) => {
    const id = layout.slots[i];
    return id && known.has(id) ? id : null;
  });
}

/** An operator's changes, kept in this browser. Valid only against the stand layout it was made on. */
export interface OperatorOverride {
  /** fingerprint() of the stand layout when the override was made. */
  base: string;
  /** Replaces the stand's slots (same length), or null to keep them. */
  slots: (string | null)[] | null;
  /** A stream shown full-screen, or null. */
  focus: string | null;
}

export function fingerprint(layout: VideoLayout, streamIds: string[]): string {
  return JSON.stringify([layout.preset, resolveSlots(layout, streamIds), streamIds]);
}

export interface Effective {
  geometry: Geometry;
  slots: (string | null)[];
  focus: string | null;
  /** The operator has changes of their own showing. */
  overridden: boolean;
}

/**
 * What this screen shows: the stand layout, with the operator's changes on top -- unless
 * the stand layout changed since they were made, in which case they are ignored (and the
 * caller should drop them), so no screen is left on a layout VIDCOMM has moved away from.
 */
export function effectiveLayout(stand: VideoLayout, streamIds: string[], override: OperatorOverride | null): Effective {
  const standSlots = resolveSlots(stand, streamIds);
  const geo = geometry(stand.preset, standSlots.length);
  const valid = !!override && override.base === fingerprint(stand, streamIds);
  const known = new Set(streamIds);
  const slots = valid && override!.slots && override!.slots.length === standSlots.length
    ? override!.slots.map((id) => (id && known.has(id) ? id : null))
    : standSlots;
  const focus = valid && override!.focus && known.has(override!.focus) ? override!.focus : null;
  return { geometry: geo, slots, focus, overridden: valid && (!!override!.slots || !!focus) };
}

/** Swap slot `index` to show `streamId`, as an override on the stand layout. */
export function withSlot(stand: VideoLayout, streamIds: string[], override: OperatorOverride | null, index: number, streamId: string | null): OperatorOverride {
  const eff = effectiveLayout(stand, streamIds, override);
  const slots = [...eff.slots];
  slots[index] = streamId;
  return { base: fingerprint(stand, streamIds), slots, focus: eff.focus };
}

export function withFocus(stand: VideoLayout, streamIds: string[], override: OperatorOverride | null, focus: string | null): OperatorOverride {
  const eff = effectiveLayout(stand, streamIds, override);
  return { base: fingerprint(stand, streamIds), slots: eff.overridden ? eff.slots : null, focus };
}

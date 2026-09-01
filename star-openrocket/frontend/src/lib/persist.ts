/**
 * The config survives a reload.
 *
 * Everything a session sets — the model, part overrides, face selections, the
 * motor, the rail, the flight params — lives in one `ViewerConfig`, which a
 * refresh would otherwise throw away. Stored in `localStorage` (per-browser, not
 * synced); the server-side design store (api/documents) is the durable, versioned
 * timeline, this is the desk you left it on.
 *
 * Deliberately NOT stored here: results (recomputed from the config), and view
 * prefs like opacity that have no bearing on the analysis.
 */

import type { ViewerConfig } from '../types/config'
import { defaultFlightParams, defaultViewerConfig } from '../types/config'

/** Versioned key, so a future shape change is ignored rather than crashed on. */
export const STORAGE_KEY = 'star-openrocket.config.v1'

/**
 * A stored config, merged onto today's defaults. Null when nothing usable is there.
 *
 * Merged per field rather than taken whole: the stored copy was written by whatever
 * version of the app last ran, so a field added since is absent from it and
 * `{...saved}` would leave it `undefined`. Default first, overwrite with saved, so a
 * new field arrives with its default and an old one is preserved. Nothing here
 * validates the analysis — the backend judges a bad selection, same as if typed.
 */
export function reviveViewerConfig(raw: string | null): ViewerConfig | null {
  if (!raw) return null
  let saved: Partial<ViewerConfig>
  try {
    saved = JSON.parse(raw)
  } catch {
    return null
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null

  const base = defaultViewerConfig()
  return {
    version: 1,
    modelId: typeof saved.modelId === 'string' ? saved.modelId : base.modelId,
    overrides: saved.overrides && typeof saved.overrides === 'object' ? saved.overrides : base.overrides,
    outerFaces: Array.isArray(saved.outerFaces) ? saved.outerFaces : base.outerFaces,
    finFaces: Array.isArray(saved.finFaces) ? saved.finFaces : base.finFaces,
    finCount: typeof saved.finCount === 'number' ? saved.finCount : base.finCount,
    motor: saved.motor ?? base.motor,
    railLength: typeof saved.railLength === 'number' ? saved.railLength : base.railLength,
    flight: { ...defaultFlightParams(), ...(saved.flight ?? {}) },
  }
}

// -- Unified design (CAD + recovery) ---------------------------------------
//
// A design is one OrkConfig = { cad, recovery }. Each slice is revived onto its
// own defaults so a field added to either half arrives with its default rather
// than undefined. The recovery slice reuses the recovery calculator's own
// `reviveUiConfig` (fed the stringified slice).

import type { OrkConfig } from '../types/config'
import { defaultOrkConfig } from '../types/config'
import { reviveUiConfig } from '../recovery/lib/persist'
import { defaultUiConfig, toStoredConfig } from '../recovery/lib/serialise'

export function reviveOrkConfig(raw: string | null): OrkConfig | null {
  if (!raw) return null
  let saved: { cad?: unknown; recovery?: unknown }
  try {
    saved = JSON.parse(raw)
  } catch {
    return null
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null
  const cad = reviveViewerConfig(saved.cad ? JSON.stringify(saved.cad) : null) ?? defaultViewerConfig()
  const recovery = reviveUiConfig(saved.recovery ? JSON.stringify(saved.recovery) : null) ?? defaultUiConfig()
  return { version: 1, cad, recovery }
}

/**
 * The design as it is *stored*: view state stripped out of the recovery slice.
 *
 * `config` gets a new identity on any UI change, including ones that carry no
 * design change at all -- collapsing a device card is the obvious one. The
 * server store compares against this form, so those never reach it, which
 * matters more now that a save is what holds a checkout open.
 */
export function toStoredOrkConfig(config: OrkConfig): OrkConfig {
  return { ...config, recovery: toStoredConfig(config.recovery) }
}

/** The stored unified design, or the default. Never throws. */
export function loadOrkConfig(): OrkConfig {
  try {
    return reviveOrkConfig(localStorage.getItem(STORAGE_KEY)) ?? defaultOrkConfig()
  } catch {
    return defaultOrkConfig()
  }
}

/** Store the unified design. Quietly does nothing if storage refuses. */
export function saveOrkConfig(config: OrkConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    /* private mode, quota, or no storage. Not worth a dialog. */
  }
}

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

/** The stored config, or the default. Never throws: storage off/full ⇒ defaults. */
export function loadViewerConfig(): ViewerConfig {
  try {
    return reviveViewerConfig(localStorage.getItem(STORAGE_KEY)) ?? defaultViewerConfig()
  } catch {
    return defaultViewerConfig()
  }
}

/** Store the config. Quietly does nothing if storage refuses — a failed save must
 *  not take down the app the user is still editing in. */
export function saveViewerConfig(config: ViewerConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    /* private mode, quota, or no storage. Not worth a dialog. */
  }
}

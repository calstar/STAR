/**
 * The config survives a reload.
 *
 * Everything a session builds -- the vehicle, the devices, the corner bounds,
 * the sweeps -- lives in one `UiConfig` in `App`, which means a refresh threw
 * all of it away. That was fine when the app opened on the worked example and
 * you edited two numbers; it is not fine once a study is four canopies and a
 * twelve-month pad sweep picked one click at a time.
 *
 * Stored, not synced. `localStorage` is per-browser and the file-based
 * `Save config` / `Load config` on the Recovery tab is still the way to move a
 * config between machines or into a review -- this is the desk you left it on,
 * not the filing cabinet. It also stores the UI-side bookkeeping a saved
 * config deliberately drops (which catalog row filled a device, which cards
 * are collapsed), because those are exactly the things that make picking up
 * where you left off feel like picking up where you left off.
 *
 * Deliberately NOT stored: unit preferences, which have their own key and
 * their own reasoning in `unitsContext`, and results. A result is derived from
 * a config in about 80 ms; storing it would mean opening the app on numbers
 * that might not match the inputs shown beside them.
 */

import type { UiConfig, UiDevice, UiStudyAxis } from '../types/schema'
import { defaultUiConfig, nextUid } from './serialise'

/** Versioned, so a future shape change can be ignored rather than crash on. */
export const STORAGE_KEY = 'recovery-calculator.config.v1'

/**
 * A stored config, merged onto today's defaults. Null when there is nothing
 * usable there.
 *
 * Merged per section rather than taken whole, because the stored copy was
 * written by whatever version of the app the user last ran. A field added
 * since then is absent from it, and `{...saved}` would leave that field
 * `undefined` -- which type-checks, reaches the form, and renders as a blank
 * box on a required input. Taking the default first and overwriting means a
 * new field arrives with its default and an old one is preserved.
 *
 * Nothing here validates physics. A stored config that is not a legal vehicle
 * comes back, gets posted, and the backend says why -- which is the same thing
 * that happens if you type it. Silently repairing it would hide a value the
 * user themselves put there.
 */
export function reviveUiConfig(raw: string | null): UiConfig | null {
  if (!raw) return null

  let saved: Partial<UiConfig>
  try {
    saved = JSON.parse(raw)
  } catch {
    return null
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null

  const base = defaultUiConfig()

  // A config with no devices is not a config, and neither is one whose devices
  // are not objects. Anything short of that is left alone: an out-of-range
  // number is the user's, and the backend is what judges it.
  const devices = Array.isArray(saved.devices) ? saved.devices : []
  if (!devices.length || devices.some((d) => !d || typeof d !== 'object')) {
    return null
  }

  return {
    vehicle: { ...base.vehicle, ...saved.vehicle },
    site: { ...base.site, ...saved.site },
    devices: devices.map((d: UiDevice) => ({
      ...base.devices[0],
      ...d,
      // Fresh keys. `nextUid` restarts at d1 on every load, so a restored uid
      // would collide with the next device added this session and React would
      // reconcile two different cards as one.
      uid: nextUid(),
    })),
    sweep: Array.isArray(saved.sweep) && saved.sweep.length
      ? saved.sweep
      : base.sweep,
    // Empty is a legitimate study -- it is what the app opens on -- so unlike
    // `sweep` there is no "empty means missing" case to fall back from.
    study: Array.isArray(saved.study)
      ? saved.study.map((a: UiStudyAxis, i: number) => ({
          ...a,
          // Namespaced rather than run through `nextUid`, which numbers
          // devices. Either would do; this keeps a restored axis identifiable
          // in the DOM.
          uid: `r${i}`,
        }))
      : base.study,
  }
}

/** The stored config, or the default one. Never throws: a browser with
 *  storage disabled or full is a browser that opens on the worked example. */
export function loadUiConfig(): UiConfig {
  try {
    return reviveUiConfig(localStorage.getItem(STORAGE_KEY)) ?? defaultUiConfig()
  } catch {
    return defaultUiConfig()
  }
}

/** Store the config. Quietly does nothing if storage refuses -- a failed save
 *  must not take down the app the user is still editing in. */
export function saveUiConfig(ui: UiConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ui))
  } catch {
    /* private mode, quota, or no storage at all. Not worth a dialog. */
  }
}

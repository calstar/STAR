/**
 * One name -> id map for the state-machine CSVs, built from the active config.
 *
 * Both CSV parsers used to carry their own copy of a fixed name -> SystemState table. The CSVs are
 * written by the config editor against [[states]], so the two agree only on a rig that never
 * renamed or renumbered a state — and when they diverged the parsers silently produced ids from a
 * numbering nothing else used. A 12-state rig parsed to ids 1, 2, 7, 13, 15, 16, 20, with the five
 * states whose names the fixed table had never heard of dropped entirely. The GUI matched those
 * against its own config ids, found 1 and 2 in common, and every button but Idle <-> Armed failed
 * a gate with no error anywhere.
 *
 * Two copies of a wrong table is how that recurred, so there is one now.
 */

import { SystemState } from '../../../shared/types.js';
import { readConfig } from '../routes/config.js';

/**
 * Fallback for a config that declares no [[states]] — the historical table, including the legacy
 * aliases the older CSVs were written with.
 */
export const LEGACY_CSV_STATE_MAP: Record<string, SystemState> = {
  'Debug': SystemState.DEBUG,
  'Idle': SystemState.IDLE,
  'Armed': SystemState.ARMED,
  'Fuel Fill': SystemState.FUEL_FILL,
  'Ox Fill': SystemState.OX_FILL,
  'Press Standby': SystemState.PRESS_STANDBY,
  'GN2 Low Press': SystemState.GN2_LOW_PRESS,
  'GN2 Low Vent': SystemState.GN2_VENT,
  'Fuel Press': SystemState.FUEL_PRESS,
  'Fuel Vent': SystemState.FUEL_VENT,
  'Ox Press': SystemState.OX_PRESS,
  'Ox Vent': SystemState.OX_VENT,
  'GN2 High Press': SystemState.GN2_HIGH_PRESS,
  'GN2 High Vent': SystemState.GN2_HIGH_VENT,
  'Vent': SystemState.VENT,
  'Calibrate': SystemState.CALIBRATE,
  'Ready': SystemState.READY,
  'Fire': SystemState.FIRE,
  'Engine Abort': SystemState.ENGINE_ABORT,
  'GSE Abort': SystemState.GSE_ABORT,
  'Emergency Abort': SystemState.EMERGENCY_ABORT,
  // Legacy names still found in older CSVs.
  'GN2 Press': SystemState.GN2_LOW_PRESS,
  'GN2 Vent': SystemState.GN2_VENT,
  'Quick Fire': SystemState.READY,
  'High Press': SystemState.GN2_HIGH_PRESS,
  'Abort': SystemState.EMERGENCY_ABORT,
};

/**
 * Name -> id for the states the active config declares; the legacy table only when it declares
 * none. When the config declares states it is the whole authority: a name it does not declare must
 * NOT fall through to a legacy id, which is the same mismatch in a quieter form.
 *
 * Read per call rather than cached — a profile can be redeployed under a running backend, and a
 * cache would go on parsing the previous rig's numbering.
 */
export function csvStateMap(): Record<string, SystemState> {
  try {
    const raw = (readConfig() as any)?.states;
    if (Array.isArray(raw)) {
      const m: Record<string, SystemState> = {};
      for (const e of raw) {
        if (typeof e?.id === 'number' && typeof e?.name === 'string') m[e.name] = e.id as SystemState;
      }
      if (Object.keys(m).length > 0) return m;
    }
  } catch {
    /* fall through to the legacy table */
  }
  return LEGACY_CSV_STATE_MAP;
}

/**
 * server/config-caches.ts — config-derived lookups on the Elodin hot path, rebuilt after a deploy.
 *
 * Owns the HP (4-20 mA) board-number set and the T7 calibrated-table field map that
 * parseElodinPacket takes on every packet, and the two slot→board_id maps behind
 * uniqueIdFromPtEntity. initConfigCaches() is the startup read (DESIGN-WP6 §1.2 row 8);
 * resetConfigCaches() is the one rebuild point, called from applyDeployedConfigChange (STYLE-S20).
 * The PT slot map is private and lazily filled; the T7 slot map is exported in step 1 because
 * board-status.noteT7Alive() still fills it too (two lazy fillers until step 2.4, DESIGN-WP6 §1.1).
 *
 * `_hpBoardNumbers` and `_t7CalFields` are `export let` live bindings assigned only here
 * (STYLE-S32); step 2.5 renames them. No effect at import (M1). Never imports api-server.ts or api/*.
 *
 * Contract: uniqueId = board_id*100+channel matches calibration_service (the calibration capture
 * path of test/ws_data_flow_test.ts); the `bid % 10, 0 → 10` slot rule here is the sixth copy
 * (D-WS, R5) and is replaced only in step 2.3 after G6.
 */

import { hpBoardNumbers, t7CalFields } from '../sensor-config.js';
import { readConfig } from '../routes/config.js';
import { t7Channels } from '../../../shared/config-validation.js';

/** Cached HP (4-20 mA) PT board-number set for the Elodin decode hot path. Rebuilt on config
 *  reload (onConfigUpdated) so moving/adding an HP board takes effect without a restart. */
export let _hpBoardNumbers: Set<number>;
/** Cached T7 calibrated-table -> field map (which float is psi, °C or kg); rebuilt with it. */
export let _t7CalFields: Map<number, string>;

/** The startup config reads (HP set, then T7 fields), in today's order. */
export function initConfigCaches(): void {
  _hpBoardNumbers = hpBoardNumbers();
  _t7CalFields = t7CalFields();
}

/** Cached slot→board_id map for uniqueIdFromPtEntity — built once, avoids config re-reads on hot path. */
const _ptSlotToBoardId = new Map<number, number>();
function _ensurePtSlotCache(): void {
  if (_ptSlotToBoardId.size > 0) return;
  try {
    const config = readConfig();
    const boards = (config.boards || {}) as Record<string, Record<string, unknown>>;
    for (const [, raw] of Object.entries(boards)) {
      const bid = raw.board_id;
      const typ = raw.type;
      if (typeof bid !== 'number' || typ !== 'PT') continue;
      const mod = bid % 10;
      _ptSlotToBoardId.set(mod === 0 ? 10 : mod, bid);
    }
  } catch { /* fine — fallback below */ }
}

/** T7 slot -> board_id, for T7<slot>_Cal.AIN<n> (built with the PT cache, cleared with it). */
export const _t7SlotToBoardId = new Map<number, number>();

/** Map PT{n}.CH{m} — or a T7 input's T7{n}_Cal.AIN{m} — to uniqueId = board_id*100+channel
 *  (matches calibration_service, where a T7 input's channel is its AIN). */
export function uniqueIdFromPtEntity(entity: string): number | null {
  const t7 = entity.match(/^T7(\d+)_Cal\.AIN(\d+)$/);
  if (t7) {
    if (_t7SlotToBoardId.size === 0) {
      try {
        for (const ch of t7Channels(readConfig().boards)) _t7SlotToBoardId.set(ch.slot, ch.boardId);
      } catch { /* no config: no T7 uid */ }
    }
    const bid = _t7SlotToBoardId.get(parseInt(t7[1], 10));
    return bid !== undefined ? bid * 100 + parseInt(t7[2], 10) : null;
  }
  const m = entity.match(/^PT(\d+)(?:_Cal)?\.CH(\d+)$/);
  if (!m) return null;
  const slot = parseInt(m[1], 10);
  const ch = parseInt(m[2], 10);
  _ensurePtSlotCache();
  const bid = _ptSlotToBoardId.get(slot);
  return bid !== undefined ? bid * 100 + ch : slot * 100 + ch;
}

/** The post-deploy rebuild: the same four statements, in the same order, as applyDeployedConfigChange had. */
export function resetConfigCaches(): void {
  _ptSlotToBoardId.clear();
  _t7SlotToBoardId.clear();
  _hpBoardNumbers = hpBoardNumbers();
  _t7CalFields = t7CalFields();
}

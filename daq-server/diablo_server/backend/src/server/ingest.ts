/**
 * server/ingest.ts — route each Elodin row to the module that owns what it says.
 *
 * Owns no state. handleElodinPacket is the one input boundary for Elodin rows: its try/catch
 * covers the whole handler (`Packet error`, packet dropped) and nothing inside catches. Its
 * first statement stays notePairDelivered(high, low) through both steps (D42(d)). In step 1 the
 * body was server.ts's packet listener verbatim; step 2.1 made it a router — each block went
 * to its owner in the per-row order of DESIGN-WP6 §3.2 step 6, which is behaviour (sensed state →
 * T7 liveness → raw ADC → mission T+0 → counters → downsampling). The two sensed-row blocks stay
 * here until G1 lands (D51); the counters and noteIngest() stay here because stats owns a
 * container, not a function.
 *
 * Event-loop only, called from elodin-link's `packet` event, which server.ts registers. No
 * effect at import (M1). Never imports api-server.ts or api/*; nothing imports this module but
 * server.ts.
 *
 * Contract: the parse site (valve calibration wrapping the tare wrapping the decoder) is
 * guarded by __tests__/lc-tare.test.ts, which greps this file for it — never quote the
 * expression in a comment here, or that check passes on nothing; the streams, self-test replay, `self_test_fail_<id>`
 * and mission_start_time are frozen in pipeline/golden/ws_streams.txt, boards/ws_events.txt
 * and ws_handshake.txt; `Unmapped packet from Elodin` is a log line.
 */

import { parseElodinPacket } from '../elodin-protocol.js';
import { expandWithTare } from '../lc-tare.js';
import { applyValveCalibration } from '../ball-valve-cal.js';
import { notePairDelivered } from '../elodin-vtable-registry.js';
import { recordBoardScanIngest, isPrimaryPhysicalStream, mapEntityToGroup } from '../board-scan-rate.js';
import { ballValveSensedEntity, sensedStateFromPosition } from '../ball-valve.js';
import { stats } from './stats.js';
import { activeNotificationKeys } from './notifications.js';
import { noteFirstSample } from './mission-time.js';
import { hpBoardNumbersCache, t7CalFieldsCache } from './config-caches.js';
import { publishSample } from './sensor-stream.js';
import { noteRawAdc } from './calibration-state.js';
import { countHeartbeat, updateBoard, updateBoardFirmware, noteT7Alive, noteSelfTestResults } from './board-status.js';
import { currentState, applySequencerState } from './engine-state.js';
import { actuatorSensedState, scheduleActuatorMismatchCheck } from './actuator-mismatch.js';
import { noteIngest } from './elodin-link.js';

export function handleElodinPacket(header: any, payload: Buffer): void {
  try {
    const [high, low] = header.packetId as [number, number];
    // Proof this table is live. A rejection naming a delivering pair is a misattribution,
    // and acting on it would re-subscribe a live table and double its rate.
    notePairDelivered(high, low);

    // ── Board heartbeat [0x10, board_id] ────────────────────────────────────
    if (high === 0x10) {
      countHeartbeat(low);
      updateBoard(low, payload);
      return;
    }

    // ── Board firmware digest [0x11, board_id] ──────────────────────────────
    // daq_bridge publishes this only when a board's firmware changes, so this
    // arrives once per board per boot or reflash, not per heartbeat.
    if (high === 0x11) {
      updateBoardFirmware(low, payload);
      return;
    }

    // ── Parse sensor/actuator/state packets ──────────────────────────────────
    // expandWithTare appends a derived `force_kg_tared` for each calibrated load-cell point and
    // leaves `force_kg` alone. It belongs HERE rather than inside parseElodinPacket (a pure,
    // stateless decoder that elodin-query.ts also uses to replay the archive — taring there
    // would apply today's offset to yesterday's samples) and rather than in the outbox drain
    // (which would leave the live stream tared and the reconnect backfill gross, because
    // emitSensorWindow records to history before it stages to any client).
    // applyValveCalibration replaces a ball valve's position_pct with its two-point calibrated
    // figure (ball-valve-cal.ts) before the mismatch check below and the browser see it.
    const parsedList = applyValveCalibration(
      expandWithTare(parseElodinPacket(header.packetId, payload, hpBoardNumbersCache, t7CalFieldsCache)));

    if (parsedList.length === 0) {
      if (high >= 0x40) {
        console.log(`[ThinServer] Unmapped packet from Elodin: [0x${high.toString(16)}, 0x${low.toString(16)}] len=${payload.length}`);
      }
      return;
    }

    const epochNow = Date.now();

    // ── Self-test results → snapshot + NOTIFICATION ────────────────────
    if (high >= 0x60 && high <= 0x6F && parsedList.length > 0) {
      noteSelfTestResults(low, parsedList, epochNow);
    }

    // ── SequencerState packet → STATE_UPDATE broadcast ───────────────────
    if (parsedList[0]?.entity === '_SEQUENCER_STATE') {
      applySequencerState(parsedList);
      scheduleActuatorMismatchCheck(currentState);
      // FIRE_START / FIRE_STOP are NOT sent from here. The sequencer owns the burn gate and
      // notifies controller_service itself (SequencerService::notifyControllerFire). This branch
      // used to send them too, so a safety-critical gate had two writers in two processes racing
      // on the same TCP endpoint — and this one keyed off SystemState.FIRE, a hardcoded enum,
      // rather than the configured fire state.
      return;
    }

    for (const parsed of parsedList) {
      if (!Number.isFinite(parsed.value)) continue;

      // A ball valve's sensed state comes from its position [0x34]: open/closed near the ends of
      // travel, nothing while it travels or its loop is dead (ball-valve.ts).
      if (parsed.component === 'position_pct') {
        const sensedEntity = ballValveSensedEntity(parsed.entity);
        if (sensedEntity) {
          const status = parsedList.find((p) => p.entity === parsed.entity && p.component === 'cal_status')?.value;
          const sensed = sensedStateFromPosition(parsed.value, status);
          const prev = actuatorSensedState.get(sensedEntity);
          if (sensed === undefined) actuatorSensedState.delete(sensedEntity);
          else actuatorSensedState.set(sensedEntity, sensed);
          if (prev !== sensed && activeNotificationKeys.has('actuator_mismatch')) {
            scheduleActuatorMismatchCheck(currentState);
          }
        }
      }

      // Track actuator sensed state [0x31] for mismatch detection
      if (parsed.component === 'actuator_state') {
        const prev = actuatorSensedState.get(parsed.entity);
        actuatorSensedState.set(parsed.entity, parsed.value);
        // Re-check mismatch when sensed state changes (clears "current" flag when resolved)
        if (prev !== parsed.value && activeNotificationKeys.has('actuator_mismatch')) {
          scheduleActuatorMismatchCheck(currentState);
        }
      }

      // A T7's raw data is its heartbeat (noteT7Alive).
      if (parsed.component === 'volts' || parsed.component === 'temperature_c') {
        const t7 = /^T7(\d+)\.(?:AIN\d+|CJC)$/.exec(parsed.entity);
        if (t7) noteT7Alive(parseInt(t7[1], 10));
      }

      // Track raw ADC for calibration (uniqueId = board_id*100+channel, same as calibration_service)
      if (parsed.component === 'raw_adc_counts') noteRawAdc(parsed.entity, parsed.value);

      // Set mission T+0 on first meaningful data packet.
      noteFirstSample(epochNow);

      stats.ingestEntityUpdatesReceived++;
      noteIngest();

      // Pre-downsample ingest rate (what boards/Elodin actually deliver) — not WS broadcast rate.
      recordBoardScanIngest(parsed.entity, parsed.component);
      // _Cal excluded: calibration_service republications would double-count PT samples.
      if (!parsed.entity.includes('_Cal') && isPrimaryPhysicalStream(parsed.entity, parsed.component)) {
        stats.rawPrimarySamplesIngested++;
        const group = mapEntityToGroup(parsed.entity) ?? 'other';
        stats.rawPrimarySamplesByGroup[group] = (stats.rawPrimarySamplesByGroup[group] || 0) + 1;
      }

      publishSample(high, low, parsed, epochNow);
    }
  } catch (err) {
    console.error('[ThinServer] Packet error:', err);
  }
}

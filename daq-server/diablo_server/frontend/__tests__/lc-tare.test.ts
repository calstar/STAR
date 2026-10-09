/**
 * Load-cell tare: the frontend half.
 *
 * The frontend does no tare arithmetic at all — the backend publishes `force_kg_tared` as its own
 * component and the page picks which one to render. What can still go wrong is picking the wrong
 * one, and both directions are bad in a specific way:
 *
 *   - a readout left on `force_kg` while the plot under it uses `force_kg_tared` shows 0 beside a
 *     trace sitting at 20, which is exactly the confusion the feature exists to remove;
 *   - the calibration page moved onto `force_kg_tared` would show a tared number beside the input
 *     where the operator types the true weight of a known mass, and that false point would tilt
 *     the whole cubic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useSensorStore, useLoadCellForceKg, buildAliasesFromConfig } from '@/lib/store';
import { renderHook } from '@testing-library/react';
import { waitForSensorFlush } from './waitForSensorFlush';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('useLoadCellForceKg', () => {
  beforeEach(() => {
    useSensorStore.setState({ sensorData: {} });
  });

  it('renders the tared component, not gross', async () => {
    const { updateSensor } = useSensorStore.getState();
    updateSensor({ entity: 'LC2_Cal.CH1', component: 'force_kg', value: 50, timestamp: Date.now() });
    updateSensor({ entity: 'LC2_Cal.CH1', component: 'force_kg_tared', value: 30, timestamp: Date.now() });
    await waitForSensorFlush();

    const { result } = renderHook(() => useLoadCellForceKg('LC2_Cal.CH1'));
    expect(result.current).toBe(30);
  });

  it('falls back to null rather than gross when the tared component is absent', async () => {
    // Not a cosmetic choice: silently substituting gross would make an untared readout
    // indistinguishable from a backend that stopped publishing the derived component.
    const { updateSensor } = useSensorStore.getState();
    updateSensor({ entity: 'LC2_Cal.CH1', component: 'force_kg', value: 50, timestamp: Date.now() });
    await waitForSensorFlush();

    const { result } = renderHook(() => useLoadCellForceKg('LC2_Cal.CH1'));
    expect(result.current).toBeNull();
  });
});

describe('force_lbf / force_n stay derived from absolute weight', () => {
  it('derives from force_kg and ignores force_kg_tared', async () => {
    // These are archive-comparable legacy aliases. Re-taring them silently produces "why does the
    // N readout disagree with the kg readout" with nothing in the code pointing at the cause.
    useSensorStore.setState({ sensorData: {} });
    const { updateSensor } = useSensorStore.getState();
    updateSensor({ entity: 'LC2_Cal.CH1', component: 'force_kg', value: 10, timestamp: Date.now() });
    updateSensor({ entity: 'LC2_Cal.CH1', component: 'force_kg_tared', value: 1, timestamp: Date.now() });
    await waitForSensorFlush();

    const data = useSensorStore.getState().sensorData;
    expect(data['LC2_Cal.CH1.force_n']).toBeCloseTo(10 * 9.80665, 4);
    expect(data['LC2_Cal.CH1.force_lbf']).toBeCloseTo(10 * 2.2046226218, 4);
  });
});

describe('which page reads which component', () => {
  it('the calibration page reads absolute weight only', () => {
    const cal = src('app/calibration/page.tsx');
    expect(cal).toContain("'force_kg'");
    expect(cal).not.toContain('force_kg_tared');
  });

  it('the LC readout and the plot beneath it read the same component', () => {
    const page = src('app/plots/lcs-tcs-rtd/page.tsx');
    // The readout goes through useLoadCellForceKg (tared); the plot must match it. A bare
    // component="force_kg" here is the split-screen bug.
    expect(page).toContain('useLoadCellForceKg');
    expect(page).toContain('component="force_kg_tared"');
    expect(page).not.toContain('component="force_kg"');
  });

  it('the chamber page plots the same component its readout uses', () => {
    const page = src('app/plots/chamber/page.tsx');
    expect(page).toContain('useLoadCellForceKg');
    expect(page).toContain('component="force_kg_tared"');
    expect(page).not.toContain('component="force_kg"');
  });

  it('the alias table carries force_kg_tared, or role-name lookups cannot resolve it', async () => {
    // Behavioural, not a string search: store.ts mentions force_kg_tared in several places, so
    // grepping for it would pass even with the component missing from lcComponents — and the
    // symptom would be a role-named readout (LC2_Cal.LOX_Scale) silently reading nothing.
    useSensorStore.setState({ sensorData: {} });
    buildAliasesFromConfig({
      boards: { lc_board: { type: 'LC', board_id: 42, active_connectors: [1] } },
      sensor_roles_lc_board: { 'LOX Scale': 1 },
    });
    const { updateSensor, getSensorValue } = useSensorStore.getState();
    updateSensor({ entity: 'LC2_Cal.CH1', component: 'force_kg_tared', value: 30, timestamp: Date.now() });
    await waitForSensorFlush();
    expect(getSensorValue('LC2_Cal.LOX_Scale', 'force_kg_tared')).toBe(30);
  });
});

describe('the tare uid', () => {
  it('comes from the config row, never from the entity string', () => {
    // "LC2_Cal.CH1" carries the Elodin slot (board_id % 10), not the board id, so parsing a uid
    // back out of it collides two boards that share a slot — the failure that once wrote a load
    // cell's curve over a 5000 psi transducer's.
    const page = src('app/plots/lcs-tcs-rtd/page.tsx');
    expect(page).toContain('r.boardId * 100 + r.channel');
    expect(page).not.toMatch(/LC(\d+)_Cal.*match|match.*LC\\d\+_Cal/);
  });

  it('sends sensorId and boardId split back out of that uid', () => {
    const page = src('app/plots/lcs-tcs-rtd/page.tsx');
    expect(page).toContain('sensorId: uid % 100');
    expect(page).toContain('boardId: Math.floor(uid / 100)');
  });
});

describe('tare state comes from the backend', () => {
  it('polls the status endpoint rather than assuming a click worked', () => {
    // [0x46,0x00] carries no reply and the service can refuse a tare outright when the stream is
    // stale. An optimistic zero would be a lie about a load cell.
    const page = src('app/plots/lcs-tcs-rtd/page.tsx');
    expect(page).toContain('/api/lc_tare');
    // Narrow to the command sender: asserting the page merely mentions setTarePending passes on
    // the strength of its own useState declaration. What matters is that sending a command marks
    // the tare unconfirmed and does NOT write the offset straight into local state.
    const sender = page.slice(page.indexOf('const sendTareCmd'), page.indexOf('const anyTared'));
    expect(sender).toContain('setTarePending(true)');
    expect(sender).not.toContain('setLcTares');
  });
});

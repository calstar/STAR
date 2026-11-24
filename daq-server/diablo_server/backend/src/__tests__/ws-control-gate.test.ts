/**
 * The WS arm gate on calibration writes (SEC-5) and on the countdown target (SEC-8).
 *
 * `handleMessage` is driven directly with a fake socket. The calibration handler, the senders
 * and the countdown owner are mocked, so what is asserted is the gate alone: an unarmed socket
 * gets `Control locked` and the handler never runs; an armed one (CONTROL_UNLOCK as an operator,
 * which is what no X-Auth-Email gives) reaches it; the read-only calibration types stay open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../calibration-handler.js', () => ({ handleCalibrationCommand: vi.fn() }));
vi.mock('../server/ws-clients.js', () => ({ send: vi.fn() }));
vi.mock('../server/mission-time.js', () => ({ setCountdownTarget: vi.fn() }));
vi.mock('../sequencer-client.js', () => ({ sendToSequencer: vi.fn(async () => ({ ok: true, reply: 'OK' })) }));

const { handleMessage } = await import('../server/commands.js');
const { handleCalibrationCommand } = await import('../calibration-handler.js');
const { send } = await import('../server/ws-clients.js');
const { setCountdownTarget } = await import('../server/mission-time.js');

const WRITES = [
  'capture_reference', 'capture_cubic_point', 'clear_cubic_channel', 'tare_lc', 'clear_tare_lc',
  'capture_point', 'new_calibration', 'zero_all', 'save_coefficients', 'clear_calibration',
];
const OPEN = ['enable_phase2', 'disable_phase2', 'reset_channel', 'char_probe'];

function socket(operator: boolean, armed: boolean): any {
  const ws: any = { __daqOperator: operator };
  if (armed) handleMessage(ws, { type: 'control_unlock', payload: {} });
  return ws;
}

const locked = () =>
  (send as any).mock.calls.some(
    ([, m]: any[]) => m.type === 'error' && /Control locked/.test(m.payload?.message ?? ''),
  );

beforeEach(() => vi.clearAllMocks());

describe('CALIBRATION_COMMAND', () => {
  it.each(WRITES)('%s from an unarmed socket is refused and never reaches the handler', (commandType) => {
    handleMessage(socket(true, false), { type: 'calibration_command', payload: { commandType } });
    expect(handleCalibrationCommand).not.toHaveBeenCalled();
    expect(locked()).toBe(true);
  });

  it.each(WRITES)('%s from a viewer who tried to arm is refused', (commandType) => {
    handleMessage(socket(false, true), { type: 'calibration_command', payload: { commandType } });
    expect(handleCalibrationCommand).not.toHaveBeenCalled();
    expect(locked()).toBe(true);
  });

  it.each(WRITES)('%s from an armed operator reaches the handler', (commandType) => {
    const ws = socket(true, true);
    vi.clearAllMocks();
    handleMessage(ws, { type: 'calibration_command', payload: { commandType } });
    expect(handleCalibrationCommand).toHaveBeenCalledTimes(1);
    expect(locked()).toBe(false);
  });

  it.each(OPEN)('%s (changes nothing) stays open to an unarmed socket', (commandType) => {
    handleMessage(socket(false, false), { type: 'calibration_command', payload: { commandType } });
    expect(handleCalibrationCommand).toHaveBeenCalledTimes(1);
    expect(locked()).toBe(false);
  });
});

describe('set_countdown_target', () => {
  const msg = { type: 'send_command', payload: { commandType: 'set_countdown_target', data: { targetTimeMs: 4102444000000 } } };

  it('from an unarmed socket is refused and the target is not set', () => {
    handleMessage(socket(true, false), msg);
    expect(setCountdownTarget).not.toHaveBeenCalled();
    expect(locked()).toBe(true);
  });

  it('from an armed operator sets the target', () => {
    const ws = socket(true, true);
    vi.clearAllMocks();
    handleMessage(ws, msg);
    expect(setCountdownTarget).toHaveBeenCalledWith(4102444000000);
    expect(locked()).toBe(false);
  });
});

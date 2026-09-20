/**
 * Load-cell re-zero: the frontend half.
 *
 * There is no arithmetic to test here — the shift is applied in C++, inside the curve, because
 * model(adc - shift) is not model(adc) - k. What can go wrong in the browser is all about
 * *claims*: a button that looks like it worked when the service refused, a chip that says
 * "absolute" about a number that is not, and the two commands that sound alike being wired to
 * each other's opcode.
 *
 * Mirrors the source-grep style of lc-tare.test.ts for the same reason it uses one: the page
 * calls httpServer-backed hooks and a live WebSocket at module scope, so the wiring is pinned by
 * reading it rather than by rendering it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const LCS_PAGE = 'app/plots/lcs-tcs-rtd/page.tsx';
const CAL_PAGE = 'app/calibration/page.tsx';

describe('zero state comes from the backend, never from a click', () => {
  it('polls /api/lc_zero', () => {
    expect(src(LCS_PAGE)).toContain('/api/lc_zero');
  });

  it('never sets the zero map optimistically when sending a command', () => {
    // [0x46,0x00] carries no reply, and the service REFUSES a re-zero whose calibration has no
    // 0 kg anchor to measure against. An optimistic chip would claim a channel reads empty at a
    // code the service never accepted.
    const page = src(LCS_PAGE);
    const body = page.slice(page.indexOf('const sendTareCmd'), page.indexOf('const anyTared'));
    expect(body).toContain('setTarePending(true)');
    expect(body).not.toContain('setLcZeros');
    expect(body).not.toContain('setLcTares');
  });

  it('refreshes the tare as well as the zero after any of the four commands', () => {
    // A re-zero moves a standing tare's kilograms: the service re-derives the tare THROUGH the
    // new shift. Refreshing only the zero would leave the tare chip showing the old offset.
    const page = src(LCS_PAGE);
    const body = page.slice(page.indexOf('const sendTareCmd'), page.indexOf('const anyTared'));
    expect(body).toContain('refreshLcState');
    const refresh = page.slice(page.indexOf('const refreshLcState'));
    expect(refresh.slice(0, 200)).toContain('fetchTares()');
    expect(refresh.slice(0, 200)).toContain('fetchZeros()');
  });
});

describe('the four commands stay distinct', () => {
  it('sends zero_lc and clear_zero_lc, not the tare commands', () => {
    const page = src(LCS_PAGE);
    expect(page).toContain("sendTareCmd('zero_lc'");
    expect(page).toContain("sendTareCmd('clear_zero_lc'");
    expect(page).toContain("sendTareCmd('tare_lc'");
    expect(page).toContain("sendTareCmd('clear_tare_lc'");
  });

  it('uses the same uid split as the tare, never parsing it out of the entity string', () => {
    // The number in "LC2_Cal.CH1" is the Elodin slot (board_id % 10), not the board id, so two
    // boards sharing a slot resolve to the same uid — the collision that once put a load cell's
    // curve on a 5000 psi transducer.
    const page = src(LCS_PAGE);
    expect(page).toContain('sensorId: uid % 100');
    expect(page).toContain('boardId: Math.floor(uid / 100)');
  });

  it('wires the per-row zero buttons to the uid from config', () => {
    const page = src(LCS_PAGE);
    expect(page).toContain("onZero={() => sendTareCmd('zero_lc', lcUids[i])}");
    expect(page).toContain("onClearZero={() => sendTareCmd('clear_zero_lc', lcUids[i])}");
  });
});

describe('the readout tells the truth about what the number means', () => {
  it('shows the zero as its own chip, independent of the tare chip', () => {
    // A tare is subtracted AFTER the curve, a zero shifts its INPUT. A channel can carry both,
    // and "why does this read 0?" has a different answer for each — one chip with three states
    // would make them look mutually exclusive.
    const page = src(LCS_PAGE);
    expect(page).toContain('shiftCodes');
    const box = page.slice(page.indexOf('function DerivedReadoutBox'), page.indexOf('function TCTempReadout'));
    expect(box).toContain('Zeroed');
    expect(box).toContain('Tared');
    expect(box).toContain('Absolute');
  });

  it('the calibration page no longer calls its load-cell reading absolute while a zero stands', () => {
    // It used to say "This page shows absolute weight". That was true of the tare, which the
    // page deliberately does not apply, and is false of the zero, which C++ applies to force_kg
    // before anything downstream sees it.
    const page = src(CAL_PAGE);
    expect(page).toContain('/api/lc_zero');
    expect(page).toContain('anyLcZeroed');
    const banner = page.slice(page.indexOf('anyLcTared && selectedKind'));
    expect(banner.slice(0, 900)).not.toContain('<strong>absolute</strong>');
  });

  it('still reads force_kg, not force_kg_tared, on the calibration page', () => {
    // Unchanged invariant, re-pinned here because the zero work touched this file: the operator
    // types the true weight of a known mass, and a tared reading beside that input is exactly
    // how a false point gets into the fit.
    const page = src(CAL_PAGE);
    expect(page).toContain("'force_kg'");
    expect(page).not.toContain('force_kg_tared');
  });
});

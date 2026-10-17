import { describe, expect, it } from 'vitest';
import { burnWindowStart, isBottleChannel } from './consolePlot';
import { channelPalette, legOf, sayDetail } from '../api';

describe('the bottles come off the tanks axis', () => {
  // LE4: tanks drawn at 750 psig MAWP, the COPV transducer red at 7,500.
  const mawps = [750, 750];
  it('a COPV transducer is a bottle by its red line', () => {
    expect(isBottleChannel({ values: [0, 0], meop: 7500, nop: 4000 }, mawps)).toBe(true);
  });
  it('and by what it read when it has no lines', () => {
    expect(isBottleChannel({ values: [10, 4485, 4300] }, mawps)).toBe(true);
  });
  it('a tank, the feed and the chamber are not', () => {
    expect(isBottleChannel({ values: [500, 520], meop: 750, nop: 585 }, mawps)).toBe(false);
    expect(isBottleChannel({ values: [0, 380, 420], meop: 454, nop: 398 }, mawps)).toBe(false);
  });
  it('with no MAWP drawn the line is 1,500 psig', () => {
    expect(isBottleChannel({ values: [1400] }, [])).toBe(false);
    expect(isBottleChannel({ values: [1600] }, [])).toBe(true);
  });
});

describe('the Burn window', () => {
  const events = [
    { t: 3, label: 'Fuel Fill' },
    { t: 40, label: 'Fire' },
    { t: 44, label: 'Vent' },
    { t: 90, label: 'Fire' },
  ];
  it('starts just before the last Fire', () => {
    expect(burnWindowStart(events, 95, 2, 10)).toBe(85);
  });
  it('never spans less than the least window', () => {
    expect(burnWindowStart(events, 91, 2, 10)).toBe(81);
  });
  it('is the last few seconds with no Fire in the history', () => {
    expect(burnWindowStart([{ t: 1, label: 'Ox Fill' }], 30, 2, 10)).toBe(20);
  });
});

describe('every channel its own colour', () => {
  it('reads a leg off tags that are not the DAQ\'s', () => {
    expect(legOf('OU-PT-R')).toBe('lox');
    expect(legOf('FU-PT-R')).toBe('fuel');
    expect(legOf('PT-HP-1')).toBe('gas');
    expect(legOf('DP-PT-R')).toBe('dome');
  });
  it('gives LE4 four colours, the tanks in their vessels\' colours', () => {
    const p = channelPalette(['PT-HP-1', 'DP-PT-R', 'FU-PT-R', 'OU-PT-R', 'PC']);
    expect(new Set(Object.values(p)).size).toBe(5);
    expect(p['OU-PT-R']).toBe('#38BDF8'); // the LOX tank's
    expect(p['FU-PT-R']).toBe('#FF4500'); // the fuel tank's
    expect(p.PC).toBe('#F39C12');
  });
  it('two channels on one leg get two shades of it', () => {
    const p = channelPalette(['OX-PT-1', 'OX-PT-2']);
    expect(p['OX-PT-1']).not.toBe(p['OX-PT-2']);
  });
  it('keeps the DAQ\'s own colours', () => {
    expect(channelPalette(['PT-OX-UP', 'PT-FU-UP'])).toEqual({ 'PT-OX-UP': '#38BDF8', 'PT-FU-UP': '#FF4500' });
  });
});

describe('a refusal is one sentence', () => {
  it('passes a sentence through', () => {
    expect(sayDetail('TK-1 holds nitrogen at 293 K.', 'x')).toBe('TK-1 holds nitrogen at 293 K.');
  });
  it('flattens a validation list, never [object Object]', () => {
    const said = sayDetail(
      [{ loc: ['body', 'dome'], msg: 'Input should be a number', type: 'float_parsing' }],
      'x',
    );
    expect(said).toBe('dome: Input should be a number.');
    expect(said).not.toContain('[object');
  });
  it('falls back when there is nothing to say', () => {
    expect(sayDetail({}, 'The server refused it (500).')).toBe('The server refused it (500).');
  });
});

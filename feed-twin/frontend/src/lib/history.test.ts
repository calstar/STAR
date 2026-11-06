import { describe, expect, it } from 'vitest';
import { historyCsv, statesAt, unread } from './history';

// The history endpoint after T-0 and Fire (scratchpad scen14.py): the events
// are rounded to the millisecond, the samples are not.
const times = [0.7377, 0.7477, 0.7577, 0.7777];
const events = [
  { t: 0.748, label: 'Ready' },
  { t: 0.758, label: 'Fire' },
];

describe('the state column', () => {
  it('labels the first sample of a state with that state', () => {
    // 0.7577 s is the first Fire sample; its event says 0.758.
    expect(statesAt(times, events, 'Fire')).toEqual(['', 'Ready', 'Fire', 'Fire']);
  });

  it('labels a window with no change by the state the stand is in', () => {
    expect(statesAt(times, [], 'Idle')).toEqual(['Idle', 'Idle', 'Idle', 'Idle']);
  });

  it('takes an event at the window\'s first sample as its starting state', () => {
    expect(statesAt(times, [{ t: 0.7377, label: 'Idle' }, ...events], 'Fire')).toEqual([
      'Idle',
      'Ready',
      'Fire',
      'Fire',
    ]);
  });
});

describe('the CSV', () => {
  const full = {
    times_s: times,
    events,
    channels: [
      { id: 'pt', tag: 'PT-1', unit: 'psig', values: [0, 500, 500.5, 501] },
      // A thermocouple on the engine: the twin models no temperature there.
      { id: 'tc', tag: 'TC-1', unit: 'K', values: [0, 0, 0, 0] },
      { id: 'rtd', tag: 'TC-3', unit: 'K', values: [90.1, 90.2, 90.3, 90.4] },
    ],
  };
  const csv = historyCsv(full, 'Fire', (_id, tag) => tag).split('\n');

  it('heads each column with its console name and the unit a person reads', () => {
    expect(csv[0]).toBe('t_s,state,PT-1 [psia],TC-1 [K],TC-3 [K]');
  });

  it('leaves a channel the twin cannot read empty, never 0 K', () => {
    expect(unread(full.channels[1])).toBe(true);
    expect(csv[3]).toBe('0.758,Fire,515.196,,90.3');
    for (const row of csv.slice(1)) expect(row.split(',')[3]).toBe('');
  });
});

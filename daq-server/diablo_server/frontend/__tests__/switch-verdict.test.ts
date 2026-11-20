import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { decodeSwitchStatus, switchVerdict } from '@/lib/switch-verdict';

// The same cases the switch's web page runs (firmware/Bluetooth_Switch/web/test/protocol.test.mjs).
const CASES = path.resolve(__dirname, '../../../../lib/daq-protocol/test/switch_verdicts.json');
const { cases } = JSON.parse(readFileSync(CASES, 'utf8')) as {
  cases: { name: string; status: string; level: string; text: string }[];
};

describe('switch verdict (shared cases)', () => {
  it('has cases', () => expect(cases.length).toBeGreaterThan(0));
  for (const c of cases) {
    it(c.name, () => {
      const bytes = Uint8Array.from(c.status.match(/../g)!.map((h) => parseInt(h, 16)));
      expect(switchVerdict(decodeSwitchStatus(bytes))).toEqual({ level: c.level, text: c.text });
    });
  }
  it('refuses a status version it does not read', () => {
    expect(() => decodeSwitchStatus(new Uint8Array(17).fill(2))).toThrow(/version 2/);
    expect(() => decodeSwitchStatus(new Uint8Array(16))).toThrow(/16 bytes/);
  });
});

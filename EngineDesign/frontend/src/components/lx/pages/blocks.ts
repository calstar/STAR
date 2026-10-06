import type { DiagKey } from '../contract';

/** Each result block's name in words, for the run record's list of models (pages/Record.tsx). */
export const BLOCK_WORDS: Partial<Record<DiagKey, string>> = {
  ladder: 'Pressure ladder', regulator: 'Regulator', pressurant: 'Pressurant budget', saturation: 'Boiling margin', cavitation: 'Cavitation',
  injector: 'Injector', stability: 'Chug', hardware: 'Hardware', thrust_shape: 'Thrust shape', start: 'Start', shutdown: 'Shutdown',
  vv: 'Checks', opmap: 'Operating map',
};

/** A provenance.models block path in words: "diagnostics.solenoids[1]" -> "Press solenoid 2". */
export function blockWords(block: string): string {
  const m = /^(?:diagnostics\.)?([a-z_]+)(?:\[(\d+)\])?(?:\.([a-z_]+))?$/.exec(block);
  if (!m) return block;
  const [, head, idx, sub] = m;
  const base: Record<string, string> = {
    ...BLOCK_WORDS as Record<string, string>, solenoids: 'Press solenoid', outflow: 'Tank outflow', water_hammer: 'Water hammer',
    flight: 'Flight', engine_card: 'Engine card',
  };
  const subWords: Record<string, string> = { separation: 'separation', isp: 'Isp breakdown', soak: 'soak-back', stability: 'static margin', chamber: 'nozzle' };
  const word = base[head] ?? head.replace(/_/g, ' ');
  return `${word}${idx !== undefined ? ` ${Number(idx) + 1}` : ''}${sub ? `, ${subWords[sub] ?? sub.replace(/_/g, ' ')}` : ''}`;
}


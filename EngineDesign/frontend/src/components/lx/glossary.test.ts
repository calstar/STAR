import { describe, expect, it } from 'vitest';
import { GLOSSARY, isGlossaryKey, type GlossaryEntry } from './glossary';

const entries = Object.entries(GLOSSARY) as [string, GlossaryEntry][];

describe('glossary', () => {
  it('carries every term the Layer X pages use', () => {
    const needed = [
      'tankPressure', 'lockup', 'domeSetting', 'bottleFill', 'regulatorDroop', 'supplyPressureEffect', 'cv',
      'pressSolenoid', 'ullage', 'ullageCollapse', 'propellantVapour', 'lineWallHeat', 'stiffness', 'chugMargin',
      'chugFrequency', 'timeLag', 'momentumRatio', 'of', 'cstar', 'etaCstar', 'isp', 'cf', 'pc', 'lstar',
      'contractionRatio', 'expansionRatio', 'throatRecession', 'peOverPa', 'separation', 'specificForce',
      'staticMargin', 'maxQ', 'mawp', 'meop', 'saturationMargin', 'cavitationNumber', 'waterHammer', 'fuelLead',
      'unusablePropellant', 'gasIngestion', 'totalImpulse', 'apogee', 'residual',
      // The rebuilt pages' words (docs/layerx/GUI-SPEC.md, DATA-CONTRACT.md).
      'pressureLadder', 'regulatorCapacity', 'choked', 'jouleThomson', 'hydraulicFlip', 'resultantAngle', 'nyquist',
      'gainMargin', 'acousticMode', 'joukowsky', 'priming', 'hardStart', 'vortex', 'summerfield', 'schmucker',
      'soakBack', 'conservationCheck',
    ];
    expect(needed.filter((k) => !isGlossaryKey(k))).toEqual([]);
  });

  it('gives each term one sentence of intuition, not a paragraph', () => {
    const long = entries.filter(([, e]) => {
      const sentences = e.short.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
      return sentences.length !== 1 || !/[.!?]$/.test(e.short) || e.short.length > 170;
    });
    expect(long.map(([k]) => k)).toEqual([]);
  });

  it('writes equations in plain unicode, not code', () => {
    const code = entries.filter(([, e]) => e.equation && /sqrt|\*\*|[A-Za-z0-9)] ?\* ?[A-Za-z0-9(]|\^|<=|>=|!=/.test(e.equation));
    expect(code.map(([k]) => k)).toEqual([]);
  });

  it('has a title, and no empty optional field', () => {
    for (const [k, e] of entries) {
      expect(e.term.trim(), k).not.toBe('');
      for (const f of ['equation', 'source', 'resolution'] as const) {
        if (e[f] !== undefined) expect(e[f]?.trim(), `${k}.${f}`).not.toBe("");
      }
    }
  });

  it('cites a findable source: a dated work or a numbered standard, never a bare name', () => {
    const vague = entries.filter(([, e]) => e.source && !/(1[89]|20)\d\d|ANSI|ASME|ISA-/.test(e.source));
    expect(vague.map(([k]) => k)).toEqual([]);
  });

  it('quotes the units table for resolution', () => {
    expect(GLOSSARY.pc.resolution).toBe('1\u00a0psi or 0.1\u00a0bar');
    expect(GLOSSARY.of.resolution).toBe('0.01');
    expect(GLOSSARY.isp.resolution).toBe('0.1\u00a0s');
  });

  it('does not treat inherited names as keys', () => {
    expect(isGlossaryKey('toString')).toBe(false);
    expect(isGlossaryKey('constructor')).toBe(false);
  });
});

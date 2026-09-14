import { describe, expect, it } from 'vitest';
import { addLeg, emptySketch, setBend, setSectionBore, splitAt } from './model';
import { exportSketch } from './export';

const L = () => setSectionBore(addLeg(addLeg(emptySketch('mm'), { x: 300, y: 0 }), { x: 300, y: 400 }), null, 10.2);

describe('a sketch as the segments feed-twin reads', () => {
  it('makes one segment of one bore from a run of one diameter', () => {
    const out = exportSketch(L());
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].bore!.value).toBe(10.2);
    expect(out.segments[0].length!.value).toBeCloseTo(700, 2);
    expect(out.segments[0].fittings).toEqual([]);
  });

  it('carries a bend as a bend fitting with its radius and angle', () => {
    const out = exportSketch(setBend(L(), 0, 50)!);
    const f = out.segments[0].fittings![0];
    expect(f.kind).toBe('bend');
    expect(f.bendDiameters).toBeCloseTo(50 / 10.2, 6);
    expect(f.angleDeg).toBeCloseTo(90, 6);
    // Straight tube is what is left once the tangents come off.
    expect(out.segments[0].length!.value).toBeCloseTo(250 + 350, 2);
    expect(out.totalLengthMm).toBeCloseTo(600 + 78.54, 1);
  });

  it('cuts a new segment where the diameter changes', () => {
    let s = splitAt(L(), 300);
    s = setSectionBore(s, s.sections[0].id, 7.7);
    const out = exportSketch(s);
    expect(out.segments.map(x => x.bore!.value)).toEqual([10.2, 7.7]);
    expect(out.segments.map(x => x.length!.value)).toEqual([300, 400]);
  });

  it('reports the fall as a negative rise in metres, and the orientation', () => {
    const out = exportSketch(L());
    expect(out.elevationChange).toMatchObject({ value: -0.4, unit: 'm' });
    expect(out.orientation).toBe('side');
    expect(exportSketch(addLeg(emptySketch('mm'), { x: 0, y: 200 })).orientation).toBe('down');
  });

  it('is nothing for an empty sketch', () => {
    const out = exportSketch(emptySketch());
    expect(out.segments).toEqual([]);
    expect(out.orientation).toBe('none');
  });
});

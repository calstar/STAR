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

  it('states no bore for a run whose inner diameter was never given', () => {
    // LE4 (3)'s fuel tank-to-main run: sketched, never given a diameter, and
    // sent out as bore 0 'estimated' -- which the sheet's check counted as a
    // size and feed-twin dropped, tube and bends together.
    const s = setBend(addLeg(addLeg(emptySketch('in'), { x: 0, y: 200 }), { x: 150, y: 200 }), 0, 38.1)!;
    const out = exportSketch(s);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].bore).toBeUndefined();
    expect(out.segments[0].length!.value).toBeGreaterThan(0);
    const f = out.segments[0].fittings![0];
    expect(f.kind).toBe('bend');
    expect(f.angleDeg).toBeCloseTo(90, 6);
    expect(f.boreMm).toBeUndefined();
    expect(f.bendDiameters).toBeUndefined();
  });

  it('states a bore only on the stretches that have one', () => {
    // Split before the diameter was given: the first stretch still has none.
    let s = splitAt(addLeg(addLeg(emptySketch('mm'), { x: 300, y: 0 }), { x: 300, y: 400 }), 300);
    s = setSectionBore(s, s.sections[0].id, 7.7);
    const out = exportSketch(s);
    expect(out.segments.map(x => x.bore?.value)).toEqual([undefined, 7.7]);
    expect(out.segments.map(x => x.length!.value)).toEqual([300, 400]);
  });

  it('is nothing for an empty sketch', () => {
    const out = exportSketch(emptySketch());
    expect(out.segments).toEqual([]);
    expect(out.orientation).toBe('none');
  });
});

describe('what a sketch writes, to a sensible precision', () => {
  // LE4 (3)'s junc_49-junc_48: an inch sketch whose bore, 0.43 in, is
  // 10.921999999999999 mm in floating point, and whose fall comes off the
  // geometry as 0.8029517354603677 m. Both were stored and shown that way.
  const le4 = () => {
    let s = emptySketch('in');
    for (const to of [
      { x: -25.665571994015636, y: 25.66557199401564 }, { x: -25.665571994015597, y: 730.4393719940156 },
      { x: -5.909008527663417, y: 750.1959354603677 }, { x: -5.9090085276634134, y: 802.9517354603677 },
    ]) s = addLeg(s, to, true);
    return setSectionBore(s, null, 0.43 * 25.4);
  };

  it('writes the bore to a ten-thousandth of a millimetre', () => {
    expect(exportSketch(le4()).segments[0].bore!.value).toBe(10.922);
  });

  it('writes the fall to a tenth of a millimetre', () => {
    expect(exportSketch(le4()).elevationChange.value).toBe(-0.803);
  });
});

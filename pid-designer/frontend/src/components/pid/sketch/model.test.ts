import { describe, expect, it } from 'vitest';
import {
  addLeg, arcLengthMm, bendableVertices, boreAt, emptySketch, fallMm, legLengthMm, pieces,
  pointAlong, removeSection, setBend, setLegLength, setSectionBore, splitAt, straightLengthMm,
  tangentLengthMm, toMm, fromMm, totalLengthMm, turnAngle, undoLeg,
} from './model';
import type { Sketch } from './model';

/** Right, then down: an L, 300 mm across and 400 mm down. */
const L = (): Sketch => addLeg(addLeg(emptySketch('mm'), { x: 300, y: 0 }), { x: 300, y: 400 });

describe('legs', () => {
  it('start at the origin, and the first one is the orientation', () => {
    const s = addLeg(emptySketch('mm'), { x: 250, y: 0 });
    expect(legLengthMm(s, 0)).toBe(250);
    expect(totalLengthMm(s)).toBe(250);
  });

  it('snap to the eight directions unless told not to', () => {
    // 100 across and 3 up is a horizontal leg of 100.04 to a fitter.
    const s = addLeg(emptySketch('mm'), { x: 100, y: 3 });
    expect(s.legs[0].to.y).toBeCloseTo(0, 6);
    const free = addLeg(emptySketch('mm'), { x: 100, y: 3 }, true);
    expect(free.legs[0].to.y).toBe(3);
  });

  it('snap a near-diagonal to 45°', () => {
    const s = addLeg(emptySketch('mm'), { x: 100, y: 95 });
    expect(s.legs[0].to.x).toBeCloseTo(s.legs[0].to.y, 6);
  });

  it('refuse a zero-length leg', () => {
    expect(addLeg(emptySketch('mm'), { x: 0, y: 0 }).legs).toHaveLength(0);
  });

  it('keep direction and carry the rest of the run when a length is edited', () => {
    // Lengthen the first leg of the L: the vertical leg moves right with it.
    const s = setLegLength(L(), 0, 500);
    expect(s.legs[0].to).toEqual({ x: 500, y: 0 });
    expect(s.legs[1].to).toEqual({ x: 500, y: 400 });
    expect(legLengthMm(s, 1)).toBe(400);
  });

  it('undo takes the last leg and whatever lived on it', () => {
    const s = setBend(L(), 0, 50)!;
    const back = undoLeg(s);
    expect(back.legs).toHaveLength(1);
    expect(back.bends).toHaveLength(0);
  });
});

describe('bends', () => {
  it('only go where two legs meet at an angle', () => {
    expect(bendableVertices(L())).toEqual([0]);
    const straight = addLeg(addLeg(emptySketch('mm'), { x: 100, y: 0 }), { x: 200, y: 0 });
    expect(bendableVertices(straight)).toEqual([]);
  });

  it('turn through the angle between the legs', () => {
    expect(Math.abs(turnAngle(L(), 0))).toBeCloseTo(Math.PI / 2, 9);
  });

  it('take tangent length off both legs and add the arc', () => {
    // r = 50 at a right angle: tangent 50 each side, arc pi*50/2 = 78.54.
    const s = setBend(L(), 0, 50)!;
    expect(tangentLengthMm(50, Math.PI / 2)).toBeCloseTo(50, 9);
    expect(straightLengthMm(s, 0)).toBeCloseTo(250, 9);
    expect(straightLengthMm(s, 1)).toBeCloseTo(350, 9);
    expect(arcLengthMm(50, Math.PI / 2)).toBeCloseTo(78.54, 2);
    expect(totalLengthMm(s)).toBeCloseTo(250 + 350 + 78.54, 2);
  });

  it('refuse a radius the legs cannot carry', () => {
    // A 400 mm radius wants 400 of tangent off a 300 mm leg.
    expect(setBend(L(), 0, 400)).toBeNull();
    expect(setBend(L(), 0, 0)).toBeNull();
    expect(setBend(L(), 1, 50)).toBeNull();
  });

  it('list the run as straights and bends in order', () => {
    const p = pieces(setBend(L(), 0, 50)!);
    expect(p.map(x => x.kind)).toEqual(['straight', 'bend', 'straight']);
    expect(p[1].radiusMm).toBe(50);
    expect(Math.abs(p[1].angleRad!)).toBeCloseTo(Math.PI / 2, 9);
    expect(p[2].fromMm).toBeCloseTo(250 + 78.54, 2);
  });
});

describe('fall', () => {
  it('is how far the end sits below the origin', () => {
    expect(fallMm(L())).toBe(400);
    expect(fallMm(addLeg(emptySketch('mm'), { x: 0, y: -100 }))).toBe(-100);
  });
});

describe('sections', () => {
  it('start as one diameter', () => {
    const s = setSectionBore(L(), null, 10.2);
    expect(boreAt(s, 0)).toBe(10.2);
    expect(boreAt(s, 650)).toBe(10.2);
  });

  it('split by distance along the run, keeping the bore until it is changed', () => {
    let s = setSectionBore(L(), null, 10.2);
    s = splitAt(s, 300);
    expect(s.sections).toHaveLength(1);
    expect(boreAt(s, 350)).toBe(10.2);
    s = setSectionBore(s, s.sections[0].id, 7.7);
    expect(boreAt(s, 299)).toBe(10.2);
    expect(boreAt(s, 301)).toBe(7.7);
  });

  it('survive the leg being lengthened, because they are distances not legs', () => {
    let s = splitAt(setSectionBore(L(), null, 10.2), 100);
    s = setLegLength(s, 0, 600);
    expect(s.sections[0].fromMm).toBe(100);
  });

  it('refuse a split off the run or on top of another', () => {
    const s = splitAt(setSectionBore(L(), null, 10.2), 300);
    expect(splitAt(s, 300).sections).toHaveLength(1);
    expect(splitAt(s, 5000).sections).toHaveLength(1);
    expect(removeSection(s, s.sections[0].id).sections).toHaveLength(0);
  });
});

describe('where a distance along the run lands', () => {
  it('walks the straights', () => {
    const s = L();
    expect(pointAlong(s, 150)!.p).toEqual({ x: 150, y: 0 });
    expect(pointAlong(s, 400)!.p).toEqual({ x: 300, y: 100 });
    expect(pointAlong(s, 400)!.dir).toEqual({ x: 0, y: 1 });
  });

  it('follows the arc through a bend', () => {
    const s = setBend(L(), 0, 50)!;
    // Halfway round the bend: 45° from the horizontal, on a circle of r=50
    // centred at (250, 50).
    const mid = pointAlong(s, 250 + 78.54 / 2)!;
    expect(Math.hypot(mid.p.x - 250, mid.p.y - 50)).toBeCloseTo(50, 1);
    expect(mid.dir.x).toBeCloseTo(Math.SQRT1_2, 2);
    expect(mid.dir.y).toBeCloseTo(Math.SQRT1_2, 2);
  });
});

describe('units', () => {
  it('convert in both directions', () => {
    expect(toMm(1, 'in')).toBe(25.4);
    expect(fromMm(1000, 'm')).toBe(1);
  });
});

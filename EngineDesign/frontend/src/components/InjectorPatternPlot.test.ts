import { describe, it, expect } from 'vitest';
import { deriveInjectorLayout } from './InjectorPatternPlot';

/**
 * The drawing makes claims about hardware. These pin the claims.
 *
 * Both fixtures are real designs this repo produced. The "before" one passed all seven
 * Layer-1 gates while being unbuildable, which is the whole reason these views exist.
 */

// configs/ethalox_8kN_FINAL.yaml -- passed every gate, could not be built
const BEFORE = {
  oxidizer: { n_elements: 28, d_jet: 0.0015821116699998301, impingement_angle: 40, spacing: 0.0030182972100858507 },
  fuel: { n_elements: 28, d_jet: 0.001375132476863662, impingement_angle: 69, spacing: 0.009875029755263455 },
  boreDiameter: 0.127,
};

// configs/ethalox_8kN_SHIP.yaml -- same thrust, same bore, buildable
const AFTER = {
  oxidizer: { n_elements: 27, d_jet: 0.0017094, impingement_angle: 40.0, spacing: 0.0081070167 },
  fuel: { n_elements: 27, d_jet: 0.0015024, impingement_angle: 50.0, spacing: 0.0111428181 },
  boreDiameter: 0.127,
};

// The requirements the shipped config actually declares.
const REQS = {
  centerClearDiameter: 0.0381, minWeb: 0.002, wallClearance: 0.008,
  ldMin: 3, ldMax: 5, plateThickness: 0.0127,
  counterboreDiameter: 0.004, orificeLandLOverD: 4,
};

const texts = (w: { text: string }[]) => w.map((x) => x.text).join(' | ');

describe('the old design, which every gate passed', () => {
  const { g, warnings } = deriveInjectorLayout({ ...BEFORE, ...REQS });

  it('crams every element onto a circle narrower than the throat', () => {
    expect(g.rImp * 2000).toBeCloseTo(41.79, 1);     // vs a 49.57 mm throat
    expect(g.coreFrac).toBeLessThan(0.11);           // 10.8 % of the chamber area
  });

  it('leaves no room at the axis for a 3/8 NPT igniter', () => {
    expect(g.centreClear * 1000).toBeCloseTo(24.84, 1);
    expect(texts(warnings)).toContain('centre clear');
  });

  it('calls out the 1.44 mm LOX web against a 2 mm floor', () => {
    expect(g.webO * 1000).toBeCloseTo(1.436, 2);
    expect(texts(warnings)).toContain('web 1.44 mm < 2.00 mm required');
  });

  it('flags the entry as too shallow to start a drill', () => {
    // theta is from the AXIS, so a 69 deg fuel jet meets the face at 21 deg.
    expect(texts(warnings)).toContain('meets the face at 21°');
  });

  it('needs a counterbore to be drillable at all', () => {
    // 12.7 mm plate at 69 deg = 35.44 mm of passage. Read at the orifice diameter --
    // no counterbore -- that is 35.44 - 5.50 land = 29.94 mm at ⌀1.375 = L/d 21.8.
    // The 4 mm counterbore in REQS is exactly what rescues it, which is the point.
    const bare = deriveInjectorLayout({
      ...BEFORE, ...REQS, counterboreDiameter: 0,
    });
    expect(texts(bare.warnings)).toContain('L/d 21.8');
    expect(texts(warnings)).not.toContain('feed passage');
  });

  it('flags the SP-8089 included angle', () => {
    expect(g.included).toBe(109);
    expect(texts(warnings)).toContain('NASA SP-8089');
  });
});

describe('the design that replaced it', () => {
  const { g, warnings } = deriveInjectorLayout({ ...AFTER, ...REQS });

  it('clears the igniter boss, the web floor and the wall land', () => {
    expect(g.centreClear).toBeGreaterThan(REQS.centerClearDiameter);
    expect(Math.min(g.webO, g.webF)).toBeGreaterThan(REQS.minWeb);
    expect(g.wallLand).toBeGreaterThan(REQS.wallClearance);
  });

  it('spreads the spray over a real share of the chamber', () => {
    expect(g.rImp * 2000).toBeGreaterThan(78);
    expect(g.coreFrac).toBeGreaterThan(0.35);
  });

  it('stays under the SP-8089 face-heating threshold', () => {
    expect(g.included).toBe(90);
    expect(texts(warnings)).not.toContain('NASA SP-8089');
  });

  it('raises no blocking warning at all', () => {
    expect(warnings.filter((w) => w.level === 'bad')).toEqual([]);
  });
});

describe('the elliptical face trace', () => {
  it('is what the clearances are measured on, not the drill diameter', () => {
    // Same hole, same ring, only the inclination changes. A 69 deg hole reaches
    // d/cos(69) = 2.79x its own diameter radially; a nearly-axial one reaches ~d.
    const base = {
      oxidizer: { n_elements: 24, d_jet: 0.0016, impingement_angle: 40, spacing: 0.0118 },
      fuel: { n_elements: 24, d_jet: 0.0016, impingement_angle: 40, spacing: 0.0039 },
      boreDiameter: 0.127,
    };
    const shallow = deriveInjectorLayout({ ...base, fuel: { ...base.fuel, impingement_angle: 5 } });
    const steep = deriveInjectorLayout({ ...base, fuel: { ...base.fuel, impingement_angle: 69 } });
    expect(steep.g.centreClear).toBeLessThan(shallow.g.centreClear);
    expect(shallow.g.centreClear - steep.g.centreClear).toBeCloseTo(
      0.0016 / Math.cos((69 * Math.PI) / 180) - 0.0016 / Math.cos((5 * Math.PI) / 180), 5);
  });
});

describe('rings on one circle', () => {
  it('is named as a non-injector rather than drawn as a doublet', () => {
    const same = {
      oxidizer: { n_elements: 20, d_jet: 0.002, impingement_angle: 50, spacing: 0.006 },
      fuel: { n_elements: 20, d_jet: 0.002, impingement_angle: 60, spacing: 0.006 },
      boreDiameter: 0.0813,
    };
    const { g, warnings } = deriveInjectorLayout(same);
    expect(g.degenerate).toBe(true);
    expect(g.lImp).toBe(0);
    expect(texts(warnings)).toContain('face-eroding non-injector');
    // and it must NOT also emit the derived-quantity noise that means nothing here
    expect(texts(warnings)).not.toContain('outside the');
    expect(texts(warnings)).not.toContain('of the chamber area is fed');
  });
});


describe('an orifice is a land on a counterbore, not a hole through the plate', () => {
  const PLATE = { plateThickness: 0.0127, orificeLandLOverD: 4 };

  it('reads the passage at the orifice diameter when no counterbore is declared', () => {
    // Conservative fallback. On the old 69 deg fuel jet: 35.44 mm of passage, a 5.50 mm land,
    // and 29.94 mm left at ⌀1.375 = L/d 21.8.
    const { warnings } = deriveInjectorLayout({ ...BEFORE, ...PLATE });
    expect(texts(warnings)).toContain('feed passage');
    expect(texts(warnings)).toContain('L/d 21.8');
  });

  it('clears once the counterbore is opened out', () => {
    // 29.94 mm at ⌀4.0 is L/d 7.5 -- an ordinary peck cycle.
    const { warnings } = deriveInjectorLayout({
      ...BEFORE, ...PLATE, counterboreDiameter: 0.004,
    });
    expect(texts(warnings)).not.toContain('feed passage');
  });

  it('still catches a counterbore too small for that depth', () => {
    // ⌀2.5 leaves L/d 12.0 on the roughing pass -- still past practice.
    const { warnings } = deriveInjectorLayout({
      ...BEFORE, ...PLATE, counterboreDiameter: 0.0025,
    });
    expect(texts(warnings)).toContain('feed passage');
  });

  it('never calls the orifice land itself too deep -- it is short by construction', () => {
    for (const d of [BEFORE, AFTER]) {
      const { warnings } = deriveInjectorLayout({ ...d, ...PLATE });
      expect(texts(warnings)).not.toContain('orifice land');
    }
  });

  it('the shipped design needs no counterbore at all to be drillable', () => {
    // Its steepest jet is 50 deg, so the worst passage is 13.75 mm at ⌀1.502 = L/d 9.2,
    // inside twist-drill practice even read at the orifice diameter.
    const { warnings } = deriveInjectorLayout({ ...AFTER, ...REQS, ...PLATE });
    expect(warnings).toEqual([]);
  });
});

describe('units', () => {
  it('reports every face dimension in mm, not metres', () => {
    // centreClear is derived in METRES like every other length here; the face readout
    // printed it raw and showed "centre clear ⌀0.07" next to "wall land 14.45 mm".
    const { g } = deriveInjectorLayout({ ...AFTER, ...REQS });
    expect(g.centreClear).toBeLessThan(1);          // metres internally
    expect(g.centreClear * 1000).toBeGreaterThan(60); // ~67 mm on the shipped design
    expect(g.wallLand * 1000).toBeGreaterThan(8);
  });
});

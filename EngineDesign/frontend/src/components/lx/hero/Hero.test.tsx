import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChamberGeometryResponse } from '../../../api/client';
import { makeUnits, DEFAULT_SYSTEM, PRESETS } from '../units';
import { standResult } from './__fixtures__/result';
import { STAND_DOC } from './__fixtures__/stand';
import { parseDrawing, type DrawingDocument } from './drawing';
import { Hero } from './Hero';
import { buildNetView } from './network';
import { lineRows, stateWord, symbolRows, vesselFigure } from './readout';

/**
 * The hero as a story: the stand drawing on a synthetic burn, rendered on the server (no DOM in
 * this suite) with the drawing and the engine geometry handed in, so nothing is fetched. Checks what
 * the page shows, not how it moves.
 */

const DOC: DrawingDocument = { id: 'stand', name: 'stand', sha256: 'x', document: STAND_DOC };

/** A conical engine whose 40 mm throat is the fixture run's. */
function geometry(): ChamberGeometryResponse {
  const cx: number[] = [];
  const cy: number[] = [];
  for (let k = 0; k <= 100; k++) {
    const x = -0.15 + (0.25 * k) / 100;
    cx.push(x);
    cy.push(x < -0.05 ? 0.04 : x < 0 ? 0.02 + (0.02 * -x) / 0.05 : 0.02 + (0.02 * x) / 0.1);
  }
  return {
    positions: cx.map((x) => x + 0.15), R_gas: cy, R_ablative_outer: cy.map((r) => r + 0.008), R_graphite_outer: cy,
    R_stainless: cy.map(() => 0.051), throat_position: 0.15, graphite_start: 0, graphite_end: 0,
    D_chamber: 0.08, D_throat: 0.04, D_exit: 0.08, L_chamber: 0.15, L_nozzle: 0.1, expansion_ratio: 4,
    ablative_enabled: true, graphite_enabled: false, nozzle_x: [], nozzle_y: [], nozzle_method: 'cone',
    chamber_contour_x: cx, chamber_contour_y: cy, Cf: null, Cf_ideal: null, A_throat_solved: null, chamber_contour_method: 'solved',
    t_abl_opt_mm: null, t_gra_opt_mm: null,
  };
}

/** The fixture run with an engine replay: firing from t > 0, slightly under-expanded. */
function burn(opts: { network?: boolean } = {}) {
  const r = standResult({ network: opts.network });
  const ft = r.series.t.filter((x) => x > 0);
  r.replay = { A_throat_m2: ft.map(() => Math.PI * 0.02 ** 2), t: ft, recession_chamber_mm: ft.map(() => 0) } as unknown as typeof r.replay;
  r.delivered = {
    t: ft, pc_psia: ft.map(() => 396), p_exit_psia: ft.map(() => 14.5), ambient_psia: ft.map(() => 13.5), gamma_exit: ft.map(() => 1.14),
    throat_area_ratio: ft.map((_, k) => 1 + 0.01 * k), eps: ft.map(() => 4), thrust_N: [], mdot_O: [], mdot_F: [], isp_s: [], mr: [],
    tc_K: ft.map(() => 3300), gamma: ft.map(() => 1.2), t_exit_K: ft.map(() => 1900),
    recession_throat_mm: [], summary: {},
  } as unknown as typeof r.delivered;
  return r;
}

const html = (r = burn(), g: ChamberGeometryResponse | null = geometry()) =>
  renderToStaticMarkup(<div className="lx" data-theme="dark"><Hero result={r} drawingId="stand" drawing={DOC} geometry={g} /></div>);

describe('Hero (story)', () => {
  const h = html();

  it('is two cards side by side: the feed system, and the engine it feeds', () => {
    expect(h).toMatch(/>Feed system<\/h2>/);
    expect(h).toMatch(/>Engine<\/h2>/);
    expect(h).toMatch(/aria-label="Engine section at T[+−]/);
  });

  it('draws the feed system with pid-designer\'s own canvas, read-only', () => {
    // The editor's renderer (React Flow) mounted with the drawing's theme answered from Layer X's
    // tokens. What it draws needs a DOM to measure symbols in, so the lines and the numbers on them
    // are checked in the browser, not in this server render.
    expect(h).toContain('class="lx-pid');
    expect(h).toContain('react-flow');
    expect(h).toContain('--color-text-primary:var(--lx-text)');
  });

  it('says when the run did not record the network', () => {
    expect(h).toContain('network not recorded');
    expect(html(burn({ network: true }))).not.toContain('network not recorded');
  });

  it('draws the engine on its end, to scale, with the gas\'s state at chamber, throat and exit', () => {
    // The 40 mm throat, grown by the cursor's area ratio.
    expect(h).toMatch(/Throat Ø\u00a04\d\.\d\d\u00a0mm/);
    expect(h).toContain('Under-expanded');
    expect(h).toContain('>Chamber<');
    expect(h).toContain('>Exit<');
    // Sonic at the throat, where T* = Tc 2/(γ+1): 3300 K at γ 1.2 is 3000 K.
    expect(h).toContain('· M 1');
    expect(h).toMatch(/>3,000(\.0)?\u00a0K</);
  });

  it('will not draw another engine than the run\'s', () => {
    const g = geometry();
    g.D_throat = 0.03;
    const other = html(burn(), g);
    expect(other).toContain('Contour not computed for this run');
    expect(other).not.toContain('Exit Mach');
  });
});

describe('readout rows', () => {
  const d = parseDrawing(STAND_DOC);
  const r = standResult();
  const v = buildNetView(d, r);
  const u = makeUnits(DEFAULT_SYSTEM);
  const i = 10;

  it('a tank: pressure, liquid of loaded, level and temperatures, absolute', () => {
    const rows = symbolRows(d.byId.get('OXT')!, v.symbols.get('OXT'), i, u);
    expect(rows.map((x) => x.label)).toEqual(['Pressure', 'Liquid', 'Level', 'Ullage gas', 'Liquid temperature']);
    expect(rows[0].unit).toBe('psia');
    expect(rows[1].note).toBe('of 6.60\u00a0kg');
  });

  it('the bottle reads absolute, like every vessel', () => {
    const rows = symbolRows(d.byId.get('KB1')!, v.symbols.get('KB1'), i, u);
    expect(rows[0]).toMatchObject({ label: 'Pressure', unit: 'psia' });
    expect(vesselFigure(d.byId.get('KB1')!, v.symbols.get('KB1'), i, u)?.unit).toBe('psia');
    expect(vesselFigure(d.byId.get('OXT')!, v.symbols.get('OXT'), i, u)?.unit).toBe('psia');
  });

  it('follows the unit system', () => {
    const bar = makeUnits(PRESETS.si);
    expect(lineRows(v.lines.get('l_kb'), i, bar)[0].unit).toBe('bar(a)');
  });

  it('leaves out what was not recorded, and has nothing for an unread line', () => {
    expect(lineRows(v.lines.get('l_gn2vent2'), i, u)).toEqual([]);
    const valve = symbolRows(d.byId.get('MVO')!, v.symbols.get('MVO'), 0, u);
    expect(valve.map((x) => x.label)).toEqual(['Flow']);
  });

  it('names a valve\'s state', () => {
    expect(stateWord(1)).toBe('Open');
    expect(stateWord(0)).toBe('Shut');
    expect(stateWord(0.4)).toBe('40\u00a0% open');
    expect(stateWord(null)).toBeNull();
  });
});

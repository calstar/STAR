import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InjectorPatternPlot } from './InjectorPatternPlot';
import { InjectorDrawing } from './InjectorDrawing';
import { drawingModel } from '../lib/injectorDrawing';
import { primitivesToDxf, bbox } from '../lib/drawingPrimitives';
import type { InjectorDrawings } from '../lib/drawingPrimitives';
import type { InjectorLayout } from '../api/client';
import { GROUPS, cdBasis, cdChange, draftFromConfig, mergeDeep, updatesFromDraft } from '../lib/injectorHardware';
import layout6500 from './__fixtures__/layout_6500N.json';

/**
 * The geometry lives in engine/core/injectors/layout.py and drawing.py and is tested there
 * (tests/test_injector_layout.py). These check that the frontend shows what the backend derived.
 * The fixture is that module's output for configs/ethalox_6500N.yaml; a Python test fails if it
 * goes stale.
 */
const L = layout6500 as unknown as InjectorLayout & { drawings: InjectorDrawings };
const DR = L.drawings;

describe('drawingModel', () => {
  it('passes the backend numbers through untouched', () => {
    const { g, drill } = drawingModel(L);
    expect(g.rImp).toBe(L.face.r_imp);
    expect(g.zImp).toBe(L.face.z_imp);
    expect(drill[0].tag).toBe('LOX');
    expect(drill[0].freeJet).toBe(L.face.free_jet_O);
    expect(drill[1].channel?.r_center).toBe(L.passages.F.channel?.r_center);
  });
});

describe('the readouts', () => {
  const html = renderToStaticMarkup(createElement(InjectorPatternPlot, { layout: L }));

  it('say the face is contoured and where the jets meet', () => {
    expect(html).toContain('face — contoured');
    expect(html).toContain('mm in front of the face');
  });

  it('give the free jet along the jet, not the axial standoff', () => {
    expect(html).toMatch(/LOX free jet 8\.06 mm = 5\.2 d/);
    expect(html).toMatch(/fuel free jet 8\.48 mm = 6\.0 d/);
  });

  it('show each channel and the lands between them', () => {
    expect(html).toContain('LOX channel on ⌀60.39');
    expect(html).toContain('between channels');
  });

  it('never talk about a walk', () => {
    expect(html.toLowerCase()).not.toContain('walk');
  });

  it('show backend warnings verbatim', () => {
    const warned = { ...L, warnings: [{ level: 'bad', code: 'x', text: 'SENTINEL-WARNING' }] } as InjectorLayout;
    expect(renderToStaticMarkup(createElement(InjectorPatternPlot, { layout: warned }))).toContain('SENTINEL-WARNING');
  });
});

describe('drawing primitives', () => {
  it('the face shows every hole of both rings, each tagged for cross-view hover', () => {
    const ids = new Set(DR.face.filter((p) => 'id' in p && p.id).map((p) => (p as { id: string }).id));
    expect(ids.size).toBe(2 * L.face.n);
    const backIds = new Set(DR.back.filter((p) => 'id' in p && p.id).map((p) => (p as { id: string }).id));
    expect(backIds).toEqual(ids);
  });

  it('the section includes the sleeve, the liner and the plug to the sleeve bore', () => {
    const layers = new Set(DR.section_doublet.map((p) => p.layer));
    for (const l of ['SLEEVE', 'LINER', 'PLATE', 'PASSAGE_O', 'PASSAGE_F', 'JET_O', 'JET_F']) expect(layers).toContain(l);
    // Radius runs across the section (x), the axis at x = 0.
    const out = (layer: string) => bbox(DR.section_doublet.filter((p) => p.layer === layer)).x1;
    expect(out('SLEEVE')).toBeCloseTo(L.envelope.r_sleeve_od, 6);
    expect(out('PLATE')).toBeCloseTo(L.envelope.r_sleeve_id, 6);
  });

  it('renders to SVG with the plug hatched in section', () => {
    const html = renderToStaticMarkup(createElement(InjectorDrawing, { prims: DR.section_doublet, sectioned: true }));
    expect(html).toContain('<pattern');
    expect(html).toMatch(/fill="url\(#/);
  });
});

describe('DXF', () => {
  const dxf = primitivesToDxf(DR.section_doublet, 'mm');

  it('is R12 in millimetres with a layer per feature', () => {
    expect(dxf).toContain('AC1009');
    expect(dxf).toMatch(/\$INSUNITS\n70\n4/);
    for (const layer of ['PLATE', 'SLEEVE', 'LINER', 'PASSAGE_O', 'PASSAGE_F', 'DIM']) {
      expect(dxf).toContain(`LAYER\n2\n${layer}\n`);
    }
    expect(dxf.trim().endsWith('EOF')).toBe(true);
  });

  it('writes one POLYLINE per poly and one CIRCLE per circle', () => {
    // hole fills are screen shading only; their walls are the CAD edges
    const polys = DR.section_doublet.filter((p) => p.t === 'poly' && !p.layer.startsWith('HOLE_')).length;
    expect(dxf).not.toContain('HOLE_O');
    const circles = DR.section_doublet.filter((p) => p.t === 'circle').length;
    expect((dxf.match(/\nPOLYLINE\n/g) ?? []).length).toBe(polys);
    expect((dxf.match(/\nCIRCLE\n/g) ?? []).length).toBe(circles);
  });

  it('scales to the unit asked for', () => {
    expect(primitivesToDxf([{ t: 'circle', layer: 'PLATE', c: [0, 0], r: 0.0254 }], 'in')).toMatch(/\n40\n1\.0000\n/);
    expect(primitivesToDxf([{ t: 'circle', layer: 'PLATE', c: [0, 0], r: 0.0254 }], 'mm')).toMatch(/\n40\n25\.4000\n/);
  });
});

describe('injector hardware form', () => {
  const cfg = {
    injector: { type: 'impinging', igniter: { thread: '1/2 NPT', hub_thickness: 0.01905 },
      plate: { face: 'contoured', back: 'channels', channel_floor: 'flat' } },
    discharge: { oxidizer: { orifice_l_over_d: 4 }, fuel: { orifice_l_over_d: 4 } },
    design_requirements: { layer1_injector_plate_thickness_m: 0.0127 },
  } as unknown as Parameters<typeof draftFromConfig>[0];

  it('shows metres as millimetres', () => {
    const d = draftFromConfig(cfg);
    expect(d.plate_t).toBe('12.7');
    expect(d.hub_t).toBe('19.05');
    expect(d.face).toBe('contoured');
    expect(d.back).toBe('channels');
  });

  it('round-trips without changing a value', () => {
    const u = updatesFromDraft(draftFromConfig(cfg)) as {
      injector: { plate: { face: string; back: string }; igniter: { hub_thickness: number } };
      design_requirements: Record<string, number | null>;
    };
    expect(u.injector.plate.face).toBe('contoured');
    expect(u.injector.plate.back).toBe('channels');
    expect(u.injector.igniter.hub_thickness).toBeCloseTo(0.01905, 12);
    expect(u.design_requirements.layer1_injector_plate_thickness_m).toBeCloseTo(0.0127, 12);
  });

  it('a blank field is unset, never zero', () => {
    const u = updatesFromDraft({ ...draftFromConfig(cfg), channel_width: '', thread: '' }) as {
      injector: { plate: { channel_width: unknown }; igniter: unknown };
    };
    expect(u.injector.plate.channel_width).toBeNull();
    expect(u.injector.igniter).toBeNull();
  });

  it('offers no structure, seal or reserve fields, and hides what does nothing for this plug', () => {
    const keys = GROUPS.flatMap((g) => g.fields.map((f) => f.key));
    for (const dead of ['material', 'yield_factor', 'design_psi', 'hub_d', 'port_wall', 'center_clear', 'manifold_land', 'passage_ld']) {
      expect(keys).not.toContain(dead);
    }
    const shown = (d: Record<string, string>) => GROUPS.flatMap((g) => g.fields.filter((f) => !f.show || f.show(d)).map((f) => f.key));
    const ch = draftFromConfig(cfg);
    expect(shown(ch)).toContain('channel_width');
    expect(shown(ch)).not.toContain('counterbore');
    expect(shown(ch)).not.toContain('ld_src');
    const pl = { ...ch, back: 'plenum' };
    expect(shown(pl)).toContain('counterbore');
    expect(shown(pl)).toContain('ld_src');
  });

  it('with channels the Cd reads the hole L/d, never a plate-derived one', () => {
    const u = updatesFromDraft({ ...draftFromConfig(cfg), ld_src: 'plate' }) as {
      discharge: { oxidizer: { l_over_d_source: string } };
    };
    expect(u.discharge.oxidizer.l_over_d_source).toBe('declared');
  });
});

describe('Cd change', () => {
  const at = (value: number) => ({ value, l_over_d: 4, model: 'lichtarowicz' as const, inlet: 'sharp',
    inlet_cd: 0.8, length_factor: value / 0.8, approach: null, uses_ld: true });

  it('is (Cd0/Cd1)^2 in drop at the same flow and Cd1/Cd0 in flow at the same drop', () => {
    const c = cdChange(at(0.8), at(0.76))!;
    expect(c.dpSameFlow).toBeCloseTo((0.8 / 0.76) ** 2 - 1, 12);
    expect(c.flowSameDp).toBeCloseTo(0.76 / 0.8 - 1, 12);
  });

  it('says when the hole length does not enter the Cd', () => {
    expect(cdBasis({ ...at(0.6), inlet: null, inlet_cd: null, length_factor: null, uses_ld: false })).toMatch(/L\/d has no effect/);
    expect(cdBasis(at(0.8))).toBe('Cd 0.800 = sharp 0.800 × 1.000 for L/d 4.0');
  });

  it('merges a partial update into the config it came from', () => {
    const m = mergeDeep({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 5 }, e: null }) as Record<string, unknown>;
    expect(m).toEqual({ a: { b: 5, c: 2 }, d: 3, e: null });
  });
});

import layoutDoublet from './__fixtures__/layout_doublet_6500N.json';

describe('the stand plate (drill-spot channels, seals, ports, checked against its drawing)', () => {
  const LD = layoutDoublet as unknown as InjectorLayout & { drawings: InjectorDrawings };
  const html = renderToStaticMarkup(createElement(InjectorPatternPlot, { layout: LD }));

  it('shows the port plate and the revolve sketch', () => {
    expect(html).toContain('Port plate');
    expect(html).toContain('Revolve sketch');
  });

  it('reads out the drill-spot floor, the channel area, the ports and the drawing check', () => {
    expect(html).toMatch(/7\.62 floor \+ 2\.54 drill spot, 118 mm²/);
    expect(html).toContain('2× 3/8 NPT per ring');
    expect(html).toMatch(/model within 0\.00\d mm of it/);
  });

  it('writes the revolve sketch as one closed polyline and the axis', () => {
    const dxf = primitivesToDxf(LD.drawings.revolve!, 'in');
    expect((dxf.match(/\nPOLYLINE\n/g) ?? []).length).toBe(2);
    expect(dxf).toContain('\n70\n1\n');          // closed
  });
});

describe('seal grooves and gland in the hardware form', () => {
  const cfg = {
    injector: { plate: {
      back: 'channels', channel_floor: 'spot', channel_spot_length: 0.00254, channel_inlets: 2, port_thread: '3/8 NPT',
      back_grooves: [{ r_inner: 0.0076454, r_outer: 0.011176, depth: 0.0019558, corner_radius: 0.000254 }],
      rim_gland: { z_start: 0.00381, width: 0.0071374, depth: 0.0042545, corner_radius: 0.000635 },
    } },
    discharge: { oxidizer: {}, fuel: {} },
  } as unknown as Parameters<typeof draftFromConfig>[0];

  it('round-trip in metres, and a half-typed groove is not sent', () => {
    const d = draftFromConfig(cfg);
    expect(d.spot).toBe('2.54');
    expect(d.ports).toBe('2');
    const rows = JSON.parse(d.grooves);
    expect(rows[0]).toEqual(['7.6454', '11.176', '1.9558', '0.254']);
    const up = updatesFromDraft({ ...d, grooves: JSON.stringify([...rows, ['20', '', '1', '']]) }) as {
      injector: { plate: { back_grooves: { r_inner: number }[]; rim_gland: { depth: number } | null; channel_inlets: number } };
    };
    expect(up.injector.plate.back_grooves).toHaveLength(1);
    expect(up.injector.plate.back_grooves[0].r_inner).toBeCloseTo(0.0076454, 9);
    expect(up.injector.plate.rim_gland?.depth).toBeCloseTo(0.0042545, 9);
    expect(up.injector.plate.channel_inlets).toBe(2);
  });

  it('drop the gland when its position is cleared', () => {
    const d = { ...draftFromConfig(cfg), gland_z: '' };
    const up = updatesFromDraft(d) as { injector: { plate: { rim_gland: unknown } } };
    expect(up.injector.plate.rim_gland).toBeNull();
  });
});

import cfgNew from './__fixtures__/injector_cfg_new.json';
import cfgOld from './__fixtures__/injector_cfg_old.json';
import { changedUpdates } from '../lib/injectorHardware';

describe('Apply sends only what the form changed', () => {
  // The 2026-09-28 break: the form had read the OLD design, the session held the NEW one, and
  // changing the igniter wrote the old plate (flat channels, no grooves, no drawing) over it.
  const NEW = cfgNew as unknown as Parameters<typeof draftFromConfig>[0];
  const OLD = cfgOld as unknown as Parameters<typeof draftFromConfig>[0];

  it('an igniter change from a stale form leaves the newer plate alone', () => {
    const stale = draftFromConfig(OLD);
    const up = changedUpdates(stale, { ...stale, thread: '1/4 NPT' });
    expect(up).toEqual({ injector: { igniter: { thread: '1/4 NPT', hub_thickness: null } } });
    const after = mergeDeep(NEW, up) as unknown as { injector: { plate: Record<string, unknown>; igniter: { thread: string } } };
    expect(after.injector.plate.channel_floor).toBe('spot');
    expect((after.injector.plate.back_grooves as unknown[]).length).toBe(5);
    expect(after.injector.plate.profile_dxf).toContain('revolve');
    expect(after.injector.igniter.thread).toBe('1/4 NPT');
  });

  it('nothing changed sends nothing', () => {
    const d = draftFromConfig(NEW);
    expect(changedUpdates(d, { ...d })).toEqual({});
  });

  it('a groove edit sends the whole groove list, and only it', () => {
    const d = draftFromConfig(NEW);
    const rows = JSON.parse(d.grooves);
    rows[0][2] = '2.1';
    const up = changedUpdates(d, { ...d, grooves: JSON.stringify(rows) }) as { injector: { plate: Record<string, unknown> } };
    expect(Object.keys(up)).toEqual(['injector']);
    expect(Object.keys(up.injector.plate)).toEqual(['back_grooves']);
    expect((up.injector.plate.back_grooves as { depth: number }[])[0].depth).toBeCloseTo(0.0021, 9);
    expect((up.injector.plate.back_grooves as unknown[]).length).toBe(5);
  });
});

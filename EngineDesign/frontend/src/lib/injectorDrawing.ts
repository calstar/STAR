import type { InjectorLayout } from '../api/client';

export const OX = '#38bdf8';     // oxidiser: cold
export const FU = '#fb923c';     // fuel: warm

/**
 * The API layout in the shape the readouts use. Presentation only: no geometry is derived here,
 * so there is nothing for the drawing and the optimizer to disagree about.
 */
export function drawingModel(layout: InjectorLayout) {
  const { face: f, passages, inputs } = layout;
  const { oxidizer, fuel } = inputs;
  const g = {
    n: f.n, rBore: f.r_bore, rO: f.r_O, rF: f.r_F, dPitchO: f.d_pitch_O, dPitchF: f.d_pitch_F,
    dr: f.dr, lImp: f.l_imp, lOverD: f.l_over_d, zImp: f.z_imp, included: f.included,
    webO: f.web_O, webF: f.web_F, oxIsInner: f.ox_is_inner,
    inner: f.ox_is_inner ? oxidizer : fuel, outer: f.ox_is_inner ? fuel : oxidizer,
    rInner: f.r_inner, rOuter: f.r_outer, rImp: f.r_imp,
    centreClear: f.centre_clear, wallLand: f.wall_land, coreFrac: f.core_frac,
    overflow: f.overflow, degenerate: f.degenerate, contoured: f.contoured, groove: f.groove,
  };
  const drill = ([['LOX', 'O', oxidizer, OX], ['fuel', 'F', fuel, FU]] as const).map(
    ([tag, k, st, c]) => {
      const p = passages[k];
      return {
        tag, k, c, d: st.d_jet, th: st.impingement_angle,
        freeJet: k === 'O' ? f.free_jet_O : f.free_jet_F,
        freeJetLd: k === 'O' ? f.free_jet_ld_O : f.free_jet_ld_F,
        thru: p.thru, land: p.land, bore: p.bore, boreLen: p.bore_len,
        landLd: p.land_ld, boreLd: p.bore_ld, offSquare: p.entry_off_square,
        rBack: p.r_back, entryD: p.entry_d, backWeb: p.back_web,
        channel: p.channel,
      };
    },
  );
  return { g, drill, warnings: layout.warnings };
}

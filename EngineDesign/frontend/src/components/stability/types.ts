/** Rich stability payload from results.stability_rich (plan §A5). */

export interface StabilityRichPayload {
  summary: {
    state: 'stable' | 'marginal' | 'unstable';
    min_margin: number;
    gate_margin_threshold: number;
    limiting_mode?: string;
  };
  chug: {
    alpha?: number;
    freq_hz?: number;
    zeta?: number;
    margin: number;
    boundary_curve: [number, number][];
    pole?: { real: number; imag: number };
    design_streams?: Array<{ stream: string; eta_inj: number; tau_theta_c: number }>;
  };
  acoustic: {
    margin: number;
    modes: Array<{
      name: string;
      freq_hz: number;
      alpha: number;
      driving: number;
      damping: { noz: number; visc: number; inj: number; twophase: number };
    }>;
  };
  phase: Array<{ mode: string; omega_tau: number }>;
  vaporization: {
    d2_profile: [number, number][];
    L_vap_m: number;
    L_ch_m: number;
    smd_um: number;
    smd_band_um: [number, number];
    tau_conv_s?: number;
    tau_sens_s?: number;
  };
  feed_pressure: {
    P_set_psi: number;
    ripple_psi: number;
    regulated: [number, number][];
    blowdown_ref: [number, number][];
  };
  radar: {
    axes: string[];
    values: number[];
    threshold: number[];
  };
  water_hammer: {
    spike_psi: number;
    available_dp_psi: number;
  };
  assumptions: {
    n: number;
    chi_acoustic: number;
    eta_inj_O: number;
    eta_inj_F: number;
    smd_O_um: number;
    dP_reg_max_psi?: number;
  };
  sensitivity: {
    acoustic_alpha_vs_n: [number, number];
    acoustic_alpha_vs_chi: [number, number];
  };
}

export interface StabilityOverrides {
  eta_inj_O?: number;
  smd_um?: number;
  n_interaction?: number;
  chi_acoustic?: number;
}

/** Rich stability payload from results.stability_rich (plan §A5). */

/** Per-stream conversion-lag decomposition (Leonardi 2017 eq. 5: tau_atom + tau_vap + tau_mix). */
export interface LagBreakdown {
  stream: string;
  model: string;
  phase: string;
  convection: string;
  tau_atom_s: number;
  tau_vap_s: number;
  tau_mix_s: number;
  tau_total_s: number;
  K_v: number;
  notes: string[];
}

export interface StabilityRichPayload {
  summary: {
    state: 'stable' | 'marginal' | 'unstable';
    min_margin: number;
    gate_margin_threshold: number;
    limiting_mode?: string;
  };
  diagnostics: {
    headline: string;
    state: 'stable' | 'marginal' | 'unstable';
    limiting_mode?: string | null;
    driver?: string | null;
    findings: Array<{ severity: 'critical' | 'warn' | 'ok'; text: string }>;
    actions: Array<{ text: string; rationale: string; lever?: string | null }>;
    assumptions_note: string;
  };
  chug: {
    alpha?: number;
    freq_hz?: number;
    /** Damping ratio of the dominant pole, zeta = -sigma/|s| (standard definition). */
    zeta?: number;
    margin: number;
    boundary_curve: [number, number][];
    pole?: { real: number; imag: number };
    design_streams?: Array<{
      stream: string;
      /** Actual propellant name from the config — never assume "LOX"/"fuel". */
      fluid?: string;
      /** "liquid" | "gas" at the injector face; a gas carries only the mixing lag. */
      phase?: string;
      eta_inj: number;
      tau_theta_c: number;
      tau_s?: number;
      tau_atom_s?: number | null;
      tau_vap_s?: number | null;
      tau_mix_s?: number | null;
    }>;
    /** s-plane eigenvalues of 1 + L(s) = 0 tracked as eta_inj sweeps (the root locus). */
    root_locus?: Array<{
      eta: number;
      /** Re(s) = sigma, growth rate [1/s]. */
      real: number;
      /** Im(s) = omega [rad/s]. */
      imag: number;
      f_hz: number;
      zeta: number;
    }>;
    locus_param?: string;
    eta_window?: [number, number];
    /** Where the locus crosses the imaginary axis — the neutral-stability stiffness. */
    eta_critical?: { eta: number; f_hz: number };
    lag_model?: string;
    convection_model?: string;
    lag_breakdown?: Record<string, LagBreakdown>;
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
    /** Headline figures describe the RATE-LIMITING stream, not the oxidizer. */
    d2_profile: [number, number][];
    L_vap_m: number;
    L_ch_m: number;
    smd_um: number;
    smd_band_um: [number, number];
    tau_conv_s?: number;
    tau_sens_s?: number;
    vaporized_in_chamber?: boolean;
    rate_limiting_stream?: string;
    streams?: Array<{
      stream: string;
      fluid: string;
      phase: string;
      smd_um: number | null;
      smd_band_um?: [number, number];
      tau_conv_s: number;
      L_vap_m: number | null;
      L_ch_m: number;
      vaporized_in_chamber: boolean;
      d2_profile: [number, number][];
      note?: string;
    }>;
  };
  radar: {
    axes: string[];
    values: number[];
    threshold: number[];
  };
  assumptions: {
    n: number;
    chi_acoustic: number;
    eta_inj_O: number;
    eta_inj_F: number;
    smd_O_um: number;
    smd_F_um?: number;
    rate_limiting_stream?: string;
    dP_reg_max_psi?: number;
    /** Named models that produced this answer — printed so a report can't be misread. */
    time_lag_model?: string;
    convection_model?: string;
    mixing_lag_fraction?: number;
    injector_type?: string;
    fluid_O?: string;
    fluid_F?: string;
    phase_O?: string;
    phase_F?: string;
    tau_conv_O_s?: number;
    tau_conv_F_s?: number;
    lag_breakdown?: Record<string, LagBreakdown>;
    fallbacks_used?: Array<{ name: string; value: unknown; unit?: string; reason?: string; count?: number }>;
  };
  sensitivity: {
    acoustic_alpha_vs_n: [number, number];
    acoustic_alpha_vs_chi: [number, number];
  };
}

export interface StabilityOverrides {
  eta_inj_O?: number;
  eta_inj_F?: number;
  smd_um?: number;
  smd_F_um?: number;
  n_interaction?: number;
  chi_acoustic?: number;
  /** Swap the conversion-lag model for this run without editing the config. */
  time_lag_model?: 'leonardi_dtl' | 'd2_law';
  convection_model?: 'none' | 'leonardi_eq8' | 'ranz_marshall';
  mixing_lag_fraction?: number;
}

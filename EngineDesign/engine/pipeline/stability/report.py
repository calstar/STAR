"""Rich stability report (<=5 s) for the final report and forward mode.

Runs the RICH tiers (chug root-find, full acoustic mode set with damping budgets) and assembles the
single payload that both the post-optimizer report and forward mode render from (plan §A5 schema).
Every block maps to a §V visualization. Pure-ish: takes the same (config, Pc, ..., diagnostics, cg)
as comprehensive_stability_analysis and reuses analysis.build_stability_inputs for identical extraction.

[Phys §3-§6; plan A5, §V]
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
import numpy as np

from engine.pipeline.stability import chug, acoustic, analysis

_PA_PER_PSI = 6894.757


# ---------------------------------------------------------------------------
# Visualization data builders
# ---------------------------------------------------------------------------

def _eta_window(streams, *, lo_frac: float = 0.35, hi_frac: float = 2.2,
                floor: float = 0.02, ceil: float = 0.90) -> Tuple[float, float]:
    """(eta_lo, eta_hi) sweep window bracketing THIS design's injector stiffness.

    The window used to be a fixed 0.08..0.45 for every engine, which puts a design at eta = 0.55
    off the right edge of its own chart and a design at eta = 0.05 off the left. Anchoring it to
    the design point keeps the operating dot on the plot whatever the injector does."""
    etas = [float(s.eta_inj) for s in streams if np.isfinite(s.eta_inj) and s.eta_inj > 0]
    eta0 = float(np.mean(etas)) if etas else 0.25
    return (float(max(floor, min(eta0 * lo_frac, 0.15))),
            float(min(ceil, max(eta0 * hi_frac, 0.45))))


def _chug_boundary_curve(streams, chamber, n_pts: int = 16,
                         eta_window: Optional[Tuple[float, float]] = None) -> List[List[float]]:
    """Viz #1: the chug stability boundary in (eta_inj, tau/theta_c). For each eta_inj, bisect on a
    lag-scale factor to find where the fast gain margin crosses 1 (marginal). Uses the FAST margin
    (cheap; ~n_pts*~12 calls)."""
    import copy
    theta_c = chamber.theta_c()
    if not np.isfinite(theta_c) or theta_c <= 0:
        return []
    tau0 = float(np.mean([s.tau_conv for s in streams]))
    lo_eta, hi_eta = eta_window if eta_window else _eta_window(streams)
    curve: List[List[float]] = []
    for eta in np.linspace(lo_eta, hi_eta, n_pts):
        # scale all streams to this eta; bisect lag factor k in [0.1, 8] for GM(k)=1
        def gm_at(kfac: float) -> float:
            sc = []
            for s in streams:
                s2 = copy.copy(s)
                s2.eta_inj = float(eta)
                s2.tau_conv = float(s.tau_conv * kfac)
                sc.append(s2)
            return chug.chug_margin_fast(sc, chamber)["gain_margin"] - 1.0
        lo, hi = 0.1, 8.0
        f_lo, f_hi = gm_at(lo), gm_at(hi)
        if f_lo * f_hi > 0:        # no crossing in range -> skip (all stable or all unstable)
            continue
        for _ in range(18):
            mid = 0.5 * (lo + hi)
            if gm_at(mid) * f_lo > 0:
                lo = mid
            else:
                hi = mid
        tau_marg = tau0 * 0.5 * (lo + hi)
        curve.append([float(eta), float(tau_marg / theta_c)])
    return curve


def _stream_vaporization(inp: Dict[str, Any], Pc: float, key: str, n_pts: int) -> Dict[str, Any]:
    """d^2-law droplet decay for ONE stream. ``key`` is "O" or "F"."""
    from engine.pipeline.assumptions import assume

    D32 = float(inp[f"D32_{key}"])
    L_ch = float(inp["L_ch"])
    phase = str(inp.get(f"phase_{key}", "liquid"))
    fluid = str(inp.get(f"fluid_name_{key}", key))
    tau_vap = float(inp[f"tau_conv_{key}"])
    side = "oxidizer" if key == "O" else "fuel"

    if phase.lower().startswith("g"):
        # A gas has no droplets to track. Say so rather than drawing a decay curve for it.
        return {"stream": key, "fluid": fluid, "phase": phase, "smd_um": None,
                "tau_conv_s": tau_vap, "L_vap_m": None, "L_ch_m": L_ch,
                "vaporized_in_chamber": True, "d2_profile": [],
                "note": f"{fluid} is injected as a gas — no atomization or vaporization to plot."}

    rho = inp.get(f"rho_{key}")
    if rho is None or not np.isfinite(float(rho)) or float(rho) <= 0.0:
        rho = assume(f"stability.viz.rho_{side}", 1140.0 if key == "O" else 800.0, unit="kg/m^3",
                     reason=f"{side} density missing when drawing the vaporization profile")
    rho = float(rho)
    eta = float(inp[f"eta_inj_{key}"])

    # Representative droplet axial speed: the solved injection velocity when the closure provides
    # it, else Bernoulli with the solved Cd.
    u = inp.get(f"u_{key}")
    if u is not None and np.isfinite(float(u)) and float(u) > 0.0:
        v_drop = float(u)
    else:
        Cd = inp.get(f"Cd_{key}")
        if Cd is None or not np.isfinite(float(Cd)) or float(Cd) <= 0.0:
            Cd = assume(f"stability.viz.Cd_{side}", 0.6, unit="-",
                        reason=f"solved {side} discharge coefficient unavailable for the droplet "
                               f"velocity; sharp-edged-orifice value")
        v_drop = float(Cd) * float(np.sqrt(max(2.0 * eta * Pc / rho, 1.0)))

    L_vap = v_drop * tau_vap if np.isfinite(tau_vap) else float("nan")
    x_max = float(max(L_ch, L_vap if np.isfinite(L_vap) else L_ch) * 1.1)
    xs = np.linspace(0.0, x_max, n_pts)
    d2 = (np.clip(1.0 - xs / L_vap, 0.0, 1.0)
          if (np.isfinite(L_vap) and L_vap > 0) else np.ones_like(xs))
    return {
        "stream": key, "fluid": fluid, "phase": phase,
        "smd_um": float(D32 * 1e6), "smd_band_um": [float(D32 * 0.8e6), float(D32 * 1.2e6)],
        "tau_conv_s": float(tau_vap),
        "L_vap_m": float(L_vap), "L_ch_m": L_ch,
        "vaporized_in_chamber": bool(np.isfinite(L_vap) and L_vap <= L_ch),
        "d2_profile": [[float(x), float(y)] for x, y in zip(xs, d2)],
    }


def _vaporization_profile(inp: Dict[str, Any], Pc: float, n_pts: int = 40) -> Dict[str, Any]:
    """Viz #5: droplet decay along the chamber, for BOTH streams.

    The top-level keys (``L_vap_m``, ``smd_um``, ``tau_conv_s``, ``vaporized_in_chamber``) describe
    the **rate-limiting** stream — the one that paces the burn — not the oxidizer. They used to be
    hardwired to the oxidizer, which is right only when the oxidizer happens to be the slower
    vaporizer. On LOX/methane it is (3.7 ms vs 2.9 ms) so the card read correctly by luck; on
    LOX/ethanol it is not (13 ms vs 25 ms), and the card reported a 211 mm vaporization length for
    LOX while ethanol -- the stream actually setting the lag -- was far worse. The health radar
    scores off these keys, so it was scoring the wrong stream too.
    """
    per_stream = [_stream_vaporization(inp, Pc, k, n_pts) for k in ("O", "F")]
    rl = str(inp.get("rate_limiting_stream", "O"))
    lead = next((s for s in per_stream if s["stream"] == rl), per_stream[0])
    # A gas stream can never be the one to plot; fall back to the liquid if it somehow is.
    if lead.get("L_vap_m") is None:
        lead = next((s for s in per_stream if s.get("L_vap_m") is not None), lead)

    out = dict(lead)
    out.pop("note", None)
    out["streams"] = per_stream
    out["rate_limiting_stream"] = lead["stream"]
    out["tau_sens_s"] = float(inp["tau_sens"])
    if lead.get("smd_um") is None:
        out["smd_um"] = float(inp["D32_O"] * 1e6)
        out["smd_band_um"] = [float(inp["D32_O"] * 0.8e6), float(inp["D32_O"] * 1.2e6)]
    return out


def _sensitivity(inp: Dict[str, Any]) -> Dict[str, Any]:
    """n / chi sensitivity bands for the acoustic limiting-mode growth rate (cheap sweep)."""
    D_ch, L_ch, gas, coeffs = inp["D_ch"], inp["L_ch"], inp["gas"], inp["damping_coeffs"]
    tv = inp["tau_conv_O"]
    a_n = [acoustic.fast_acoustic(D_ch, L_ch, gas, n=nn, tau_sens=inp["tau_sens"], coeffs=coeffs)["alpha_max"]
           for nn in (0.3, 0.6)]
    a_chi = [acoustic.fast_acoustic(D_ch, L_ch, gas, n=inp["n_interaction"], tau_sens=cc * tv, coeffs=coeffs)["alpha_max"]
             for cc in (0.05, 0.30)]
    return {"acoustic_alpha_vs_n": [float(min(a_n)), float(max(a_n))],
            "acoustic_alpha_vs_chi": [float(min(a_chi)), float(max(a_chi))]}


def _chug_pole(chug_rich: Dict[str, Any]) -> Dict[str, float]:
    """Viz #1b: dominant chug pole location in the s-plane (σ + jω)."""
    alpha = chug_rich.get("alpha")
    f_hz = chug_rich.get("f_chug_hz")
    if alpha is None or f_hz is None or not np.isfinite(alpha) or not np.isfinite(f_hz):
        return {"real": float("nan"), "imag": float("nan")}
    return {"real": float(alpha), "imag": float(2 * np.pi * f_hz)}


def _locus_crossing(locus: List[Dict[str, float]]) -> Dict[str, float]:
    """Where the locus branch crosses the imaginary axis: the neutral-stability gain and frequency.

    Linear interpolation in ``eta`` on the sign change of ``Re(s)``. This is the number a designer
    reads off a root locus — "stiffen past here and the pole is in the left half-plane" — so it is
    computed once on the backend rather than eyeballed off the chart."""
    out = {"eta": float("nan"), "f_hz": float("nan")}
    for a, b in zip(locus, locus[1:]):
        if a["real"] == 0.0 or a["real"] * b["real"] < 0.0:
            da = b["real"] - a["real"]
            t = (0.0 - a["real"]) / da if da != 0 else 0.0
            out["eta"] = float(a["eta"] + t * (b["eta"] - a["eta"]))
            out["f_hz"] = float(a["f_hz"] + t * (b["f_hz"] - a["f_hz"]))
            break
    return out


def _radar(chug_margin: float, ac: Dict[str, Any], vap: Dict[str, Any],
           gate_threshold: float, alpha_offset: float) -> Dict[str, Any]:
    """Viz #7: one-glance health radar."""
    def mode_alpha(name):
        for m in ac["modes"]:
            if m["mode"] == name:
                return m["alpha"]
        return float("-inf")
    a1L, a1T = mode_alpha("1L"), mode_alpha("1T")
    # normalize alphas to a 0..1.3 "margin-like" scale via the same acoustic gate mapping
    v1L = analysis._acoustic_gate_margin(a1L, alpha_offset)
    v1T = analysis._acoustic_gate_margin(a1T, alpha_offset)
    vap_complete = float(np.clip(vap["L_ch_m"] / vap["L_vap_m"], 0.0, 1.3)) if (
        np.isfinite(vap["L_vap_m"]) and vap["L_vap_m"] > 0) else 1.3
    axes = ["chug", "1L", "1T", "vaporization"]
    values = [float(chug_margin), float(v1L), float(v1T), vap_complete]
    return {"axes": axes, "values": values, "threshold": [gate_threshold] * len(axes)}


# ---------------------------------------------------------------------------
# Diagnostics — plain-language verdict + actionable levers (forward-mode panel §C)
# ---------------------------------------------------------------------------

_DRIVER_LABEL = {
    "feed_inertance": "feed-line inertance",
    "feed_resistance": "feed-line resistance",
    "injector_stiffness": "injector stiffness (ΔP_inj)",
    "regulator": "dome-regulator dynamics",
    "unknown": "feed/injector coupling",
}


def _diagnostics(state: str, chug_margin: float, acoustic_margin: float, gate_threshold: float,
                 limiting: Optional[str], chug_rich: Dict[str, Any], ac: Dict[str, Any],
                 vap: Dict[str, Any], fallbacks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Turn the rich quantities into a verdict, findings, and design actions tied to the
    sensitivity sliders (η_inj, SMD, n, χ). Derived from the SAME numbers the cards render,
    so the headline can never disagree with the charts."""
    findings: List[Dict[str, str]] = []
    actions: List[Dict[str, Optional[str]]] = []

    # --- chug (low-frequency, feed-coupled) ---
    chug_stable = chug_rich.get("stable", True)
    chug_f = chug_rich.get("f_chug_hz")
    driver = chug_rich.get("driver", "unknown")
    driver_lbl = _DRIVER_LABEL.get(driver, driver)
    if not chug_stable or chug_margin < gate_threshold:
        txt = "Chug (low-frequency, feed-coupled) loop is "
        txt += "growing" if not chug_stable else "near the stability boundary"
        if chug_f is not None and np.isfinite(chug_f) and chug_f > 0:
            txt += f" around {chug_f:.0f} Hz"
        txt += f"; dominant driver is {driver_lbl} (margin {chug_margin:.2f})."
        findings.append({"severity": "critical" if not chug_stable else "warn", "text": txt})
        actions.append({
            "text": "Stiffen the injector — raise ΔP_inj/Pc (η_inj).",
            "rationale": "A stiffer injector decouples chamber-pressure oscillations from the feed, "
                         "shrinking the chug loop gain.",
            "lever": "η_inj",
        })
        actions.append({
            "text": "Improve atomization — reduce SMD.",
            "rationale": "Finer droplets shorten the vaporization lag τ, pushing the chug pole left.",
            "lever": "SMD",
        })

    # --- acoustic (high-frequency chamber modes) ---
    ac_modes = ac.get("modes", [])
    lim_name = ac.get("limiting_mode")
    lim = next((m for m in ac_modes if m.get("mode") == lim_name), ac_modes[0] if ac_modes else None)
    if ac.get("any_unstable") or acoustic_margin < gate_threshold:
        if lim is not None:
            driven = lim.get("alpha", 0.0) > 0
            txt = (f"Acoustic mode {lim.get('mode')} ({lim.get('f_hz', 0):.0f} Hz) is "
                   f"{'driven' if driven else 'only lightly damped'} "
                   f"(α={lim.get('alpha', 0):.0f} 1/s, margin {acoustic_margin:.2f}).")
        else:
            txt = f"Acoustic margin is low ({acoustic_margin:.2f})."
        findings.append({"severity": "critical" if ac.get("any_unstable") else "warn", "text": txt})
        actions.append({
            "text": f"Add chamber acoustic damping (baffles / acoustic liner) tuned to "
                    f"{lim_name or 'the limiting mode'}.",
            "rationale": "Passive damping raises the nozzle/viscous/two-phase budget against the "
                         "combustion driving term.",
            "lever": None,
        })
        actions.append({
            "text": "Soften the combustion response — lower the interaction index n (and check χ).",
            "rationale": "A smaller n weakens the heat-release feedback that drives the mode (Rayleigh criterion).",
            "lever": "n",
        })

    # --- vaporization completeness ---
    if not vap.get("vaporized_in_chamber", True):
        lvap, lch = vap.get("L_vap_m"), vap.get("L_ch_m")
        ratio = (lvap / lch) if (lch and lvap is not None and np.isfinite(lvap) and lch > 0) else float("nan")
        txt = "Droplets are not fully vaporized within the chamber"
        if np.isfinite(ratio):
            txt += f" (L_vap ≈ {ratio:.1f}× L_ch)"
        txt += "; unburned propellant lengthens the combustion lag and roughens the burn."
        findings.append({"severity": "warn", "text": txt})
        actions.append({
            "text": "Finer atomization (lower SMD) or a longer chamber (raise L*).",
            "rationale": "A shorter vaporization length completes burning upstream of the nozzle.",
            "lever": "SMD",
        })

    if not findings:
        findings.append({"severity": "ok",
                         "text": "No driven modes — chug, acoustic, and vaporization all clear the gate."})

    if state == "stable":
        headline = (f"Stable — every mode clears the gate "
                    f"(min margin {min(chug_margin, acoustic_margin):.2f}). Still monitor on hot fire.")
    elif state == "marginal":
        headline = (f"Marginal — {limiting or 'a mode'} sits near the boundary. "
                    "Instrument heavily and ramp up cautiously.")
    else:
        headline = (f"Unstable risk — {limiting or 'a mode'} is driven. "
                    "Change the design before hot fire.")

    fb = fallbacks
    if fb:
        names = ", ".join(str(f.get("name", "?")) for f in fb[:3])
        more = "…" if len(fb) > 3 else ""
        # Say where the missing values live. "Load a propellant preset" was printed for every
        # fallback including feed-line lengths and chamber geometry, which no propellant preset
        # supplies -- advice that cannot work reads as noise and gets ignored.
        kinds = {("propellant" if ".fluids." in str(f.get("name", "")) else
                  "plumbing" if ".feed." in str(f.get("name", "")) else
                  "model") for f in fb}
        hints = []
        if "propellant" in kinds:
            hints.append("load a propellant preset for the fluid properties")
        if "plumbing" in kinds:
            hints.append("set feed_system lengths/bores for the plumbing")
        if "model" in kinds:
            hints.append("the rest are model calibration defaults")
        assumptions_note = (f"{len(fb)} physics input(s) fell back to recorded defaults "
                            f"({names}{more}). " + "; ".join(hints).capitalize() + ".")
    else:
        assumptions_note = "Config fully specified the stability physics — no fallbacks used."

    return {
        "headline": headline,
        "state": state,
        "limiting_mode": limiting,
        "driver": driver_lbl if limiting == "chug" else None,
        "findings": findings,
        "actions": actions,
        "assumptions_note": assumptions_note,
    }


# ---------------------------------------------------------------------------
# Top-level assembly
# ---------------------------------------------------------------------------

def build_rich_report(config, Pc: float, MR: float, mdot_total: float, cstar: float,
                      gamma: float, R: float, Tc: float, diagnostics: Dict[str, Any],
                      cg: Any, *, gate_threshold: float = 1.05,
                      overrides: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """Assemble the full rich stability payload (plan §A5 schema). <=5 s."""
    from engine.pipeline import assumptions as _assumptions
    with _assumptions.scope() as _used_here:
        return _build_rich_report(config, Pc, MR, mdot_total, cstar, gamma, R, Tc, diagnostics, cg,
                                  gate_threshold=gate_threshold, overrides=overrides,
                                  used_here=_used_here)


def _build_rich_report(config, Pc: float, MR: float, mdot_total: float, cstar: float,
                       gamma: float, R: float, Tc: float, diagnostics: Dict[str, Any],
                       cg: Any, *, gate_threshold: float, overrides: Optional[Dict[str, float]],
                       used_here: Dict[str, Any]) -> Dict[str, Any]:
    inp = analysis.build_stability_inputs(
        config, Pc, MR, mdot_total, cstar, gamma, R, Tc, diagnostics, cg, overrides=overrides,
    )
    streams, chamber, gas = inp["streams"], inp["chamber"], inp["gas"]

    # --- chug (rich root-find + with/without regulator + boundary) ---
    chug_rich = chug.chug_growth_rate(streams, chamber)
    chug_margin = analysis._chug_gate_margin(
        chug.chug_margin_fast(streams, chamber).get("gain_margin", float("nan")))
    eta_window = _eta_window(streams)
    boundary = _chug_boundary_curve(streams, chamber, eta_window=eta_window)
    theta_c = chamber.theta_c()
    design_streams = []
    lag_break = inp.get("lag_breakdown") or {}
    for label, eta, tau in (
        ("O", inp["eta_inj_O"], inp["tau_conv_O"]),
        ("F", inp["eta_inj_F"], inp["tau_conv_F"]),
    ):
        tt = float(tau / theta_c) if (np.isfinite(theta_c) and theta_c > 0) else float("nan")
        lb = lag_break.get(label, {})
        design_streams.append({
            "stream": label,
            "fluid": inp.get(f"fluid_name_{label}", label),
            "phase": inp.get(f"phase_{label}", "liquid"),
            "eta_inj": float(eta), "tau_theta_c": tt, "tau_s": float(tau),
            "tau_atom_s": lb.get("tau_atom_s"), "tau_vap_s": lb.get("tau_vap_s"),
            "tau_mix_s": lb.get("tau_mix_s"),
        })

    # Root locus: the dominant eigenvalue tracked through the s-plane as injector stiffness sweeps.
    locus = chug.chug_root_locus(
        streams, chamber, eta_values=np.linspace(eta_window[0], eta_window[1], 26))
    eta_critical = _locus_crossing(locus)

    # --- acoustic (full mode set with damping budgets) ---
    ac = acoustic.analyze_acoustic_modes(inp["D_ch"], inp["L_ch"], gas,
                                         n=inp["n_interaction"], tau_sens=inp["tau_sens"],
                                         coeffs=inp["damping_coeffs"])
    ac_alpha_max = ac["modes"][0]["alpha"] if ac["modes"] else float("nan")
    acoustic_margin = analysis._acoustic_gate_margin(ac_alpha_max, inp["acoustic_gate_alpha_offset"])
    acoustic_modes = [{
        "name": m["mode"], "freq_hz": m["f_hz"], "alpha": m["alpha"],
        "driving": m["driving"],
        "damping": {"noz": m["damping"]["nozzle"], "visc": m["damping"]["viscous"],
                    "inj": m["damping"]["injector"], "twophase": m["damping"]["twophase"]},
    } for m in ac["modes"]]

    # --- phase clock (omega*tau_sens per mode) ---
    phase = [{"mode": m["mode"], "omega_tau": float(2 * np.pi * m["f_hz"] * inp["tau_sens"])}
             for m in ac["modes"]]

    vap = _vaporization_profile(inp, Pc)
    sens = _sensitivity(inp)
    fallbacks = _fallbacks_used(used_here)
    radar = _radar(chug_margin, ac, vap, gate_threshold, inp["acoustic_gate_alpha_offset"])

    min_margin = float(min(chug_margin, acoustic_margin))
    state = ("stable" if (chug_margin >= gate_threshold and acoustic_margin >= gate_threshold
                          and chug_rich.get("stable", True) and not ac["any_unstable"])
             else "marginal" if min_margin >= 0.95 else "unstable")
    limiting = "chug" if chug_margin <= acoustic_margin else ac.get("limiting_mode")
    diag = _diagnostics(state, chug_margin, acoustic_margin, gate_threshold, limiting,
                        chug_rich, ac, vap, fallbacks)

    return {
        "summary": {"state": state, "min_margin": min_margin,
                    "gate_margin_threshold": gate_threshold, "limiting_mode": limiting},
        "diagnostics": diag,
        "chug": {
            "alpha": chug_rich.get("alpha"), "freq_hz": chug_rich.get("f_chug_hz"),
            "zeta": chug_rich.get("zeta"), "margin": chug_margin,
            "alpha_no_reg": chug_rich.get("alpha_no_reg"), "driver": chug_rich.get("driver"),
            "boundary_curve": boundary,
            "pole": _chug_pole(chug_rich),
            "design_streams": design_streams,
            "root_locus": locus,
            "locus_param": "eta_inj",
            "eta_window": [float(eta_window[0]), float(eta_window[1])],
            "eta_critical": eta_critical,
            "lag_model": inp.get("lag_model"),
            "convection_model": inp.get("convection_model"),
            "lag_breakdown": lag_break,
        },
        "acoustic": {"margin": acoustic_margin, "modes": acoustic_modes,
                     "any_unstable": ac["any_unstable"], "limiting_mode": ac["limiting_mode"]},
        "phase": phase,
        "vaporization": vap,
        "radar": radar,
        "assumptions": {
            "n": inp["n_interaction"], "chi_acoustic": inp["chi_acoustic"],
            "dP_reg_max_psi": float(streams[0].regulator.max_excursion_pa / _PA_PER_PSI),
            "eta_inj_O": inp["eta_inj_O"], "eta_inj_F": inp["eta_inj_F"],
            "smd_O_um": float(inp["D32_O"] * 1e6),
            "smd_F_um": float(inp["D32_F"] * 1e6),
            "rate_limiting_stream": inp.get("rate_limiting_stream"),
            "mach_nozzle_entrance": float(inp["mach_nozzle_entrance"]),
            "contraction_ratio": float(inp["contraction_ratio"]),
            "feed_length_O_m": float(inp["feed_length_O"]), "feed_length_F_m": float(inp["feed_length_F"]),
            "acoustic_gate_alpha_offset": float(inp["acoustic_gate_alpha_offset"]),
            # Which named models produced this answer, and what the propellants/injector actually
            # are -- so a report can never be read as if it described a different engine.
            "time_lag_model": inp.get("lag_model"),
            "convection_model": inp.get("convection_model"),
            "mixing_lag_fraction": inp.get("mixing_lag_fraction"),
            "injector_type": inp.get("injector_type"),
            "fluid_O": inp.get("fluid_name_O"), "fluid_F": inp.get("fluid_name_F"),
            "phase_O": inp.get("phase_O"), "phase_F": inp.get("phase_F"),
            "tau_conv_O_s": float(inp["tau_conv_O"]), "tau_conv_F_s": float(inp["tau_conv_F"]),
            "lag_breakdown": lag_break,
            # Every recorded silent-default substitution this process has made (P2c registry).
            # Empty list = config fully specified the physics. The hardcoded-Cd bug class, surfaced.
            "fallbacks_used": fallbacks,
        },
        "sensitivity": sens,
    }


def _fallbacks_used(used_here: Optional[Dict[str, Any]] = None):
    """Substitutions made by THIS evaluation.

    ``used_here`` is the collection from the ``assumptions.scope()`` wrapped around the report. The
    old form read the process-global registry, so a report inherited every fallback the process had
    ever recorded -- after a methalox run, an ethalox run with a complete preset still announced the
    previous propellant's missing fields. Falls back to the global registry only when called without
    a scope (kept so an external caller does not break).
    """
    try:
        from engine.pipeline import assumptions
    except ImportError:
        return []
    if used_here is not None:
        return assumptions.as_list(used_here)
    return assumptions.fallbacks_used()

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


def _chug_boundary_curve(streams, chamber, n_pts: int = 24,
                         eta_window: Optional[Tuple[float, float]] = None) -> List[List[float]]:
    """Viz #1: the chug stability boundary in the design's own frame: x = the streams' mass-
    weighted injector stiffness, reached by scaling every stream's drop by one factor; y = their
    mass-weighted lag over theta_c, reached by scaling every lag by one factor k. At each x, k is
    bisected to gain margin 1. The design itself is the point (1, 1) of both scalings, so it sits
    in the same plane as the curve (``_chug_design_point``) -- the old curve set every stream to
    one common eta and scaled their mean lag, and then plotted each stream against it, which is
    two different systems on one chart."""
    import copy
    theta_c = chamber.theta_c()
    if not np.isfinite(theta_c) or theta_c <= 0:
        return []
    eta0 = chug.mean_eta(streams)
    tau0 = _mean_tau(streams)
    lo_eta, hi_eta = eta_window if eta_window else _eta_window(streams)
    curve: List[List[float]] = []
    for eta in np.linspace(lo_eta, hi_eta, n_pts):
        def gm_at(kfac: float) -> float:
            sc = []
            for s in streams:
                s2 = copy.copy(s)
                s2.eta_inj = float(s.eta_inj * eta / eta0)
                s2.tau_conv = float(s.tau_conv * kfac)
                sc.append(s2)
            return chug.chug_margin_fast(sc, chamber)["gain_margin"] - 1.0
        # GM is not monotone in the lag: scan for the FIRST scale that goes unstable, then bisect.
        ks = np.geomspace(0.05, 20.0, 41)
        fs = [gm_at(float(k)) for k in ks]
        j = next((i for i in range(1, len(ks)) if np.isfinite(fs[i - 1]) and np.isfinite(fs[i])
                  and fs[i - 1] > 0 >= fs[i]), None)
        if j is None or fs[0] <= 0:
            continue
        lo, hi = float(ks[j - 1]), float(ks[j])
        f_lo = fs[j - 1]
        for _ in range(24):
            mid = float(np.sqrt(lo * hi))
            if gm_at(mid) * f_lo > 0:
                lo = mid
            else:
                hi = mid
        curve.append([float(eta), float(tau0 * np.sqrt(lo * hi) / theta_c)])
    return curve


def _mean_tau(streams) -> float:
    m = sum(max(float(s.mdot), 0.0) for s in streams)
    return float(sum(float(s.mdot) * float(s.tau_conv) for s in streams) / m) if m > 0 else float("nan")


def _chug_design_point(streams, chamber, band: Optional[Dict[str, Any]], inp: Dict[str, Any]) -> Dict[str, Any]:
    """Where the design sits on the boundary chart: nominal mixing lag, and the mixing lag the gate
    is taken at (the low end of the band). Both at the design's own mean stiffness."""
    theta_c = chamber.theta_c()
    eta0, tau0 = chug.mean_eta(streams), _mean_tau(streams)
    out = {"eta": float(eta0), "tau_theta_c": float(tau0 / theta_c) if theta_c > 0 else float("nan")}
    if band is not None and inp.get("tau_mix_basis") is not None:
        shift = (float(band["at_min_fraction"]) - float(inp["mixing_lag_fraction"])) * float(inp["tau_mix_basis"])
        out["gate_tau_theta_c"] = float((tau0 + shift) / theta_c) if theta_c > 0 else float("nan")
        out["gate_mixing_fraction"] = float(band["at_min_fraction"])
    return out


def _stream_from_march(inp: Dict[str, Any], key: str, march: Dict[str, Any]) -> Dict[str, Any]:
    """One stream's vaporization from the droplet march that set eta_vap
    (combustion_physics.vaporization_profile): x from the injector face, ``L_vap_m`` where 95 % of
    the stream's liquid is gone (None when it is not gone by the chamber end), ``L_ch_m`` the
    chamber the march ran in (L* A_t / A_c, the volume-equivalent cylinder).

    This card used to take L_vap = u_inj x tau_conv: the injection velocity held all the way down
    the chamber, times the CHUG lag -- which on the Leonardi model includes a mixing lag that is
    not evaporation at all. On the 6.5 kN ethalox doublet that read 675 mm against a 199 mm
    chamber while the march that sets eta_vap had the fuel 95 % gone at 157 mm."""
    st = march["streams"].get(key)
    fluid = str(inp.get(f"fluid_name_{key}", key))
    L = float(march["L_chamber"])
    D32 = float(inp[f"D32_{key}"])
    if st is None or st.get("instant"):
        return {"stream": key, "fluid": fluid, "phase": str(inp.get(f"phase_{key}", "gas")), "smd_um": None,
                "tau_conv_s": float(inp[f"tau_conv_{key}"]), "L_vap_m": None, "L_ch_m": L,
                "frac_vaporized_end": 1.0, "vaporized_in_chamber": True, "d2_profile": [],
                "remaining_profile": [],
                "note": f"{fluid} enters as vapour — nothing to vaporize."}
    x95 = st["x95"]
    return {
        "stream": key, "fluid": fluid, "phase": str(inp.get(f"phase_{key}", "liquid")),
        "smd_um": float(D32 * 1e6), "smd_band_um": [float(D32 * 0.8e6), float(D32 * 1.2e6)],
        "tau_conv_s": float(inp[f"tau_conv_{key}"]),
        "L_vap_m": None if x95 is None else float(x95), "L_ch_m": L,
        "frac_vaporized_end": float(st["frac_end"]),
        "vaporized_in_chamber": x95 is not None and float(x95) <= L,
        # Liquid mass left along the chamber: what the curve draws.
        "remaining_profile": [[float(x), float(1.0 - f)] for x, f in st["profile"]],
        "d2_profile": [],
        "basis": "droplet march (the model eta_vap uses): Rosin-Rammler classes, heat-up, "
                 "d²-law with blowing, drag in the burning gas",
    }


def _stream_vaporization(inp: Dict[str, Any], Pc: float, key: str, n_pts: int) -> Dict[str, Any]:
    """d^2-law droplet decay for ONE stream. ``key`` is "O" or "F". Used only when the solve
    carried no droplet march (see ``_stream_from_march``): the drop's speed held at injection and
    its life taken as the chug convective lag, which over-counts both ways."""
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


def _vaporization_profile(inp: Dict[str, Any], Pc: float, n_pts: int = 40,
                          march: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Viz #5: droplet decay along the chamber, for BOTH streams.

    The top-level keys (``L_vap_m``, ``smd_um``, ``tau_conv_s``, ``vaporized_in_chamber``) describe
    the **rate-limiting** stream — the one that paces the burn — not the oxidizer. They used to be
    hardwired to the oxidizer, which is right only when the oxidizer happens to be the slower
    vaporizer. On LOX/methane it is (3.7 ms vs 2.9 ms) so the card read correctly by luck; on
    LOX/ethanol it is not (13 ms vs 25 ms), and the card reported a 211 mm vaporization length for
    LOX while ethanol -- the stream actually setting the lag -- was far worse. The health radar
    scores off these keys, so it was scoring the wrong stream too.
    """
    if march is not None:
        per_stream = [_stream_from_march(inp, k, march) for k in ("O", "F")]
        # The stream the march finishes last paces the burn.
        def _late(s):
            return (s["L_vap_m"] is None, s["L_vap_m"] or 0.0, -s.get("frac_vaporized_end", 1.0))
        liquid = [s for s in per_stream if s.get("smd_um") is not None]
        rl = max(liquid, key=_late)["stream"] if liquid else str(inp.get("rate_limiting_stream", "O"))
    else:
        per_stream = [_stream_vaporization(inp, Pc, k, n_pts) for k in ("O", "F")]
        rl = str(inp.get("rate_limiting_stream", "O"))
    lead = next((s for s in per_stream if s["stream"] == rl), per_stream[0])
    # A gas stream can never be the one to plot; fall back to the liquid if it somehow is. (A
    # liquid with no L_vap is one not 95 % vaporized by the chamber end: the worst, not a gas.)
    if lead.get("smd_um") is None:
        lead = next((s for s in per_stream if s.get("smd_um") is not None), lead)

    out = dict(lead)
    out.pop("note", None)
    out["basis"] = lead.get("basis") or ("u_inj x chug lag (no droplet march in this result)")
    out["streams"] = per_stream
    out["rate_limiting_stream"] = lead["stream"]
    out["tau_sens_s"] = float(inp["tau_sens"])
    if lead.get("smd_um") is None:
        out["smd_um"] = float(inp["D32_O"] * 1e6)
        out["smd_band_um"] = [float(inp["D32_O"] * 0.8e6), float(inp["D32_O"] * 1.2e6)]
    return out


def _sensitivity(inp: Dict[str, Any], nominal_gm: float) -> Dict[str, Any]:
    """Sensitivity of both verdicts to the inputs nobody has measured (cheap sweeps).

    Acoustic: alpha of the limiting mode over n and chi (chi scales the RATE-LIMITING stream's lag,
    which is what tau_sens is built from). Chug: GM over the feed lengths (x0.5, x2) and over a
    uniform scale on every conversion lag (x0.5, x2). The liquid bulk modulus does not enter the
    lumped chug loop at all (no line compliance), so the chug verdict cannot move with it."""
    import copy
    D_ch, L_ch, gas, coeffs = inp["D_ch"], inp["L_ch"], inp["gas"], inp["damping_coeffs"]
    tv = inp["tau_rate_limiting"]
    a_n = [acoustic.fast_acoustic(D_ch, L_ch, gas, n=nn, tau_sens=inp["tau_sens"], coeffs=coeffs)["alpha_max"]
           for nn in (0.3, 0.6)]
    # alpha is not monotone in chi (omega*tau_sens runs through many periods), so sample the band.
    a_chi = [acoustic.fast_acoustic(D_ch, L_ch, gas, n=inp["n_interaction"], tau_sens=cc * tv, coeffs=coeffs)["alpha_max"]
             for cc in np.linspace(0.05, 0.30, 51)]

    def gm_scaled(attr: str, k: float) -> float:
        st = []
        for s0 in inp["streams"]:
            s1 = copy.copy(s0)
            setattr(s1, attr, float(getattr(s0, attr)) * k)
            st.append(s1)
        return float(chug.chug_margin_fast(st, inp["chamber"])["gain_margin"])

    return {"acoustic_alpha_vs_n": [float(min(a_n)), float(max(a_n))],
            "acoustic_alpha_vs_chi": [float(min(a_chi)), float(max(a_chi))],
            "chug_gm_nominal": float(nominal_gm),
            "chug_gm_vs_feed_length": {"x0.5": gm_scaled("feed_length", 0.5), "x2": gm_scaled("feed_length", 2.0)},
            "chug_gm_vs_lag_scale": {"x0.5": gm_scaled("tau_conv", 0.5), "x2": gm_scaled("tau_conv", 2.0)},
            "chug_bulk_modulus": "not an input: the lumped chug loop has no line compliance"}


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
           gate_threshold: float) -> Dict[str, Any]:
    """Viz #7: one-glance health radar. Every axis is a ratio that is 1 at neutral stability:
    chug GM, acoustic damping/driving per mode (nominal phase, report-only unless gated), and
    L_ch/L_vap for vaporization. Plot caps: 3 for the margins, 1.3 for vaporization (an infinite
    damping/driving would otherwise serialize as null)."""
    def mode_margin(name):
        for m in ac["modes"]:
            if m["mode"] == name:
                return m["margin"]
        return float("nan")
    lv = vap.get("L_vap_m")
    if lv is not None and np.isfinite(lv) and lv > 0:
        vap_complete = float(np.clip(vap["L_ch_m"] / lv, 0.0, 1.3))
    elif vap.get("frac_vaporized_end") is not None:
        # Not 95 % gone by the chamber end: how far along it got, on the same 1 = neutral scale.
        vap_complete = float(np.clip(vap["frac_vaporized_end"] / 0.95, 0.0, 1.0))
    else:
        vap_complete = 1.3
    def worst_phase(name):
        for m in ac["modes"]:
            if m["mode"] == name:
                return m["margin_worst_phase"]
        return float("nan")
    axes = ["chug", "1L", "1T", "vaporization"]
    cap = lambda v: float(np.clip(v, 0.0, 3.0)) if not np.isnan(v) else float("nan")
    # Acoustic axes are the worst-phase margin (damping over the most driving any lag could give):
    # the nominal-phase one flips with a few percent of an uncalibrated tau. Neither gates.
    values = [cap(chug_margin), cap(worst_phase("1L")), cap(worst_phase("1T")), vap_complete]
    return {"axes": axes, "values": values, "threshold": [gate_threshold] * len(axes),
            "gated": [True, False, False, False],
            "basis": ["chug Nyquist gain margin, worst mixing lag (the gate)",
                      "damping / worst-phase driving (uncalibrated damping; report only)",
                      "damping / worst-phase driving (uncalibrated damping; report only)",
                      "L_ch / L_vap(95 %) from the droplet march (performance, not stability)"]}


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
                 vap: Dict[str, Any], fallbacks: List[Dict[str, Any]],
                 acoustic_gate: str = "report_only") -> Dict[str, Any]:
    """Turn the rich quantities into a verdict, findings, and design actions tied to the
    sensitivity sliders (η_inj, SMD, n, χ). Derived from the SAME numbers the cards render,
    so the headline can never disagree with the charts."""
    findings: List[Dict[str, str]] = []
    actions: List[Dict[str, Optional[str]]] = []
    ac_gated = acoustic_gate != "report_only"

    # --- chug (low-frequency, feed-coupled) ---
    chug_stable = chug_rich.get("stable", True)
    chug_f = chug_rich.get("f_chug_hz")
    driver = chug_rich.get("driver", "unknown")
    driver_lbl = _DRIVER_LABEL.get(driver, driver)
    if not chug_stable or not (chug_margin >= gate_threshold):
        txt = "Chug " + ("grows" if not chug_stable else "is short of margin")
        if chug_f is not None and np.isfinite(chug_f) and chug_f > 0:
            txt += f" near {chug_f:.0f} Hz"
        txt += f": gain margin {chug_margin:.2f} against {gate_threshold:.2f}, driven by {driver_lbl}."
        findings.append({"severity": "critical" if not chug_stable else "warn", "text": txt})
        actions.append({
            "text": "Raise injector ΔP/Pc.",
            "rationale": "A stiffer injector decouples chamber-pressure oscillations from the feed, "
                         "shrinking the chug loop gain.",
            "lever": "η_inj",
        })
        actions.append({
            "text": "Atomize finer (smaller D32).",
            "rationale": "Finer droplets shorten the vaporization lag τ, pushing the chug pole left.",
            "lever": "SMD",
        })

    # --- acoustic (high-frequency chamber modes) ---
    ac_modes = ac.get("modes", [])
    lim_name = ac.get("limiting_mode")
    lim = next((m for m in ac_modes if m.get("mode") == lim_name), ac_modes[0] if ac_modes else None)
    if not ac_gated:
        txt = ("Acoustic stability is not assessed: the damping is uncalibrated. Rate it by test "
               "(≥ 25 kHz Pc, pulse or bomb; Harrje & Reardon SP-194).")
        findings.append({"severity": "warn", "text": txt})
    elif ac.get("any_unstable") or not (acoustic_margin >= gate_threshold):
        if lim is not None:
            driven = lim.get("alpha", 0.0) > 0
            txt = (f"Acoustic mode {lim.get('mode')} ({lim.get('f_hz', 0):.0f} Hz) is "
                   f"{'driven' if driven else 'only lightly damped'} "
                   f"(α={lim.get('alpha', 0):.0f} 1/s, damping/driving {acoustic_margin:.2f}).")
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
            "text": "Soften the combustion response (lower n, check χ).",
            "rationale": "A smaller n weakens the heat-release feedback that drives the mode (Rayleigh criterion).",
            "lever": "n",
        })

    # --- vaporization completeness ---
    if not vap.get("vaporized_in_chamber", True):
        lvap, lch = vap.get("L_vap_m"), vap.get("L_ch_m")
        ratio = (lvap / lch) if (lch and lvap is not None and np.isfinite(lvap) and lch > 0) else float("nan")
        txt = "Spray not 95 % vaporized in the chamber"
        if np.isfinite(ratio):
            txt += f" (L_vap ≈ {ratio:.1f}× L_ch)"
        elif vap.get("frac_vaporized_end") is not None:
            txt += f" ({vap['frac_vaporized_end'] * 100:.1f} % of the {vap.get('fluid', '')} by the chamber end)"
        txt += "."
        findings.append({"severity": "warn", "text": txt})
        actions.append({
            "text": "Atomize finer or lengthen the chamber.",
            "rationale": "A shorter vaporization length completes burning upstream of the nozzle.",
            "lever": "SMD",
        })

    if not findings:
        findings.append({"severity": "ok",
                         "text": "Nothing driven."})

    gm_txt = f"chug gain margin {chug_margin:.2f} against {gate_threshold:.2f}"
    if state == "stable":
        headline = f"Stable: {gm_txt}."
    elif state == "marginal":
        headline = f"Marginal: {gm_txt}."
    elif state == "unknown":
        headline = "Not assessed: the stability model could not be evaluated here."
    else:
        headline = f"Unstable: {limiting or 'a mode'} is driven ({gm_txt})."

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
                      cg: Any, *, gate_threshold: Optional[float] = None,
                      overrides: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """Assemble the full rich stability payload (plan §A5 schema). <=5 s.

    ``gate_threshold`` defaults to design_requirements.min_stability_margin (as Layer 1 relaxes
    it), so the report and the optimizer gate on the same number."""
    from engine.pipeline import assumptions as _assumptions
    if gate_threshold is None:
        gate_threshold = analysis._stability_requirement(config)
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

    # --- chug (rich root-find + boundary + band over the unmeasured mixing lag) ---
    chug_rich = chug.chug_growth_rate(streams, chamber)
    chug_fast = chug.chug_margin_fast(streams, chamber)
    gm_nominal = float(chug_fast.get("gain_margin", float("nan")))
    band = analysis.chug_band(inp, gm_nominal)
    chug_margin = band["min"] if band is not None else gm_nominal
    eta_window = _eta_window(streams)
    boundary = _chug_boundary_curve(streams, chamber, eta_window=eta_window)
    design_point = _chug_design_point(streams, chamber, band, inp)
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
        streams, chamber, eta_values=np.linspace(eta_window[0], eta_window[1], 26), scale_design=True)
    eta_critical = _locus_crossing(locus)

    # --- acoustic (full mode set with damping budgets) ---
    ac = acoustic.analyze_acoustic_modes(inp["D_ch"], inp["L_ch"], gas,
                                         n=inp["n_interaction"], tau_sens=inp["tau_sens"],
                                         coeffs=inp["damping_coeffs"])
    ac_gate_mode = inp["acoustic_gate"]
    ac_gated = ac_gate_mode != "report_only"
    m_key = "margin_worst_phase" if ac_gate_mode == "worst_phase" else "margin"
    ac_margins = [m[m_key] for m in ac["modes"]]
    acoustic_margin_model = float(min(ac_margins)) if ac_margins else float("nan")
    acoustic_margin = acoustic_margin_model if ac_gated else float("inf")
    acoustic_modes = [{
        "name": m["mode"], "freq_hz": m["f_hz"], "alpha": m["alpha"],
        "driving": m["driving"], "driving_max": m["driving_max"],
        "margin": m["margin"], "margin_worst_phase": m["margin_worst_phase"], "n_min": m["n_min"],
        "damping": {"noz": m["damping"]["nozzle"], "visc": m["damping"]["viscous"],
                    "inj": m["damping"]["injector"], "twophase": m["damping"]["twophase"]},
    } for m in ac["modes"]]

    # --- phase clock (omega*tau_sens per mode) ---
    # Driving is n(1 - cos wt) (acoustic.py): none at wt = 0 mod 2pi, most at pi. drive_share is
    # the mode's driving over the most any lag could give, (1 - cos wt)/2.
    phase = []
    for m in ac["modes"]:
        wt = float(2 * np.pi * m["f_hz"] * inp["tau_sens"])
        phase.append({"mode": m["mode"], "omega_tau": wt, "omega_tau_mod": float(wt % (2 * np.pi)),
                      "drive_share": float(m["driving"] / m["driving_max"]) if m["driving_max"] > 0 else 0.0})

    from engine.pipeline.combustion_physics import vaporization_profile
    try:
        march = vaporization_profile((diagnostics or {}).get("cstar_efficiency") or {})
    except Exception:
        march = None
    vap = _vaporization_profile(inp, Pc, march=march)
    sens = _sensitivity(inp, gm_nominal)
    fallbacks = _fallbacks_used(used_here)
    radar = _radar(chug_margin, ac, vap, gate_threshold)

    ac_alpha_nominal = ac["modes"][0]["alpha"] if ac["modes"] else float("nan")
    state = analysis.classify_stability(gm_nominal, chug_margin, acoustic_margin,
                                        ac_alpha_nominal, ac_gated, gate_threshold)
    if chug_rich.get("stable") is False and state in ("stable", "marginal"):
        state = "unstable"          # the root-find found a growing pole the scan did not
    min_margin = float(min(chug_margin, acoustic_margin))
    limiting = "chug" if (not ac_gated or chug_margin <= acoustic_margin) else ac.get("limiting_mode")
    diag = _diagnostics(state, chug_margin, acoustic_margin, gate_threshold, limiting,
                        chug_rich, ac, vap, fallbacks, acoustic_gate=ac_gate_mode)

    return {
        "summary": {"state": state, "min_margin": min_margin,
                    "gate_margin_threshold": gate_threshold, "limiting_mode": limiting,
                    "margin_basis": "chug Nyquist gain margin at the low end of the mixing-lag band"
                                    + ("" if not ac_gated else f"; acoustic damping/driving ({ac_gate_mode})")},
        "diagnostics": diag,
        "chug": {
            "alpha": chug_rich.get("alpha"), "freq_hz": chug_rich.get("f_chug_hz"),
            "zeta": chug_rich.get("zeta"), "margin": chug_margin,
            "gain_margin_nominal": gm_nominal,
            "gain_margin_db": analysis.gain_margin_db(chug_margin),
            "gain_margin_nominal_db": analysis.gain_margin_db(gm_nominal),
            "gm_band": band,
            "phase_margin_deg": chug_fast.get("phase_margin_deg"),
            "theta_c_s": float(theta_c),
            "regulator_status": chug_rich.get("regulator_status"),
            "alpha_no_reg": chug_rich.get("alpha_no_reg"), "driver": chug_rich.get("driver"),
            "boundary_curve": boundary,
            "boundary_basis": "every stream's drop and lag scaled together from the design; x = "
                              "mass-weighted ΔP_inj/Pc, y = mass-weighted τ/θ_c; nominal mixing lag",
            "design_point": design_point,
            "eta_mean": float(chug.mean_eta(streams)),
            "pole": _chug_pole(chug_rich),
            "design_streams": design_streams,
            "root_locus": locus,
            "locus_param": "eta_inj_mean (every stream's drop scaled by one factor)",
            "eta_window": [float(eta_window[0]), float(eta_window[1])],
            "eta_critical": eta_critical,
            "lag_model": inp.get("lag_model"),
            "convection_model": inp.get("convection_model"),
            "lag_breakdown": lag_break,
        },
        "acoustic": {"margin": acoustic_margin, "margin_model": acoustic_margin_model,
                     "gate_status": ac_gate_mode, "modes": acoustic_modes,
                     "any_unstable": ac["any_unstable"], "limiting_mode": ac["limiting_mode"],
                     "chamber_length_m": float(inp["L_ch"]), "chamber_diameter_m": float(inp["D_ch"]),
                     "sound_speed_m_s": float(gas.a_sound)},
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
            "acoustic_gate": ac_gate_mode,
            "acoustic_overlap": {m["mode"]: m["overlap"] for m in ac["modes"]},
            "damping_injector_frac": float(inp["damping_coeffs"].injector_frac),
            "damping_twophase_frac": float(inp["damping_coeffs"].twophase_frac),
            # Which named models produced this answer, and what the propellants/injector actually
            # are -- so a report can never be read as if it described a different engine.
            "time_lag_model": inp.get("lag_model"),
            "convection_model": inp.get("convection_model"),
            "mixing_lag_fraction": inp.get("mixing_lag_fraction"),
            "mixing_lag_fraction_band": list(inp["chug_band"]) if inp.get("chug_band") else None,
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

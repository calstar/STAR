"""The injector's state per twin step: jet velocities, momentum ratio, the spray's resultant tilt,
and eta_c* from the replay.

``build_injector(result, prep=None, config, *, forward=None, runner=None)`` ->
``diagnostics.injector`` (DATA-CONTRACT 3).

Every quantity is EngineDesign's own definition, called rather than restated:

* jet bulk velocity ``v = mdot / (rho n A_jet)``, ``A_jet = pi d_jet^2 / 4``, at the config density
  (the same ``v_O_bulk``/``v_F_bulk`` ``engine.core.injectors.impinging`` computes);
* momentum ratio ``R = sqrt(rho_O v_O^2 / (rho_F v_F^2))``
  (``impinging.momentum_ratio_R_from_bulk_velocities``; R is the Cd-dp split, not Rupe's mixing
  criterion) and Rupe's ``M = rho_O v_O^2 d_O / (rho_F v_F^2 d_F)`` (``impinging.rupe_mixing_ratio``:
  Rupe, JPL PR 20-195, restated by Elverum & Morey, JPL Memo 30-5, 1959, eq. 1);
* the resultant's tilt from the chamber axis, + toward the wall, from the vector sum of the two
  streams' momenta (``layer1_static_optimization._impinging_resultant_tilt_deg``, the rule
  ``reconcile._angles_for_tilt`` uses; which ring is inboard from the pitch circles).

The flows are the twin's (``series.*.mdot``), so these follow the burn; the densities are the
config's, because that is what the card's injector was tabulated at (AUDIT ledger #27: the twin's
saturated-line densities differ by 0.2 % / 0.04 %). ``design_momentum_ratio`` is EngineDesign's
Forward solve at the burn's lockup (``forward``, or evaluated with ``runner``); without either it
is null. ``eta_cstar`` is the replay's, linearly interpolated onto the twin's steps inside the
replay's span and null outside it (the replay has ~28 points: never read 50 ms resolution into it).
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

import numpy as np

from engine.layerx.diag.ladder import (
    PSI, arr, firing_mask, inp, model_block, out, scalar, series_t, unavailable,
)
from engine.layerx.diag.saturation import cd_effective, orifice_geometry

SOURCE = ("EngineDesign: engine.core.injectors.impinging.momentum_ratio_R_from_bulk_velocities and "
          "rupe_mixing_ratio (Rupe, JPL PR 20-195; Elverum & Morey, JPL Memo 30-5, 1959, eq. 1); "
          "engine.optimizer.layers.layer1_static_optimization._impinging_resultant_tilt_deg (momentum "
          "vector sum, + toward the wall)")


def forward_design_point(prep: Any, config: Any, runner: Any = None,
                         forward: Optional[Mapping[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """EngineDesign's Forward solve at the burn's lockup, both tanks, at the site's ambient: what
    the design column of a "design assumed X -> feed delivers Y(t)" row must come from (AUDIT 4).
    ``forward`` (a ``runner.evaluate`` result) is returned as is; else ``runner`` is evaluated."""
    if forward is not None:
        return dict(forward)
    if runner is None or prep is None:
        return None
    derived = getattr(prep, "derived", {}) or {}
    lockup = derived.get("target_lockup_psia")
    if not lockup:
        return None
    ambient = float(getattr(prep, "ambient_pa", None) or derived.get("ambient_pa") or 101325.0)
    res = runner.evaluate(float(lockup) * PSI, float(lockup) * PSI, P_ambient=ambient, silent=True)
    res = dict(res)
    res["_basis"] = {"tank_psia": float(lockup), "ambient_pa": ambient}
    return res


def _replay_onto(result: Mapping[str, Any], key: str, t: np.ndarray) -> np.ndarray:
    rep = result.get("replay") or {}
    rt = arr(rep.get("t"))
    rv = arr(rep.get(key)) if rep.get(key) is not None else np.full(rt.size, np.nan)
    ok = np.isfinite(rt) & np.isfinite(rv)
    if ok.sum() < 1:
        return np.full(t.size, np.nan)
    rt, rv = rt[ok], rv[ok]
    vals = np.interp(t, rt, rv)
    return np.where((t >= rt[0] - 1e-9) & (t <= rt[-1] + 1e-9), vals, np.nan)


def build_injector(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
                   forward: Optional[Mapping[str, Any]] = None, runner: Any = None) -> Dict[str, Any]:
    """``diagnostics.injector``. Never raises. Needs ``config`` (the orifices) and the series."""
    try:
        if config is None:
            return unavailable("the engine config is needed for the orifices")
        from engine.core.injectors.impinging import momentum_ratio_R_from_bulk_velocities, rupe_mixing_ratio
        from engine.optimizer.layers.layer1_static_optimization import _impinging_resultant_tilt_deg

        series = result.get("series") or {}
        t = series_t(result)
        n = t.size
        firing = firing_mask(result, n)
        go, gf = orifice_geometry(config, "ox"), orifice_geometry(config, "fuel")
        m_o = arr((series.get("ox") or {}).get("mdot"), n)
        m_f = arr((series.get("fuel") or {}).get("mdot"), n)
        flowing = firing & (np.nan_to_num(m_o) > 0) & (np.nan_to_num(m_f) > 0)
        v_o = np.where(flowing, m_o / (go["rho"] * go["area"]), np.nan)
        v_f = np.where(flowing, m_f / (gf["rho"] * gf["area"]), np.nan)
        R = np.full(n, np.nan)
        M = np.full(n, np.nan)
        tilt = np.full(n, np.nan)
        for k in np.flatnonzero(flowing):
            R[k] = momentum_ratio_R_from_bulk_velocities(go["rho"], gf["rho"], float(v_o[k]), float(v_f[k]))
            M[k] = rupe_mixing_ratio(go["rho"], float(v_o[k]), go["d_jet"], gf["rho"], float(v_f[k]), gf["d_jet"])
            tilt[k] = _impinging_resultant_tilt_deg(
                float(m_o[k]), float(m_f[k]), go["rho"], gf["rho"], float(go["n"]), go["d_jet"], gf["d_jet"],
                go["angle_deg"], gf["angle_deg"], spacing_O_m=go["spacing"], spacing_F_m=gf["spacing"])
        cd_o = cd_effective(m_o, arr((series.get("ox") or {}).get("dp_injector_psi"), n), go["area"], go["rho"])
        cd_f = cd_effective(m_f, arr((series.get("fuel") or {}).get("dp_injector_psi"), n), gf["area"], gf["rho"])
        eta = _replay_onto(result, "eta_cstar", t)

        fwd = None
        fwd_note = "no Forward solve supplied (pass forward= or runner=)"
        try:
            fwd = forward_design_point(prep, config, runner, forward)
        except Exception as exc:  # noqa: BLE001
            fwd_note = f"Forward solve failed: {type(exc).__name__}: {exc}"
        d = (fwd or {}).get("diagnostics") or {}
        design_R = scalar(d.get("momentum_ratio_R")) if fwd else None
        design_M = scalar(d.get("rupe_M")) if fwd else None
        design_tilt = None
        if fwd and fwd.get("mdot_O") and fwd.get("mdot_F"):
            design_tilt = scalar(_impinging_resultant_tilt_deg(
                float(fwd["mdot_O"]), float(fwd["mdot_F"]), go["rho"], gf["rho"], float(go["n"]), go["d_jet"],
                gf["d_jet"], go["angle_deg"], gf["angle_deg"], spacing_O_m=go["spacing"], spacing_F_m=gf["spacing"]))
        if fwd:
            fwd_note = f"EngineDesign Forward at {((fwd.get('_basis') or {}).get('tank_psia'))} psia both tanks"

        def rng(a: np.ndarray) -> Optional[list]:
            ok = flowing & np.isfinite(a)
            return [scalar(np.nanmin(a[ok])), scalar(np.nanmax(a[ok]))] if ok.any() else None

        req = getattr(config, "design_requirements", None)
        band = [getattr(req, "impinging_momentum_R_min", None), getattr(req, "impinging_momentum_R_max", None)]
        return {
            "t": out(t),
            "v_ox": out(v_o), "v_fuel": out(v_f),
            "momentum_ratio": out(R), "rupe_M": out(M),
            "design_momentum_ratio": design_R, "design_rupe_M": design_M,
            "momentum_ratio_band": band if any(b is not None for b in band) else None,
            "resultant_angle_deg": out(tilt), "design_resultant_angle_deg": design_tilt,
            "Cd_eff_ox": out(cd_o), "Cd_eff_fuel": out(cd_f),
            "design_Cd": ({"ox": scalar(d.get("Cd_O")), "fuel": scalar(d.get("Cd_F"))} if fwd else None),
            "eta_cstar": out(eta),
            "design_eta_cstar": scalar(fwd.get("eta_cstar") or d.get("eta_cstar")) if fwd else None,
            "eta_cstar_replay": {"t": (result.get("replay") or {}).get("t"),
                                 "values": (result.get("replay") or {}).get("eta_cstar")},
            "range": {"momentum_ratio": rng(R), "resultant_angle_deg": rng(tilt), "v_ox": rng(v_o),
                      "v_fuel": rng(v_f)},
            "design_basis": fwd_note,
            "model": model_block(
                "injector state on the twin's flows (EngineDesign definitions)",
                SOURCE,
                ["v = mdot / (rho n A_jet) at the config density (the card's basis), the twin's mdot per step",
                 "R = sqrt(rho_O v_O^2 / (rho_F v_F^2)); M = R^2 d_O/d_F (Rupe)",
                 "tilt: + toward the wall; ring order from the pitch circles (D = n s / pi)",
                 "Cd_eff = mdot / (A sqrt(2 rho dp_inj)) on the twin's orifice drop",
                 "eta_c* interpolated between replay points, null outside the replay's span",
                 "design values: one EngineDesign Forward solve at the burn's lockup on both tanks"],
                {"rho_ox": inp(go["rho"], "kg/m^3", "config fluids.oxidizer.density"),
                 "rho_fuel": inp(gf["rho"], "kg/m^3", "config fluids.fuel.density"),
                 "d_jet_ox": inp(go["d_jet"] * 1e3, "mm", "config injector.geometry.oxidizer.d_jet"),
                 "d_jet_fuel": inp(gf["d_jet"] * 1e3, "mm", "config injector.geometry.fuel.d_jet"),
                 "n_elements": inp(go["n"], "-", "config injector.geometry.*.n_elements"),
                 "angle_ox": inp(go["angle_deg"], "deg", "config injector.geometry.oxidizer.impingement_angle"),
                 "angle_fuel": inp(gf["angle_deg"], "deg", "config injector.geometry.fuel.impingement_angle"),
                 "spacing_ox": inp(go["spacing"] * 1e3, "mm", "config injector.geometry.oxidizer.spacing"),
                 "spacing_fuel": inp(gf["spacing"] * 1e3, "mm", "config injector.geometry.fuel.spacing")}),
        }
    except Exception as exc:  # noqa: BLE001
        return unavailable(f"{type(exc).__name__}: {exc}")

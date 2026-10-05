"""The assumption ledger: what EngineDesign's design point assumes, against what the burn delivered.

``build_ledger(result, prep=None, config, *, forward=None, runner=None, injector=None)`` ->
``diagnostics.ledger`` (DATA-CONTRACT 3): one row per AUDIT section-4 assumption that a result can
fill, ``{key, label, design_value, unit, delivered: {min, max, mean, start, end}, series_ref,
replaced, note}``.

**The design column is one EngineDesign Forward solve at the burn's lockup on both tanks**
(``engine.layerx.diag.injector.forward_design_point``), not the config's ``design_*`` / ``target_*``
fields: AUDIT 4 found those stale (6.5 kN values on a 6.8 kN engine). Rows that are config constants
EngineDesign uses as they are (densities, nozzle efficiency, A_t before erosion) take the config's
value and say so. Without a Forward solve the Forward rows carry ``design_value: null``.

**The delivered column** is min / max / time-mean / first / last over the firing steps of the series
named in ``series_ref`` (``dt``-weighted mean), or over the replay's points for replay series
(eta_c*), or one value where the quantity is a scalar (burn time, impulse).

``replaced`` reads as AUDIT 4 does: ``yes`` when the burn takes the quantity from the drawing or
the twin, ``partly`` when it takes the operating point but not the model's inputs, ``no`` when the
design's own value is used unchanged.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional

import numpy as np

from engine.layerx.diag.ladder import PSI, arr, firing_mask, scalar, series_t, unavailable

G0 = 9.80665


def _stats(values: np.ndarray, weights: Optional[np.ndarray] = None) -> Optional[Dict[str, Optional[float]]]:
    ok = np.isfinite(values)
    if not ok.any():
        return None
    v = values[ok]
    w = weights[ok] if weights is not None else np.ones(v.size)
    if not np.isfinite(w).all() or w.sum() <= 0:
        w = np.ones(v.size)
    return {"min": scalar(v.min()), "max": scalar(v.max()), "mean": scalar(float(np.sum(v * w) / np.sum(w))),
            "start": scalar(v[0]), "end": scalar(v[-1])}


def _one(value: Any) -> Optional[Dict[str, Optional[float]]]:
    v = scalar(value)
    return None if v is None else {"min": v, "max": v, "mean": v, "start": v, "end": v}


def _get(d: Any, path: str) -> Any:
    for part in path.split("."):
        if d is None:
            return None
        d = d.get(part) if isinstance(d, Mapping) else getattr(d, part, None)
    return d


def build_ledger(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
                 forward: Optional[Mapping[str, Any]] = None, runner: Any = None,
                 injector: Optional[Mapping[str, Any]] = None) -> Any:
    """``diagnostics.ledger`` (a list of rows). Never raises: a failure is ``{available: false, error}``."""
    try:
        from engine.layerx.diag.injector import forward_design_point
        from engine.layerx.diag.saturation import cd_effective, orifice_geometry, saturated_liquid_density, \
            side_fluid

        series = result.get("series") or {}
        dl = result.get("delivered") or {}
        rep = result.get("replay") or {}
        t = series_t(result)
        n = t.size
        fire = firing_mask(result, n)
        dt = arr(series.get("dt"), n) if series.get("dt") is not None and len(series["dt"]) == n else np.ones(n)

        fwd = None
        fwd_err = None
        try:
            fwd = forward_design_point(prep, config, runner, forward)
        except Exception as exc:  # noqa: BLE001
            fwd_err = f"{type(exc).__name__}: {exc}"
        fd = (fwd or {}).get("diagnostics") or {}
        basis = (fwd or {}).get("_basis") or {}
        lockup = basis.get("tank_psia") or ((getattr(prep, "derived", None) or
                                             (result.get("provenance") or {}).get("derived") or {})
                                            .get("target_lockup_psia"))
        fwd_note = (f"EngineDesign Forward at {lockup} psia both tanks" if fwd else
                    f"no Forward solve ({fwd_err or 'pass forward= or runner='})")

        def fwd_val(key: str, scale: float = 1.0) -> Optional[float]:
            if fwd is None:
                return None
            v = fwd.get(key)
            if v is None:
                v = fd.get(key)
            v = scalar(v)
            return None if v is None else v / scale

        def ser(path: str) -> np.ndarray:
            return arr(_get(series, path), n)

        def firing_stats(v: np.ndarray) -> Optional[Dict[str, Optional[float]]]:
            return _stats(np.where(fire, v, np.nan), np.where(fire, dt, np.nan))

        def dl_stats(key: str, scale: float = 1.0) -> Optional[Dict[str, Optional[float]]]:
            v = dl.get(key)
            if v is None:
                return None
            d_t = arr(dl.get("t"))
            vv = arr(v) * scale
            w = np.diff(d_t, prepend=d_t[0] - (d_t[1] - d_t[0] if d_t.size > 1 else 1.0)) if d_t.size else None
            return _stats(vv, w)

        rows: List[Dict[str, Any]] = []

        def row(key: str, label: str, design: Optional[float], unit: str, delivered: Any, series_ref: str,
                replaced: str, note: str = "", design_source: str = "") -> None:
            rows.append({"key": key, "label": label, "design_value": scalar(design) if design is not None else None,
                         "design_source": design_source or fwd_note, "unit": unit, "delivered": delivered,
                         "series_ref": series_ref, "replaced": replaced, "note": note})

        sides = (("ox", "O", "LOX", "oxidizer"), ("fuel", "F", "Fuel", "fuel"))
        for s, k, lab, _ in sides:
            row(f"tank_pressure_{s}", f"{lab} tank pressure", lockup, "psia", firing_stats(ser(f"{s}.tank_psia")),
                f"series.{s}.tank_psia", "yes",
                "EngineDesign holds the tank at the lockup; the twin's ullage dips at ignition and rides the "
                "regulator's supply-pressure effect", design_source="Forward input (the burn's lockup)")
        regs = series.get("regulators") or {}
        for rid, reg in regs.items():
            row(f"regulator_outlet_{rid}", f"Regulator {reg.get('label') or rid} outlet", lockup, "psia",
                firing_stats(arr(reg.get("outlet_psia"), n)), f"series.regulators.{rid}.outlet_psia", "yes",
                "Forward has no regulator (a flat setpoint); the drawing's supply-pressure effect and droop act "
                "here. Sources disagree on the supply effect (AUDIT D9).",
                design_source="flat setpoint at the lockup (no regulator in Forward)")
        for s, k, lab, _ in sides:
            row(f"feed_loss_{s}", f"{lab} feed loss, tank to manifold", fwd_val(f"delta_p_feed_{k}", PSI), "psi",
                firing_stats(ser(f"{s}.tank_psia") - ser(f"{s}.manifold_psia")),
                f"series.{s}.tank_psia - series.{s}.manifold_psia", "yes",
                "design: the config's lumped K0 + Borda dump; delivered: the drawing's lines, head and the dump")
        row("pc", "Chamber pressure", fwd_val("Pc", PSI), "psia", dl_stats("pc_psia"), "delivered.pc_psia", "yes")
        row("thrust", "Thrust", fwd_val("F"), "N", dl_stats("thrust_N"), "delivered.thrust_N", "yes")
        row("of", "O/F", fwd_val("MR"), "-", dl_stats("mr"), "delivered.mr", "yes")
        for s, k, lab, _ in sides:
            row(f"mdot_{s}", f"{lab} flow", fwd_val(f"mdot_{k}"), "kg/s", dl_stats(f"mdot_{k}"),
                f"delivered.mdot_{k}", "yes")
        row("isp", "Isp", fwd_val("Isp"), "s", dl_stats("isp_s"), "delivered.isp_s", "yes")
        pc_f = fwd_val("Pc", PSI)
        for s, k, lab, _ in sides:
            dpi = fwd_val(f"delta_p_injector_{k}", PSI)
            row(f"stiffness_{s}", f"{lab} injector dP/Pc", (dpi / pc_f) if dpi is not None and pc_f else None, "-",
                firing_stats(ser(f"{s}.stiffness")), f"series.{s}.stiffness", "yes",
                "design band from design_requirements.injector_dp_ratio_*")
            row(f"dp_injector_{s}", f"{lab} injector dP", dpi, "psi", firing_stats(ser(f"{s}.dp_injector_psi")),
                f"series.{s}.dp_injector_psi", "yes")
            row(f"manifold_{s}", f"{lab} manifold pressure", fwd_val(f"P_injector_{k}", PSI), "psia",
                firing_stats(ser(f"{s}.manifold_psia")), f"series.{s}.manifold_psia", "yes")

        # throat area: the design's (as built), delivered as A_t0 x the replay's growth
        at0 = scalar(_get(config, "chamber_geometry.A_throat")) if config is not None else None
        at0 = at0 or fwd_val("A_throat")
        ratio = dl.get("throat_area_ratio")
        row("throat_area", "Throat area", at0 * 1e6 if at0 else None, "mm^2",
            dl_stats("throat_area_ratio", at0 * 1e6) if (at0 and ratio is not None) else None,
            "delivered.throat_area_ratio x A_t0", "yes", "recession rates unvalidated (AUDIT 1 #10)",
            design_source="config chamber_geometry.A_throat (as built)")
        eps0 = scalar(_get(config, "chamber_geometry.expansion_ratio")) if config is not None else None
        row("eps", "Expansion ratio", eps0, "-", dl_stats("eps"), "delivered.eps", "yes",
            design_source="config chamber_geometry.expansion_ratio")
        lstar0 = scalar(_get(config, "chamber_geometry.Lstar")) if config is not None else None
        row("lstar", "L*", lstar0, "m", _stats(arr(rep.get("Lstar_m"))) if rep.get("Lstar_m") else None,
            "replay.Lstar_m", "partly", "the twin's card stays as built (AUDIT 3 #10)",
            design_source="config chamber_geometry.Lstar")
        row("eta_cstar", "eta_c*", fwd_val("eta_cstar"), "-",
            _stats(arr(rep.get("eta_cstar"))) if rep.get("eta_cstar") else None, "replay.eta_cstar", "partly",
            "the same model at each replay point; its inputs (E_m, SMD) stay assumed")
        if config is not None:
            for s, k, lab, ck in sides:
                geo = orifice_geometry(config, s)
                cd = cd_effective(ser(f"{s}.mdot"), ser(f"{s}.dp_injector_psi"), geo["area"], geo["rho"])
                row(f"cd_{s}", f"{lab} orifice Cd", fwd_val(f"Cd_{k}"), "-", firing_stats(cd),
                    f"derived: series.{s}.mdot / (A sqrt(2 rho series.{s}.dp_injector_psi))", "no",
                    "the card's capacity is EngineDesign's Cd model (Lichtarowicz); the burn does not measure it")
            for s, k, lab, ck in sides:
                rho_cfg = scalar(_get(config, f"fluids.{ck}.density")) if isinstance(config.fluids, Mapping) else None
                fluid = side_fluid(prep, result, s) or ("oxygen" if s == "ox" else "ethanol")
                T_l = ser(f"{s}.liquid_K")
                rho_twin = np.array([saturated_liquid_density(fluid, x) if math.isfinite(x) else math.nan
                                     for x in T_l])
                row(f"density_{s}", f"{lab} density (engine)", rho_cfg, "kg/m^3", firing_stats(rho_twin),
                    f"CoolProp saturated liquid at series.{s}.liquid_K (the twin's basis)", "no",
                    "the twin prices liquid on the saturated line at T; the engine card keeps the config density "
                    "(AUDIT ledger #27)", design_source=f"config fluids.{ck}.density")
            zeta = scalar(_get(config, "chamber_geometry.nozzle_efficiency"))
            row("nozzle_efficiency", "Nozzle efficiency", zeta, "-", _one(zeta), "config (unchanged by the burn)",
                "no", "schema default with no source (AUDIT D16)",
                design_source="config chamber_geometry.nozzle_efficiency")
        amb_d = fwd_val("P_ambient", PSI)
        row("ambient", "Ambient pressure", amb_d, "psia", dl_stats("ambient_psia"), "delivered.ambient_psia",
            "partly", "site ambient on the pad; altitude only inside RocketPy")
        # specific force and the liquid heads it sets
        flight = result.get("flight") or {}
        sched = flight.get("schedule") if flight.get("ok") else None
        if sched and sched.get("t"):
            a = np.interp(t, arr(sched["t"]), arr(sched["accel_m_s2"])) / G0
            a_ref, a_note = "flight.schedule.accel_m_s2 / g0", "the flown pass's axial specific force"
        else:
            a = np.ones(n)
            a_ref, a_note = "Setup.body_acceleration (pad: 1 g)", "on the pad: one g"
        row("specific_force", "Axial specific force", None, "g", firing_stats(a), a_ref, "partly",
            f"EngineDesign has no head term at all; {a_note}", design_source="none (no head term)")
        for s, k, lab, _ in sides:
            row(f"tank_head_{s}", f"{lab} tank head", 0.0, "psi",
                firing_stats(ser(f"{s}.outlet_psia") - ser(f"{s}.tank_psia")),
                f"series.{s}.outlet_psia - series.{s}.tank_psia", "partly",
                "no line heights on the drawing: only the tanks' own liquid feels the acceleration",
                design_source="EngineDesign: no hydrostatic head")
        if injector and injector.get("momentum_ratio") is not None:
            row("momentum_ratio", "Momentum ratio R", injector.get("design_momentum_ratio"), "-",
                firing_stats(arr(injector["momentum_ratio"], n)), "diagnostics.injector.momentum_ratio",
                "partly", "derived on the twin's flows at the config densities")
        summ = (dl.get("summary") or {})
        burn_cfg = scalar(_get(config, "thrust.burn_time")) if config is not None else None
        row("burn_time", "Burn time", burn_cfg, "s", _one((result.get("summary") or {}).get("burn_time_s")),
            "summary.burn_time_s", "yes", "the config's burn time is a stale field (AUDIT 4 #22)",
            design_source="config thrust.burn_time")
        load = None
        if config is not None:
            load = (scalar(_get(config, "design_requirements.lox_tank_capacity_kg")) or 0.0) + \
                (scalar(_get(config, "design_requirements.fuel_tank_capacity_kg")) or 0.0)
        isp_f = fwd_val("Isp")
        row("impulse", "Total impulse", (load * isp_f * G0) if (load and isp_f) else None, "N s",
            _one(summ.get("total_impulse_Ns")), "delivered.summary.total_impulse_Ns", "yes",
            "design: propellant load x Forward Isp x g0",
            design_source="config load x Forward Isp")
        return rows
    except Exception as exc:  # noqa: BLE001
        return unavailable(f"{type(exc).__name__}: {exc}")


def build_feed_diagnostics(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
                           runner: Any = None, forward: Optional[Mapping[str, Any]] = None,
                           target_N: Optional[float] = None, sampler: Any = None) -> Dict[str, Any]:
    """Every feed-diagnostic block of DATA-CONTRACT 3 this package builds, keyed as the contract
    keys them under ``result["diagnostics"]``: ladder, regulator, solenoids, pressurant,
    saturation, cavitation, injector, thrust_shape, ledger. One Forward solve at the lockup is
    shared by the injector and the ledger. Each block fails on its own (``{available: false,
    error}``); this never raises."""
    from engine.layerx.diag.injector import build_injector, forward_design_point
    from engine.layerx.diag.ladder import build_ladder
    from engine.layerx.diag.pressurant import build_pressurant
    from engine.layerx.diag.regulator import build_regulator, build_solenoids
    from engine.layerx.diag.saturation import build_cavitation, build_saturation
    from engine.layerx.diag.thrustshape import build_thrust_shape

    out: Dict[str, Any] = {}
    try:
        fwd = forward_design_point(prep, config, runner, forward)
    except Exception:  # noqa: BLE001 - the Forward rows go null, the rest stands
        fwd = None
    out["ladder"] = build_ladder(result, prep, config)
    out["regulator"] = build_regulator(result, prep, config)
    out["solenoids"] = build_solenoids(result, prep, config)
    reg = out["regulator"] if isinstance(out["regulator"], Mapping) and "error" not in out["regulator"] else None
    out["pressurant"] = build_pressurant(result, prep, config, regulator=reg)
    out["saturation"] = build_saturation(result, prep, config)
    out["cavitation"] = build_cavitation(result, prep, config)
    out["injector"] = build_injector(result, prep, config, forward=fwd)
    out["thrust_shape"] = build_thrust_shape(result, prep, config, sampler=sampler, target_N=target_N)
    inj = out["injector"] if isinstance(out["injector"], Mapping) and "error" not in out["injector"] else None
    out["ledger"] = build_ledger(result, prep, config, forward=fwd, injector=inj)
    return out

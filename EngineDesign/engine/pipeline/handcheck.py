"""Re-derive a design's headline numbers by hand and set them beside the model's.

Nothing here calls the engine's physics: thermochemistry comes from NASA CEA through rocketcea (or,
where rocketcea is not installed, c* from the committed wide CEA table and nothing else),
everything else from the textbook relation named on its row. ``handcheck`` takes a solved result
(``PintleEngineRunner.evaluate``) and returns the rows; scripts/design_handcheck.py prints them and
forward mode shows them in its independent-check box.

A row is flagged when the two disagree by more than its tolerance, or when a design-practice bound
is not met.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping

PSI = 6894.757
G0 = 9.80665


#: Said on the report when the deployment has no rocketcea (the API image leaves it out: it builds
#: CEA from Fortran). The textbook rows need no CEA; c* is checked against the committed wide table.
NO_ROCKETCEA = ("rocketcea is not installed here: c* is checked against the committed wide CEA "
                "table; Tc, γ, Cf and exit pressure need live CEA and are not checked")


def _cea_names(cfg: Any) -> tuple:
    cea = getattr(cfg.combustion, "cea", None)
    return (getattr(cea, "ox_name", "LOX"), getattr(cea, "fuel_name", "Ethanol"))


def _live_cea(cfg: Any):
    """rocketcea's CEA_Obj for the design's propellants, or None where rocketcea is not installed."""
    try:
        from rocketcea.cea_obj import CEA_Obj
    except ImportError:
        return None
    ox, fu = _cea_names(cfg)
    return CEA_Obj(oxName=ox, fuelName=fu)


def _table_cstar(cfg: Any, Pc: float, MR: float):
    """c* [m/s] from the committed wide CEA table (O/F 0.1–20, its own grid and interpolation), or
    None if the pair has none. Built from CEA's equilibrium chamber like the trilinear cache the
    model reads, but on a different grid -- so it catches a stale cache or a clamped O/F."""
    import numpy as np
    from engine.pipeline.combustion_physics import get_cstar_wide_table

    w = get_cstar_wide_table(*_cea_names(cfg))
    if w is None or not (w.MR_min <= MR <= w.MR_max):
        return None
    return float(np.interp(math.log(MR), np.log(w.MR), w.row(Pc)))


def handcheck(cfg: Any, r: Mapping[str, Any], PO: float, PF: float) -> Dict[str, Any]:
    """Rows ``{quantity, model, hand, diff, ok, source, kind}`` (kind: "compare" or "bound") and the
    flags, for result ``r`` of ``cfg`` at tank pressures PO, PF [Pa].

    Without rocketcea (the deployed API image) the textbook rows still run, c* is checked against
    the committed wide table, and the rows that need live CEA say so; ``note`` carries why.
    """
    cea = _live_cea(cfg)

    rows: List[Dict[str, Any]] = []
    flags: List[str] = []

    def compare(name, model, hand, tol, source, unit=""):
        rel = abs(model - hand) / max(abs(hand), 1e-300)
        ok = rel <= tol
        rows.append({"quantity": name, "model": f"{model:.5g} {unit}".strip(), "hand": f"{hand:.5g} {unit}".strip(),
                     "diff": f"{rel:.2%}", "ok": ok, "source": source, "kind": "compare", "rel": rel, "tol": tol})
        if not ok:
            flags.append(f"{name}: model {model:.5g} vs hand {hand:.5g} ({rel:.2%} > {tol:.2%})")

    def bound(name, value, lo, hi, source, unit=""):
        if value is None or not math.isfinite(value):
            rows.append({"quantity": name, "model": "n/a", "hand": "", "diff": "n/a", "ok": True,
                         "source": source, "kind": "info"})
            return
        ok = (lo is None or value >= lo) and (hi is None or value <= hi)
        band = f"{'' if lo is None else f'{lo:g}'}..{'' if hi is None else f'{hi:g}'}"
        rows.append({"quantity": name, "model": f"{value:.4g} {unit}".strip(), "hand": band,
                     "diff": "ok" if ok else "OUT", "ok": ok, "source": source, "kind": "bound"})
        if not ok:
            flags.append(f"{name} = {value:.4g} outside {band}")

    def info(name, value, note, source):
        rows.append({"quantity": name, "model": value, "hand": note, "diff": "info", "ok": True,
                     "source": source, "kind": "info"})

    d = r["diagnostics"]
    cg = cfg.chamber_geometry
    fl = cfg.fluids
    geo = cfg.injector.geometry
    Pc, Pc_ns, MR = r["Pc"], d.get("Pc_ns", r["Pc"]), r["MR"]
    At, eps, Pa = r["A_throat"], r["eps"], r["P_ambient"]
    mdot, F = r["mdot_total"], r["F"]

    # ---- thermochemistry: CEA (infinite-area combustor, equilibrium)
    pc_psia = Pc / PSI
    zeta = cg.nozzle_efficiency
    needs_cea = "needs rocketcea"
    if cea is not None:
        cstar_cea = cea.get_Cstar(pc_psia, MR) * 0.3048
        cstar_src = "CEA (rocketcea)"
        Tc_cea = cea.get_Tcomb(pc_psia, MR) / 1.8
        _, g_ch = cea.get_Chamber_MolWt_gamma(pc_psia, MR, eps)
        Isp_vac_cea = cea.get_Isp(pc_psia, MR, eps)
    else:
        cstar_cea = _table_cstar(cfg, Pc, MR)
        cstar_src = "CEA wide c* table (committed)"
    if cstar_cea is not None:
        compare("c* ideal", r["cstar_ideal"], cstar_cea, 0.005, cstar_src, "m/s")
    else:
        info("c* ideal", f"{r['cstar_ideal']:.5g} m/s", needs_cea, "CEA")
    if cea is not None:
        compare("Tc ideal", d.get("Tc_ideal", r["Tc"]), Tc_cea, 0.005, "CEA", "K")
        compare("gamma chamber", r["gamma"], g_ch, 0.01, "CEA")
    else:
        info("Tc ideal", f"{d.get('Tc_ideal', r['Tc']):.5g} K", needs_cea, "CEA")
        info("gamma chamber", f"{r['gamma']:.5g}", needs_cea, "CEA")

    # ---- mass balance: c* = p1 At / mdot (Sutton eq 3-32), at the nozzle stagnation pressure
    compare("mdot = Pc_ns At / c*", mdot, Pc_ns * At / r["cstar_actual"], 0.003, "Sutton 3-32", "kg/s")
    if cstar_cea is not None:
        compare("eta c*", r["eta_cstar"], r["cstar_actual"] / cstar_cea, 0.005, f"c*_act / c*_CEA ({cstar_src})")

    # ---- thrust coefficient: F = Cf p1 At; Cf = zeta_n Cf_vac - pa eps / p1
    if cea is not None:
        Cf_vac_cea = Isp_vac_cea * G0 / cstar_cea
        Cf_hand = zeta * Cf_vac_cea - Pa * eps / Pc_ns
        compare("Cf (zeta_n on vacuum Cf)", r["Cf"], Cf_hand, 0.01, f"Sutton 3-30, CEA Cf_vac, zeta_n={zeta}")
    else:
        info("Cf (zeta_n on vacuum Cf)", f"{r['Cf']:.5g}", needs_cea, "Sutton 3-30, CEA Cf_vac")
    compare("F = Cf Pc_ns At", F, r["Cf"] * Pc_ns * At, 0.002, "Sutton 3-31", "N")
    compare("Isp = F / (mdot g0)", r["Isp"], F / (mdot * G0), 0.002, "definition", "s")
    # exit state: CEA shifting equilibrium at this area ratio
    if cea is not None:
        pe_cea = Pc / cea.get_PcOvPe(pc_psia, MR, eps)
        compare("exit pressure", r["P_exit"], pe_cea, 0.02, "CEA Pc/Pe at eps", "Pa")
    else:
        info("exit pressure", f"{r['P_exit']:.5g} Pa", needs_cea, "CEA Pc/Pe at eps")
    bound("pe / pa (Summerfield > 0.4)", r["P_exit"] / Pa, 0.4, None, "Sutton 3.3 flow separation")

    # ---- injector: mdot = Cd A sqrt(2 rho dP) per stream (Sutton eq 8-1)
    for s, key, rho in (("O", "oxidizer", fl["oxidizer"].density), ("F", "fuel", fl["fuel"].density)):
        el = getattr(geo, key)
        A = el.n_elements * math.pi * el.d_jet ** 2 / 4.0
        dp = d[f"delta_p_injector_{s}"]
        m_hand = d[f"Cd_{s}"] * A * math.sqrt(2.0 * rho * dp)
        if d.get("manifold_model") == "ring_network":
            # dP is port-to-chamber; the ring-manifold solve spends a little of it in the channel
            # (entry + friction), so the holes see slightly less than dP.
            compare(f"mdot_{s} = Cd A sqrt(2 rho dP) (port head)", r[f"mdot_{s}"], m_hand, 0.02,
                    "Sutton 8-1; channel loss in the ring-manifold solve", "kg/s")
        else:
            compare(f"mdot_{s} = Cd A sqrt(2 rho dP)", r[f"mdot_{s}"], m_hand, 1e-6, "Sutton 8-1", "kg/s")
        compare(f"P_inj_{s} = P_tank - dP_feed", d[f"P_injector_{s}"], (PO if s == "O" else PF) - d[f"delta_p_feed_{s}"], 1e-9, "definition", "Pa")
        bound(f"dP_inj_{s} / Pc", dp / Pc, 0.15, None, "Huzel & Huang 4.2; Sutton 8.1 (chug margin)")
        v = r[f"mdot_{s}"] / (rho * A)
        bound(f"jet velocity {s}", v, 10.0, 60.0, "bulk mdot/(rho A); typical doublet range", "m/s")

    # ---- unlike doublet mixing and momentum (Rupe 1953; Sutton 8.3)
    rO, rF = fl["oxidizer"].density, fl["fuel"].density
    vO = r["mdot_O"] / (rO * geo.oxidizer.n_elements * math.pi * geo.oxidizer.d_jet ** 2 / 4.0)
    vF = r["mdot_F"] / (rF * geo.fuel.n_elements * math.pi * geo.fuel.d_jet ** 2 / 4.0)
    M = (rO * vO ** 2 * geo.oxidizer.d_jet) / (rF * vF ** 2 * geo.fuel.d_jet)
    compare("Rupe M", d["rupe_M"], M, 1e-6, "rho_O v_O^2 d_O / (rho_F v_F^2 d_F)")
    bound("Rupe M (best mixing near 1)", M, 0.8, 1.25, "Rupe 1953; Elverum & Morey 1959")
    thO, thF = math.radians(geo.oxidizer.impingement_angle), math.radians(geo.fuel.impingement_angle)
    pO, pF = r["mdot_O"] * vO, r["mdot_F"] * vF
    beta = math.degrees(math.atan2(pO * math.sin(thO) - pF * math.sin(thF), pO * math.cos(thO) + pF * math.cos(thF)))
    # Its limit is the reach-based wall allowance design_audit.py gates on, not a fixed number.
    info("resultant spray angle", f"{beta:.2f} deg", "see design_audit", "Sutton eq 8-7 (momentum resultant)")
    bound("included angle", geo.oxidizer.impingement_angle + geo.fuel.impingement_angle, 60.0, 100.0,
          "Sutton 8.3 / Huzel 4.2 practice", "deg")
    if d.get("L_imp"):
        bound("free-jet length / d_O", d["L_imp"] / geo.oxidizer.d_jet, 2.0, 7.0, "jet coherence before impact")

    # ---- chamber
    ch = r["chamber_intrinsics"]
    rho_c = Pc / (r["R"] * r["Tc"])
    compare("stay time = L* At rho_c / mdot", ch["residence_time"], ch["Lstar"] * At * rho_c / mdot, 0.02, "Sutton 8-9", "s")
    Dt = math.sqrt(4 * At / math.pi)
    CR = (cg.chamber_diameter / Dt) ** 2
    bound("contraction ratio", CR, 3.0, 15.0, "Huzel & Huang 4.3 practice")
    bound("chamber Mach", ch["mach_number_chamber"], None, 0.3, "Rayleigh loss small below ~0.3")

    out = {"rows": rows, "flags": flags,
           "summary": {"Pc_psia": Pc / PSI, "OF": MR, "F": F, "Isp": r["Isp"], "Pa": Pa}}
    if cea is None:
        out["note"] = NO_ROCKETCEA
    return out

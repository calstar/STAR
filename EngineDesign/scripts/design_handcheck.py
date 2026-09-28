"""Re-derive a design's headline numbers by hand and set them beside the model's.

    python3 scripts/design_handcheck.py configs/ethalox_6500N.yaml [--pamb 94070]

Nothing here calls the engine's physics: thermochemistry comes from NASA CEA through rocketcea,
everything else from the textbook relation named on its row. The model's answer is the one
``PintleEngineRunner.evaluate`` gives at the config's own tank pressures. A row is flagged when the
two disagree by more than its tolerance, or when a design-practice bound is not met.

Exits non-zero on any flag.
"""
from __future__ import annotations

import argparse
import copy
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

PSI = 6894.757
G0 = 9.80665

rows: list[tuple[str, str, str, str, str]] = []
flags: list[str] = []


def compare(name, model, hand, tol, source, unit=""):
    rel = abs(model - hand) / max(abs(hand), 1e-300)
    ok = rel <= tol
    rows.append((name, f"{model:.5g} {unit}".strip(), f"{hand:.5g} {unit}".strip(), f"{rel:.2%}", source))
    if not ok:
        flags.append(f"{name}: model {model:.5g} vs hand {hand:.5g} ({rel:.2%} > {tol:.2%})")


def bound(name, value, lo, hi, source, unit=""):
    ok = (lo is None or value >= lo) and (hi is None or value <= hi)
    band = f"{'' if lo is None else f'{lo:g}'}..{'' if hi is None else f'{hi:g}'}"
    rows.append((name, f"{value:.4g} {unit}".strip(), band, "ok" if ok else "OUT", source))
    if not ok:
        flags.append(f"{name} = {value:.4g} outside {band}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--pamb", type=float, default=None, help="ambient pressure [Pa]; default: the config's")
    a = ap.parse_args()

    from rocketcea.cea_obj import CEA_Obj
    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner

    cfg = load_config(a.config)
    PO = cfg.lox_tank.initial_pressure_psi * PSI
    PF = cfg.fuel_tank.initial_pressure_psi * PSI
    kw = {} if a.pamb is None else {"P_ambient": a.pamb}
    r = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(PO, PF, silent=True, **kw)
    d = r["diagnostics"]
    cg = cfg.chamber_geometry
    fl = cfg.fluids
    geo = cfg.injector.geometry

    Pc, Pc_ns, MR = r["Pc"], d.get("Pc_ns", r["Pc"]), r["MR"]
    At, eps, Pa = r["A_throat"], r["eps"], r["P_ambient"]
    mdot, F = r["mdot_total"], r["F"]

    # ---- thermochemistry: CEA (infinite-area combustor, equilibrium)
    cea = CEA_Obj(oxName=cfg.combustion.cea.ox_name if hasattr(cfg.combustion, "cea") else "LOX",
                  fuelName=cfg.combustion.cea.fuel_name if hasattr(cfg.combustion, "cea") else "Ethanol")
    pc_psia = Pc / PSI
    cstar_cea = cea.get_Cstar(pc_psia, MR) * 0.3048
    Tc_cea = cea.get_Tcomb(pc_psia, MR) / 1.8
    _, g_ch = cea.get_Chamber_MolWt_gamma(pc_psia, MR, eps)
    Isp_vac_cea = cea.get_Isp(pc_psia, MR, eps)
    compare("c* ideal", r["cstar_ideal"], cstar_cea, 0.005, "CEA (rocketcea)", "m/s")
    compare("Tc ideal", d.get("Tc_ideal", r["Tc"]), Tc_cea, 0.005, "CEA", "K")
    compare("gamma chamber", r["gamma"], g_ch, 0.01, "CEA")

    # ---- mass balance: c* = p1 At / mdot (Sutton eq 3-32), at the nozzle stagnation pressure
    compare("mdot = Pc_ns At / c*", mdot, Pc_ns * At / r["cstar_actual"], 0.003, "Sutton 3-32", "kg/s")
    compare("eta c*", r["eta_cstar"], r["cstar_actual"] / cstar_cea, 0.005, "c*_act / c*_CEA")

    # ---- thrust coefficient: F = Cf p1 At; Cf = zeta_n Cf_vac - pa eps / p1
    Cf_vac_cea = Isp_vac_cea * G0 / cstar_cea
    zeta = cg.nozzle_efficiency
    Cf_hand = zeta * Cf_vac_cea - Pa * eps / Pc_ns
    compare("Cf (zeta_n on vacuum Cf)", r["Cf"], Cf_hand, 0.01, f"Sutton 3-30, CEA Cf_vac, zeta_n={zeta}")
    compare("F = Cf Pc_ns At", F, r["Cf"] * Pc_ns * At, 0.002, "Sutton 3-31", "N")
    compare("Isp = F / (mdot g0)", r["Isp"], F / (mdot * G0), 0.002, "definition", "s")
    # exit state: CEA shifting equilibrium at this area ratio
    pe_cea = Pc / cea.get_PcOvPe(pc_psia, MR, eps)
    compare("exit pressure", r["P_exit"], pe_cea, 0.02, "CEA Pc/Pe at eps", "Pa")
    bound("pe / pa (Summerfield > 0.4)", r["P_exit"] / Pa, 0.4, None, "Sutton 3.3 flow separation")

    # ---- injector: mdot = Cd A sqrt(2 rho dP) per stream (Sutton eq 8-1)
    for s, key, rho in (("O", "oxidizer", fl["oxidizer"].density), ("F", "fuel", fl["fuel"].density)):
        el = getattr(geo, key)
        A = el.n_elements * math.pi * el.d_jet ** 2 / 4.0
        dp = d[f"delta_p_injector_{s}"]
        m_hand = d[f"Cd_{s}"] * A * math.sqrt(2.0 * rho * dp)
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
    rows.append(("resultant spray angle", f"{beta:.2f} deg", "see design_audit", "info",
                 "Sutton eq 8-7 (momentum resultant)"))
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

    # ---- report
    w = [max(len(x[i]) for x in rows + [("quantity", "model", "hand/bound", "diff", "source")]) for i in range(5)]
    hdr = ("quantity", "model", "hand/bound", "diff", "source")
    print("  ".join(h.ljust(w[i]) for i, h in enumerate(hdr)))
    for row in rows:
        print("  ".join(c.ljust(w[i]) for i, c in enumerate(row)))
    print()
    print(f"{a.config}: Pc {Pc/PSI:.1f} psia, O/F {MR:.3f}, F {F:.0f} N, Isp {r['Isp']:.1f} s at pa {Pa/1000:.1f} kPa")
    if flags:
        print("FLAGS:")
        for f in flags:
            print("  " + f)
        sys.exit(1)
    print("no flags")


if __name__ == "__main__":
    main()

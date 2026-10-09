"""Does a design survive the things the model is NOT sure about?

    python3 scripts/design_robustness.py configs/<design>.yaml

A converged run tells you the design is self-consistent. It tells you nothing about how
much of the answer rests on a number nobody measured. This sweeps the three that carry
real uncertainty and re-solves the design AS WRITTEN at each point.

Read the "Cd got" column. ``inlet_geometry`` resolves Cd inside
``cd_inf_from_orifice_diameter`` and overrides ``Cd_inf``, so a sweep that only sets
``Cd_inf`` silently does nothing -- measured, 0.72 / 0.76 / 0.80 all returned exactly the
same thrust until this script cleared ``inlet_geometry`` too. Any sweep of this model must
report the value it actually achieved, not the one it asked for.

Three knobs carry real uncertainty, and none of them is settled by a converged run:
  eta_c*  -- 0.95 here vs a 0.87 published comparable for this propellant/class
  Cd      -- 0.80 is an inlet-geometry correlation, not a flow test
  Pc      -- the throat grows as the graphite recesses
Each is swept INDEPENDENTLY through its plausible range and the design re-solved as written.
"""
import sys, copy, math, json
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parents[1]))
import yaml
from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner

def solve(cfg):
    run = PintleEngineRunner(copy.deepcopy(cfg))
    res = run.evaluate(cfg.lox_tank.initial_pressure_psi*6894.757,
                       cfg.fuel_tank.initial_pressure_psi*6894.757, silent=True)
    return float(res.get('Pc', float('nan'))), res

def main():
    path = sys.argv[1]
    base = load_config(path)
    pc0, r0 = solve(base)
    F0 = r0.get('F') or 0.0
    print(f"BASE  Pc {pc0/6894.757:7.2f} psia   F {F0:8.1f} N   O/F {r0['MR']:.4f}   "
          f"eta_c* {r0['eta_cstar']:.4f}   Isp {r0.get('Isp',float('nan')):.2f}")
    print()
    print("--- Cd swept (flow test not yet done; 0.80 is a correlation) ---")
    print(f"{'Cd set':>7s}{'Cd got':>8s}{'Pc psia':>10s}{'thrust N':>11s}{'d(F)':>9s}{'O/F':>9s}{'dP/Pc O':>9s}{'dP/Pc F':>9s}")
    for cd in (0.72, 0.76, 0.80, 0.84, 0.88):
        c = copy.deepcopy(base)
        PO = c.lox_tank.initial_pressure_psi*6894.757
        PF = c.fuel_tank.initial_pressure_psi*6894.757
        for side in ('fuel','oxidizer'):
            d = c.discharge[side]
            # inlet_geometry resolves Cd inside cd_inf_from_orifice_diameter and WINS over
            # Cd_inf, so it has to be cleared or the sweep silently does nothing. (Measured:
            # 0.72/0.76/0.80 all returned the same thrust until this line existed.)
            d.inlet_geometry = None
            d.inlet_radius_ratio = None
            d.use_geometry_cd = False
            d.Cd_inf = cd; d.Cd_min = cd; d.a_Re = 0.0; d.cd_inf_max = cd; d.cd_inf_min_geom = cd
        try:
            pc, r = solve(c)
            dpo = (PO - pc)/pc if pc else float('nan'); dpf = (PF - pc)/pc if pc else float('nan')
            got = r.get('Cd_O', float('nan'))
            flag = "" if abs(got-cd) < 5e-3 else "   <-- CLAMPED, sweep not honoured"
            print(f"{cd:7.2f}{got:8.3f}{pc/6894.757:10.2f}{r.get('F',0):11.1f}"
                  f"{100*((r.get('F',0)-F0)/F0):+8.1f}%{r['MR']:9.4f}{dpo:9.3f}{dpf:9.3f}{flag}")
        except Exception as e:
            print(f"{cd:6.2f}   FAILED: {type(e).__name__}: {str(e)[:60]}")
    print()
    print("--- eta_c* haircut (0.95 modelled vs 0.87 published comparable) ---")
    print(f"{'scale':>7s}{'eta_c*':>9s}{'Pc psia':>10s}{'thrust N':>11s}{'d(F)':>9s}{'Isp':>9s}")
    for k in (1.00, 0.97, 0.94, 0.92):
        c = copy.deepcopy(base)
        e = c.combustion.efficiency
        e.Em_peak = float(e.Em_peak) * k
        try:
            pc, r = solve(c)
            print(f"{k:7.2f}{r['eta_cstar']:9.4f}{pc/6894.757:10.2f}{r.get('F',0):11.1f}"
                  f"{100*((r.get('F',0)-F0)/F0):+8.1f}%{r.get('Isp',float('nan')):9.2f}")
        except Exception as ex:
            print(f"{k:7.2f}   FAILED: {type(ex).__name__}: {str(ex)[:60]}")
    print()
    print("--- throat growth from graphite recession (mid-burn) ---")
    print(f"{'dA/A':>7s}{'D_t mm':>9s}{'Pc psia':>10s}{'thrust N':>11s}{'d(F)':>9s}")
    A0 = base.chamber_geometry.A_throat
    for g in (0.0, 0.02, 0.05, 0.09):
        c = copy.deepcopy(base)
        # The throat erodes; the exit plane does not move. eps therefore FALLS.
        c.chamber_geometry.A_throat = A0*(1+g)
        c.chamber_geometry.expansion_ratio = c.chamber_geometry.A_exit/(A0*(1+g))
        c.combustion.cea.expansion_ratio = c.chamber_geometry.expansion_ratio
        try:
            pc, r = solve(c)
            print(f"{g:6.0%}{math.sqrt(4*A0*(1+g)/math.pi)*1000:9.2f}{pc/6894.757:10.2f}"
                  f"{r.get('F',0):11.1f}{100*((r.get('F',0)-F0)/F0):+8.1f}%")
        except Exception as ex:
            print(f"{g:6.0%}   FAILED: {type(ex).__name__}: {str(ex)[:60]}")

if __name__ == '__main__':
    main()

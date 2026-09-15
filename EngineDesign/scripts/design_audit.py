"""Audit a design against EVERY limit its own config declares, with NO gate slack forgiven.

    python3 scripts/design_audit.py configs/ethalox_8kN_SHIP.yaml [more.yaml ...]

Layer 1's own gates carry tolerances -- the spray-tilt gate forgives
``layer1_resultant_tilt_gate_tol_deg`` (shipped default 1.0 deg) and the O/F gate forgives
15 %. Those exist so a search sitting on a boundary is not thrown away, and they are
reasonable there. They are NOT reasonable in a sign-off: measured, three candidates reported
ALL GATES PASS while exceeding their own declared tilt allowance, because 1.0 deg of slack is
most of the margin the allowance exists to create. This re-checks every limit at face value.

Exits non-zero if any design fails, so it can gate a commit.
"""
import sys, copy, math, yaml
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parents[1]))
from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner
from engine.optimizer.layers.layer1_static_optimization import (
    _impinging_resultant_tilt_deg, _resultant_tilt_breakeven_deg,
    _resolve_tilt_allowance_deg, _impinging_face_infeasibility_terms)

def audit(f):
    c = load_config(f); Y = yaml.safe_load(open(f))
    g = Y['injector']['geometry']; cg = Y['chamber_geometry']; rq = Y['design_requirements']
    run = PintleEngineRunner(copy.deepcopy(c))
    r = run.evaluate(c.lox_tank.initial_pressure_psi*6894.757,
                     c.fuel_tank.initial_pressure_psi*6894.757, silent=True)
    O, F = g['oxidizer'], g['fuel']; n = int(O['n_elements'])
    bore = cg['chamber_diameter']; Lch = cg['length_cylindrical']+cg['length_contraction']
    tilt = _impinging_resultant_tilt_deg(r['mdot_O'], r['mdot_F'], 1140.0, 789.0, n,
        O['d_jet'], F['d_jet'], O['impingement_angle'], F['impingement_angle'])
    be = _resultant_tilt_breakeven_deg(n_elements=n, spacing_O_m=O['spacing'],
        spacing_F_m=F['spacing'], angle_O_deg=O['impingement_angle'],
        angle_F_deg=F['impingement_angle'], D_chamber_inner_m=bore, L_chamber_m=Lch)
    allow = _resolve_tilt_allowance_deg(from_reach=True, constant_deg=0.0,
        breakeven_deg=be, margin=float(rq.get('layer1_resultant_tilt_reach_margin') or 1.5))
    face = _impinging_face_infeasibility_terms(n_elements=float(n),
        spacing_O_m=O['spacing'], spacing_F_m=F['spacing'], d_jet_O_m=O['d_jet'],
        d_jet_F_m=F['d_jet'], D_chamber_inner_m=bore,
        angle_O_deg=O['impingement_angle'], angle_F_deg=F['impingement_angle'],
        center_clear_dia_m=rq.get('layer1_injector_center_clear_dia_m') or 0.0,
        min_web_m=rq.get('layer1_injector_min_web_m') or 0.0,
        wall_clearance_m=rq.get('layer1_injector_wall_clearance_m') or 0.0,
        spray_radius_frac=rq.get('layer1_injector_spray_radius_frac') or 0.0,
        spray_radius_tol=rq.get('layer1_injector_spray_radius_tol') or 0.08)
    PO = c.lox_tank.initial_pressure_psi*6894.757; PF = c.fuel_tank.initial_pressure_psi*6894.757
    dpo, dpf = (PO-r['Pc'])/r['Pc'], (PF-r['Pc'])/r['Pc']
    checks = [
        ("thrust 8000 +/-2%",  abs(r['F']-8000)/8000 <= 0.02,  f"{r['F']:.1f} N"),
        ("O/F 1.65 +/-5%",     abs(r['MR']-1.65)/1.65 <= 0.05, f"{r['MR']:.4f}"),
        ("dP/Pc O in band",    0.20 <= dpo <= 0.40,            f"{dpo:.3f}"),
        ("dP/Pc F in band",    0.20 <= dpf <= 0.40,            f"{dpf:.3f}"),
        ("n <= 30",            n <= 30,                        f"{n}"),
        ("included <= 90",     O['impingement_angle']+F['impingement_angle'] <= 90.0,
                                f"{O['impingement_angle']+F['impingement_angle']:.0f} deg"),
        ("jet >= 40 deg",      min(O['impingement_angle'],F['impingement_angle']) >= 40.0,
                                f"{O['impingement_angle']:.0f}/{F['impingement_angle']:.0f}"),
        ("incidence >= 40 deg",90-max(O['impingement_angle'],F['impingement_angle']) >= 40.0,
                                f"{90-max(O['impingement_angle'],F['impingement_angle']):.0f} deg"),
        ("face limits all met", face <= 1e-12,                 f"{face:.2e}"),
        ("tilt <= allowed (NO slack)", tilt <= allow,          f"{tilt:+.3f} vs {allow:.3f}"),
    ]
    bad = [c for c in checks if not c[1]]
    print(f"{f.split('/')[-1]:34s} n={n:2d} Isp {r['Isp']:.2f} O/F {r['MR']:.4f}  "
          f"{'CLEAN' if not bad else 'FAILS: ' + ', '.join(c[0] for c in bad)}")
    for name, ok, val in checks:
        if not ok: print(f"      {name:30s} {val}")
    return not bad


if __name__ == '__main__':
    ok = all([audit(f) for f in sys.argv[1:]])
    sys.exit(0 if ok else 1)

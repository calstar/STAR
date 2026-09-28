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
from engine.core.injectors.layout import impingement_ld_band, layout_from_config
from engine.optimizer.layers.layer1_static_optimization import (
    _impinging_resultant_tilt_deg, _resultant_tilt_breakeven_deg,
    _resolve_tilt_allowance_deg, _impinging_face_infeasibility_terms,
    _layer1_centre_clear_m, _layer1_plate, _layer1_declared_limit_gates,
    _layer1_momentum_gate,
    _LAYER1_DEFAULT_DP_O_BAND, _LAYER1_DEFAULT_DP_F_BAND)
from engine.core.injectors.layout import EXIT_LAND_DEFAULT


def _opt(rq, key, default=None):
    """A requirement as a float, or ``default`` when the config leaves it unset."""
    v = rq.get(key)
    return default if v is None else float(v)


def _flag(rq, key, default):
    v = rq.get(key)
    if v is None:
        return default
    if isinstance(v, str):
        return v.strip().lower() in ("true", "1", "yes", "on")
    return bool(v)


def audit(f):
    """Every limit is the one THIS config declares (Layer 1's default where it declares none).

    An earlier version hardcoded the SHIP numbers -- densities 1140/789, dP/Pc 0.20-0.40,
    n <= 30, 90 deg, 40 deg -- so it audited every other design against SHIP's requirements.
    A limit the config does not declare and Layer 1 has no default for is skipped and said so.
    """
    c = load_config(f); Y = yaml.safe_load(open(f))
    g = Y['injector']['geometry']; cg = Y['chamber_geometry']; rq = Y.get('design_requirements') or {}
    run = PintleEngineRunner(copy.deepcopy(c))
    PO = c.lox_tank.initial_pressure_psi*6894.757; PF = c.fuel_tank.initial_pressure_psi*6894.757
    r = run.evaluate(PO, PF, silent=True)
    O, F = g['oxidizer'], g['fuel']; n = int(O['n_elements'])
    thO, thF = float(O['impingement_angle']), float(F['impingement_angle'])
    bore = cg['chamber_diameter']; Lch = cg['length_cylindrical']+cg['length_contraction']
    rho_O = float(c.fluids['oxidizer'].density); rho_F = float(c.fluids['fuel'].density)
    tilt = _impinging_resultant_tilt_deg(r['mdot_O'], r['mdot_F'], rho_O, rho_F, n,
        O['d_jet'], F['d_jet'], thO, thF)
    be = _resultant_tilt_breakeven_deg(n_elements=n, spacing_O_m=O['spacing'],
        spacing_F_m=F['spacing'], angle_O_deg=thO,
        angle_F_deg=thF, D_chamber_inner_m=bore, L_chamber_m=Lch)
    allow = _resolve_tilt_allowance_deg(
        from_reach=_flag(rq, 'layer1_resultant_tilt_from_reach', False),
        constant_deg=_opt(rq, 'layer1_resultant_tilt_max_deg', 0.0),
        breakeven_deg=be, margin=_opt(rq, 'layer1_resultant_tilt_reach_margin', 1.5))
    plate = _layer1_plate(c)
    contoured = plate.get('face') == 'contoured'
    # A contoured face has every exit square to its flank: no drill-incidence limit applies.
    inc_min = 0.0 if contoured else _opt(rq, 'layer1_injector_min_face_incidence_deg', 0.0)
    face = _impinging_face_infeasibility_terms(n_elements=float(n),
        spacing_O_m=O['spacing'], spacing_F_m=F['spacing'], d_jet_O_m=O['d_jet'],
        d_jet_F_m=F['d_jet'], D_chamber_inner_m=bore,
        angle_O_deg=thO, angle_F_deg=thF,
        center_clear_dia_m=_layer1_centre_clear_m(c, rq),
        min_web_m=_opt(rq, 'layer1_injector_min_web_m', 0.0),
        wall_clearance_m=_opt(rq, 'layer1_injector_wall_clearance_m', 0.0),
        spray_radius_frac=_opt(rq, 'layer1_injector_spray_radius_frac', 0.0),
        spray_radius_tol=_opt(rq, 'layer1_injector_spray_radius_tol', 0.08),
        min_face_incidence_deg=inc_min, face_contoured=contoured,
        exit_land=plate.get('exit_land') if plate.get('exit_land') is not None else EXIT_LAND_DEFAULT)
    # The band is injector dP / Pc (schema: injector_dp_ratio_*), across the orifices. Tank minus
    # Pc also carries the feed line and the manifold dump loss.
    _d = r['diagnostics']
    dpo, dpf = _d['delta_p_injector_O']/r['Pc'], _d['delta_p_injector_F']/r['Pc']
    dpo_lo = _opt(rq, 'injector_dp_ratio_O_min', _LAYER1_DEFAULT_DP_O_BAND[0])
    dpo_hi = _opt(rq, 'injector_dp_ratio_O_max', _LAYER1_DEFAULT_DP_O_BAND[1])
    dpf_lo = _opt(rq, 'injector_dp_ratio_F_min', _LAYER1_DEFAULT_DP_F_BAND[0])
    dpf_hi = _opt(rq, 'injector_dp_ratio_F_max', _LAYER1_DEFAULT_DP_F_BAND[1])
    # Targets come from the config being audited, not from whatever design happened to be
    # current when this script was written. Hardcoding 8000 N here made every 6405 N
    # candidate report FAILS: thrust, which is the tool being stale, not the design.
    F_tgt = float(rq.get('target_thrust') or 0.0)
    OF_tgt = float(rq.get('optimal_of_ratio') or 0.0)
    band = impingement_ld_band(rq)
    tan_sum = math.tan(math.radians(thO)) + math.tan(math.radians(thF))
    L_imp = 0.5 * abs(n*O['spacing'] - n*F['spacing']) / math.pi / tan_sum
    ld = L_imp / (0.5*(O['d_jet'] + F['d_jet']))
    ld_eps = 1e-6 * max(1.0, band.hi)   # arithmetic noise only -- this is a no-slack audit
    lay = layout_from_config(Y)
    back_web_req = _opt(rq, 'layer1_injector_min_back_web_m')
    channels = lay['back']['mode'] == 'channels'
    back_web = min(lay['passages']['O']['back_web'], lay['passages']['F']['back_web'])
    # With channels the propellants are separated by the land between the channels; with a
    # plenum back, by the land between the two rings' entries.
    o_f_land = lay['back']['lands']['between'] if channels else lay['back']['o_f_land']
    if channels:
        back_web_req = None      # the passages open into a channel, not onto a web
    n_max = _opt(rq, 'layer1_impinging_n_doublets_max')
    inc_lo = _opt(rq, 'layer1_impinging_angle_deg_min')
    inc_hi = _opt(rq, 'layer1_impinging_angle_deg_max')
    jet_lo = _opt(rq, 'layer1_impinging_jet_angle_min_deg')
    SKIP = None
    # Layer 1's own sign-off gates (element pitch, L_cyl/D, face-to-exit length, SP-8089 free
    # jet), the same function validation uses, at face value.
    gates = _layer1_declared_limit_gates(c, rq, {})
    R = float((r.get('diagnostics') or {}).get('momentum_ratio_R', float('nan')))
    r_lo, r_hi = _opt(rq, 'impinging_momentum_R_min'), _opt(rq, 'impinging_momentum_R_max')
    checks = [
        (f"thrust {F_tgt:.0f} +/-2%",
         F_tgt > 0 and abs(r['F']-F_tgt)/F_tgt <= 0.02,
         f"{r['F']:.1f} N" + ("" if F_tgt > 0 else "  (no target_thrust in config)")),
        (f"O/F {OF_tgt:.3f} +/-5%",
         OF_tgt > 0 and abs(r['MR']-OF_tgt)/OF_tgt <= 0.05,
         f"{r['MR']:.4f}" + ("" if OF_tgt > 0 else "  (no optimal_of_ratio in config)")),
        (f"dP/Pc O in [{dpo_lo:g},{dpo_hi:g}]", dpo_lo <= dpo <= dpo_hi, f"{dpo:.3f}"),
        (f"dP/Pc F in [{dpf_lo:g},{dpf_hi:g}]", dpf_lo <= dpf <= dpf_hi, f"{dpf:.3f}"),
        (f"n <= {n_max:g}" if n_max else "n <= (unset)",
         SKIP if n_max is None else n <= n_max, f"{n}"),
        (f"included in [{inc_lo or 0:g},{inc_hi or 180:g}]",
         SKIP if inc_lo is None and inc_hi is None
         else (inc_lo or 0.0) <= thO + thF <= (inc_hi or 180.0), f"{thO+thF:.1f} deg"),
        (f"jet >= {jet_lo:g} deg" if jet_lo else "jet >= (unset)",
         SKIP if jet_lo is None else min(thO, thF) >= jet_lo, f"{thO:.1f}/{thF:.1f}"),
        (f"incidence >= {inc_min:g} deg" if not contoured else "incidence (contoured face: square exits)",
         SKIP if not inc_min else 90 - max(thO, thF) >= inc_min, f"{90-max(thO, thF):.1f} deg"),
        (f"standoff L/d in [{band.lo:g},{band.hi:g}]",
         band.lo - ld_eps <= ld <= band.hi + ld_eps, f"{ld:.4f}"),
        ("face limits all met", face <= 1e-12,                 f"{face:.2e}"),
        (f"back-face web >= {back_web_req * 1000:g} mm" if back_web_req else "back-face web >= (unset)",
         SKIP if not back_web_req else back_web >= back_web_req, f"{back_web * 1000:.2f} mm"),
        ("LOX/fuel entries separate", o_f_land >= 0.0,         f"{o_f_land * 1000:.2f} mm land"),
        ("tilt <= allowed (NO slack)", tilt <= allow,          f"{tilt:+.3f} vs {allow:.3f}"),
        (f"momentum R in [{r_lo:g},{r_hi:g}]" if r_lo is not None and r_hi is not None
         else "momentum R band (unset)",
         SKIP if r_lo is None or r_hi is None else _layer1_momentum_gate(R, r_lo, r_hi)[0],
         f"{R:.4f}"),
        *[(f"L1 gate: {k}", ok, msg) for k, (ok, msg) in gates.items()
          if k in ("element_pitch", "lcyl_over_d", "engine_length", "free_jet")],
        ("layout: nothing impossible",
         not [w for w in lay['warnings'] if w['level'] == 'bad'],
         "; ".join(w['code'] for w in lay['warnings'] if w['level'] == 'bad') or "none"),
    ]
    bad = [c for c in checks if c[1] is False]
    skipped = [c[0] for c in checks if c[1] is None]
    print(f"{f.split('/')[-1]:34s} n={n:2d} Isp {r['Isp']:.2f} O/F {r['MR']:.4f}  "
          f"{'CLEAN' if not bad else 'FAILS: ' + ', '.join(c[0] for c in bad)}")
    for name, ok, val in checks:
        if ok is False: print(f"      {name:30s} {val}")
    if skipped:
        print(f"      not declared, not checked: {', '.join(skipped)}")
    # The drawing's own findings, so a sign-off sees what the Geometry tab would show.
    for w in lay['warnings']:
        print(f"      drawing {w['level']:4s}: {w['text']}")
    return not bad


if __name__ == '__main__':
    ok = all([audit(f) for f in sys.argv[1:]])
    sys.exit(0 if ok else 1)

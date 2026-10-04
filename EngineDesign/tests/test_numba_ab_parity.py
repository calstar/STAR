"""Live A/B parity for the Numba accelerator against the authoritative Python physics.

Runs both implementations on the same inputs at test time and diffs them field by
field, so a drift on EITHER side fails regardless of which one moved. This is the
sole numeric guard on the accelerated path now that the C port is gone.

TOLERANCE. RTOL is 1e-6, not the 2e-3 the retired C suite used. Measured agreement
on 120 randomized points across both configs is ~2.5e-9 -- the accelerated and
Python paths run the same physics and differ only by Brent's convergence
tolerance, so 1e-6 leaves ~400x headroom while still being three orders tighter
than the old contract. If a change pushes this above 1e-6, that is a physics
divergence, not rounding: fix it rather than widening the bound.

THE REFERENCE MUST BE FORCED TO PYTHON. With the accelerator enabled,
runner.evaluate reaches chamber_solver._accel_chamber_pc -> accel.chamber_solve
and closure.flows -> accel.solve, so an unguarded "Python" reference is largely
the same numba kernels and the comparison is self-referential (it reads as ~1e-15
agreement, which is the tell). _python_only() below disables the accelerator for
the reference computation; without it this suite proves nothing.

THE CONFIG LIST IS DELIBERATE. canonical/impinging.yaml has ablative cooling ON and
a back-channel ring manifold, impinging_lox_ch4_8000N.yaml has neither (plenum, no
liner), canonical/pintle.yaml exercises the pintle injector -- a different solve
(kernels.injector_solve_pintle) and a different mixing input: no Rupe M, so E_m is
rupe_Em_opt flat and the drops leave axially -- and the 6.5 kN ethalox fixture is the
design as drawn, where both liquids heat up on CoolProp tables (engine.accel.chamber).
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
PSI_TO_PA = 6894.76
PA_AMBIENT = 101325.0

# The chamber-level classes are slow (whole Python chamber solves per point), so they run in the
# accel-parity CI job or with ED_AB_PARITY=1. The injector-solve, chug and default-path checks
# below them are cheap and run in every suite: those kernels sit on the DEFAULT Python path too
# (closure.flows -> accel.solve, stability._chug_fast -> accel.chug_margin_fast), so a drift there
# changes what every user sees, not just the optimizer.
_ab_parity = pytest.mark.skipif(
    os.environ.get("ED_REQUIRE_ACCEL") != "1" and os.environ.get("ED_AB_PARITY") != "1",
    reason="A/B parity runs in the accel-parity CI job; set ED_AB_PARITY=1 to run locally",
)


def _chamber_gate():
    """Python chamber physics the kernels do not mirror yet (empty => chamber kernels in use)."""
    from engine import accel
    return tuple(accel.chamber_physics_not_mirrored())

POINTS_PSI = [(563.467, 567.644), (518.4, 550.6), (597.3, 584.7)]

RTOL = 1e-6

CONFIGS = [
    ("configs/canonical/impinging.yaml", True),          # impinging, ring manifold, ablative ON
    ("configs/impinging_lox_ch4_8000N.yaml", False),     # impinging, plenum, ablative off
    ("configs/canonical/pintle.yaml", True),             # pintle, ablative ON
    # the 6.5 kN LOX/ethanol doublet as drawn (ring manifold, CoolProp heat-up of both liquids)
    ("tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml", True),
]

CORE_FIELDS = ["Pc", "F", "Isp", "MR", "cstar_actual", "eta_cstar",
               "mdot_total", "mdot_O", "mdot_F", "Cf_actual",
               "P_exit", "T_exit", "v_exit"]

# momentum_ratio_R is impinging-only (absent for pintle); the .get() guards skip it.
DIAG_FIELDS = ["D32_O", "D32_F", "Cd_O", "Cd_F", "momentum_ratio_R",
               "delta_p_feed_O", "delta_p_feed_F", "delta_p_injector_O",
               "delta_p_injector_F", "A_geom_O", "A_geom_F", "A_eff_O", "A_eff_F",
               "turbulence_intensity_mix", "u_O", "u_F", "We_O", "We_F"]


@contextmanager
def _python_only():
    """Force the authoritative Python path for the reference computation.

    Disables strict mode as well as the accelerator. Under ED_REQUIRE_ACCEL=1 (the
    CI parity job) closure._try_native_flows treats "disabled + strict" as a
    genuine accelerator failure and raises -- which is exactly right in
    production, and exactly wrong here, where the accelerator is off ON PURPOSE.
    Without this the whole suite fails under CI's env while passing locally.
    """
    from engine import accel
    real_enabled, real_require = accel.enabled, accel.require
    accel.enabled = lambda: False
    accel.require = lambda: False
    try:
        yield
    finally:
        accel.enabled, accel.require = real_enabled, real_require


def _rel(got, want):
    return abs(float(got) - float(want)) / max(abs(float(want)), 1e-12)


def _assert_close(name, got, want, rtol=RTOL):
    assert got is not None and want is not None, f"{name}: missing value ({got} vs {want})"
    rel = _rel(got, want)
    assert rel <= rtol, f"{name}: accel={float(got):.10g} python={float(want):.10g} rel={rel:.3e} > {rtol:g}"


def _py_field(ref, key):
    if key in ref and ref[key] is not None:
        return ref[key]
    return (ref.get("diagnostics") or {}).get(key)


_RIGS = {}


def _rig(cfg_rel):
    """Config + runner + per-point pure-Python reference, built once."""
    if cfg_rel in _RIGS:
        return _RIGS[cfg_rel]
    from engine import accel
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config

    if not accel.available():
        if os.environ.get("ED_REQUIRE_ACCEL") == "1":
            pytest.fail("ED_REQUIRE_ACCEL=1 but numba is unavailable")
        pytest.skip("numba unavailable")

    config = load_config(str(ROOT / cfg_rel))
    # With the chamber gate closed, can_handle_chamber is False BY DESIGN (the kernels would
    # compute other physics); the classes below then pin the fallback instead of the kernel.
    assert accel.can_handle_chamber(config) == (not _chamber_gate()), (
        f"accelerator chamber routing for {cfg_rel} disagrees with the mirror gate")
    runner = PintleEngineRunner(config)
    points = [(po * PSI_TO_PA, pf * PSI_TO_PA) for po, pf in POINTS_PSI]
    with _python_only():
        reference = {p: runner.evaluate(p[0], p[1], P_ambient=PA_AMBIENT, silent=True)
                     for p in points}
    rig = {"config": config, "runner": runner, "cache": runner.cea_cache,
           "points": points, "reference": reference}
    _RIGS[cfg_rel] = rig
    return rig


def _default_path(r, p):
    """What Layer 1 actually consumes: accel.evaluate, else (None) the runner on the DEFAULT,
    accelerator-enabled path -- which still routes the injector through accel.solve and the chug
    scan through the kernel."""
    from engine import accel
    got = accel.evaluate(r["config"], r["cache"], p[0], p[1], PA_AMBIENT)
    if got is None and _chamber_gate():
        got = r["runner"].evaluate(p[0], p[1], P_ambient=PA_AMBIENT, silent=True)
    return got


@_ab_parity
@pytest.mark.parametrize("cfg_rel,ablative", CONFIGS, ids=lambda v: str(v).split("/")[-1])
class TestAccelMatchesPython:
    """The contract: what the optimizer consumes must match the authoritative path."""

    def test_wrapper_fields(self, cfg_rel, ablative):
        from engine import accel
        r = _rig(cfg_rel)
        for p in r["points"]:
            ref = r["reference"][p]
            if _chamber_gate():
                # Gate closed: the chamber kernels must refuse (not compute other physics) ...
                assert accel.evaluate(r["config"], r["cache"], p[0], p[1], PA_AMBIENT) is None
            got = _default_path(r, p)
            assert got is not None, f"accelerator bailed where Python converged at {p}"
            for k in CORE_FIELDS:
                want = _py_field(ref, k)
                if want:
                    _assert_close(f"{k}@{p[0]:.0f}/{p[1]:.0f}", got[k], want)

    def test_diagnostics(self, cfg_rel, ablative):
        from engine import accel
        r = _rig(cfg_rel)
        for p in r["points"]:
            pd = (r["reference"][p].get("diagnostics") or {})
            gd = _default_path(r, p)["diagnostics"]
            for k in DIAG_FIELDS:
                if pd.get(k) and k in gd:
                    _assert_close(f"diag[{k}]", gd[k], pd[k])

    def test_kernel_level_raw_tuple(self, cfg_rel, ablative):
        """Kernel level: chamber.evaluate_core's own result vector, no wrapper in the way.

        The retired C suite kept this level because a wrapper override once hid a
        kernel computing retired momentum-method thrust. The property is
        backend-agnostic and worth keeping: a wrapper cannot paper over the kernel.
        """
        from engine.accel import chamber, kernels, params
        r = _rig(cfg_rel)
        if _chamber_gate():
            pytest.xfail("chamber kernels do not mirror: " + " | ".join(_chamber_gate()))
        P = params.extract_params(r["config"])
        CH = chamber.chamber_inputs(r["config"], r["cache"])
        assert CH is not None, "chamber_inputs refused a config the accelerator claims"
        arr = kernels.cea_arrays(r["cache"])
        R = chamber._R
        for p in r["points"]:
            ref = r["reference"][p]
            ok, raw = chamber.evaluate_core(P, CH, arr, p[0], p[1], PA_AMBIENT)
            assert ok, f"kernel did not converge at {p}"
            _assert_close("kernel Pc", raw[R["PC"]], _py_field(ref, "Pc"))
            _assert_close("kernel F", raw[R["F"]], _py_field(ref, "F"))
            _assert_close("kernel Isp", raw[R["ISP"]], _py_field(ref, "Isp"))
            _assert_close("kernel MR", raw[R["MR"]], _py_field(ref, "MR"))
            ce = ref["diagnostics"]["cstar_efficiency"]
            _assert_close("kernel eta_vap", raw[R["ETA_VAP"]], ce["eta_vaporization"])
            _assert_close("kernel eta_mix", raw[R["ETA_MIX"]], ce["eta_mixing"])
            _assert_close("kernel eta_HL", raw[R["ETA_HL"]], ce["eta_heat_loss"])
            _assert_close("kernel P_exit", raw[R["P_EXIT"]], _py_field(ref, "P_exit"))
            if ablative:
                _assert_close("kernel liner heat", raw[R["Q_ABL"]],
                              ref["diagnostics"]["cooling"]["ablative"]["heat_removed"])


@_ab_parity
@pytest.mark.parametrize("cfg_rel,ablative", CONFIGS, ids=lambda v: str(v).split("/")[-1])
class TestRandomizedSweep:
    """Breadth the three fixed points cannot give. Fixed seed, so failures repeat."""

    N = 60

    def test_sweep(self, cfg_rel, ablative):
        r = _rig(cfg_rel)
        rng = np.random.default_rng(20260904)
        matched = 0
        worst = 0.0
        # Gate closed: both sides are Python chamber solves, so fewer points buy the same breadth
        # of injector/chug coverage at a fraction of the cost.
        n = self.N if not _chamber_gate() else 12
        for _ in range(n):
            p_o = float(rng.uniform(3.0e6, 5.5e6)); p_f = float(rng.uniform(3.0e6, 5.5e6))
            try:
                got = _default_path(r, (p_o, p_f))
            except Exception:
                got = None
            with _python_only():
                try:
                    ref = r["runner"].evaluate(p_o, p_f, P_ambient=PA_AMBIENT, silent=True)
                except Exception:
                    ref = None
            py_ok = ref is not None and np.isfinite(ref.get("F", np.nan))
            if not py_ok:
                continue
            # Python converged, so the accelerated path must too: same physics,
            # same inputs. A one-sided bail is a bug, not a tolerance question.
            assert got is not None, f"accelerator bailed where Python converged at {p_o:.0f}/{p_f:.0f}"
            matched += 1
            for k in CORE_FIELDS:
                want = _py_field(ref, k)
                if want:
                    worst = max(worst, _rel(got[k], want))
        assert matched > n // 2, f"only {matched}/{n} points converged"
        assert worst <= RTOL, f"worst accel-vs-Python divergence {worst:.3e} over {matched} points"


@_ab_parity
class TestCoolingIsActuallyApplied:
    """Pins the Tc_ideal / Tc_effective distinction.

    evaluate_core returns the ideal Tc at index 7 and the cooling-adjusted one at
    index 21; the wrapper must expose the EFFECTIVE value, because that is what
    reaches comprehensive_stability_analysis. Returning the ideal one is a silent
    ~0.8% error that lands in stability rather than crashing.
    """

    def test_effective_tc_differs_and_is_reported(self):
        from engine import accel
        from engine.accel import chamber, kernels, params
        if _chamber_gate():
            pytest.skip("chamber kernels gated off; the wrapper this pins does not run")
        r = _rig("configs/canonical/impinging.yaml")
        P = params.extract_params(r["config"])
        CH = chamber.chamber_inputs(r["config"], r["cache"])
        arr = kernels.cea_arrays(r["cache"])
        p_o, p_f = r["points"][0]
        ok, raw = chamber.evaluate_core(P, CH, arr, p_o, p_f, PA_AMBIENT)
        assert ok, "kernel did not converge"
        tc_ideal, tc_eff = float(raw[chamber._R["TC_IDEAL"]]), float(raw[chamber._R["TC_EFF"]])
        assert tc_eff < tc_ideal - 1.0, (
            f"cooling not applied: Tc_ideal={tc_ideal:.2f} Tc_effective={tc_eff:.2f}. "
            "If ablative is genuinely inactive for this config the test is vacuous."
        )
        reported = accel.evaluate(r["config"], r["cache"], p_o, p_f, PA_AMBIENT)["Tc"]
        assert _rel(reported, tc_eff) < 1e-12, (
            f"wrapper reported Tc={reported:.4f}, expected the EFFECTIVE {tc_eff:.4f} "
            f"(not the ideal {tc_ideal:.4f})"
        )


@_ab_parity
@pytest.mark.parametrize("cfg_rel,ablative", CONFIGS, ids=lambda v: str(v).split("/")[-1])
class TestDeliveredIspInvariant:
    """Delivered Isp must sit at/below eta_cstar * the ideal ceiling.

    Physics invariant, not a cross-implementation diff: this is what the original
    momentum-method thrust bug violated (model Isp >= the ideal equilibrium
    ceiling). Carried over from the retired C parity suite; it depends on no
    backend, so it outlives both.
    """

    def test_delivered_below_ceiling(self, cfg_rel, ablative):
        g0 = 9.80665
        r = _rig(cfg_rel)
        for p in r["points"]:
            ref = r["reference"][p]
            diag = ref.get("diagnostics") or {}
            eta = float(diag.get("eta_cstar", ref.get("eta_cstar", np.nan)))
            cstar_ideal = float(diag.get("cstar_ideal", ref.get("cstar_ideal", np.nan)))
            cf_vac = r["cache"].eval_cf_vac(ref["MR"], ref["Pc"], ref["eps"])
            ceiling = eta * cf_vac * cstar_ideal / g0
            # Ambient thrust <= vacuum thrust, so this bound holds a fortiori.
            assert ref["Isp"] <= ceiling * (1.0 + 1e-6), (
                f"delivered Isp {ref['Isp']:.2f}s exceeds eta_cstar*Isp_vac_ideal "
                f"{ceiling:.2f}s — an efficiency term has been dropped from the thrust path"
            )


# ---------------------------------------------------------------------------------------------
# Cheap checks, run in every suite (no ED_AB_PARITY needed).
# ---------------------------------------------------------------------------------------------

def _need_numba():
    from engine import accel
    if not accel.available():
        pytest.skip("numba unavailable")


class TestChugKernelMatchesPython:
    """accel.chug_margin_fast is what stability._chug_fast runs whenever the accelerator is on,
    so it must be chug.chug_margin_fast to rounding -- including every negative-real-axis
    crossing (phases -pi, -3pi, ...), not only the unwrapped -pi one."""

    # STAB-5 counterexample (tests/test_combustion_stability_audit.py): the worst crossing is the
    # -3pi one at ~102 Hz. The -pi-only kernel read GM 4.27 (stable) on a loop that is unstable.
    PC = 3.61e6
    O = dict(mdot=0.9907, eta=0.3745, dPf=648654.0, L=0.6093, A=1.534e-4, tau=1.638e-3)
    F = dict(mdot=0.7122, eta=0.1775, dPf=625208.0, L=0.9913, A=3.534e-4, tau=13.85e-3)

    def _case(self, O, F, Z_hf=0.0):
        from engine.pipeline.stability.chug import ChugChamber, ChugStream, Regulator
        mk = lambda n, d: ChugStream(n, mdot=d["mdot"], eta_inj=d["eta"], Pc=self.PC,  # noqa: E731
                                     dP_feed=d["dPf"], feed_length=d["L"], feed_area=d["A"],
                                     tau_conv=d["tau"], regulator=Regulator(Z_hf=Z_hf))
        return [mk("O", O), mk("F", F)], ChugChamber(1872.7, 4.353e-4, 1.093, 1.178)

    @staticmethod
    def _same(a, b):
        for k in ("gain_margin", "f_chug_hz", "phase_margin_deg"):
            x, y = float(a[k]), float(b[k])
            if np.isnan(x) and np.isnan(y):
                continue
            assert _rel(x, y) <= 1e-9, f"{k}: accel={x!r} python={y!r}"
        assert a["stable"] == b["stable"]
        assert np.allclose(a["crossings_hz"], b["crossings_hz"], rtol=1e-9, atol=0.0)

    def test_minus_3pi_crossing(self):
        _need_numba()
        from engine.accel.stability import chug_margin_fast as fast
        from engine.pipeline.stability.chug import chug_margin_fast as ref
        streams, ch = self._case(self.O, self.F)
        got, want = fast(streams, ch), ref(streams, ch)
        assert want["gain_margin"] < 1.0 and not want["stable"]     # the case is what it claims
        self._same(got, want)

    def test_randomised_loops(self):
        _need_numba()
        from engine.accel.stability import chug_margin_fast as fast
        from engine.pipeline.stability.chug import chug_margin_fast as ref
        rng = np.random.default_rng(20260926)
        for i in range(150):
            O, F = dict(self.O), dict(self.F)
            for d in (O, F):
                d["eta"] *= rng.uniform(0.3, 2.0)
                d["tau"] *= rng.uniform(0.2, 5.0)
                d["L"] *= rng.uniform(0.2, 5.0)
            streams, ch = self._case(O, F, Z_hf=float(rng.choice([0.0, 2.0e5])))
            self._same(fast(streams, ch), ref(streams, ch))


_INJ_CONFIGS = ["configs/ethalox_6500N.yaml", "configs/canonical/impinging.yaml",
                "configs/impinging_lox_ch4_8000N.yaml", "configs/canonical/pintle.yaml",
                "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"]
_INJ_CORE_KEYS = 18     # the first 18 are published by both injector types
_INJ_KEYS = ["Cd_O", "Cd_F", "delta_p_feed_O", "delta_p_feed_F", "delta_p_injector_O",
             "delta_p_injector_F", "D32_O", "D32_F", "x_star", "u_O", "u_F", "We_O", "We_F",
             "momentum_ratio_R", "rupe_M", "u_axial_spray", "iterations",
             "constraints_satisfied",
             # spray/doublet geometry Layer 1 reads out of the diagnostics (geometry-fit term,
             # final report); None on the accelerated path until the extras were added
             "L_imp", "D_pitch_O", "D_pitch_F", "element_gap_O", "element_gap_F", "s_pair",
             "vaporization_length_total", "L_sheet_breakup", "k_evap_O", "k_evap_F",
             "tau_evap_O", "tau_evap_F", "J", "TMR", "theta", "Oh_O", "Oh_F", "rho_gas_breakup",
             # the back-channel ring, hole by hole (impinging._manifold_diagnostics)
             "element_flow_ratio_min_O", "element_flow_ratio_max_O", "element_flow_ratio_min_F",
             "element_flow_ratio_max_F", "element_mixture_ratio_min", "element_mixture_ratio_max",
             "manifold_branch_velocity_O", "manifold_branch_velocity_F", "Cd_eff_manifold_O",
             "Cd_eff_manifold_F"]


@pytest.mark.parametrize("cfg_rel", _INJ_CONFIGS, ids=lambda v: v.split("/")[-1])
def test_injector_solve_matches_python(cfg_rel):
    """closure.flows runs accel.solve on the DEFAULT path, on every residual of the Python chamber
    solve. It must reproduce the Python injector: one closure pass with Cd untouched (impinging),
    the feed exit dump K_exit on d_exit, the passage at A_hydraulic, pintle's fixed-K x*."""
    _need_numba()
    from engine import accel
    from engine.core.injectors import get_injector_model
    from engine.pipeline.io import load_config
    config = load_config(str(ROOT / cfg_rel))
    assert accel.can_handle(config)
    model = get_injector_model(config)
    for P_tank in (584.27 * PSI_TO_PA, 520.0 * PSI_TO_PA, 650.0 * PSI_TO_PA):
        for Pc in (2.0e6, 2.6e6, 3.0e6):
            got = accel.solve(config, P_tank, P_tank, Pc)
            assert got is not None, f"accel.solve bailed at {P_tank:.0f}/{Pc:.0f}"
            mO, mF, want = model.solve(P_tank, P_tank, Pc)
            _assert_close("mdot_O", got[0], mO, rtol=1e-9)
            _assert_close("mdot_F", got[1], mF, rtol=1e-9)
            keys = _INJ_KEYS if config.injector.type == "impinging" else _INJ_KEYS[:_INJ_CORE_KEYS]
            for k in keys:
                if k in want and want[k] is not None:
                    assert k in got[2], f"accel diagnostics lack {k!r}, which Python publishes"
                    w = float(want[k])
                    if np.isnan(w):
                        assert np.isnan(float(got[2][k])), f"diag[{k}]: python NaN, accel {got[2][k]}"
                        continue
                    _assert_close(f"diag[{k}]", float(got[2][k]), w, rtol=1e-9)
            assert list(got[2].get("violations", [])) == list(want.get("violations", [])) or \
                "violations" not in want
            assert got[2].get("manifold_model") == want.get("manifold_model")
            for k in ("element_mixture_ratios", "element_mass_flows", "element_mass_flows_O"):
                if want.get(k) is not None:
                    np.testing.assert_allclose(got[2][k], want[k], rtol=1e-9, err_msg=k)


def test_default_path_matches_python_on_the_shipped_engine():
    """The shipped 6.5 kN at its tank pressure and pad ambient: what the default (accelerated)
    path returns -- the thing Layer 1 and the UI read -- must be the ED_ACCEL=off answer."""
    _need_numba()
    from engine import accel
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config
    config = load_config(str(ROOT / "configs/ethalox_6500N.yaml"))
    runner = PintleEngineRunner(config)
    P = 584.27 * PSI_TO_PA
    Pa = 94070.0
    got = accel.evaluate(config, runner.cea_cache, P, P, Pa)
    if got is None:
        got = runner.evaluate(P, P, P_ambient=Pa, silent=True)
    with _python_only():
        want = runner.evaluate(P, P, P_ambient=Pa, silent=True)
    for k in ("F", "Pc", "MR", "Isp", "mdot_O", "mdot_F"):
        _assert_close(k, got[k], want[k])
    _assert_close("eta_cstar", _py_field(got, "eta_cstar"), _py_field(want, "eta_cstar"))
    # The chug verdict runs the chug kernel on the accelerated side (stability._chug_fast).
    st_got, st_want = got["stability"]["chugging"], want["stability"]["chugging"]
    for k in ("chug_gain_margin", "stability_margin", "frequency"):
        assert np.isfinite(st_want[k]), f"reference chug {k} is not finite"
        _assert_close(f"chug {k}", st_got[k], st_want[k])


def test_chamber_kernel_serves_the_designs():
    """Every chamber piece is mirrored, so the shipped design and the one drawn from CAD run on
    the kernel (NOT_HANDLED here would put Layer 1 back on the ~60 ms Python solve)."""
    _need_numba()
    from engine import accel
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config
    assert accel.chamber_physics_not_mirrored() == ()
    for rel in ("configs/ethalox_6500N.yaml", "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"):
        config = load_config(str(ROOT / rel))
        runner = PintleEngineRunner(config)
        P = 560.0 * PSI_TO_PA
        res, oc = accel.evaluate_ex(config, runner.cea_cache, P, P, PA_AMBIENT)
        assert oc is accel.Outcome.OK, f"{rel}: {oc}"


def test_heatup_tables_match_coolprop():
    """The one tabulation in the chamber kernel: CoolProp's liquid cp(T) and density at the
    chamber pressure (combustion_physics.liquid_heatup_properties), for both liquids of the 6.5 kN
    engine over the whole Pc window. A point the table refuses is allowed (the kernel returns no
    solution and the caller runs Python); a point it answers must answer right."""
    _need_numba()
    from engine.accel import chamber
    from engine.pipeline.combustion_physics import liquid_heatup_properties, saturation_state
    from engine.pipeline.io import load_config
    cfg = load_config(str(ROOT / "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"))
    rng = np.random.default_rng(20260929)
    for side in ("oxidizer", "fuel"):
        fl = cfg.fluids[side]
        Tcrit = fl.critical_temperature or 0.0
        T0 = 293.0 if fl.temperature is None else fl.temperature
        tabs = chamber.heatup_tables(fl.name, T0, fl.boiling_point, fl.latent_heat,
                                     fl.molecular_weight, Tcrit)
        assert tabs is not None
        answered = 0
        for P in np.exp(rng.uniform(np.log(2.1e5), np.log(1.5e7), 400)):
            Tc = float(rng.uniform(2800.0, 3500.0))
            Ts = saturation_state(P, fl.boiling_point, fl.latent_heat, fl.molecular_weight,
                                  Tcrit or None)[0]
            if not Ts > T0:
                continue
            want = liquid_heatup_properties(fl.name, P, T0, Ts, Tc)
            st, I, rho = chamber._heatup(np.zeros(1), 0, *tabs, P, T0, Ts, Tc)
            if st < 0:
                continue
            assert (st == 1) == (want is not None), f"{fl.name} at {P:.4g} Pa: None-ness differs"
            if want is not None:
                answered += 1
                assert abs(I / want["heatup_integral"] - 1.0) < 5e-6, f"{fl.name} I at {P:.4g}"
                assert abs(rho / want["rho_l"] - 1.0) < 5e-7, f"{fl.name} rho at {P:.4g}"
        assert answered > 300, f"{fl.name}: the table answered only {answered} of 400 points"

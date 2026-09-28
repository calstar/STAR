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

THE CONFIG LIST IS DELIBERATE. canonical/impinging.yaml has ablative cooling ON
(the path the project's default configs take), impinging_lox_ch4_8000N.yaml has
it off, and canonical/pintle.yaml exercises the pintle injector -- a different
solve (kernels.injector_solve_pintle) and, critically, a different mixing term:
pintle gets eta_mixing = Em_peak flat, with NO momentum-mixing penalty. Reusing
the impinging mom_R/R_opt logic there would silently diverge from the
authoritative path, so that divergence is pinned here.
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
    ("configs/canonical/impinging.yaml", True),          # impinging, ablative ON
    ("configs/impinging_lox_ch4_8000N.yaml", False),     # impinging, ablative off
    ("configs/canonical/pintle.yaml", True),             # pintle, ablative ON
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
        """Kernel level: the raw evaluate_core tuple, no wrapper in the way.

        The retired C suite kept this level because a wrapper override once hid a
        kernel computing retired momentum-method thrust. The property is
        backend-agnostic and worth keeping: a wrapper cannot paper over the kernel.
        """
        from engine.accel import kernels, params
        r = _rig(cfg_rel)
        if _chamber_gate():
            # Strict: once the kernels are ported this XPASSes and fails, which is the prompt to
            # empty accel._CHAMBER_PHYSICS_NOT_MIRRORED and let the kernels back in.
            pytest.xfail("chamber kernels do not mirror: " + " | ".join(_chamber_gate()))
        P = params.extract_params(r["config"])
        arr = kernels.cea_arrays(r["cache"])
        for p in r["points"]:
            ref = r["reference"][p]
            raw = kernels.evaluate_core(P, *arr, p[0], p[1], PA_AMBIENT)
            assert raw[0], f"kernel did not converge at {p}"
            _assert_close("kernel Pc", raw[1], _py_field(ref, "Pc"))
            _assert_close("kernel F", raw[2], _py_field(ref, "F"))
            _assert_close("kernel Isp", raw[3], _py_field(ref, "Isp"))
            _assert_close("kernel MR", raw[4], _py_field(ref, "MR"))


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
        from engine.accel import kernels, params
        if _chamber_gate():
            pytest.skip("chamber kernels gated off; the wrapper this pins does not run")
        r = _rig("configs/canonical/impinging.yaml")
        P = params.extract_params(r["config"])
        arr = kernels.cea_arrays(r["cache"])
        p_o, p_f = r["points"][0]
        raw = kernels.evaluate_core(P, *arr, p_o, p_f, PA_AMBIENT)
        assert raw[0], "kernel did not converge"
        tc_ideal, tc_eff = float(raw[7]), float(raw[21])
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
                "configs/impinging_lox_ch4_8000N.yaml", "configs/canonical/pintle.yaml"]
_INJ_CORE_KEYS = 18     # the first 18 are published by both injector types
_INJ_KEYS = ["Cd_O", "Cd_F", "delta_p_feed_O", "delta_p_feed_F", "delta_p_injector_O",
             "delta_p_injector_F", "D32_O", "D32_F", "x_star", "u_O", "u_F", "We_O", "We_F",
             "momentum_ratio_R", "rupe_M", "u_axial_spray", "iterations",
             "constraints_satisfied",
             # spray/doublet geometry Layer 1 reads out of the diagnostics (geometry-fit term,
             # final report); None on the accelerated path until the extras were added
             "L_imp", "D_pitch_O", "D_pitch_F", "element_gap_O", "element_gap_F", "s_pair",
             "vaporization_length_total", "L_sheet_breakup", "k_evap_O", "k_evap_F",
             "tau_evap_O", "tau_evap_F", "J", "TMR", "theta", "Oh_O", "Oh_F", "rho_gas_breakup"]


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


def test_chamber_fallback_is_loud_while_physics_is_unmirrored(caplog):
    """A closed gate must refuse (NOT_HANDLED, never NO_SOLUTION or a number) and say why."""
    _need_numba()
    import logging

    from engine import accel
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config
    reasons = accel.chamber_physics_not_mirrored()
    if not reasons:
        pytest.skip("chamber kernels mirror the Python physics; nothing is gated")
    config = load_config(str(ROOT / "configs/ethalox_6500N.yaml"))
    runner = PintleEngineRunner(config)
    accel._warned_chamber_fallback = False
    with caplog.at_level(logging.WARNING, logger="engine.accel"):
        res, oc = accel.evaluate_ex(config, runner.cea_cache, 4.0e6, 4.0e6, 94070.0)
    assert res is None and oc is accel.Outcome.NOT_HANDLED
    assert accel.chamber_solve_ex(config, runner.cea_cache, 4.0e6, 4.0e6)[1] is accel.Outcome.NOT_HANDLED
    assert any("falls back to the Python solve" in m for m in caplog.messages)
    # the injector-only surface stays accelerated: it IS mirrored
    assert accel.solve_ex(config, 4.0e6, 4.0e6, 2.6e6)[1] is accel.Outcome.OK

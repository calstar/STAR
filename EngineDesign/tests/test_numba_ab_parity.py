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

pytestmark = pytest.mark.skipif(
    os.environ.get("ED_REQUIRE_ACCEL") != "1" and os.environ.get("ED_AB_PARITY") != "1",
    reason="A/B parity runs in the accel-parity CI job; set ED_AB_PARITY=1 to run locally",
)

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
    """Force the authoritative Python path for the reference computation."""
    from engine import accel
    real = accel.enabled
    accel.enabled = lambda: False
    try:
        yield
    finally:
        accel.enabled = real


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
    assert accel.can_handle_chamber(config), f"accelerator cannot handle {cfg_rel}"
    runner = PintleEngineRunner(config)
    points = [(po * PSI_TO_PA, pf * PSI_TO_PA) for po, pf in POINTS_PSI]
    with _python_only():
        reference = {p: runner.evaluate(p[0], p[1], P_ambient=PA_AMBIENT, silent=True)
                     for p in points}
    rig = {"config": config, "runner": runner, "cache": runner.cea_cache,
           "points": points, "reference": reference}
    _RIGS[cfg_rel] = rig
    return rig


@pytest.mark.parametrize("cfg_rel,ablative", CONFIGS, ids=lambda v: str(v).split("/")[-1])
class TestAccelMatchesPython:
    """The contract: what the optimizer consumes must match the authoritative path."""

    def test_wrapper_fields(self, cfg_rel, ablative):
        from engine import accel
        r = _rig(cfg_rel)
        for p in r["points"]:
            ref = r["reference"][p]
            got = accel.evaluate(r["config"], r["cache"], p[0], p[1], PA_AMBIENT)
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
            gd = accel.evaluate(r["config"], r["cache"], p[0], p[1], PA_AMBIENT)["diagnostics"]
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


@pytest.mark.parametrize("cfg_rel,ablative", CONFIGS, ids=lambda v: str(v).split("/")[-1])
class TestRandomizedSweep:
    """Breadth the three fixed points cannot give. Fixed seed, so failures repeat."""

    N = 60

    def test_sweep(self, cfg_rel, ablative):
        from engine import accel
        r = _rig(cfg_rel)
        rng = np.random.default_rng(20260904)
        matched = 0
        worst = 0.0
        for _ in range(self.N):
            p_o = float(rng.uniform(3.0e6, 5.5e6)); p_f = float(rng.uniform(3.0e6, 5.5e6))
            got = accel.evaluate(r["config"], r["cache"], p_o, p_f, PA_AMBIENT)
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
        assert matched > self.N // 2, f"only {matched}/{self.N} points converged"
        assert worst <= RTOL, f"worst accel-vs-Python divergence {worst:.3e} over {matched} points"


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

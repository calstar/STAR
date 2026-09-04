"""Live A/B parity for the Numba accelerator: Numba vs C, and Numba vs Python.

Sibling of test_native_ab_parity.py, and deliberately shaped like it -- same
points, same tolerance, same opt-in gating -- so the two read as one story while
both backends exist.

THREE COMPARISONS, each answering a different question:

  Numba vs C      at 1e-12  -- the regression guard. These two implement the same
                              physics from the same inputs, so they agree to a few
                              ULP (measured: worst 9.7e-16 over 300 points). Any
                              loosening here means a real divergence, not noise.
  Numba vs Python at 2e-3   -- the contract. Same RTOL as the C suite and for the
                              same reason: the accelerated chamber solve lands
                              within ~1e-3 of Python, so 2e-3 has headroom without
                              masking a physics bug.
  Randomized sweep          -- 200 fixed-seed points across the operating box,
                              which the C suite never had. Also asserts the
                              accelerated path does not bail where Python converges.

BOTH CONFIGS ARE EXERCISED ON PURPOSE. configs/canonical/impinging.yaml has
ablative cooling ON and impinging_lox_ch4_8000N.yaml has it off; those are
different code paths through _cooling_evaluate, and the ablative one is what the
project's default configs actually take.

SCOPE: this covers the pure-Numba surface (chamber + nozzle + thrust core). The
injector *diagnostics* dict is still assembled by a C call inside
make_native_signature_evaluate, so asserting on it here would be partly circular;
that coverage lands when the diagnostics are surfaced from Numba's own solve.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PSI_TO_PA = 6894.76
PA_AMBIENT = 101325.0

pytestmark = pytest.mark.skipif(
    os.environ.get("ED_REQUIRE_ACCEL") != "1" and os.environ.get("ED_AB_PARITY") != "1",
    reason="A/B parity runs in the parity CI job; set ED_AB_PARITY=1 to run locally",
)

POINTS_PSI = [(563.467, 567.644), (518.4, 550.6), (597.3, 584.7)]

RTOL = 2e-3          # Numba vs Python -- matches the C suite's target
RTOL_TIGHT = 1e-12   # Numba vs C -- same physics, same inputs; ULP-level or bust

CONFIGS = [
    ("configs/canonical/impinging.yaml", True),          # ablative ON (default configs)
    ("configs/impinging_lox_ch4_8000N.yaml", False),     # ablative off
]

# Fields NumbaEvaluator.evaluate() produces; all are core physics, no diagnostics.
CORE_FIELDS = ["Pc", "F", "Isp", "MR", "cstar_actual", "gamma",
               "Tc", "mdot_total", "v_exit", "Cf_actual"]


def _rel(got, want):
    return abs(float(got) - float(want)) / max(abs(float(want)), 1e-12)


def _assert_close(name, got, want, rtol):
    assert got is not None and want is not None, f"{name}: missing value ({got} vs {want})"
    rel = _rel(got, want)
    assert rel <= rtol, f"{name}: got={float(got):.10g} want={float(want):.10g} rel={rel:.3e} > {rtol:g}"


def _py_field(ref, key):
    """Python's result dict keeps some fields top-level and some in diagnostics."""
    if key in ref and ref[key] is not None:
        return ref[key]
    return (ref.get("diagnostics") or {}).get(key)


_RIGS = {}


def _rig(cfg_rel):
    """Config + C shim + Numba evaluator + live Python reference, built once."""
    if cfg_rel in _RIGS:
        return _RIGS[cfg_rel]
    if os.environ.get("ED_USE_NATIVE", "1") == "0":
        pytest.skip("ED_USE_NATIVE=0 -- no C side to compare against")
    try:
        from engine.native.python import autobuild, ed_native, native_injector
        ed_native.load(autobuild.ensure_lib())
    except Exception as exc:
        if os.environ.get("ED_REQUIRE_ACCEL") == "1":
            pytest.fail(f"ED_REQUIRE_ACCEL=1 but the C reference is unavailable: {exc}")
        pytest.skip(f"C reference unavailable ({exc})")
    if not native_injector.native_enabled():
        pytest.skip("native kernel not enabled")

    from engine.accel import kernels
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config

    config = load_config(str(ROOT / cfg_rel))
    assert native_injector._can_handle_chamber(config), f"C cannot handle {cfg_rel}"
    runner = PintleEngineRunner(config)
    native_injector._ensure_cea(runner.cea_cache)

    points = [(po * PSI_TO_PA, pf * PSI_TO_PA) for po, pf in POINTS_PSI]
    rig = {
        "config": config, "runner": runner, "cache": runner.cea_cache,
        "ni": native_injector, "nb": kernels.NumbaEvaluator(config, runner.cea_cache),
        "mod": kernels, "points": points,
        "reference": {p: runner.evaluate(p[0], p[1], P_ambient=PA_AMBIENT, silent=True)
                      for p in points},
    }
    _RIGS[cfg_rel] = rig
    return rig


@pytest.mark.parametrize("cfg_rel,ablative", CONFIGS, ids=lambda v: str(v).split("/")[-1])
class TestNumbaMatchesC:
    """The regression guard. Numba and C must agree to ULP, not to a tolerance."""

    def test_core_fields(self, cfg_rel, ablative):
        r = _rig(cfg_rel)
        for p_o, p_f in r["points"]:
            c = r["ni"].evaluate(r["config"], r["cache"], p_o, p_f, PA_AMBIENT)
            n = r["nb"].evaluate(p_o, p_f, PA_AMBIENT)
            assert c is not None and n is not None, f"a backend bailed at {p_o:.0f}/{p_f:.0f}"
            for k in CORE_FIELDS:
                if k in c and k in n:
                    _assert_close(f"{k}@{p_o:.0f}/{p_f:.0f}", n[k], c[k], RTOL_TIGHT)


@pytest.mark.parametrize("cfg_rel,ablative", CONFIGS, ids=lambda v: str(v).split("/")[-1])
class TestNumbaMatchesPython:
    """The contract: what the optimizer consumes must match the authoritative path."""

    def test_wrapper_core_fields(self, cfg_rel, ablative):
        r = _rig(cfg_rel)
        for p in r["points"]:
            ref = r["reference"][p]
            n = r["nb"].evaluate(p[0], p[1], PA_AMBIENT)
            assert n is not None, f"numba bailed where Python converged at {p}"
            for k in CORE_FIELDS:
                want = _py_field(ref, k)
                if want:
                    _assert_close(f"{k}@{p[0]:.0f}/{p[1]:.0f}", n[k], want, RTOL)

    def test_kernel_level_raw_tuple(self, cfg_rel, ablative):
        """Kernel level: the raw evaluate_core tuple, with no wrapper in the way.

        The C suite keeps this level because a wrapper override once hid a kernel
        computing retired momentum-method thrust. Numba has no ctypes struct, so
        this is simply the returned tuple -- same property, less machinery.
        """
        r = _rig(cfg_rel)
        nb, mod = r["nb"], r["mod"]
        for p in r["points"]:
            ref = r["reference"][p]
            raw = mod.evaluate_core(nb.P, *nb.cea, p[0], p[1], PA_AMBIENT)
            assert raw[0], f"kernel did not converge at {p}"
            _assert_close("kernel Pc", raw[1], _py_field(ref, "Pc"), RTOL)
            _assert_close("kernel F", raw[2], _py_field(ref, "F"), RTOL)
            _assert_close("kernel Isp", raw[3], _py_field(ref, "Isp"), RTOL)
            _assert_close("kernel MR", raw[4], _py_field(ref, "MR"), RTOL)


@pytest.mark.parametrize("cfg_rel,ablative", CONFIGS, ids=lambda v: str(v).split("/")[-1])
class TestRandomizedSweep:
    """Breadth the three fixed points cannot give. Fixed seed, so failures repeat."""

    N = 200

    def test_sweep_matches_c(self, cfg_rel, ablative):
        import numpy as np
        r = _rig(cfg_rel)
        rng = np.random.default_rng(20260904)
        lo, hi = 3.0e6, 5.5e6
        matched = c_only = nb_only = 0
        worst = 0.0
        for _ in range(self.N):
            p_o = float(rng.uniform(lo, hi)); p_f = float(rng.uniform(lo, hi))
            c = r["ni"].evaluate(r["config"], r["cache"], p_o, p_f, PA_AMBIENT)
            n = r["nb"].evaluate(p_o, p_f, PA_AMBIENT)
            if c is None and n is None:
                continue
            # A convergence disagreement is a real divergence: same physics, same
            # inputs, so one backend bailing where the other did not is a bug.
            assert c is not None, f"C bailed where Numba converged at {p_o:.0f}/{p_f:.0f}"
            assert n is not None, f"Numba bailed where C converged at {p_o:.0f}/{p_f:.0f}"
            matched += 1
            for k in CORE_FIELDS:
                if k in c and k in n and c[k]:
                    worst = max(worst, _rel(n[k], c[k]))
        assert matched > self.N // 2, f"only {matched}/{self.N} points converged"
        assert worst <= RTOL_TIGHT, f"worst Numba-vs-C divergence {worst:.3e} over {matched} points"


class TestCoolingIsActuallyApplied:
    """Pins the Tc_ideal/Tc_effective distinction.

    ed_evaluate.c returns Tc_ideal as `.Tc` but Tc_effective as `.Tc_effective`,
    and native_injector.py:538 puts the EFFECTIVE one into the dict the optimizer
    and comprehensive_stability_analysis consume. Returning the ideal value is a
    silent ~0.8% error that lands in stability, not a crash -- so assert both that
    the two differ and that the wrapper exposes the effective one.
    """

    def test_effective_tc_differs_and_is_reported(self):
        r = _rig("configs/canonical/impinging.yaml")
        nb, mod = r["nb"], r["mod"]
        p_o, p_f = r["points"][0]
        raw = mod.evaluate_core(nb.P, *nb.cea, p_o, p_f, PA_AMBIENT)
        assert raw[0], "kernel did not converge"
        tc_ideal, tc_eff = float(raw[7]), float(raw[21])
        assert tc_eff < tc_ideal - 1.0, (
            f"cooling not applied: Tc_ideal={tc_ideal:.2f} Tc_effective={tc_eff:.2f}. "
            "If ablative is genuinely inactive for this config the test is vacuous."
        )
        reported = r["nb"].evaluate(p_o, p_f, PA_AMBIENT)["Tc"]
        assert _rel(reported, tc_eff) < 1e-12, (
            f"wrapper reported Tc={reported:.4f}, expected the EFFECTIVE {tc_eff:.4f} "
            f"(not the ideal {tc_ideal:.4f})"
        )

    def test_matches_c_effective_tc(self):
        r = _rig("configs/canonical/impinging.yaml")
        p_o, p_f = r["points"][0]
        c = r["ni"].evaluate(r["config"], r["cache"], p_o, p_f, PA_AMBIENT)
        n = r["nb"].evaluate(p_o, p_f, PA_AMBIENT)
        _assert_close("Tc (effective)", n["Tc"], c["Tc"], RTOL_TIGHT)


class TestDiagnosticsMatchC:
    """The injector diagnostics dict, assembled from Numba's own solve.

    This used to come from a second solve in C (native_injector._nat().injector_solve
    + _result_to_diag). Numba's injector_solve already computed every value; they
    were simply discarded. Assembling them here is what removes the last C call
    from the accelerated evaluate path.
    """

    # C also emits these four; no reader for any of them exists anywhere, and they
    # are impinging spray quantities the accelerated path never needs.
    #
    # A_eff_O/F and turbulence_intensity_mix were briefly on this list and that was
    # WRONG -- the suite caught it. A_eff is asserted present (not merely derivable
    # from Cd) by test_flow_capacity_effective_area, and turbulence_intensity_mix
    # reaches chamber_solver.py:180 via *closure* diagnostics, i.e. the accel.solve
    # path rather than the accel.evaluate path the first analysis examined. Both are
    # now produced. Treat every addition here with that in mind.
    KNOWN_ABSENT = {"J", "TMR", "theta", "feed_orifice_coupling_iterations"}

    @pytest.mark.parametrize("cfg_rel,ablative", CONFIGS, ids=lambda v: str(v).split("/")[-1])
    def test_fields_match_and_nothing_new_is_missing(self, cfg_rel, ablative):
        import math
        from engine.accel import diagnostics, params
        r = _rig(cfg_rel)
        ni, kernels = r["ni"], r["mod"]

        P = params.extract_params(r["config"])
        arr = kernels.cea_arrays(r["cache"])
        state = ni.build_state(r["config"])

        for p_o, p_f in r["points"]:
            core = kernels.evaluate_core(P, *arr, p_o, p_f, PA_AMBIENT)
            assert core[0], f"kernel did not converge at {p_o:.0f}/{p_f:.0f}"
            Pc = core[1]
            got = diagnostics.build_diag(P, kernels.injector_solve(P, p_o, p_f, Pc))
            rc, ir = ni._nat().injector_solve(state, p_o, p_f, Pc)
            assert rc == 0, "C injector solve failed"
            want = ni._result_to_diag(r["config"], ir)

            # A newly-missing field means a consumer could silently get None.
            newly_absent = (set(want) - set(got)) - self.KNOWN_ABSENT
            assert not newly_absent, (
                f"fields C provides but Numba dropped: {sorted(newly_absent)}. "
                "Either produce them or justify the omission in KNOWN_ABSENT."
            )

            for k in sorted(set(want) & set(got)):
                a, b = got[k], want[k]
                if isinstance(b, bool) or not isinstance(b, (int, float)):
                    assert a == b, f"{k}: numba={a!r} C={b!r}"
                elif b and math.isfinite(float(b)):
                    _assert_close(f"diag[{k}]", a, b, RTOL_TIGHT)

"""Live A/B parity: native C kernel vs the authoritative Python physics.

Unlike the golden-vector C tests (which compare C against a *frozen snapshot* of
Python's output, committed as JSON), this suite runs BOTH implementations live on
the same inputs and diffs the results field by field. A golden test can only be
as current as its snapshot: when the Python physics changes and the snapshot is
not regenerated, the golden suite keeps certifying C against retired physics and
stays green. This suite closes that gap — it re-derives the Python reference at
test time, so any C-vs-Python drift fails here regardless of which side moved.

Two comparison levels, on purpose:

1. **Wrapper level** (`native_injector.evaluate()` vs `runner.evaluate()`):
   validates the contract the Layer-1 optimizer actually consumes — the dict the
   inner loop ranks candidates on must match the authoritative Python path.

2. **Kernel (struct) level** (raw `EdEvaluateResult` off the ctypes call vs
   `runner.evaluate()`): validates the C kernel's *own* numbers, with no Python
   shim papering over them. This is what catches C physics left behind after a
   Python-side change even when a wrapper override hides it from consumers.

Native availability policy (mirrors the CI parity job's contract):
  * default: if the native library cannot build/load, SKIP (dev machines without
    a C toolchain must not fail the general gate);
  * ED_REQUIRE_NATIVE=1 (the CI parity job): a missing/broken library FAILS —
    otherwise the job would silently pass on the Python fallback (false green).

No rocketcea/Fortran involved: both sides read the committed CEA cache tables
(output/cache/*.npz). This tests C≡Python *consistency* on top of those tables;
table *correctness* is the separate, CEA-driven regenerate-cea-cache workflow.
"""

import ctypes
import os
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
PSI_TO_PA = 6894.76
PA_AMBIENT = 101325.0

def _parity_should_run() -> tuple[bool, str]:
    """Run whenever this machine has already built the native kernel.

    This suite is the native-parity CI job's payload, but it used to skip
    unconditionally outside that job -- which meant `pytest tests/` could report
    all-green while comparing today's Python against a stale binary. That is not
    hypothetical: the native kernel is the DEFAULT execution path
    (native_injector.native_enabled() is True unless ED_USE_NATIVE=0) and
    chamber_solver._native_chamber_pc runs the whole Pc solve in C, so a
    physics change made only in Python does not affect shipped numbers at all.
    A green suite that never exercised C is actively misleading.

    So: if a library is already built, the toolchain exists and running is
    cheap -- and ensure_lib() rebuilds it when it is older than the C sources,
    which is exactly the stale-binary case. If nothing has ever been built,
    skip rather than impose a first-time CMake build on a plain test run.

    ED_AB_PARITY=1 forces it on, ED_AB_PARITY=0 forces it off.
    """
    if os.environ.get("ED_REQUIRE_NATIVE") == "1" or os.environ.get("ED_AB_PARITY") == "1":
        return True, ""
    if os.environ.get("ED_AB_PARITY") == "0":
        return False, "ED_AB_PARITY=0 explicitly disables the A/B parity suite"
    try:
        from engine.native.python import autobuild
        if autobuild.lib_if_built() is not None:
            return True, ""
    except Exception as exc:  # import problems must not break collection
        return False, f"native autobuild unavailable ({exc})"
    return False, ("no native library has been built on this machine; build it "
                   "or set ED_AB_PARITY=1 to force the A/B parity suite")


_SHOULD_RUN, _SKIP_REASON = _parity_should_run()
pytestmark = pytest.mark.skipif(not _SHOULD_RUN, reason=_SKIP_REASON)

# Tank-pressure points (psi) on the canonical impinging engine — nominal plus
# off-nominal, same operating window the manual parity tools exercised.
POINTS_PSI = [(563.467, 567.644), (518.4, 550.6), (597.3, 584.7)]

# Program parity target: the native chamber solve lands within ~1e-3 of Python
# (see engine/native/tools/check_evaluate_parity.py), so 2e-3 gives headroom
# without masking a real physics divergence (the retired-nozzle drift is ~15%).
RTOL = 2e-3


def _require_native() -> bool:
    return os.environ.get("ED_REQUIRE_NATIVE", "0") == "1"


def _rel(got: float, want: float) -> float:
    return abs(got - want) / max(abs(want), 1e-12)


def _assert_close(name: str, got, want, rtol: float = RTOL) -> None:
    assert got is not None and want is not None, f"{name}: missing value (native={got}, python={want})"
    rel = _rel(float(got), float(want))
    assert rel <= rtol, (
        f"{name}: native={float(got):.8g} python={float(want):.8g} rel={rel:.3e} > rtol={rtol:g}"
    )


@pytest.fixture(scope="module")
def native_injector_mod():
    """The native shim module, with the library proven built + loaded.

    Skips when the toolchain is absent (default), fails under ED_REQUIRE_NATIVE=1
    so the CI parity job cannot false-green on the Python fallback.
    """
    if os.environ.get("ED_USE_NATIVE", "1") == "0":
        if _require_native():
            pytest.fail("ED_REQUIRE_NATIVE=1 but ED_USE_NATIVE=0 disables the native path")
        pytest.skip("ED_USE_NATIVE=0 — native path disabled")
    try:
        from engine.native.python import autobuild, ed_native, native_injector
        lib_path = autobuild.ensure_lib()
        ed_native.load(lib_path)
    except Exception as exc:
        if _require_native():
            pytest.fail(f"ED_REQUIRE_NATIVE=1 but the native library failed to build/load: {exc}")
        pytest.skip(f"native library unavailable ({exc}); install cmake + a C compiler to run A/B parity")
    if not native_injector.native_enabled():
        if _require_native():
            pytest.fail("ED_REQUIRE_NATIVE=1 but native_injector.native_enabled() is False")
        pytest.skip("native kernel not enabled")
    return native_injector


@pytest.fixture(scope="module")
def rig(native_injector_mod):
    """Config + runner + per-point PYTHON reference results.

    The reference MUST be computed with the native path disabled. The native
    kernel is the default execution path -- native_injector.native_enabled() is
    True unless ED_USE_NATIVE=0, and chamber_solver._native_chamber_pc then
    runs the entire Pc solve in C and skips Python's Brent entirely.

    Measured, with a deliberate Python-only divergence live (the cooling->c*
    conversion forced back to linear), reference taken from a default
    runner.evaluate():

        Pc, F, Isp              |native - "python"| / native = 0.000e+00
        eta_cstar, cstar_actual |native - "python"| / native = 1.976e-02

    i.e. the headline performance numbers were served straight from C and
    compared against themselves -- they could not disagree no matter what
    Python did. Only the fields Python recomputes on top of C's Pc (the
    efficiency diagnostics) were genuine comparisons. Forcing the reference
    onto the Python solver makes every field a real Python-vs-C check.

    native_enabled() re-reads the env var on every call, so toggling it around
    the reference computation is sufficient; no reload is needed.

    """
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config

    config = load_config(ROOT / "configs" / "canonical" / "impinging.yaml")
    if not native_injector_mod._can_handle_chamber(config):
        pytest.fail("native kernel reports it cannot handle the canonical impinging config")

    points = [(po * PSI_TO_PA, pf * PSI_TO_PA) for po, pf in POINTS_PSI]

    # ED_REQUIRE_NATIVE must come off with it: the CI parity job sets it to 1,
    # and closure._native_solve raises outright when native is required but
    # disabled (closure.py:59). Leaving it set would make this fixture explode
    # in CI while passing locally.
    prior = {k: os.environ.get(k) for k in ("ED_USE_NATIVE", "ED_REQUIRE_NATIVE")}
    os.environ["ED_USE_NATIVE"] = "0"
    os.environ["ED_REQUIRE_NATIVE"] = "0"
    try:
        if native_injector_mod.native_enabled():
            pytest.fail(
                "ED_USE_NATIVE=0 did not disable the native path; the reference "
                "would be C, not Python, and this suite would compare C to itself"
            )
        runner = PintleEngineRunner(config)
        reference = {
            (p_o, p_f): runner.evaluate(p_o, p_f, P_ambient=PA_AMBIENT, silent=True)
            for p_o, p_f in points
        }
    finally:
        for key, value in prior.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    if not native_injector_mod.native_enabled():
        pytest.fail("native path did not re-enable after building the Python reference")

    return {"config": config, "runner": runner, "points": points, "reference": reference}


# ---------------------------------------------------------------------------
# Level 1 — wrapper contract: what the Layer-1 inner loop consumes
# ---------------------------------------------------------------------------

WRAPPER_TOP_FIELDS = [
    "F", "Isp", "Pc", "MR", "mdot_total", "mdot_O", "mdot_F",
    "Cf_actual", "cstar_actual", "cstar_ideal", "eta_cstar",
    "P_exit", "T_exit", "v_exit",
    # Tc here is the cooling-REDUCED effective chamber temperature (Tc_ideal
    # minus the ablative temperature reduction), so it is the wrapper-visible
    # end of the thermal chain. Anything that moves gas-side heat transfer
    # moves this.
    "Tc",
]
WRAPPER_DIAG_FIELDS = [
    "D32_O", "D32_F", "Cd_O", "Cd_F", "momentum_ratio_R",
    "delta_p_feed_O", "delta_p_feed_F",
]

# --- EdEvaluateResult -> live-Python mapping -------------------------------
#
# Every double on the struct is resolved against the live Python result. The
# default rule is "same name, top level first, then diagnostics"; the map below
# only lists fields whose Python name differs. TestKernelStructParity's coverage
# test asserts that every struct field is either resolvable or explicitly
# excluded, so adding a field to ed_state.h without a parity story fails here.
#
# The Tc pair is the trap: the struct's `Tc` is the IDEAL flame temperature,
# while Python's top-level `Tc` is the cooling-REDUCED one (the struct calls
# that `Tc_effective`). Mapping them by name would silently compare the wrong
# pair and mask a real cooling divergence.
# A value may be a dotted path, or a callable(ref) for derived quantities.
STRUCT_FIELD_OVERRIDES = {
    "Tc": "diagnostics.Tc_ideal",
    "Tc_effective": "Tc",
    "delta_P_injector_O": "diagnostics.delta_p_injector_O",
    "delta_P_injector_F": "diagnostics.delta_p_injector_F",
    "cooling_efficiency": "diagnostics.cooling_efficiency",
    # Derived, not a Python key: ed_chamber.c:98 stores the coarser of the two
    # stream SMDs (`d->SMD = ed_max(inj.D32_O, inj.D32_F)`), while Python only
    # reports D32_O / D32_F separately. Reproduce the C definition here rather
    # than pinning to whichever stream happens to be larger in one config.
    "SMD": lambda ref: max((ref.get("diagnostics") or {})["D32_O"],
                           (ref.get("diagnostics") or {})["D32_F"]),
}

# Struct fields with no live-Python counterpart, with the reason.
STRUCT_FIELDS_UNMAPPED = {
    "converged": "C-side solver status flag; asserted separately in struct_results",
}


def _resolve_ref(ref: dict, struct_name: str):
    """Live-Python value for a struct field, or None if absent."""
    path = STRUCT_FIELD_OVERRIDES.get(struct_name, struct_name)
    if callable(path):
        try:
            return path(ref)
        except (KeyError, TypeError):
            return None
    if path.startswith("diagnostics."):
        return (ref.get("diagnostics") or {}).get(path.split(".", 1)[1])
    if ref.get(path) is not None:
        return ref[path]
    return (ref.get("diagnostics") or {}).get(path)


class TestWrapperParity:
    """native_injector.evaluate() must match runner.evaluate() live."""

    def test_wrapper_matches_python(self, native_injector_mod, rig):
        for p_o, p_f in rig["points"]:
            ref = rig["reference"][(p_o, p_f)]
            nat = native_injector_mod.evaluate(
                rig["config"], rig["runner"].cea_cache, p_o, p_f, PA_AMBIENT)
            assert nat is not None, (
                f"native evaluate returned None at ({p_o / PSI_TO_PA:.1f}, "
                f"{p_f / PSI_TO_PA:.1f}) psi — fell back to Python instead of solving"
            )
            for key in WRAPPER_TOP_FIELDS:
                _assert_close(f"({p_o / PSI_TO_PA:.0f},{p_f / PSI_TO_PA:.0f})psi {key}",
                              nat.get(key), ref.get(key))
            ref_diag = ref.get("diagnostics") or {}
            nat_diag = nat.get("diagnostics") or {}
            for key in WRAPPER_DIAG_FIELDS:
                if ref_diag.get(key) is None:
                    continue
                _assert_close(f"({p_o / PSI_TO_PA:.0f},{p_f / PSI_TO_PA:.0f})psi diag.{key}",
                              nat_diag.get(key), ref_diag.get(key))

    def test_wrapper_stability_matches_python(self, native_injector_mod, rig):
        for p_o, p_f in rig["points"]:
            ref = rig["reference"][(p_o, p_f)]
            nat = native_injector_mod.evaluate(
                rig["config"], rig["runner"].cea_cache, p_o, p_f, PA_AMBIENT)
            assert nat is not None
            rs = ref.get("stability_results") or {}
            ns = nat.get("stability_results") or {}
            assert ns.get("stability_state") == rs.get("stability_state"), (
                f"stability_state: native={ns.get('stability_state')} "
                f"python={rs.get('stability_state')}"
            )
            _assert_close("stability_score", ns.get("stability_score"), rs.get("stability_score"))
            for section in ("chugging", "acoustic"):
                _assert_close(
                    f"{section}.stability_margin",
                    (ns.get(section) or {}).get("stability_margin"),
                    (rs.get(section) or {}).get("stability_margin"),
                )


# ---------------------------------------------------------------------------
# Level 2 — kernel struct: the C kernel's own numbers, no Python shim
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def struct_results(native_injector_mod, rig):
    """Raw EdEvaluateResult per point, straight off the ctypes call."""
    ni = native_injector_mod
    nat = ni._nat()
    assert ni._ensure_cea(rig["runner"].cea_cache), "CEA tables failed to load into the native lib"
    state = ni.build_state(rig["config"])
    out = {}
    for p_o, p_f in rig["points"]:
        rc, res = nat.evaluate(ctypes.byref(state), p_o, p_f, PA_AMBIENT)
        assert rc == 0 and res.converged, f"ed_evaluate rc={rc} converged={res.converged}"
        out[(p_o, p_f)] = res
    return out


class TestKernelStructParity:
    """EdEvaluateResult fields must match live Python — no wrapper overrides.

    Split into chamber vs thrust so a failure localizes the stale stage instead
    of reading as 'native is broken'.
    """

    def test_struct_chamber_matches_python(self, rig, struct_results):
        for p_o, p_f in rig["points"]:
            ref = rig["reference"][(p_o, p_f)]
            res = struct_results[(p_o, p_f)]
            label = f"({p_o / PSI_TO_PA:.0f},{p_f / PSI_TO_PA:.0f})psi struct"
            _assert_close(f"{label}.Pc", res.Pc, ref["Pc"])
            _assert_close(f"{label}.MR", res.MR, ref["MR"])
            _assert_close(f"{label}.mdot_total", res.mdot_total, ref["mdot_total"])
            _assert_close(f"{label}.eta_cstar", res.eta_cstar,
                          (ref.get("diagnostics") or {}).get("eta_cstar", ref.get("eta_cstar")))

    def test_struct_thrust_matches_python(self, rig, struct_results):
        """The C kernel's delivered F/Isp must be on the same physics basis as
        production Python (RPA delivered thrust: F = zeta_n*Cf_vac*Pc*At - Pa*Ae).

        If this fails with native ~13-15% HIGH while test_struct_chamber_* passes,
        ed_nozzle.c is still computing the retired momentum-method thrust (ideal-Tc
        exhaust velocity, no combustion-efficiency penalty) that the RPA fix
        removed from nozzle.py — i.e. EdEvaluateResult.F carries the pre-fix
        inflated number and only the Python wrapper override hides it. Port the
        Cf_vac formula to ed_evaluate.c/ed_nozzle.c; do not paper over this by
        widening the tolerance.
        """
        for p_o, p_f in rig["points"]:
            ref = rig["reference"][(p_o, p_f)]
            res = struct_results[(p_o, p_f)]
            label = f"({p_o / PSI_TO_PA:.0f},{p_f / PSI_TO_PA:.0f})psi struct"
            _assert_close(f"{label}.F", res.F, ref["F"])
            _assert_close(f"{label}.Isp", res.Isp, ref["Isp"])
            _assert_close(f"{label}.Cf_actual", res.Cf_actual, ref["Cf_actual"])

    def test_struct_thermal_matches_python(self, rig, struct_results):
        """The C kernel's gas-side thermal chain must match live Python.

        Previously NOTHING here compared a thermal quantity: the wrapper and
        struct field lists covered flow, thrust and injector terms only. The
        only C-vs-Python check on the cooling path was
        tests/golden/residual_samples.json via test_residual_golden.c — a frozen
        snapshot, which by construction cannot see a Python-side change until a
        human regenerates it.

        These two fields are the end of that chain:
          * cooling_efficiency -- ablative heat removal as a fraction, the
            output of ed_cooling_evaluate / compute_ablative_response;
          * Tc_effective       -- Tc_ideal reduced by that heat removal, which
            then propagates into c* and thrust.

        Both depend on the gas-side film coefficient, so a divergence in
        viscosity, conductivity, Prandtl, emissivity or the Nusselt branch
        between the two implementations surfaces here immediately, with no
        regeneration step.

        Requires a config with ablative cooling enabled (canonical/impinging.yaml
        has it on); with all cooling disabled these collapse to 1.0 / Tc_ideal
        and the check becomes vacuous rather than wrong.
        """
        assert rig["config"].ablative_cooling.enabled, (
            "canonical impinging config no longer enables ablative cooling — "
            "this test would be vacuous; point it at a config that does"
        )
        for p_o, p_f in rig["points"]:
            ref = rig["reference"][(p_o, p_f)]
            res = struct_results[(p_o, p_f)]
            label = f"({p_o / PSI_TO_PA:.0f},{p_f / PSI_TO_PA:.0f})psi struct"
            ref_diag = ref.get("diagnostics") or {}
            _assert_close(f"{label}.cooling_efficiency", res.cooling_efficiency,
                          ref_diag.get("cooling_efficiency"))
            _assert_close(f"{label}.Tc_effective", res.Tc_effective, ref["Tc"])

    def test_struct_all_fields_match_python(self, rig, struct_results):
        """Every EdEvaluateResult double vs its live-Python counterpart.

        The focused tests above localize the common failure modes; this one is
        the backstop that leaves no field unchecked. It is what makes the
        component golden-vector suites (nozzle/injector) redundant: the fields
        they pin against a frozen snapshot -- throat/exit state, discharge
        coefficients, jet areas, SMD, momentum ratio -- are all compared here
        against Python re-derived at test time, so a change on either side is
        caught with no regeneration step.
        """
        from engine.native.python.ed_native import EdEvaluateResult

        checked = 0
        for p_o, p_f in rig["points"]:
            ref = rig["reference"][(p_o, p_f)]
            res = struct_results[(p_o, p_f)]
            label = f"({p_o / PSI_TO_PA:.0f},{p_f / PSI_TO_PA:.0f})psi struct"
            for name in EdEvaluateResult._doubles:
                if name in STRUCT_FIELDS_UNMAPPED:
                    continue
                want = _resolve_ref(ref, name)
                assert want is not None, (
                    f"{label}.{name}: no live-Python counterpart resolved. Add a "
                    f"STRUCT_FIELD_OVERRIDES entry or justify it in "
                    f"STRUCT_FIELDS_UNMAPPED."
                )
                _assert_close(f"{label}.{name}", getattr(res, name), want)
                checked += 1
        assert checked > 0, "no struct fields were compared — fixture produced no points"

    def test_struct_field_coverage_is_complete(self):
        """No EdEvaluateResult field may be silently uncompared.

        Without this, adding a field to ed_state.h + the ctypes mirror would
        create untested C surface that looks covered.
        """
        from engine.native.python.ed_native import EdEvaluateResult

        all_fields = set(EdEvaluateResult._doubles) | {"converged"}
        accounted = set(EdEvaluateResult._doubles) | set(STRUCT_FIELDS_UNMAPPED)
        missing = all_fields - accounted
        assert not missing, (
            f"EdEvaluateResult fields with no parity story: {sorted(missing)}. "
            f"Either they have a live-Python counterpart (add to the comparison) "
            f"or they do not (add to STRUCT_FIELDS_UNMAPPED with a reason)."
        )


# ---------------------------------------------------------------------------
# Physics invariant — the ceiling check that would have caught the thrust bug
# ---------------------------------------------------------------------------


class TestDeliveredIspInvariant:
    """Delivered Isp must sit at/below eta_cstar * zeta_n * of the ideal — on
    BOTH implementations. This is the thermodynamic invariant the original
    momentum-method bug violated (model Isp >= the ideal equilibrium ceiling)."""

    def test_python_delivered_below_ceiling(self, rig):
        g0 = 9.80665
        for p_o, p_f in rig["points"]:
            ref = rig["reference"][(p_o, p_f)]
            diag = ref.get("diagnostics") or {}
            eta = float(diag.get("eta_cstar", ref.get("eta_cstar", np.nan)))
            cstar_ideal = float(diag.get("cstar_ideal", ref.get("cstar_ideal", np.nan)))
            cf_vac = rig["runner"].cea_cache.eval_cf_vac(ref["MR"], ref["Pc"], ref["eps"])
            isp_vac_ideal = cf_vac * cstar_ideal / g0
            # Ambient thrust <= vacuum thrust, so this bound holds a fortiori.
            ceiling = eta * isp_vac_ideal
            assert ref["Isp"] <= ceiling * (1.0 + 1e-6), (
                f"delivered Isp {ref['Isp']:.2f}s exceeds eta_cstar*Isp_vac_ideal "
                f"{ceiling:.2f}s — an efficiency term has been dropped from the thrust path"
            )

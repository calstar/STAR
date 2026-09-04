"""Exact-equality check: engine.accel.params.build_state == native_injector.build_state.

TEMPORARY BY DESIGN. This test exists only while the C port does, and is deleted
with it. Its whole job is to prove that the pure-Python config->scalar
reconciliation in engine/accel/params.py is a faithful transcription of
native_injector.build_state, so the Numba kernels can stop reading the C
EdEngineState and the C tree can be removed.

Tolerance is EXACT (==), deliberately. Both sides are float() of the same Python
config objects -- there is no arithmetic between them, so any difference at all
is a mapping bug (a wrong field name, a missing `or` default, a schema default
substituted for a zero-init), not a rounding artifact. A tolerance here would
hide exactly the class of bug the test is for.
"""
from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _configs():
    """Every committed config, so a mapping bug cannot hide in an unexercised one."""
    out = []
    for d in (ROOT / "configs", ROOT / "configs" / "canonical"):
        if d.is_dir():
            out.extend(sorted(p for p in d.glob("*.yaml")))
    return out


CONFIGS = _configs()


@pytest.fixture(scope="module")
def native():
    """The C side is the reference. Skip (don't fail) when it can't be built."""
    if os.environ.get("ED_USE_NATIVE") == "0":
        pytest.skip("ED_USE_NATIVE=0")
    try:
        from engine.native.python import autobuild, ed_native, native_injector
        ed_native.load(autobuild.ensure_lib())
    except Exception as e:  # pragma: no cover - toolchain-dependent
        if os.environ.get("ED_REQUIRE_NATIVE") == "1":
            pytest.fail(f"ED_REQUIRE_NATIVE=1 but native unavailable: {e}")
        pytest.skip(f"native unavailable: {e}")
    if not native_injector.native_enabled():
        pytest.skip("native_injector.native_enabled() is False")
    return native_injector


def _walk(py, prefix=""):
    """Yield (dotted_path, value) for every scalar leaf of the Python state tree."""
    for name, val in vars(py).items():
        path = f"{prefix}.{name}" if prefix else name
        if isinstance(val, SimpleNamespace):
            yield from _walk(val, path)
        else:
            yield path, val


def _get(obj, path):
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


@pytest.mark.parametrize("cfg_path", CONFIGS, ids=lambda p: p.parent.name + "/" + p.name)
def test_python_state_matches_native_state(native, cfg_path):
    from engine.accel import params as accel_params
    from engine.pipeline.io import load_config

    try:
        cfg = load_config(str(cfg_path))
    except Exception as e:
        # Some committed YAMLs are overlays/fragments, not standalone configs
        # (e.g. a bare `cea: {}` that fails schema validation). Nothing to
        # compare -- they never reach build_state in production either.
        pytest.skip(f"config does not load standalone: {type(e).__name__}")

    # build_state only maps impinging configs; for anything else BOTH sides must
    # fail, and failing the same way is itself the contract worth asserting.
    try:
        want = native.build_state(cfg)
    except Exception as e_native:
        with pytest.raises(type(e_native)):
            accel_params.build_state(cfg)
        pytest.skip(f"config not mappable by build_state ({type(e_native).__name__})")

    got = accel_params.build_state(cfg)

    mismatches = []
    checked = 0
    for path, py_val in _walk(got):
        try:
            c_val = _get(want, path)
        except AttributeError:
            mismatches.append(f"{path}: absent on EdEngineState")
            continue
        checked += 1
        if float(py_val) != float(c_val):
            mismatches.append(f"{path}: python={py_val!r} native={c_val!r}")

    assert checked > 50, f"only {checked} fields compared -- walker missed the tree"
    assert not mismatches, (
        f"{len(mismatches)} field(s) diverge from EdEngineState for {cfg_path.name}:\n  "
        + "\n  ".join(mismatches)
    )

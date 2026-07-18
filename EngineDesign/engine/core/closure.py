"""Closure logic: solve branch flows with spray constraints.

The impinging branch routes through the native C kernel (engine/native) when
``ED_USE_NATIVE`` is on (the default). The Python injector models below run for
everything native doesn't cover — pintle, coaxial, an unbuilt library, or
``ED_USE_NATIVE=0``. Dispatch is pure capability routing: ``native_injector.solve``
returns ``None`` for any config it can't handle and the Python model runs.

This native fast-path matters for performance even with the Layer-1 single-call
``ed_evaluate`` seam: ~30% of CMA candidates don't converge in the single-call native
path and fall back to ``runner.evaluate`` → ``chamber_solver`` → here, whose Brent
residual solves the injector many times. Keeping that native keeps the fallback fast.

Native↔Python parity is guaranteed by the golden test suite (engine/native/tests)
and the load-time ABI assert in ed_native.py — there is no runtime self-check.
"""

import os
from typing import Tuple, Dict, Any, Optional

from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.injectors import get_injector_model

# Build the native kernel on startup (background, non-blocking) when enabled, so the
# first evaluation does not pay the one-time CMake build cost. No-op by default.
if os.environ.get("ED_USE_NATIVE", "1") != "0":
    try:
        from engine.native.python import autobuild as _autobuild
        _autobuild.prewarm()
    except Exception:  # pragma: no cover - never let prewarm break import
        pass


def _try_native_flows(
    P_tank_O: float,
    P_tank_F: float,
    Pc: float,
    config: PintleEngineConfig,
) -> Optional[Tuple[float, float, Dict[str, Any]]]:
    """Native (mdot_O, mdot_F, diagnostics), or None if native is disabled or can't
    handle this config (the caller then falls back to the Python injector model).

    Parity is guaranteed by the golden test suite + the load-time ABI assert, not a
    runtime self-check (capability-dispatch architecture). Strict mode
    (``ED_REQUIRE_NATIVE=1``, the CI parity job) makes a *genuine* native failure —
    the library won't import or won't enable — raise instead of silently falling back
    to Python, which would report a false green. A config the kernel simply doesn't
    handle (``solve`` returns None) still falls back quietly; default runs are
    unaffected.
    """
    try:
        from engine.native.python import native_injector
    except Exception:
        if os.environ.get("ED_REQUIRE_NATIVE", "0") == "1":
            raise
        return None
    if not native_injector.available():
        if native_injector.require_native():
            raise RuntimeError("ED_REQUIRE_NATIVE=1 but the native path is not enabled/available")
        return None
    return native_injector.solve(config, P_tank_O, P_tank_F, Pc)


def flows(
    P_tank_O: float,
    P_tank_F: float,
    Pc: float,
    config: PintleEngineConfig,
) -> Tuple[float, float, Dict[str, Any]]:
    """Solve injector branch flows: returns (mdot_O, mdot_F, diagnostics)."""
    native = _try_native_flows(P_tank_O, P_tank_F, Pc, config)
    if native is not None:
        return native
    return get_injector_model(config).solve(P_tank_O, P_tank_F, Pc)

"""Closure logic: solve branch flows with spray constraints.

The impinging branch routes through the accelerator (engine/accel) when enabled
(the default). The Python injector models below run for everything it doesn't
cover — pintle, coaxial, a missing numba, or ``ED_ACCEL=off``. Dispatch is pure
capability routing: ``accel.solve`` returns ``None`` for any config it can't
handle and the Python model runs.

This native fast-path matters for performance even with the Layer-1 single-call
``ed_evaluate`` seam: ~30% of CMA candidates don't converge in the single-call native
path and fall back to ``runner.evaluate`` → ``chamber_solver`` → here, whose Brent
residual solves the injector many times. Keeping that native keeps the fallback fast.

Accelerator↔Python parity is enforced by tests/test_numba_ab_parity.py, which
diffs both live on the same inputs — there is no runtime self-check.
"""

import os
from typing import Tuple, Dict, Any, Optional

from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.injectors import get_injector_model

# Warm the JIT on import so the first evaluation does not pay compile/load cost.
try:
    from engine import accel as _accel
    if _accel.enabled():
        _accel.warmup()
except Exception:  # pragma: no cover - never let warmup break import
    pass


def _try_native_flows(
    P_tank_O: float,
    P_tank_F: float,
    Pc: float,
    config: PintleEngineConfig,
) -> Optional[Tuple[float, float, Dict[str, Any]]]:
    """Accelerated (mdot_O, mdot_F, diagnostics), or None if the accelerator is
    disabled or can't handle this config (caller falls back to the Python model).

    Parity is enforced by the A/B suite, not a runtime self-check (capability
    dispatch). Strict mode (``ED_REQUIRE_ACCEL=1``/``ED_REQUIRE_NATIVE=1``, the CI
    parity job) makes a *genuine* accelerator failure raise instead of silently
    falling back to Python, which would report a false green. A config the kernel
    simply doesn't handle (``solve`` returns None) still falls back quietly.
    """
    from engine import accel
    if not accel.enabled():
        if accel.require():
            raise RuntimeError("strict mode set but the accelerator is not enabled/available")
        return None
    return accel.solve(config, P_tank_O, P_tank_F, Pc)


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

"""Closure logic: solve branch flows with spray constraints.

By default this calls the Python injector models. When the environment variable
ED_USE_NATIVE=1 is set, the impinging branch is routed through the native C
kernel (engine/native) for the expensive feed-orifice fixed point, with:
  * automatic library build on first use (no manual cmake step), and
  * a one-time parity self-check against the Python solver — if mdot disagrees by
    more than 0.1%, native is disabled for the rest of the process and Python is
    used. This keeps default runs byte-identical and makes the native path safe to
    enable in production.
"""

import logging
import os
from typing import Tuple, Dict, Any, Optional

from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.injectors import get_injector_model

_logger = logging.getLogger(__name__)

# Build the native kernel on startup (background, non-blocking) when enabled, so
# the first evaluation does not pay the one-time CMake build cost. No-op by default.
if os.environ.get("ED_USE_NATIVE", "0") == "1":
    try:
        from engine.native.python import autobuild as _autobuild
        _autobuild.prewarm()
    except Exception:  # pragma: no cover - never let prewarm break import
        pass

# Process-wide native dispatch state: None=unchecked, True=use native, False=disabled.
_NATIVE_OK: Optional[bool] = None
_NATIVE_RTOL = 1e-3  # mdot parity tolerance for the self-check (matches Layer-1 spec)


def _native_close(a: float, b: float) -> bool:
    return abs(a - b) <= _NATIVE_RTOL * max(abs(b), 1e-12) + 1e-9


def _try_native_flows(
    P_tank_O: float,
    P_tank_F: float,
    Pc: float,
    config: PintleEngineConfig,
) -> Optional[Tuple[float, float, Dict[str, Any]]]:
    """Return native (mdot_O, mdot_F, diagnostics) or None to fall back to Python."""
    global _NATIVE_OK
    # Strict mode (ED_REQUIRE_NATIVE=1, CI parity job): native failures raise
    # instead of silently reverting to Python (which would pass on the fallback
    # and report a false green). Default runs are unaffected.
    require = os.environ.get("ED_REQUIRE_NATIVE", "0") == "1"
    if _NATIVE_OK is False:
        if require:
            raise RuntimeError("ED_REQUIRE_NATIVE=1 but native flows were disabled earlier this process")
        return None
    try:
        from engine.native.python import native_injector
    except Exception:
        _NATIVE_OK = False
        if require:
            raise
        return None
    if not native_injector.available():
        if require:
            raise RuntimeError("ED_REQUIRE_NATIVE=1 but ED_USE_NATIVE!=1 (native path not enabled)")
        return None

    res = native_injector.solve(config, P_tank_O, P_tank_F, Pc)
    if res is None:
        return None

    if _NATIVE_OK is None:
        # One-time correctness gate before trusting native for the session.
        try:
            p_mo, p_mf, _ = get_injector_model(config).solve(P_tank_O, P_tank_F, Pc)
            ok = _native_close(res[0], p_mo) and _native_close(res[1], p_mf)
        except Exception:
            ok = False
        _NATIVE_OK = ok
        if not ok:
            if require:
                raise RuntimeError(
                    f"ED_REQUIRE_NATIVE=1 parity self-check FAILED: native mdot="
                    f"({res[0]:g},{res[1]:g}) disagrees with Python beyond {_NATIVE_RTOL:g} rtol"
                )
            _logger.warning(
                "Native injector parity self-check failed (native mdot=(%g,%g)); "
                "disabling native path for this process.", res[0], res[1]
            )
            return None
        _logger.info("Native injector parity self-check passed; using native flows.")

    return res


def flows(
    P_tank_O: float,
    P_tank_F: float,
    Pc: float,
    config: PintleEngineConfig
) -> Tuple[float, float, Dict[str, Any]]:
    native = _try_native_flows(P_tank_O, P_tank_F, Pc, config)
    if native is not None:
        return native
    injector = get_injector_model(config)
    return injector.solve(P_tank_O, P_tank_F, Pc)

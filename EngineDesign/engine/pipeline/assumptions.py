"""Runtime assumptions registry — make every silent fallback VISIBLE (UNIFICATION_PLAN Phase 2c).

Motivation: the hardcoded-Cd incident. A value nobody remembers choosing (injector Cd_inf=0.4) sat in
a config default and silently wrecked optimizer runs. The fix pattern is not "no defaults" — solvers
need to keep running when a property is missing — it is **no INVISIBLE defaults**: every time the code
substitutes an assumed value for missing config data, that substitution is recorded here and surfaced
(rich stability report `assumptions.fallbacks_used`, logs, future /api/assumptions endpoint).

Usage (call-site pattern)::

    from engine.pipeline.assumptions import assume
    rho = cfg_rho if cfg_rho is not None else assume(
        "stability.rho_oxidizer", 1140.0, unit="kg/m^3",
        reason="fluids.oxidizer.density missing from config")

Registry is per-process (optimizer workers each carry their own — diagnostic, not authoritative).
``clear()`` at the start of an evaluation scope if per-run isolation matters.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)
_lock = threading.Lock()
_registry: Dict[str, Dict[str, Any]] = {}


def assume(name: str, value: Any, *, unit: str = "", reason: str = "") -> Any:
    """Record that ``value`` is being ASSUMED (config did not provide it) and return it.

    Re-recording the same name updates the count rather than spamming the log — fallbacks inside
    optimizer loops fire thousands of times.
    """
    with _lock:
        entry = _registry.get(name)
        if entry is None:
            _registry[name] = {"value": value, "unit": unit, "reason": reason, "count": 1}
            _log.warning("ASSUMED %s = %r %s (%s)", name, value, unit, reason)
        else:
            entry["count"] += 1
            entry["value"] = value
    return value


def get_assumptions() -> Dict[str, Dict[str, Any]]:
    """Snapshot of all assumptions used so far in this process."""
    with _lock:
        return {k: dict(v) for k, v in _registry.items()}


def fallbacks_used() -> List[Dict[str, Any]]:
    """Compact list form for report payloads: [{name, value, unit, reason, count}, ...]."""
    with _lock:
        return [{"name": k, **v} for k, v in sorted(_registry.items())]


def clear() -> None:
    with _lock:
        _registry.clear()

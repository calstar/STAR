"""Named drag models and the Cd tables the 6-DOF flies.

``DRAG_MODELS`` are the named models a request can pick (CLAUDE.md: named models over
tuned coefficients, so a result can say which assumption produced it):

* ``buildup`` (default) -- ``drag_buildup``: OpenRocket's component buildup with its
  long-rocket shortcuts replaced by handbook correlations.
* ``openrocket-24.12`` -- ``drag_openrocket``: OpenRocket's own model, formula for
  formula, for comparison with what the team sees in OpenRocket.
* ``stub`` -- the fixed Cd(Mach) curve the 6-DOF flew before any of this, kept so an
  older result can be reproduced exactly.

Drag depends on the Reynolds number as well as Mach. RocketPy (1.13) evaluates a drag
function of (alpha, beta, mach, reynolds, ...), with ``reynolds`` on the rocket's
diameter; :func:`drag_tables` tabulates each model over Mach x Reynolds and
:func:`rocketpy_drag` hands RocketPy a bilinear lookup. Angle of attack does not
enter -- zero-AoA drag, as OpenRocket's ``CD`` before its axial correction.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from . import drag_buildup, drag_openrocket
from .drag_geometry import DragGeometry

#: The fixed curve the 6-DOF flew before the drag models: subsonic ~0.45 with a
#: transonic bump. ``stub`` reproduces it exactly.
STUB_CURVE = [[0.0, 0.45], [0.6, 0.48], [0.9, 0.55], [1.0, 0.62], [1.2, 0.58], [2.0, 0.48], [5.0, 0.40]]

DEFAULT_MODEL = "buildup"
DRAG_MODELS = ("buildup", "openrocket-24.12", "stub")

#: Mach grid: fine through the transonic rise, coarse above.
MACH_GRID = np.unique(np.concatenate([np.arange(0.0, 2.0001, 0.05), np.arange(2.25, 5.0001, 0.25)]))
#: Diameter Reynolds numbers spanning a model rocket at a crawl to a large one at Mach 3.
RE_D_GRID = np.logspace(3.5, 8.5, 11)


def breakdown(geom: DragGeometry, model: str, mach: float, v_nu: float, *, power_on: bool = False):
    """One model's ``DragBreakdown`` at a flight condition."""
    if model == "buildup":
        return drag_buildup.drag(geom, mach, v_nu, power_on=power_on)
    if model == "openrocket-24.12":
        return drag_openrocket.drag(geom, mach, v_nu)
    if model == "stub":
        cd = float(np.interp(mach, [p[0] for p in STUB_CURVE], [p[1] for p in STUB_CURVE]))
        return drag_openrocket.DragBreakdown(cd=cd, terms={"stub curve": cd})
    raise ValueError(f"unknown drag model {model!r}; one of {', '.join(DRAG_MODELS)}")


@dataclass(frozen=True)
class DragTables:
    model: str
    mach: np.ndarray
    log_re_d: np.ndarray
    power_off: np.ndarray  # (len(mach), len(re))
    power_on: np.ndarray


def drag_tables(geom: DragGeometry, model: str) -> DragTables:
    d = 2 * geom.ref_radius
    off = np.empty((len(MACH_GRID), len(RE_D_GRID)))
    on = np.empty_like(off)
    for i, m in enumerate(MACH_GRID):
        for j, re_d in enumerate(RE_D_GRID):
            v_nu = re_d / d
            off[i, j] = breakdown(geom, model, float(m), v_nu).cd
            on[i, j] = breakdown(geom, model, float(m), v_nu, power_on=True).cd
    return DragTables(model, MACH_GRID.copy(), np.log10(RE_D_GRID), off, on)


def _bilinear(tab: np.ndarray, mach_grid: np.ndarray, lre_grid: np.ndarray) -> Callable[[float, float], float]:
    def f(mach: float, re_d: float) -> float:
        m = min(max(float(mach), mach_grid[0]), mach_grid[-1])
        lre = math.log10(max(float(re_d), 1.0))
        lre = min(max(lre, lre_grid[0]), lre_grid[-1])
        i = int(np.clip(np.searchsorted(mach_grid, m) - 1, 0, len(mach_grid) - 2))
        j = int(np.clip(np.searchsorted(lre_grid, lre) - 1, 0, len(lre_grid) - 2))
        u = (m - mach_grid[i]) / (mach_grid[i + 1] - mach_grid[i])
        v = (lre - lre_grid[j]) / (lre_grid[j + 1] - lre_grid[j])
        return float((1 - u) * (1 - v) * tab[i, j] + u * (1 - v) * tab[i + 1, j]
                     + (1 - u) * v * tab[i, j + 1] + u * v * tab[i + 1, j + 1])

    return f


def rocketpy_drag(tables: DragTables | None) -> tuple[object, object]:
    """(power_off_drag, power_on_drag) arguments for ``rocketpy.Rocket``.

    ``None`` (the stub) is the old Mach-only curve itself, so ``stub`` flies exactly the
    trajectory it always did.
    """
    if tables is None:
        return STUB_CURVE, STUB_CURVE
    off = _bilinear(tables.power_off, tables.mach, tables.log_re_d)
    on = _bilinear(tables.power_on, tables.mach, tables.log_re_d)

    def power_off(alpha, beta, mach, reynolds, pitch_rate, yaw_rate, roll_rate):
        return off(mach, reynolds)

    def power_on(alpha, beta, mach, reynolds, pitch_rate, yaw_rate, roll_rate):
        return on(mach, reynolds)

    return power_off, power_on


def curve_at(tables: DragTables | None, re_per_mach: float) -> dict:
    """Cd(Mach) at a fixed V/nu-per-Mach (``re_per_mach`` = a * D / nu): one line of
    the table at the launch site's air, for display."""
    if tables is None:
        return {"mach": [p[0] for p in STUB_CURVE], "powerOff": [p[1] for p in STUB_CURVE],
                "powerOn": [p[1] for p in STUB_CURVE]}
    off = _bilinear(tables.power_off, tables.mach, tables.log_re_d)
    on = _bilinear(tables.power_on, tables.mach, tables.log_re_d)
    ms = [float(m) for m in tables.mach if m <= 3.0]
    return {
        "mach": ms,
        "powerOff": [off(m, max(m, 1e-3) * re_per_mach) for m in ms],
        "powerOn": [on(m, max(m, 1e-3) * re_per_mach) for m in ms],
    }

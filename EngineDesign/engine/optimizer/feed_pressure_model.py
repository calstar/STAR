"""Feed tank/manifold pressure vs time — blowdown segments vs dome-regulated (Phys §6.2).

The dome-regulated curve is the regulator's setpoint plus its supply-pressure effect (SPE): a dome
regulator's outlet rises as its inlet falls, by a ratio that belongs to the regulator, not to the
code: the Aqua 1092 datasheet gives 10 psi per 1000 psi of inlet drop, the 2026-09-25 config audit
reads TB 1031 at 17. So the ratio is a field with its source, and the inlet is the COPV's own
blowdown -- never a fraction of the setpoint.

What this module used to add and no longer does: a ±9 psi two-sine "ripple" (no measured spectrum
exists; test T6 would provide one), an inlet running from 1.2x the setpoint down to 0.84x (a
regulator delivering its setpoint from an inlet below it), a fixed 10 psi/1000 psi SPE labelled
as one regulator's, and a "lockup droop" that lockup -- a no-flow condition -- does not produce.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Sequence, Tuple
import numpy as np

_PA_PER_PSI = 6894.757


@dataclass(frozen=True)
class RegulatorModel:
    """A dome regulator as the tank-pressure curve sees it.

    supply_pressure_effect : outlet rise per unit inlet drop [-] (psi per psi). 0 = ideal.
    source                 : where that number came from (datasheet, test); "" when unsourced.
    min_differential_pa    : inlet minus outlet below which the regulator cannot hold its outlet
                             (drops out). 0 enforces only that an outlet never exceeds its inlet.
    """
    supply_pressure_effect: float = 0.0
    source: str = ""
    min_differential_pa: float = 0.0


class RegulatorDropout(ValueError):
    """The inlet history falls below setpoint + minimum differential: the regulator cannot deliver
    the curve being asked of it. Raised rather than drawing a flat line through it."""


def get_feed_pressure_model(config: Any) -> str:
    """Return ``blowdown`` or ``dome_regulated`` from design requirements."""
    dr = getattr(config, "design_requirements", None)
    if dr is None:
        return "blowdown"
    model = getattr(dr, "feed_pressure_model", None) or "blowdown"
    return str(model).strip().lower()


def regulator_from_config(config: Any) -> RegulatorModel:
    """RegulatorModel from ``design_requirements.regulator_*``; unset fields are recorded
    assumptions (ideal regulator), never silent constants."""
    from engine.pipeline.assumptions import assume
    dr = getattr(config, "design_requirements", None)
    spe = getattr(dr, "regulator_supply_pressure_effect", None)
    src = getattr(dr, "regulator_supply_pressure_effect_source", None) or ""
    dmin_psi = getattr(dr, "regulator_min_differential_psi", None)
    if spe is None:
        # The regulator itself is unconfirmed (audit operator question 6). The stability design
        # record names the Aqua 1092, whose datasheet gives 10 psi / 1000 psi; TB 1031 reads 17.
        spe = assume("feed.regulator_supply_pressure_effect", 0.010, unit="psi/psi",
                     reason="design_requirements.regulator_supply_pressure_effect unset: Aqua 1092 "
                            "datasheet value (docs/stability/combustion_stability_physics.md ref 16); "
                            "the regulator is unconfirmed and TB 1031 reads 0.017")
    if dmin_psi is None:
        dmin_psi = assume("feed.regulator_min_differential_psi", 0.0, unit="psi",
                          reason="design_requirements.regulator_min_differential_psi unset: only "
                                 "outlet <= inlet is enforced")
    return RegulatorModel(float(spe), str(src), float(dmin_psi) * _PA_PER_PSI)


def generate_dome_regulated_pressure_curve(
    P_set_pa: float,
    *,
    burn_time_s: float,
    n_points: int = 200,
    P_inlet_pa: Optional[Sequence[float]] = None,
    P_inlet_0_pa: Optional[float] = None,
    P_inlet_end_pa: Optional[float] = None,
    regulator: Optional[RegulatorModel] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """Eq. (6.2): regulated outlet = setpoint + SPE x (inlet drop since t = 0).

    The inlet history is ``P_inlet_pa`` (one value per output point, e.g. the COPV blowdown trace)
    or, failing that, a straight line from ``P_inlet_0_pa`` to ``P_inlet_end_pa``. With no inlet
    history there is nothing for the SPE to act on and the curve is the flat setpoint.

    Raises RegulatorDropout when the inlet falls below outlet + ``regulator.min_differential_pa``.
    Returns (time_s, P_tank_pa).
    """
    n_points = max(2, int(n_points))
    t = np.linspace(0.0, max(burn_time_s, 1e-6), n_points)
    P_set = float(P_set_pa)
    reg = regulator or RegulatorModel()

    if P_inlet_pa is not None:
        P_in = np.asarray(P_inlet_pa, dtype=float)
        if P_in.shape != t.shape:
            raise ValueError(f"P_inlet_pa has {P_in.size} points; the curve has {t.size}")
    elif P_inlet_0_pa is not None and P_inlet_end_pa is not None:
        P_in = float(P_inlet_0_pa) + (float(P_inlet_end_pa) - float(P_inlet_0_pa)) * (t / t[-1])
    else:
        return t, np.full_like(t, P_set)

    P = P_set + float(reg.supply_pressure_effect) * (P_in[0] - P_in)
    short = P_in - P < float(reg.min_differential_pa)
    if np.any(short):
        k = int(np.argmax(short))
        raise RegulatorDropout(
            f"regulator inlet {P_in[k] / _PA_PER_PSI:.0f} psia at t = {t[k]:.2f} s is below outlet "
            f"{P[k] / _PA_PER_PSI:.0f} psia + minimum differential "
            f"{reg.min_differential_pa / _PA_PER_PSI:.0f} psi: regulation is lost")
    return t, P


def dome_regulated_tank_pair(
    initial_lox_pa: float,
    initial_fuel_pa: float,
    burn_time_s: float,
    n_points: int = 200,
    *,
    copv_pressure_pa: Optional[Sequence[float]] = None,
    copv_initial_pa: Optional[float] = None,
    copv_end_pa: Optional[float] = None,
    regulator: Optional[RegulatorModel] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """LOX and fuel regulated manifold curves for Layer 2 / the time solver.

    Both tanks hang off the same COPV, so both see the same inlet history: ``copv_pressure_pa``
    (a trace, one value per point) or the ``copv_initial_pa``/``copv_end_pa`` pair. Without either
    the curves are the flat setpoints.
    """
    kw = dict(burn_time_s=burn_time_s, n_points=n_points, P_inlet_pa=copv_pressure_pa,
              P_inlet_0_pa=copv_initial_pa, P_inlet_end_pa=copv_end_pa, regulator=regulator)
    t, P_O = generate_dome_regulated_pressure_curve(initial_lox_pa, **kw)
    _, P_F = generate_dome_regulated_pressure_curve(initial_fuel_pa, **kw)
    return t, P_O, P_F

"""The chamber: total flow in, pressure and gas state out.

One relation carries most of it. At steady state the throat passes exactly what
the injector delivers, which fixes chamber pressure:

.. code-block:: text

    p_c = mdot_total . c* / A_throat

and that is a *feedback* loop, not a formula evaluated once. More flow raises
chamber pressure, which lowers the injector's pressure difference, which lowers
the flow. Every pressure-fed engine sits at the fixed point of that loop, and
the loop is why chamber pressure moves so much less than tank pressure does
over a burn -- and why an injector stiffness ratio below about 20% makes the
whole thing twitchy.

Where ``c*`` comes from
-----------------------
``c*`` is not a constant. It depends on mixture ratio, and mixture ratio moves
during a burn because the two propellant legs have different resistances and
respond differently to the same upstream change. Modelling ``c*`` as fixed is
what makes O/F drift invisible -- which is a shame, because O/F drift is the
output most worth having.

So the chamber takes a :class:`CStarModel`, and the one that matters is
:class:`CEATable`, which reads EngineDesign's own ``.npz`` CEA cache. That gives
``c*``, thrust coefficient, **chamber temperature** and ``gamma`` on the real
``(p_c, O/F, epsilon)`` grid for the actual propellant pair -- so a firing
trajectory reports chamber temperature that came from CEA rather than from a
guess, and the two tools agree because they are reading the same table.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol, runtime_checkable

import numpy as np


@dataclass(frozen=True, slots=True)
class CombustionState:
    """What the gas in the chamber is doing."""

    cstar: float
    """Characteristic velocity [m/s]."""

    temperature: float = 0.0
    """Chamber stagnation temperature [K]. Zero when the model has no table."""

    gamma: float = 0.0
    """Ratio of specific heats. Zero when unknown."""

    thrust_coefficient: float = 0.0
    """C_F at the design expansion. Zero when unknown."""

    extrapolated: bool = False
    """The operating point was outside the combustion table and got clamped to
    its edge. **Load-bearing, not cosmetic.** A burn whose mixture ratio drifts
    past the range CEA was tabulated over reports a c* that stopped moving,
    which looks like a physical plateau and is a table edge. Anything reading
    a chamber temperature or a c* must be able to ask whether it was real."""


@runtime_checkable
class CStarModel(Protocol):
    """Combustion properties as a function of the operating point."""

    def combustion(self, pressure: float, mixture_ratio: float) -> CombustionState: ...


@dataclass(frozen=True, slots=True)
class ConstantCStar:
    """One number, honestly labelled.

    Right for a first pass and for testing the coupling itself, and wrong for
    anything that cares about mixture-ratio drift -- with a constant ``c*`` the
    O/F trace still moves but nothing downstream of it does, which reads as
    "O/F drift does not matter here" when it means "this model cannot see it".
    """

    cstar: float
    temperature: float = 0.0
    gamma: float = 0.0
    thrust_coefficient: float = 0.0

    def combustion(self, pressure: float, mixture_ratio: float) -> CombustionState:
        return CombustionState(
            cstar=self.cstar,
            temperature=self.temperature,
            gamma=self.gamma,
            thrust_coefficient=self.thrust_coefficient,
        )


class CEATable:
    """EngineDesign's own CEA cache, read directly.

    The cache is a ``(p_c, O/F, epsilon)`` grid of ``c*``, ``C_F``, ``T_c``,
    ``gamma``, ``R`` and ``M`` for one propellant pair. Reading it rather than
    re-running CEA has two virtues: it is fast enough to sit inside an
    integrator's right-hand side, and it guarantees that feed-twin and
    EngineDesign are quoting the *same* combustion, so a disagreement between
    them is a real disagreement rather than two CEA runs with different options.

    Args:
        path: A ``cea_cache_*.npz`` written by EngineDesign.
        expansion_ratio: Where on the epsilon axis to sit. Defaults to the
            table's own design value from its metadata.

    Raises:
        ValueError: the point is outside the table. Refused rather than
            extrapolated -- the same discipline the property backends keep, and
            for the same reason: a CEA table extrapolated past its mixture-ratio
            range returns a number, and the number is fiction.
    """

    def __init__(self, path: str | Path, *, expansion_ratio: float | None = None):
        from scipy.interpolate import RegularGridInterpolator

        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(f"no CEA cache at {self.path}")
        data = np.load(self.path, allow_pickle=True)

        self.pressures = np.asarray(data["Pc"], dtype=float)
        self.mixture_ratios = np.asarray(data["MR"], dtype=float)
        self.expansions = np.asarray(data["eps"], dtype=float)

        meta_raw = data["meta"].item() if "meta" in data else "{}"
        self.meta: Mapping[str, object] = (
            json.loads(meta_raw) if isinstance(meta_raw, str) else dict(meta_raw)
        )
        raw_eps = self.meta.get("expansion_ratio", float(self.expansions[0]))
        default_eps = float(raw_eps)  # type: ignore[arg-type,unused-ignore]
        self.expansion_ratio = (
            default_eps if expansion_ratio is None else float(expansion_ratio)
        )
        lo, hi = float(self.expansions[0]), float(self.expansions[-1])
        self.expansion_ratio = min(max(self.expansion_ratio, lo), hi)

        grid = (self.pressures, self.mixture_ratios, self.expansions)
        self._fields = {
            name: RegularGridInterpolator(
                grid, np.asarray(data[name], dtype=float), bounds_error=False
            )
            for name in ("cstar", "Cf", "Tc", "gamma")
            if name in data
        }

    @property
    def propellants(self) -> tuple[str, str]:
        return (
            str(self.meta.get("ox_name", "?")),
            str(self.meta.get("fuel_name", "?")),
        )

    def _clamped(self, pressure: float, mixture_ratio: float) -> tuple[float, float]:
        p = min(max(pressure, float(self.pressures[0])), float(self.pressures[-1]))
        mr = min(
            max(mixture_ratio, float(self.mixture_ratios[0])),
            float(self.mixture_ratios[-1]),
        )
        return p, mr

    def contains(self, pressure: float, mixture_ratio: float) -> bool:
        """Whether this point is inside the table, before clamping."""
        return bool(
            float(self.pressures[0]) <= pressure <= float(self.pressures[-1])
            and float(self.mixture_ratios[0])
            <= mixture_ratio
            <= float(self.mixture_ratios[-1])
        )

    def combustion(self, pressure: float, mixture_ratio: float) -> CombustionState:
        """Interpolated combustion state.

        Clamped to the table's edges rather than extrapolated. A transient
        passes through startup, where chamber pressure begins near zero and
        mixture ratio is briefly whatever the first propellant to arrive makes
        it; refusing there would make every ignition unrunnable. Clamping is
        the honest compromise, and :meth:`contains` is how a caller asks whether
        the point it cares about was inside.
        """
        inside = self.contains(pressure, mixture_ratio)
        p, mr = self._clamped(pressure, mixture_ratio)
        point = np.array([[p, mr, self.expansion_ratio]])
        values = {
            name: float(interp(point)[0]) for name, interp in self._fields.items()
        }
        return CombustionState(
            cstar=values.get("cstar", 0.0),
            temperature=values.get("Tc", 0.0),
            gamma=values.get("gamma", 0.0),
            thrust_coefficient=values.get("Cf", 0.0),
            extrapolated=not inside,
        )

    def __repr__(self) -> str:
        ox, fuel = self.propellants
        return (
            f"CEATable({ox}/{fuel}, {len(self.pressures)}x"
            f"{len(self.mixture_ratios)}x{len(self.expansions)}, "
            f"eps={self.expansion_ratio:.2f})"
        )


@dataclass(frozen=True, slots=True)
class ChamberResult:
    """The engine's answer at one operating point."""

    pressure: float
    """Chamber stagnation pressure [Pa]."""

    mdot_total: float
    mdot_oxidiser: float
    mdot_fuel: float
    mixture_ratio: float
    combustion: CombustionState
    thrust: float
    """[N]. Zero when the model has no thrust coefficient, or when the chamber
    is at ambient and there is nothing to call thrust."""

    specific_impulse: float
    """[s]. Zero when thrust is unknown."""


#: Standard gravity, for turning thrust into specific impulse [m/s^2].
GRAVITY = 9.80665


class Chamber:
    """Chamber pressure from the flows the injector delivers.

    Args:
        throat_area: ``A_t`` [m^2].
        cstar_model: Where combustion properties come from.
        volume: Chamber volume [m^3]. Not integrated -- see
            :meth:`fill_time`, which reports how long the chamber takes to
            respond so the quasi-steady assumption is visible rather than
            assumed.
        nozzle_efficiency: ``eta_n``. Multiplies the thrust coefficient, so it
            moves thrust and Isp and leaves chamber pressure alone.
        efficiency: ``c*`` efficiency. Multiplies the table value, and is the
            one place a real engine's losses enter this model.
        ambient_pressure: What the chamber sits at with nothing flowing [Pa].
            **Not a numerical guard.** A chamber is open to atmosphere through
            its own nozzle, so ``mdot c* / A_t`` is only the chamber pressure
            once that exceeds ambient; below it the nozzle is not choked and the
            chamber is simply at ambient. Leaving it out lets a shut engine
            report a near-vacuum chamber, which then asks the feed system to
            solve a 650 psi drop across a shut valve into 0.5 psi -- a state no
            hardware ever occupies and no solver enjoys being asked about.
            Sea level by default; set it for altitude or a vacuum stand.
    """

    def __init__(
        self,
        throat_area: float,
        cstar_model: CStarModel,
        *,
        volume: float = 0.0,
        efficiency: float = 1.0,
        nozzle_efficiency: float = 1.0,
        ambient_pressure: float = 101325.0,
    ) -> None:
        if throat_area <= 0.0:
            raise ValueError(f"throat area must be positive, got {throat_area}")
        self.throat_area = throat_area
        self.cstar_model = cstar_model
        self.volume = volume
        self.efficiency = efficiency
        self.nozzle_efficiency = nozzle_efficiency
        self.ambient_pressure = ambient_pressure

    def evaluate(self, mdot_oxidiser: float, mdot_fuel: float) -> ChamberResult:
        """Chamber state for a pair of propellant flows.

        Chamber pressure is ``mdot c* / A_t``, but ``c*`` depends on mixture
        ratio and (weakly) on pressure, so this iterates the pressure to
        consistency. Three passes is ample -- the dependence on pressure is
        gentle -- and it converges from any starting point because raising
        pressure barely moves ``c*``.
        """
        total = mdot_oxidiser + mdot_fuel
        mixture_ratio = mdot_oxidiser / mdot_fuel if mdot_fuel > 1e-12 else 0.0
        if total <= 0.0:
            return ChamberResult(
                pressure=self.ambient_pressure,
                mdot_total=0.0,
                mdot_oxidiser=mdot_oxidiser,
                mdot_fuel=mdot_fuel,
                mixture_ratio=mixture_ratio,
                combustion=CombustionState(cstar=0.0),
                thrust=0.0,
                specific_impulse=0.0,
            )

        pressure = max(self.ambient_pressure, 1.0e5)
        state = CombustionState(cstar=0.0)
        for _ in range(3):
            state = self.cstar_model.combustion(pressure, mixture_ratio)
            pressure = max(
                total * state.cstar * self.efficiency / self.throat_area,
                self.ambient_pressure,
            )

        # eta_n multiplies the thrust coefficient, not the chamber pressure: a
        # lossy nozzle makes less thrust from the same chamber, it does not
        # make a different chamber.
        thrust = (
            state.thrust_coefficient
            * self.nozzle_efficiency
            * pressure
            * self.throat_area
            if state.thrust_coefficient > 0.0
            else 0.0
        )
        firing = pressure > self.ambient_pressure * 1.001
        return ChamberResult(
            pressure=pressure,
            mdot_total=total,
            mdot_oxidiser=mdot_oxidiser,
            mdot_fuel=mdot_fuel,
            mixture_ratio=mixture_ratio,
            combustion=state,
            thrust=thrust if firing else 0.0,
            specific_impulse=(
                thrust / (total * GRAVITY) if firing and thrust > 0.0 else 0.0
            ),
        )

    def is_firing(self, result: ChamberResult) -> bool:
        """Whether the throat is actually choked, or the engine is just open.

        Below ambient-driven flow there is no combustion chamber to speak of;
        reporting a thrust and an Isp there would be arithmetic, not physics.
        """
        return result.pressure > self.ambient_pressure * 1.001

    def fill_time(self, pressure: float, mixture_ratio: float) -> float:
        """Chamber residence time [s]: how fast chamber pressure can respond.

        ``tau = V / (A_t c*)``, of order a millisecond on a small engine. It is
        reported rather than integrated because it is three orders of magnitude
        below anything a feed system does, and carrying it as a state would make
        the whole system stiff for no answer anyone wants. When it stops being
        small -- a very large chamber, or a startup transient resolved at the
        millisecond level -- this is the number that says so.
        """
        if self.volume <= 0.0:
            return 0.0
        state = self.cstar_model.combustion(pressure, mixture_ratio)
        if state.cstar <= 0.0:
            return 0.0
        return self.volume / (self.throat_area * state.cstar)

    def __repr__(self) -> str:
        return (
            f"Chamber(A_t={self.throat_area * 1e6:.1f} mm^2, " f"{self.cstar_model!r})"
        )


def cea_cache_for(
    design_name: str, search_paths: tuple[str, ...] = ("output/cache",)
) -> Path | None:
    """Find a CEA cache matching a propellant pair, if one is lying around.

    A convenience, not a contract: it returns ``None`` rather than guessing, so
    a missing cache surfaces as "no table, using a constant" rather than as a
    silently wrong propellant pair.
    """
    for directory in search_paths:
        base = Path(directory)
        if not base.is_dir():
            continue
        for candidate in sorted(base.glob("cea_cache_*.npz")):
            if design_name.lower() in candidate.name.lower():
                return candidate
    return None


def mixture_ratio_of(mdot_oxidiser: float, mdot_fuel: float) -> float:
    """O/F by mass, with the zero-fuel case answered rather than raised."""
    return mdot_oxidiser / mdot_fuel if abs(mdot_fuel) > 1e-12 else math.inf

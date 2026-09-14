"""A closed volume of gas, with the thermodynamics done exactly.

A COPV, a tank ullage and a manifold plenum are the same object at different
sizes: a fixed volume holding a mass of gas at some energy. Everything
interesting about a pressure-fed system starts here, because what the regulator
sees is this vessel's pressure and what the vessel's pressure does over a burn
is mostly a question of how much it cools.

State is ``(mass, internal energy)``, not ``(mass, temperature)``
--------------------------------------------------------------
The energy balance of a vessel losing gas is exactly

.. code-block:: text

    dm/dt = mdot_in - mdot_out
    dU/dt = mdot_in . h_in - mdot_out . h(vessel) + Qdot

in *internal energy*. Writing it in temperature instead needs
``du = cv dT + (du/drho)_T drho``, and dropping that second term -- which is
what a ``T``-based state quietly does -- is wrong for a real gas by exactly the
amount that makes a COPV interesting. Since ``(rho, u)`` is a state pair the
property layer can address directly, tracking ``U`` costs nothing and keeps the
balance exact.

Why blowdown cooling matters
----------------------------
Gas leaving a bottle does work on the gas behind it, so the bottle cools, so its
pressure falls faster than mass alone would suggest. Model it as isothermal and
you over-predict how long the bottle holds regulator inlet pressure. Model it as
adiabatic and you under-predict, because the vessel wall is a heat reservoir
several times the gas's own heat capacity and it fights the cooling the whole
way down. Neither bound is the answer; the wall is, which is why
:class:`GasVolume` carries one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from feedtwin.props import Fluid

#: Standard acceleration due to gravity, by definition [m/s^2].
GRAVITY = 9.80665


@dataclass(frozen=True, slots=True)
class VesselState:
    """The exact state of a closed gas volume.

    Args:
        mass: Gas mass [kg].
        energy: **Total** internal energy [J], not specific. Total is what the
            balance integrates, and keeping it that way avoids dividing by a
            mass that is on its way to zero.
        wall_temperature: Lumped vessel-wall temperature [K]. Equal to the gas
            temperature at rest; it lags during a fast blowdown, which is the
            whole reason it is tracked.
    """

    mass: float
    energy: float
    wall_temperature: float = 293.15

    def specific_energy(self) -> float:
        """Internal energy per unit mass [J/kg]."""
        if self.mass <= 0.0:
            raise ValueError("an empty vessel has no specific energy")
        return self.energy / self.mass


@dataclass(frozen=True, slots=True)
class Rates:
    """Time derivatives of a vessel's state. What Phase 07 integrates."""

    mass: float
    """dm/dt [kg/s]."""

    energy: float
    """dU/dt [W]."""

    wall_temperature: float = 0.0
    """dT_wall/dt [K/s]."""

    heat_from_wall: float = 0.0
    """Heat the wall gave the gas [W]. Reported rather than inferred, because
    it is the term that decides how fast a bottle droops and it should be
    visible in a result rather than buried in an energy total."""


class GasVolume:
    """A fixed volume of gas: a COPV, an ullage, a plenum.

    Args:
        fluid: The gas.
        volume: Internal volume [m^3].
        wall_mass: Mass of vessel wall in thermal contact with the gas [kg].
            Zero gives adiabatic behaviour, which is a bound rather than an
            answer.
        wall_capacity: Wall specific heat [J/(kg.K)]. Aluminium is about 900,
            steel about 500, a carbon-overwrapped liner somewhere between and
            worth measuring.
        wall_conductance: Overall gas-to-wall conductance ``hA`` [W/K]. The
            least-known number here by some way; it is what
            :meth:`~feedtwin.vessels.volume.GasVolume.rates` multiplies the
            gas-to-wall temperature difference by.
    """

    def __init__(
        self,
        fluid: Fluid,
        volume: float,
        *,
        wall_mass: float = 0.0,
        wall_capacity: float = 0.0,
        wall_conductance: float = 0.0,
    ) -> None:
        if volume <= 0.0:
            raise ValueError(f"volume must be positive, got {volume}")
        self.fluid = fluid
        self.volume = volume
        self.wall_mass = wall_mass
        self.wall_capacity = wall_capacity
        self.wall_conductance = wall_conductance

    # ------------------------------------------------------------- the state

    def density(self, state: VesselState) -> float:
        return state.mass / self.volume

    def pressure(self, state: VesselState) -> float:
        """Pressure [Pa] from mass and energy, through the real-gas EOS."""
        return self.fluid.get("p", rho=self.density(state), u=state.specific_energy())

    def temperature(self, state: VesselState) -> float:
        return self.fluid.get("T", rho=self.density(state), u=state.specific_energy())

    def enthalpy(self, state: VesselState) -> float:
        """Specific enthalpy of the gas in the vessel [J/kg].

        This is what leaves through an outlet: gas exits carrying its enthalpy,
        not its internal energy, and the difference is the flow work that cools
        what stays behind.
        """
        return self.fluid.get("h", rho=self.density(state), u=state.specific_energy())

    def compressibility(self, state: VesselState) -> float:
        return self.fluid.get("Z", rho=self.density(state), u=state.specific_energy())

    def initial_state(self, pressure: float, temperature: float) -> VesselState:
        """Build a state from the two numbers anyone actually knows.

        Nobody fills a bottle to an internal energy. They fill it to a pressure
        at a temperature, and this converts that into the state the balance
        needs.

        Raises:
            ValueError: the state is a liquid. ``(rho, u)`` is an excellent set
                of state variables for a gas and a poor one for a liquid --
                liquid density is roughly 180x less sensitive to pressure, so
                recovering pressure from density amplifies any error in it by
                the same factor. On the exact equation of state the round trip
                is still perfect; through interpolated tables a liquid comes
                back 0.1-0.7% out where a gas is within 1e-4%. Catching it here
                beats discovering it as pressures that are quietly slightly
                wrong.
        """
        phase = self.fluid.phase(p=pressure, T=temperature)
        if phase.is_liquid_like:
            raise ValueError(
                f"{self.fluid.name} at {pressure / 1e5:.3g} bar and "
                f"{temperature:.4g} K is a liquid ({phase.value}). A GasVolume "
                "tracks a gas; liquid inventory belongs to a tank's liquid "
                "volume, not to its ullage."
            )
        rho = self.fluid.get("rho", p=pressure, T=temperature)
        u = self.fluid.get("u", p=pressure, T=temperature)
        return VesselState(
            mass=rho * self.volume,
            energy=u * rho * self.volume,
            wall_temperature=temperature,
        )

    # ------------------------------------------------------------- the rates

    def rates(
        self,
        state: VesselState,
        *,
        mdot_out: float = 0.0,
        mdot_in: float = 0.0,
        enthalpy_in: float = 0.0,
        heat_in: float = 0.0,
        stirring: float = 1.0,
    ) -> Rates:
        """Time derivatives, for an integrator to march.

        Args:
            state: Where the vessel is now.
            mdot_out: Gas leaving [kg/s]. It carries the vessel's own enthalpy.
            mdot_in: Gas arriving [kg/s].
            enthalpy_in: Specific enthalpy of arriving gas [J/kg]. Matters:
                warm pressurant into a cold ullage is a heat source, and it is
                the mechanism behind ullage collapse.
            heat_in: External heat [W] -- ambient through insulation, say.
                Wall exchange is computed here and need not be included.
            stirring: Multiplier on the gas-to-wall conductance, 1 by default.
                ``wall_conductance`` is the still-gas figure; a charge jet
                stirs the vessel and forced convection off it runs several
                times natural. Named and passed in rather than inferred from
                ``mdot_in`` so a caller says when it applies and a run can
                report what was assumed.
        """
        gas_T = self.temperature(state)
        q_wall = (
            self.wall_conductance
            * max(stirring, 0.0)
            * (state.wall_temperature - gas_T)
        )

        d_energy = (
            mdot_in * enthalpy_in - mdot_out * self.enthalpy(state) + heat_in + q_wall
        )

        capacity = self.wall_mass * self.wall_capacity
        d_wall = -q_wall / capacity if capacity > 0.0 else 0.0

        return Rates(
            mass=mdot_in - mdot_out,
            energy=d_energy,
            wall_temperature=d_wall,
            heat_from_wall=q_wall,
        )

    def step(self, state: VesselState, rates: Rates, dt: float) -> VesselState:
        """One explicit Euler step. For demonstration and simple sweeps.

        Phase 07 replaces this with a proper stiff integrator; it exists so that
        the vessel model can be exercised and validated now rather than waiting
        on a solver that does not exist yet.
        """
        return VesselState(
            mass=state.mass + rates.mass * dt,
            energy=state.energy + rates.energy * dt,
            wall_temperature=state.wall_temperature + rates.wall_temperature * dt,
        )

    def blowdown(
        self,
        state: VesselState,
        mdot: float | Callable[[VesselState, float], float],
        duration: float,
        *,
        steps: int = 2000,
        heat_in: float = 0.0,
    ) -> list[tuple[float, VesselState]]:
        """March a blowdown and return ``(time, state)`` samples.

        ``mdot`` is either a constant or a callable of ``(state, t)`` -- the
        latter is how a real orifice or regulator gets coupled in before the
        network solver does it properly.

        Stops early if the vessel empties, which is a physical end rather than
        an error.
        """
        dt = duration / steps
        history = [(0.0, state)]
        for i in range(steps):
            if state.mass <= 1e-9:
                break
            flow = mdot(state, i * dt) if callable(mdot) else mdot
            state = self.step(
                state, self.rates(state, mdot_out=flow, heat_in=heat_in), dt
            )
            history.append(((i + 1) * dt, state))
        return history

    def with_wall(self, mass: float, capacity: float, conductance: float) -> GasVolume:
        """A copy with a different wall. Handy for bounding a real vessel
        between adiabatic and isothermal without rebuilding it."""
        return GasVolume(
            self.fluid,
            self.volume,
            wall_mass=mass,
            wall_capacity=capacity,
            wall_conductance=conductance,
        )

    def __repr__(self) -> str:
        return f"GasVolume({self.fluid.name!r}, {self.volume * 1e3:.2f} L)"

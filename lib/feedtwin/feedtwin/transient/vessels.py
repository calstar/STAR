"""State-owner adapters for the Phase 05 vessels.

The vessel classes are deliberately stateless -- ``GasVolume`` and ``Tank`` take
a state and return rates, and hold nothing themselves. That is right for
testing and wrong for an integrator, which wants an object it can push a state
into and ask for derivatives.

These adapters bridge the two without putting mutable state into the physics.
The vessel stays a pure function of its state; the adapter is the only thing
that remembers where the integrator has got to, and the only thing that has to
be reset between runs.
"""

from __future__ import annotations

from typing import Sequence

from feedtwin.props import Fluid
from feedtwin.vessels.tank import Tank, TankState
from feedtwin.vessels.volume import GasVolume, VesselState


class GasVolumeOwner:
    """A COPV or plenum as an integrable object.

    Args:
        id: Tag, matching the network node this vessel sets the pressure of.
        volume: The vessel physics.
        state: Its starting state.
        node: Network node whose pressure this vessel drives. Defaults to the
            vessel's own id, which is the common case and one less thing to
            keep in step.
    """

    def __init__(
        self,
        id: str,
        volume: GasVolume,
        state: VesselState,
        *,
        node: str = "",
    ) -> None:
        self.id = id
        self.volume = volume
        self.state = state
        self.node = node or id
        # Flows written by the coupling each step, read by derivatives().
        self.mdot_out = 0.0
        self.mdot_in = 0.0
        self.enthalpy_in = 0.0
        self.heat_in = 0.0

    def state_names(self) -> Sequence[str]:
        return ("mass", "energy", "wall_temperature")

    def pack(self) -> Sequence[float]:
        return (self.state.mass, self.state.energy, self.state.wall_temperature)

    def unpack(self, values: Sequence[float]) -> None:
        self.state = VesselState(
            mass=float(values[0]),
            energy=float(values[1]),
            wall_temperature=float(values[2]),
        )

    def derivatives(self, t: float) -> Sequence[float]:
        rates = self.volume.rates(
            self.state,
            mdot_out=self.mdot_out,
            mdot_in=self.mdot_in,
            enthalpy_in=self.enthalpy_in,
            heat_in=self.heat_in,
        )
        return (rates.mass, rates.energy, rates.wall_temperature)

    def pressure(self) -> float:
        return self.volume.pressure(self.state)

    def temperature(self) -> float:
        return self.volume.temperature(self.state)

    def outputs(self) -> dict[str, float]:
        return {
            "pressure": self.pressure(),
            "temperature": self.temperature(),
            "mass": self.state.mass,
            "wall_temperature": self.state.wall_temperature,
        }

    @property
    def fluid(self) -> Fluid:
        return self.volume.fluid

    def __repr__(self) -> str:
        return f"GasVolumeOwner({self.id!r}, {self.volume!r})"


class TankOwner:
    """A propellant tank as an integrable object.

    Carries one more state than a gas volume -- the interface contact time --
    because ullage collapse goes as ``1/sqrt(t)`` and needs to know how long the
    surface has been exposed. Integrating it rather than reading a clock is what
    lets a repressurisation event reset it mid-run.
    """

    def __init__(
        self,
        id: str,
        tank: Tank,
        state: TankState,
        *,
        node: str = "",
    ) -> None:
        self.id = id
        self.tank = tank
        self.state = state
        self.node = node or id
        self.mdot_liquid_out = 0.0
        self.mdot_gas_in = 0.0
        self.enthalpy_gas_in = 0.0
        self.heat_in = 0.0

    def state_names(self) -> Sequence[str]:
        return (
            "ullage_mass",
            "ullage_energy",
            "wall_temperature",
            "liquid_mass",
            "liquid_temperature",
            "contact_time",
            "wetted_wall_temperature",
        )

    def pack(self) -> Sequence[float]:
        return (
            self.state.ullage.mass,
            self.state.ullage.energy,
            self.state.ullage.wall_temperature,
            self.state.liquid_mass,
            self.state.liquid_temperature,
            self.state.contact_time,
            # A single-lump tank packs its one wall twice, so the vector is the
            # same shape either way and unpack can tell which it was given.
            (
                self.state.wetted_wall_temperature
                if self.state.wetted_wall_temperature is not None
                else self.state.ullage.wall_temperature
            ),
        )

    def unpack(self, values: Sequence[float]) -> None:
        split = self.state.wetted_wall_temperature is not None
        self.state = TankState(
            ullage=VesselState(
                mass=float(values[0]),
                energy=float(values[1]),
                wall_temperature=float(values[2]),
            ),
            liquid_mass=float(values[3]),
            liquid_temperature=float(values[4]),
            contact_time=float(values[5]),
            vapour_mass=self.state.vapour_mass,
            wetted_wall_temperature=float(values[6]) if split else None,
        )

    def derivatives(self, t: float) -> Sequence[float]:
        rates = self.tank.rates(
            self.state,
            mdot_liquid_out=self.mdot_liquid_out,
            mdot_gas_in=self.mdot_gas_in,
            enthalpy_gas_in=self.enthalpy_gas_in,
            heat_in=self.heat_in,
        )
        return (
            rates.ullage.mass,
            rates.ullage.energy,
            rates.ullage.wall_temperature,
            rates.liquid_mass,
            rates.liquid_temperature,
            rates.contact_time,
            rates.wetted_wall_temperature,
        )

    def pressure(self) -> float:
        """Ullage pressure. What the pressurant line sees."""
        return self.tank.pressure(self.state)

    def outlet_pressure(self) -> float:
        """Ullage plus liquid column. What the feed line sees."""
        return self.tank.outlet_pressure(self.state)

    def outputs(self) -> dict[str, float]:
        rates = self.tank.rates(
            self.state,
            mdot_liquid_out=self.mdot_liquid_out,
            mdot_gas_in=self.mdot_gas_in,
            enthalpy_gas_in=self.enthalpy_gas_in,
            heat_in=self.heat_in,
        )
        return {
            "pressure": self.pressure(),
            "outlet_pressure": self.outlet_pressure(),
            "gas_temperature": self.tank.gas_temperature(self.state),
            "liquid_mass": self.state.liquid_mass,
            "liquid_temperature": self.state.liquid_temperature,
            "fill_fraction": self.tank.fill_fraction(self.state),
            "level": self.tank.level(self.state),
            "contact_time": self.state.contact_time,
            "heat_to_liquid": rates.heat_to_liquid,
            "expansion_power": rates.expansion_power,
        }

    def __repr__(self) -> str:
        return f"TankOwner({self.id!r}, {self.tank!r})"

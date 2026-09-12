"""A propellant tank: liquid below, pressurant above, coupled at the surface.

This is the component that decides whether a pressure-fed system works, and the
one where the interesting mistakes live. Three of them are structural enough to
be worth stating before any code.

**The ullage is not a fixed volume.** Liquid leaves, so the gas expands, so it
cools, so the pressurant demand is larger than "volume divided by density" says.
:class:`~feedtwin.vessels.volume.GasVolume` assumes a fixed volume and cannot be
reused unmodified; the expansion work term is what this module adds.

**The liquid's state variables are not the gas's.** The ullage is tracked as
``(mass, internal energy)`` because a real gas's energy balance is only exact in
``u``. The liquid is tracked as ``(mass, temperature)`` -- the opposite choice,
for the opposite reason: liquid density is about 180x less sensitive to pressure
than a gas's, so recovering pressure from ``(rho, u)`` amplifies any error in
density by that factor. Each phase gets the state pair its physics is
well-conditioned in. Forcing one convention on both is tidier and wrong.

**Ullage collapse shows up as pressurant demand, not as a pressure drop.** With
a regulator holding tank pressure, heat lost to the liquid is made up by more
gas, which drains the COPV faster, which lowers regulator inlet, which moves the
outlet through the supply-pressure coefficient. Collapse and droop are one loop.
A tank model that reports pressure and not consumption hides the entire effect.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from feedtwin.props import Fluid
from feedtwin.props.errors import PropertyError
from feedtwin.vessels.collapse import (
    CollapseModel,
    ConductionCollapse,
    LiquidThermal,
    NoCollapse,
)
from feedtwin.vessels.geometry import TankGeometry, level_of_volume
from feedtwin.vessels.vapour import NoVapour, VapourModel, latent_heat
from feedtwin.vessels.volume import GRAVITY, Rates, VesselState

#: Universal gas constant [J/(mol.K)].
R_UNIVERSAL = 8.314462618


class UllageCondensed(ValueError):
    """The ullage is no longer a gas the property layer can evaluate.

    Its own exception because the two causes need different responses: a real
    long hold wants a repressurisation in the scenario, a numerical overshoot
    wants a smaller step. A generic ValueError makes a caller guess.
    """


@dataclass(frozen=True, slots=True)
class TankState:
    """Everything needed to continue a tank's history.

    Args:
        ullage: Gas state -- mass, total internal energy, wall temperature.
        liquid_mass: Propellant remaining [kg].
        liquid_temperature: Bulk liquid temperature [K].
        contact_time: Seconds the current interface has been exposed to warm
            gas. Reset by a repressurisation, which is why it is state and not
            a clock reading -- see :mod:`feedtwin.vessels.collapse`.
    """

    ullage: VesselState
    liquid_mass: float
    liquid_temperature: float
    contact_time: float = 0.0
    vapour_mass: float = 0.0
    """Propellant vapour in the ullage [kg]. Zero unless a vapour model is
    fitted -- see :mod:`feedtwin.vessels.vapour`. Kept apart from
    ``ullage.mass`` rather than summed into it because the two species have
    different equations of state and Dalton wants them separately."""
    wetted_wall_temperature: float | None = None
    """Temperature of the wall under the liquid [K], when it is tracked apart
    from the wall above it. ``None`` -- the default, and every state built
    before this existed -- means one lumped wall for both faces, which is what
    the model always did.

    Two nodes exist because one cannot describe a loaded cryogenic tank. Its
    wetted wall has chilled to the liquid; the wall above the ullage has not.
    Lumped at liquid temperature the ullage face condenses the pressurant
    (nitrogen at 39 bar saturates at 113 K, well above a 90 K wall); lumped at
    ambient the wetted face boils the liquid at kilowatts. The two lumps are
    split by wetted-area fraction at the state that created them and are not
    conducted between -- along a thin wall over a tank's height that is a
    twenty-minute time constant, which is a hold and not a burn."""
    surface_temperature: float | None = None
    """Temperature of the liquid's surface layer [K], when it is tracked apart
    from the bulk. ``None`` -- the default -- is a well-mixed liquid.

    A quiescent cryogen stratifies. Heat leaking in through the wetted wall
    rides up the wall in a natural-convection boundary layer and pools at
    the surface; the bulk below stays cold. The ullage sees the *surface*,
    so the vapour pressure follows the surface temperature, and a shut LOX
    tank climbs at tens of psi a minute -- neither the ~100 psi/min of a
    model that boils the whole leak nor the ~0.3 psi/min of one that warms
    all fifteen kilograms. See :attr:`Tank.surface_layer`."""

    def repressurised(self) -> TankState:
        """The same state with the interface clock reset.

        What a repressurisation immediately before ignition buys: fresh gas
        scrubs the chilled surface layer away, and the sqrt(t) flux restarts at
        its steepest. Modelling the reset is the difference between predicting
        a pad hold correctly and predicting it as if the tank had just been
        filled.
        """
        return replace(self, contact_time=0.0)


@dataclass(frozen=True, slots=True)
class TankRates:
    """Time derivatives of a tank's state, plus the terms worth seeing."""

    ullage: Rates
    liquid_mass: float
    """dm_liquid/dt [kg/s]. Negative while draining."""

    liquid_temperature: float
    """dT_liquid/dt [K/s]."""

    contact_time: float = 1.0
    """d(contact time)/dt. One, except across a repressurisation event."""

    vapour_mass: float = 0.0
    """d(vapour mass)/dt [kg/s]. Positive is boil-off."""

    evaporation: float = 0.0
    """Mass crossing the interface [kg/s], positive out of the liquid. Same
    number as :attr:`vapour_mass` today and reported separately because they
    stop being the same as soon as vapour can leave through a vent."""

    latent_power: float = 0.0
    """The part of the interfacial heat that went into phase change [W]. The
    remainder warmed the liquid; reporting the split is how you tell a boiling
    tank from a warming one without inferring it from two other numbers."""

    heat_to_wetted_wall: float = 0.0
    """Heat the liquid drew from the wetted wall [W]. Chilldown, when it is on;
    zero when ``wetted_conductance`` is zero, which is the default."""

    heat_to_liquid: float = 0.0
    """Heat the ullage lost to the liquid surface [W]. Reported rather than
    buried, because it is the term that sets pressurant consumption and it
    should be visible in a result."""

    expansion_power: float = 0.0
    """Work the ullage does pushing the liquid surface down [W]. The term that
    a fixed-volume vessel model does not have."""
    wetted_wall_temperature: float = 0.0
    """d(wetted wall temperature)/dt [K/s]. Zero with one lumped wall."""

    surface_temperature: float = 0.0
    """dT_surface/dt [K/s]; zero when the surface layer is not tracked."""


class Tank:
    """A partly-filled propellant tank.

    Args:
        liquid: The propellant.
        gas: The pressurant. A separate fluid: this is a two-species model with
            one interface, not a mixture. Vapour in the ullage is a Phase 14
            refinement and the seam for it is :attr:`collapse`.
        geometry: Tank shape -- see :mod:`feedtwin.vessels.geometry`.
        collapse: Interfacial heat transfer model. Defaults to transient
            conduction, which is a lower bound; ``NoCollapse()`` disables it,
            and either choice is recorded rather than assumed.
        wall_mass: Mass of tank wall in thermal contact with the ullage [kg].
        wall_capacity: Wall specific heat [J/(kg.K)].
        wall_conductance: Ullage-to-wall conductance hA [W/K].
        vapour: Propellant vapour in the ullage. Defaults to
            :class:`~feedtwin.vessels.vapour.NoVapour`, which is exactly the
            two-species behaviour this class had before the model existed.
        wetted_conductance: Liquid-to-wall conductance per unit wetted area
            [W/(m^2.K)]. **Chilldown.** Zero by default, which removes the term
            entirely; give it a value and a warm wall dumps heat into the
            liquid, which with a vapour model fitted is what boils a cryogen off
            during a load. Per unit area rather than lumped because the wetted
            area is a strong function of fill and the geometry already knows it.
        ambient_conductance: Air-to-wall film per unit outer area [W/(m^2.K)].
            **Heat leak.** Zero by default, which is a wall that has no outside
            -- once chilled it stays chilled and a loaded tank sits forever.
            Give it a value and the room leaks heat into the metal, split
            between the wetted and ullage-side lumps by area: the wetted wall
            passes it to the liquid through ``wetted_conductance``, and with a
            vapour model fitted a saturated cryogen boils, so a LOX tank with
            its vent shut climbs -- which is what one does.
        ambient_temperature: The room [K].
        wall_boiling: Let heat arriving at a superheated wetted wall boil the
            liquid **at the wall**, straight into the ullage, rather than
            warming the bulk. Off by default. Nucleate boiling needs the wall
            above saturation at the tank's *total* pressure -- a bubble has to
            push the whole ullage back -- so a LOX tank at atmosphere with
            its vent shut boils and climbs, and the same tank pressed to
            38 bar of helium does not: its liquid is a hundred kelvin
            subcooled at that pressure and the leak warms the bulk instead.
            Both are what the stand does. Needs a vapour model fitted.
    """

    def __init__(
        self,
        liquid: Fluid,
        gas: Fluid,
        geometry: TankGeometry,
        *,
        collapse: CollapseModel | None = None,
        wall_mass: float = 0.0,
        wall_capacity: float = 0.0,
        wall_conductance: float = 0.0,
        vapour: VapourModel | None = None,
        wetted_conductance: float = 0.0,
        ambient_conductance: float = 0.0,
        ambient_temperature: float = 293.15,
        wall_boiling: bool = False,
        nucleate_conductance: float = 0.0,
        leidenfrost_superheat: float = float("inf"),
        boiling_onset: float = 0.0,
        surface_layer: float = 0.0,
        surface_mixing: float = 0.0,
    ) -> None:
        self.liquid = liquid
        self.gas = gas
        self.geometry = geometry
        self.collapse: CollapseModel = (
            ConductionCollapse() if collapse is None else collapse
        )
        self.wall_mass = wall_mass
        self.wall_capacity = wall_capacity
        self.wall_conductance = wall_conductance
        self.vapour: VapourModel = NoVapour() if vapour is None else vapour
        self.wetted_conductance = wetted_conductance
        self.ambient_conductance = ambient_conductance
        self.ambient_temperature = ambient_temperature
        self.wall_boiling = wall_boiling
        #: Wetted-wall conductance once the liquid wets the metal (nucleate
        #: boiling), and the wall superheat below which it does. Zero / inf:
        #: ``wetted_conductance`` applies at every superheat, as before.
        self.nucleate_conductance = nucleate_conductance
        self.leidenfrost_superheat = leidenfrost_superheat
        #: Wall superheat above saturation needed before the wetted wall
        #: boils rather than warming the liquid [K]. Zero: any superheat boils,
        #: as before. Incipience for a cryogen on smooth metal is a few kelvin.
        self.boiling_onset = boiling_onset
        #: Thickness of the stratified surface layer [m]; zero is a well-mixed
        #: liquid (the old model). Wetted-wall heat that does not boil, and the
        #: sensible part of the interfacial heat, warm this layer rather than
        #: the bulk. Only states carrying ``surface_temperature`` use it.
        self.surface_layer = surface_layer
        #: Conductance per unit interface area between the layer and the bulk
        #: [W/(m^2.K)] -- conduction and whatever mixing there is.
        self.surface_mixing = surface_mixing
        self._r_vapour: float | None = None
        self._critical: tuple[float, float] | None = None

    # --------------------------------------------------------------- geometry

    def liquid_volume(self, state: TankState) -> float:
        """Volume the propellant occupies [m^3], at its own density."""
        rho = self.liquid_density(state)
        return state.liquid_mass / rho if rho > 0.0 else 0.0

    def ullage_volume(self, state: TankState) -> float:
        """What is left for the gas [m^3].

        Raises:
            ValueError: the tank is overfull. A negative ullage is not a small
                error to clip -- it means the load, the density or the geometry
                disagree, and continuing would silently produce a pressure from
                a volume that does not exist.
        """
        volume = self.geometry.total_volume - self.liquid_volume(state)
        if volume <= 0.0:
            raise ValueError(
                f"tank is overfull: {state.liquid_mass:.4g} kg of "
                f"{self.liquid.name} occupies "
                f"{self.liquid_volume(state) * 1e3:.4g} L in a "
                f"{self.geometry.total_volume * 1e3:.4g} L tank, leaving no "
                "ullage. Check the propellant load, the liquid temperature, or "
                "the tank geometry."
            )
        return volume

    def level(self, state: TankState) -> float:
        """Height of the liquid surface above the tank's lowest point [m]."""
        return level_of_volume(self.geometry, self.liquid_volume(state))

    def interface_area(self, state: TankState) -> float:
        """Liquid surface area [m^2]. Falls away as a head empties."""
        return self.geometry.cross_section(self.level(state))

    def fill_fraction(self, state: TankState) -> float:
        return self.liquid_volume(state) / self.geometry.total_volume

    # ------------------------------------------------------------- properties

    def _ullage(self, state: TankState, prop: str) -> float:
        """One ullage property from ``(rho, u)``, with a legible failure.

        An ullage driven cold and dense enough stops being a gas, and the
        property layer says so in terms of its own internals -- a bare
        ``rhoV is invalid`` several frames down inside CoolProp. That is a real
        physical event with two very different causes and it should name both:
        a long unpressurised hold genuinely does chill an ullage into a
        liquid-like state, and a too-large integration step gets there
        spuriously. Either way, continuing would report a pressure from a state
        this model does not represent.
        """
        rho = state.ullage.mass / self.ullage_volume(state)
        try:
            return self.gas.get(prop, rho=rho, u=state.ullage.specific_energy())
        except (ValueError, PropertyError) as exc:
            raise UllageCondensed(
                f"{self.gas.name} ullage at {rho:.4g} kg/m^3 and "
                f"{state.ullage.specific_energy() / 1e3:.4g} kJ/kg is no longer "
                f"a gas this model can evaluate ({exc}). Either the ullage has "
                "genuinely chilled into a liquid-like state -- a long hold with "
                "no repressurisation will do that -- or the integration step is "
                "too large and has overshot. Check the step size first."
            ) from exc

    def pressure(self, state: TankState) -> float:
        """Ullage pressure [Pa]. What the regulator sees and the outlet feeds.

        Pressurant plus propellant vapour, by Dalton. With no vapour model
        fitted the second term is identically zero and this is the pressurant
        pressure alone, exactly as before.
        """
        return self._ullage(state, "p") + self.vapour_pressure(state)

    def vapour_pressure(self, state: TankState) -> float:
        """The propellant vapour's own partial pressure in the ullage [Pa].

        Its own equation of state at the shared ullage temperature and its own
        partial density -- not a mixture EOS. See
        :mod:`feedtwin.vessels.vapour` for why that approximation is the right
        one here.
        """
        if state.vapour_mass <= 0.0:
            return 0.0
        volume = self.ullage_volume(state)
        if volume <= 0.0:
            return 0.0
        density = state.vapour_mass / volume
        temperature = self._ullage(state, "T")
        try:
            partial = self.liquid.get("p", rho=density, T=temperature)
            # The equation of state is asked for a state it is poor at.
            #
            # A trace of vapour in a large ullage is a very low density -- a
            # microgram of oxygen in half a litre is 0.002 kg/m^3 -- and the
            # Helmholtz formulation extrapolates badly down there: measured on
            # CoolProp's oxygen, 1 ug in this tank returns **-6057 psi**, while
            # 10 ug and everything above it is clean and linear. One negative
            # sample is enough to take the whole tank pressure negative and
            # every solve after it with it.
            #
            # Below about 1 kg/m^3 the gas is ideal to well under a tenth of a
            # percent anyway, so the ideal answer is not a fallback, it is the
            # better number. Falling back on a *non-physical* result rather than
            # on a density threshold means this also catches whatever else the
            # backend does badly at the edges.
            if partial > 0.0:
                return partial
        except (ValueError, PropertyError):
            pass
        try:
            return density * self._vapour_r_specific() * temperature
        except (ValueError, PropertyError):
            # A vapour state the equation of state will not answer for. Zero is
            # wrong but bounded; inventing a pressure here would be worse, and
            # the alternative -- raising -- would kill a run for a term that is
            # a fraction of a percent whenever it is well behaved.
            return 0.0

    def gas_temperature(self, state: TankState) -> float:
        return self._ullage(state, "T")

    def gas_enthalpy(self, state: TankState) -> float:
        return self._ullage(state, "h")

    def _vapour_r_specific(self) -> float:
        """Specific gas constant of the propellant vapour [J/(kg.K)]: R / M.

        This used to be read off the equation of state at one bar and 300 K,
        "where every propellant here is a well-behaved gas". Ethanol is not:
        at one bar and 300 K it is a liquid at 780 kg/m^3, the "gas constant"
        came out at 0.43 J/(kg.K) instead of 181, and a fuel tank primed with
        its equilibrium vapour was seeded with 124 grams of ethanol vapour in
        a 2.6 litre ullage -- half its gas by mass, which then slowed its vent
        to twice the real time. The molar mass is what the ideal-gas fallback
        actually needs, and the equation of state knows it for any species.
        """
        if self._r_vapour is None:
            self._r_vapour = R_UNIVERSAL / self.liquid.get(
                "molar_mass", T=300.0, p=1.0e5
            )
        return self._r_vapour

    def liquid_density(self, state: TankState) -> float:
        """Liquid density [kg/m^3], on the saturation line at its temperature.

        Saturated rather than at tank pressure: for a cryogen the compressed-
        liquid correction is a fraction of a percent, while asking for a
        pressure the liquid is not actually at risks landing outside a tabular
        backend's envelope for no gain.
        """
        return self.liquid.get("rho", T=state.liquid_temperature, q=0.0)

    def liquid_thermal(self, state: TankState) -> LiquidThermal:
        T = state.liquid_temperature
        return LiquidThermal(
            conductivity=self.liquid.get("k", T=T, q=0.0),
            density=self.liquid.get("rho", T=T, q=0.0),
            heat_capacity=self.liquid.get("cp", T=T, q=0.0),
        )

    def outlet_pressure(self, state: TankState) -> float:
        """Pressure at the tank outlet [Pa]: ullage plus the liquid column.

        The head a full tank adds is not negligible against a feed-system
        budget -- a metre of LOX is about 1.6 psi -- and it decays over a burn,
        so a model that leaves it out predicts a drifting error rather than a
        constant one.
        """
        return self.pressure(state) + self.liquid_density(state) * GRAVITY * self.level(
            state
        )

    # ---------------------------------------------------------- initial state

    def initial_state(
        self,
        *,
        pressure: float,
        liquid_mass: float,
        liquid_temperature: float,
        gas_temperature: float | None = None,
        contact_time: float = 0.0,
        split_wall: bool = False,
    ) -> TankState:
        """Build a state from what is actually known before a test.

        A propellant load, a liquid temperature, a tank pressure, and the
        pressurant temperature. Everything else follows.

        ``contact_time`` is how long the interface has existed [s]; a tank that
        was loaded minutes ago is not one whose surface appeared this instant,
        and the collapse flux goes as ``1/sqrt(t)``. ``split_wall`` gives the
        wall under the liquid its own temperature -- the liquid's -- while the
        wall above stays at the gas temperature. Off, a single lump at the gas
        temperature, exactly as before.
        """
        rho_l = self.liquid.get("rho", T=liquid_temperature, q=0.0)
        volume = self.geometry.total_volume - liquid_mass / rho_l
        if volume <= 0.0:
            raise ValueError(
                f"{liquid_mass:.4g} kg of {self.liquid.name} at "
                f"{liquid_temperature:.4g} K does not fit in a "
                f"{self.geometry.total_volume * 1e3:.4g} L tank"
            )
        T_gas = liquid_temperature if gas_temperature is None else gas_temperature
        # A loaded tank whose interface has existed for a while already holds
        # its propellant's vapour at the liquid's saturation pressure, and the
        # pressurant makes up the *rest* of the stated total. Built with no
        # vapour, a saturated cryogen boils it off after the regulator has
        # locked up at the total, and nothing can take the extra 15 psi back
        # out -- the trace then opens above lockup. Only with a vapour model
        # fitted, only with liquid present, and only where the pressurant is
        # still the bulk of the ullage.
        p_vapour = 0.0
        if (
            liquid_mass > 0.0
            and contact_time > 0.0
            and not isinstance(self.vapour, NoVapour)
        ):
            try:
                p_sat = self.liquid.get("p", T=liquid_temperature, q=0.0)
            except (ValueError, PropertyError):
                p_sat = 0.0
            if 0.0 < p_sat < 0.5 * pressure:
                p_vapour = p_sat
        p_gas = pressure - p_vapour
        phase = self.gas.phase(p=p_gas, T=T_gas)
        if phase.is_liquid_like:
            raise ValueError(
                f"pressurant {self.gas.name} at {p_gas / 1e5:.3g} bar and "
                f"{T_gas:.4g} K is a liquid ({phase.value}); an ullage holds gas"
            )
        rho_g = self.gas.get("rho", p=p_gas, T=T_gas)
        u_g = self.gas.get("u", p=p_gas, T=T_gas)
        vapour_mass = (
            p_vapour * volume / (self._vapour_r_specific() * T_gas)
            if p_vapour > 0.0
            else 0.0
        )
        return TankState(
            ullage=VesselState(
                mass=rho_g * volume,
                energy=u_g * rho_g * volume,
                wall_temperature=T_gas,
            ),
            liquid_mass=liquid_mass,
            liquid_temperature=liquid_temperature,
            contact_time=max(contact_time, 0.0),
            vapour_mass=vapour_mass,
            wetted_wall_temperature=liquid_temperature if split_wall else None,
            surface_temperature=(
                liquid_temperature if self.surface_layer > 0.0 else None
            ),
        )

    def surface_mass(self, state: TankState, rho_l: float | None = None) -> float:
        """Liquid in the surface layer [kg]: a slab ``surface_layer`` deep over
        the interface, never more than the liquid there is."""
        if self.surface_layer <= 0.0 or state.liquid_mass <= 0.0:
            return 0.0
        rho = self.liquid_density(state) if rho_l is None else rho_l
        slab = rho * self.interface_area(state) * self.surface_layer
        return min(slab, state.liquid_mass)

    def _critical_point(self) -> tuple[float, float]:
        """``(T_crit, p_crit)`` of the propellant, read once; infinite for a
        measured table with no critical point."""
        if self._critical is None:
            try:
                self._critical = (
                    float(self.liquid.critical_temperature),
                    float(self.liquid.critical_pressure),
                )
            except Exception:  # noqa: BLE001 - a table has no critical point
                self._critical = (float("inf"), float("inf"))
        return self._critical

    # ------------------------------------------------------------------ rates

    def rates(
        self,
        state: TankState,
        *,
        mdot_liquid_out: float = 0.0,
        mdot_gas_in: float = 0.0,
        enthalpy_gas_in: float = 0.0,
        heat_in: float = 0.0,
        stirring: float = 1.0,
        mdot_vapour_out: float = 0.0,
    ) -> TankRates:
        """Time derivatives, for an integrator to march.

        Args:
            mdot_liquid_out: Propellant leaving [kg/s].
            mdot_gas_in: Pressurant arriving [kg/s].
            enthalpy_gas_in: Specific enthalpy of arriving pressurant [J/kg].
                Warm gas into a cold ullage is a heat source and the number
                that makes helium behave differently from nitrogen.
            heat_in: External heat into the ullage [W].
            stirring: Multiplier on the ullage-to-wall conductance, 1 by
                default; see :meth:`GasVolume.rates`.
            mdot_vapour_out: Propellant vapour leaving through a vent [kg/s].
                A well-mixed ullage vents pressurant and vapour in proportion,
                and the caller knows the split. Without this a venting LOX
                tank lost only its pressurant: the vapour it boiled stayed,
                and a tank with a 3/8 in vent wide open climbed to 500 psig. Wall exchange and
                interfacial loss are computed here and must not be included.
        """
        volume = self.ullage_volume(state)
        T_gas = self.gas_temperature(state)
        pressure = self.pressure(state)

        # The surface the ullage sees: the stratified layer when there is one.
        layered = self.surface_layer > 0.0 and state.surface_temperature is not None
        T_surface = (
            state.surface_temperature
            if layered and state.surface_temperature is not None
            else state.liquid_temperature
        )

        two_walls = state.wetted_wall_temperature is not None
        T_wetted = (
            state.wetted_wall_temperature
            if state.wetted_wall_temperature is not None
            else state.ullage.wall_temperature
        )
        # `stirring` scales the still-gas conductance while a charge jet is
        # stirring the ullage; 1 is exactly the old behaviour.
        q_wall = (
            self.wall_conductance
            * max(stirring, 0.0)
            * (state.ullage.wall_temperature - T_gas)
        )

        q_liquid = self.collapse.heat_rate(
            area=self.interface_area(state),
            gas_temperature=T_gas,
            liquid_temperature=T_surface,
            liquid=self.liquid_thermal(state),
            elapsed=state.contact_time,
        )

        # The ullage grows at the rate the liquid leaves, and does p.dV work
        # on the receding surface. This is the term a fixed-volume vessel
        # does not have, and it is why an ullage cools while being fed.
        rho_l = self.liquid_density(state)
        dV_dt = mdot_liquid_out / rho_l if rho_l > 0.0 else 0.0
        expansion_power = pressure * dV_dt

        # ---- chilldown: the wetted wall ---------------------------------
        #
        # The wall term above is ullage-to-wall. This is the other face of the
        # same wall, the part under liquid, and it is what chills down. Zero
        # unless someone asked for it.
        q_wetted = 0.0
        # Saturation at the tank's *total* pressure: what the wall has to be
        # above to boil, and what the boiling regime is measured from.
        # One saturation call per step is what the layer and the regimes
        # cost; skip it when nothing can use it -- a wall no warmer than its
        # liquid has no regime to pick and nothing to boil, and a state with
        # no surface layer has no cap to check.
        T_sat_total = float("inf")
        wants_sat = state.liquid_mass > 0.0 and not isinstance(self.vapour, NoVapour)
        if wants_sat and not (
            (self.wetted_conductance > 0.0 and T_wetted > state.liquid_temperature)
            or (self.surface_layer > 0.0 and state.surface_temperature is not None)
        ):
            wants_sat = False
        if wants_sat:
            try:
                T_sat_total = self.liquid.get("T", p=pressure, q=0.0)
            except (ValueError, PropertyError):
                T_sat_total = float("inf")
        if self.wetted_conductance > 0.0:
            wetted = self.geometry.wetted_area(self.level(state))
            # Two boiling regimes. A wall far above saturation is insulated by
            # its own vapour film (film boiling, ~100 W/m2K on a cryogen); once
            # the superheat falls under the Leidenfrost point the liquid wets
            # the metal and nucleate boiling runs at thousands. The second is
            # why the end of a chilldown is quick. Opt-in: with no nucleate
            # value the film value applies throughout, as it always did.
            h = self.wetted_conductance
            superheat = T_wetted - T_sat_total
            if (
                self.nucleate_conductance > 0.0
                and 0.0 < superheat < self.leidenfrost_superheat
            ):
                h = self.nucleate_conductance
            q_wetted = h * wetted * (T_wetted - state.liquid_temperature)

        # ---- boiling at the wall ------------------------------------------
        #
        # A wetted wall above saturation at the tank's total pressure grows
        # bubbles, and what they carry into the ullage never warms the bulk.
        # Off unless asked for; needs a vapour model, since the vapour has to
        # go somewhere.
        wall_boil = 0.0
        q_boil = 0.0
        if (
            self.wall_boiling
            and q_wetted > 0.0
            and state.liquid_mass > 0.0
            and not isinstance(self.vapour, NoVapour)
        ):
            try:
                h_fg = latent_heat(self.liquid, state.liquid_temperature)
            except (ValueError, PropertyError):
                h_fg = 0.0
            if T_wetted > T_sat_total + self.boiling_onset and h_fg > 0.0:
                q_boil = q_wetted
                wall_boil = q_boil / h_fg

        # ---- where the interfacial heat goes ----------------------------
        #
        # Everything arriving at the surface -- from the ullage above and the
        # wall below -- is either latent or sensible. A saturated liquid takes
        # it as latent and boils; a subcooled one takes it as sensible and
        # warms. The vapour model decides the split, and with NoVapour fitted
        # it is all sensible, which is what this method did before. Heat the
        # wall has already turned to vapour is not on the table here.
        q_interface = q_liquid + q_wetted - q_boil
        exchange = self.vapour.exchange(
            liquid=self.liquid,
            liquid_temperature=T_surface,
            ullage_pressure=pressure,
            vapour_partial_pressure=self.vapour_pressure(state),
            interface_area=self.interface_area(state),
            heat_to_interface=q_interface,
        )

        # The liquid warms by what is left after the phase change. Small over a
        # burn -- a few millikelvin -- and carried because over a pad hold it
        # is not.
        cp_l = self.liquid.get("cp", T=state.liquid_temperature, q=0.0)
        heat_capacity_l = state.liquid_mass * cp_l
        sensible = q_interface - exchange.latent_power
        d_T_liquid = sensible / heat_capacity_l if heat_capacity_l > 0.0 else 0.0
        d_T_surface = 0.0
        if layered:
            # Stratification. What the wall did not boil rides up to the
            # surface in the boundary layer, the ullage's heat lands there
            # too, and the slab of liquid at the top takes all of it as
            # sensible heat -- fifteen kilograms do not warm, a few hundred
            # grams do, and the vapour pressure follows *them*. The bulk
            # sees only what leaks down through the layer.
            m_surface = self.surface_mass(state, rho_l)
            m_bulk = state.liquid_mass - m_surface
            q_mix = (
                self.surface_mixing
                * self.interface_area(state)
                * (T_surface - state.liquid_temperature)
            )
            # Liquid warmed at the wall arrives at the surface no hotter than
            # the wall that warmed it. The wall's convective heat therefore
            # feeds the layer only while the layer is below the wall; past
            # that it can only thicken the layer, which in a slab of fixed
            # depth means it goes to the bulk. Without this bound a wall a
            # few kelvin warm, dumping its stored heat into a few hundred
            # grams, put the surface tens of kelvin above the metal. The
            # ullage's heat needs no such guard: the collapse term already
            # follows T_gas - T_surface and turns off on its own.
            q_wall_conv = q_wetted - q_boil
            span = T_wetted - state.liquid_temperature
            reach = (
                min(max((T_wetted - T_surface) / span, 0.0), 1.0)
                if span > 1e-9
                else 0.0
            )
            to_bulk = q_wall_conv * (1.0 - reach)
            if m_surface > 0.0 and m_bulk > 1e-6:
                net = sensible - to_bulk - q_mix
                # A surface at saturation for the tank's total pressure does
                # not superheat: it boils. Once the layer is there, the heat
                # that would have warmed it evaporates it instead, and the
                # vapour carries the pressure up. Also kept clear of the
                # critical point, where the saturation line -- and every
                # property call on it -- ends. Without both a warm dry wall
                # ran the layer to 154.6 K and the tank froze at 0 psig.
                T_crit, p_crit = self._critical_point()
                cap = min(T_sat_total, T_crit - 2.0)
                if net > 0.0 and T_surface >= cap:
                    # Only while there is a saturation line to boil along:
                    # below the critical pressure, and with the vapour not
                    # already at saturation over the surface. Past either
                    # the model has no phase change to offer (h_fg -> 0 at
                    # the critical point made this term infinite once) and
                    # the heat goes to the bulk; the tank sits at the
                    # propellant's critical pressure, as it always has.
                    try:
                        p_sat_cap = self.liquid.get("p", T=min(T_surface, cap), q=0.0)
                        h_fg_s = latent_heat(self.liquid, min(T_surface, cap))
                    except (ValueError, PropertyError):
                        p_sat_cap, h_fg_s = 0.0, 0.0
                    boils = (
                        h_fg_s > 0.0
                        and pressure < 0.97 * p_crit
                        and self.vapour_pressure(state) < p_sat_cap
                    )
                    if boils:
                        wall_boil += net / h_fg_s
                        q_boil += net
                    else:
                        to_bulk += net
                    net = 0.0
                d_T_surface = net / (m_surface * cp_l)
                d_T_liquid = (to_bulk + q_mix) / (m_bulk * cp_l)
            elif heat_capacity_l > 0.0:
                # Down to the last of the liquid: one node, and the surface
                # is pulled onto it.
                d_T_liquid = sensible / heat_capacity_l
                d_T_surface = d_T_liquid + (state.liquid_temperature - T_surface)

        # Boil-off deliberately contributes **no** term to this balance, and
        # the reason is a trap worth naming.
        #
        # `ullage.energy` is the *pressurant's* internal energy, in the
        # pressurant's reference state. Saturated-vapour enthalpy comes out of
        # the propellant's equation of state, in the propellant's reference
        # state, and the two references are unrelated: at 90 K, LOX saturated
        # liquid sits at -133.7 kJ/kg while helium at ullage conditions is
        # +628.6 kJ/kg. Adding one into the other is not a small error, it is a
        # category error -- and with only a couple of grams of helium in a LOX
        # ullage it drives the state to a negative pressure inside one step.
        #
        # So the vapour is tracked for **mass and partial pressure**, not as a
        # second energy carrier. The energy that made it has already left this
        # balance through `q_liquid`. What is not captured is the thermal energy
        # the vapour carries back into the ullage, which biases the ullage cool.
        # That is a bounded, stated approximation; the alternative is a genuine
        # two-species energy state, which is a larger change than this phase.
        d_energy = (
            mdot_gas_in * enthalpy_gas_in
            + heat_in
            + q_wall
            - q_liquid
            - expansion_power
        )

        # ---- the room: heat leaking in through the outer skin -------------
        #
        # Zero unless asked for. Split between the two lumps by the area each
        # presents to the air, so the wetted wall gets most of it on a full
        # tank and passes it on to the liquid through `wetted_conductance`.
        total_area = self.geometry.wetted_area(self.geometry.height)
        wetted_area = self.geometry.wetted_area(self.level(state))
        q_ambient_ullage = q_ambient_wetted = 0.0
        if self.ambient_conductance > 0.0 and total_area > 0.0:
            if two_walls:
                q_ambient_wetted = (
                    self.ambient_conductance
                    * wetted_area
                    * (self.ambient_temperature - T_wetted)
                )
                q_ambient_ullage = (
                    self.ambient_conductance
                    * (total_area - wetted_area)
                    * (self.ambient_temperature - state.ullage.wall_temperature)
                )
            else:
                q_ambient_ullage = (
                    self.ambient_conductance
                    * total_area
                    * (self.ambient_temperature - state.ullage.wall_temperature)
                )

        # The wall pays for what it gave and takes what the room gives it.
        # With one lump it pays for both faces; with two, each lump pays for
        # its own face, the metal split between them by the wetted-area
        # fraction of the tank as it stands now.
        capacity = self.wall_mass * self.wall_capacity
        d_wetted_wall = 0.0
        if capacity <= 0.0:
            d_wall = 0.0
        elif two_walls:
            wet_frac = wetted_area / total_area if total_area > 0.0 else 0.0
            wet_frac = min(max(wet_frac, 1e-3), 1.0 - 1e-3)
            d_wall = (q_ambient_ullage - q_wall) / (capacity * (1.0 - wet_frac))
            d_wetted_wall = (q_ambient_wetted - q_wetted) / (capacity * wet_frac)
        else:
            d_wall = (q_ambient_ullage - q_wall - q_wetted) / capacity

        return TankRates(
            ullage=Rates(
                mass=mdot_gas_in,
                energy=d_energy,
                wall_temperature=d_wall,
                heat_from_wall=q_wall,
            ),
            # Liquid leaves through the outlet and, when it boils, through the
            # surface as well. Boil-off is real propellant loss: a tank that
            # has been venting has less in it than the load sheet says.
            liquid_mass=-mdot_liquid_out - exchange.mdot - wall_boil,
            liquid_temperature=d_T_liquid,
            contact_time=1.0,
            vapour_mass=exchange.mdot + wall_boil - max(mdot_vapour_out, 0.0),
            evaporation=exchange.mdot,
            latent_power=exchange.latent_power,
            heat_to_wetted_wall=q_wetted,
            heat_to_liquid=q_liquid,
            expansion_power=expansion_power,
            wetted_wall_temperature=d_wetted_wall,
            surface_temperature=d_T_surface,
        )

    def step(self, state: TankState, rates: TankRates, dt: float) -> TankState:
        """One explicit Euler step. Phase 07 replaces this with a real integrator."""
        return TankState(
            ullage=VesselState(
                mass=state.ullage.mass + rates.ullage.mass * dt,
                energy=state.ullage.energy + rates.ullage.energy * dt,
                wall_temperature=state.ullage.wall_temperature
                + rates.ullage.wall_temperature * dt,
            ),
            liquid_mass=state.liquid_mass + rates.liquid_mass * dt,
            liquid_temperature=state.liquid_temperature + rates.liquid_temperature * dt,
            contact_time=state.contact_time + rates.contact_time * dt,
            vapour_mass=max(state.vapour_mass + rates.vapour_mass * dt, 0.0),
            wetted_wall_temperature=(
                None
                if state.wetted_wall_temperature is None
                else state.wetted_wall_temperature + rates.wetted_wall_temperature * dt
            ),
            surface_temperature=(
                None
                if state.surface_temperature is None
                else state.surface_temperature + rates.surface_temperature * dt
            ),
        )

    def pressurant_for_expulsion(
        self,
        state: TankState,
        mdot_liquid: float,
        duration: float,
        *,
        inlet_temperature: float,
        steps: int = 500,
    ) -> dict[str, float]:
        """How much pressurant it takes to hold pressure through an expulsion.

        The question a pressurisation system is actually sized by, and the one
        where ullage collapse shows itself: with pressure held constant the
        collapse never appears in the pressure trace at all, only in this
        number.

        Solves for the gas inflow that keeps ullage pressure at its starting
        value, marching the real energy balance -- expansion work, interfacial
        loss and wall exchange included.

        Returns:
            ``mass`` [kg] of pressurant consumed, the ``heat_to_liquid`` [J]
            lost at the interface over the run, the ``expansion_work`` [J], and
            the ``pressure_error`` [Pa] left at the end, which should be small
            and is reported so it can be checked rather than trusted.
        """
        target = self.pressure(state)
        h_in = self.gas.get("h", p=target, T=inlet_temperature)
        dt = duration / steps
        total_gas = 0.0
        total_heat = 0.0
        total_work = 0.0

        for _ in range(steps):
            if state.liquid_mass <= 0.0:
                break
            # Bisect on the inflow that holds pressure across this step. The
            # relation is monotonic -- more gas in, higher pressure -- so a
            # bracket is guaranteed and a dozen iterations is plenty.
            lo, hi = 0.0, max(mdot_liquid, 1e-6)
            for _ in range(60):
                mid = 0.5 * (lo + hi)
                rates = self.rates(
                    state,
                    mdot_liquid_out=mdot_liquid,
                    mdot_gas_in=mid,
                    enthalpy_gas_in=h_in,
                )
                trial = self.step(state, rates, dt)
                if self.pressure(trial) < target:
                    lo = mid
                else:
                    hi = mid
                if hi - lo < 1e-12:
                    break
                if hi == max(mdot_liquid, 1e-6) and lo == hi:
                    break
                # Widen if even the ceiling cannot hold pressure.
                if lo == hi == max(mdot_liquid, 1e-6):
                    hi *= 2.0
            mdot_gas = 0.5 * (lo + hi)
            rates = self.rates(
                state,
                mdot_liquid_out=mdot_liquid,
                mdot_gas_in=mdot_gas,
                enthalpy_gas_in=h_in,
            )
            state = self.step(state, rates, dt)
            total_gas += mdot_gas * dt
            total_heat += rates.heat_to_liquid * dt
            total_work += rates.expansion_power * dt

        return {
            "mass": total_gas,
            "heat_to_liquid": total_heat,
            "expansion_work": total_work,
            "pressure_error": self.pressure(state) - target,
            "liquid_remaining": state.liquid_mass,
        }

    def __repr__(self) -> str:
        return (
            f"Tank({self.liquid.name!r}/{self.gas.name!r}, "
            f"{self.geometry.total_volume * 1e3:.2f} L, "
            f"collapse={self.collapse.name!r})"
        )

"""Pydantic schemas for YAML/JSON configuration validation"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator, ConfigDict
from typing import Literal, Optional, Union, List, Dict, Tuple, Set
import numpy as np


class FluidConfig(BaseModel):
    """Fluid property configuration"""
    name: str
    density: float = Field(gt=0, description="Density [kg/m³]")
    viscosity: float = Field(gt=0, description="Dynamic viscosity [Pa·s]")
    surface_tension: float = Field(gt=0, description="Surface tension [N/m]")
    vapor_pressure: float = Field(ge=0, description="Vapor pressure [Pa]")
    specific_heat: float = Field(default=2200.0, gt=0, description="Specific heat at constant pressure [J/(kg·K)]")
    thermal_conductivity: float = Field(default=0.15, gt=0, description="Thermal conductivity [W/(m·K)]")
    temperature: float = Field(default=293.15, gt=0, description="Bulk fluid temperature [K]")
    # Fuel-specific properties for combustion physics
    latent_heat: Optional[float] = Field(default=None, gt=0, description="Latent heat of vaporization [J/kg] (fuel only)")
    boiling_point: Optional[float] = Field(default=None, gt=0, description="Boiling point at 1 atm [K] (fuel only)")
    molecular_weight: Optional[float] = Field(default=None, gt=0, description="Molecular weight [g/mol] (fuel only)")
    bulk_modulus_pa: Optional[float] = Field(default=None, gt=0, description="Liquid bulk modulus [Pa] — feed acoustics / water-hammer (stability). Preset-supplied; see configs/propellants/.")
    critical_temperature: Optional[float] = Field(
        default=None, gt=0,
        description=(
            "Liquid critical temperature [K]. Sets the evaporation constant in the chug time-lag "
            "model (Leonardi 2017 eq. 9) — a PROPELLANT property, so it belongs here rather than in "
            "a table inside the stability code. None = look it up (CoolProp, then handbook), and the "
            "lookup is recorded in the assumptions registry."
        ),
    )
    injection_phase: Optional[Literal["liquid", "gas"]] = Field(
        default=None,
        description=(
            "Phase of this propellant AT THE INJECTOR FACE. A gas neither atomizes nor vaporizes, so "
            "it carries only the mixing lag in the chug model; running a droplet-lifetime model on it "
            "invents a lag that does not exist. None = infer from temperature vs critical point and "
            "vapor pressure vs chamber pressure."
        ),
    )


class PintleLOXConfig(BaseModel):
    """LOX (oxidizer) pintle geometry - Axial flow through orifices"""
    n_orifices: int = Field(gt=0, description="Number of orifices on pintle tip")
    d_orifice: float = Field(gt=0, description="Diameter of each orifice [m]")
    theta_orifice: float = Field(ge=0, le=90, description="Angle of orifices from axis [deg]")
    A_entry: float = Field(gt=0, description="Single entry hole area [m²]")
    d_hydraulic: float = Field(gt=0, description="Hydraulic diameter for Re calculation [m]")


class PintleFuelConfig(BaseModel):
    """Fuel (RP-1) pintle geometry - Reservoir with gap spillage"""
    d_pintle_tip: float = Field(gt=0, description="Outer diameter of pintle tip [m]")
    d_reservoir_inner: float = Field(gt=0, description="Inner diameter of fuel reservoir [m]")
    h_gap: float = Field(gt=0, description="Gap height between pintle tip and reservoir [m]")
    A_entry: float = Field(gt=0, description="Single entry port area into reservoir [m²]")
    d_hydraulic: float = Field(gt=0, description="Hydraulic diameter for Re calculation [m] (gap hydraulic diameter)")


class PintleGeometryConfig(BaseModel):
    """Pintle injector geometry configuration"""
    lox: PintleLOXConfig
    fuel: PintleFuelConfig


class InjectorBaseConfig(BaseModel):
    """Base injector configuration with type identifier"""
    type: Literal["pintle", "coaxial", "impinging"]


class PintleInjectorConfig(InjectorBaseConfig):
    """Complete pintle injector configuration"""
    type: Literal["pintle"] = "pintle"
    geometry: PintleGeometryConfig


class CoaxialCoreConfig(BaseModel):
    """Core (inner) element geometry for coaxial injector"""
    n_ports: int = Field(gt=0, description="Number of core ports/nozzles")
    d_port: float = Field(gt=0, description="Diameter of each core port [m]")
    length: Optional[float] = Field(default=None, gt=0, description="Port length for loss modeling [m]")


class CoaxialAnnulusConfig(BaseModel):
    """Annular (outer) element geometry for coaxial injector"""
    inner_diameter: float = Field(gt=0, description="Inner diameter of annulus (matches core OD) [m]")
    gap_thickness: float = Field(gt=0, description="Annulus gap thickness [m]")
    swirl_angle: float = Field(default=0.0, ge=0, le=90, description="Swirl angle for outer flow [deg]")


class CoaxialInjectorGeometry(BaseModel):
    """Complete geometry description for a shear coaxial injector"""
    core: CoaxialCoreConfig
    annulus: CoaxialAnnulusConfig


class CoaxialInjectorConfig(InjectorBaseConfig):
    """Coaxial injector configuration"""
    type: Literal["coaxial"] = "coaxial"
    geometry: CoaxialInjectorGeometry


class ImpingingElementConfig(BaseModel):
    """Geometry parameters for a single impinging jet element"""
    n_elements: int = Field(gt=0, description="Number of elements (pairs or triplets)")
    d_jet: float = Field(gt=0, description="Jet diameter [m]")
    impingement_angle: float = Field(
        gt=0, lt=90,
        description=(
            "This stream's jet angle from the chamber AXIS [deg], not the included angle. "
            "The included angle of an unlike doublet is theta_O + theta_F; the face "
            "incidence the drill sees is 90 - theta."
        ),
    )
    spacing: float = Field(gt=0, description="Center-to-center spacing between jets [m]")


class ImpingingInjectorGeometry(BaseModel):
    """Complete geometry for an impinging injector"""
    oxidizer: ImpingingElementConfig
    fuel: ImpingingElementConfig


class IgniterPortConfig(BaseModel):
    """The igniter port through the centre of the injector plate.

    Hardware, not a requirement: the thread is what was bought, and every keep-out follows from
    it (engine/core/injectors/hardware_tables.NPT). Declaring this derives the centre keep-out
    that ``layer1_injector_center_clear_dia_m`` used to be typed in as a bare number (1.5 in on
    the shipped designs, against the ~25 mm a 1/2 NPT port needs); an explicit value for that
    key still wins and the layout reports both.
    """
    thread: Literal["1/8 NPT", "1/4 NPT", "3/8 NPT", "1/2 NPT", "3/4 NPT"] = Field(
        description="Igniter thread callout. ASME B1.20.1 dimensions are looked up from it.")
    hub_thickness: Optional[float] = Field(default=None, gt=0.0,
        description="Plate thickness AT the port [m] when the centre is left thicker than the "
                    "field -- a raised hub on the back, machined integral ('tall port'), as wide "
                    "as the port's keep-out (thread OD + 2 x layer1_injector_min_web_m). The "
                    "thread needs its effective length L2 of engagement (13.56 mm for 1/2 NPT). "
                    "None => the field thickness layer1_injector_plate_thickness_m.")


class InjectorPlateConfig(BaseModel):
    """The injector as a plug in the chamber sleeve: how its face and back are machined.
    Geometry only -- structure (FEA), seals, the manifold cover and the plug's retention are the
    designer's; engine/core/injectors/layout.py reports the lands they get. The holes' L/d is
    discharge.<side>.orifice_l_over_d: one number sets both the Cd and, with channels, how deep
    the channels sit."""
    face: Literal["flat", "contoured"] = Field(default="contoured",
        description="flat: orifices leave an axis-normal face at the jet angle (elliptical exits, "
                    "the drill enters off square). contoured: the face is turned with an annular "
                    "groove whose flanks are normal to the jets, so each orifice leaves square and "
                    "round (SP-8089 p.43, 'local grooving ... to increase the effective angle').")
    exit_land: Optional[float] = Field(default=None, ge=0.0,
        description="Metal between a round exit and the edge of its flank, and between a passage "
                    "and its channel wall [m]. None => 0.5 mm (assumed).")
    groove_bottom: Literal["flat", "v"] = Field(default="flat",
        description="Contoured face: flat-bottomed groove just deep enough for each exit's land "
                    "(default), or the sharp V where the flanks meet.")
    back: Literal["plenum", "channels"] = Field(default="channels",
        description="plenum: passages run through to a flat back face (a manifold volume behind "
                    "it). channels: the back face is flat with one annular channel per ring; each "
                    "passage runs from its exit to its channel floor and the channel is centred on "
                    "where the passage meets it.")
    channel_width: Optional[float] = Field(default=None, gt=0.0,
        description="Channels back: channel width [m]. None or narrower than the passage footprint "
                    "=> footprint + 2 x exit_land.")
    channel_floor: Literal["flat", "coned"] = Field(default="flat",
        description="Channels back: flat floor (holes break through off square; deburr and "
                    "flow-test) or a floor turned as a cone normal to the passages (square "
                    "breakthrough).")
    channel_inlets: int = Field(default=1, ge=1,
        description="Channels back: feed ports into each channel. Each splits two ways around "
                    "the ring, so a branch carries mdot / (2 x inlets) at the port; the layout "
                    "checks that branch's velocity head against the injector drop.")


class ImpingingInjectorConfig(InjectorBaseConfig):
    """Impinging-element injector configuration"""
    type: Literal["impinging"] = "impinging"
    geometry: ImpingingInjectorGeometry
    igniter: Optional[IgniterPortConfig] = Field(default=None,
        description="Igniter port through the plate centre. None => no port modelled.")
    plate: Optional[InjectorPlateConfig] = Field(default=None,
        description="How the plug's face and back are machined, and its stress-check material. "
                    "None => drawn as a contoured face with a channel back (the defaults); Layer 1 applies the plug's constraints only when declared.")


#: Named feed-line sizes -> flow bore [m]. A line size is a NAME, not a diameter: "3/8 NPT"
#: names a *thread*, and its flow area is set by the fitting's through-bore (~0.380"), not by
#: the 0.375" thread nominal. Those two differ by only 1.3% in diameter but the pair is exactly
#: the kind of near-miss that looks right forever -- so the mapping lives here, once, by name.
FEED_LINE_SIZES: Dict[str, float] = {
    # NPT fittings — keyed on the thread callout the user actually buys, valued at the bore.
    "1/4_NPT": 0.00635,      # 0.250" through-bore
    "3/8_NPT": 0.0096520,    # 0.380" through-bore  (NOT 0.375" — that is the thread nominal)
    "1/2_NPT": 0.0127000,    # 0.500" through-bore
    "3/4_NPT": 0.0190500,    # 0.750" through-bore
    # Tube ODs quote a wall, so the bore depends on it; these assume 0.035" wall.
    # Both values encoded a 0.0325" wall, not the 0.035" their names and comments claim
    # (and the 1/2" comment's own arithmetic was wrong: 0.500 - 2(0.035) = 0.430, not 0.435).
    # Corrected to the stated wall. The old values overstated flow area 2.3-3.3%, which is
    # 4.7-6.7% of understated dp -- small, but this table exists to be the one place the
    # near-miss cannot hide.
    "3/8_TUBE_035": 0.0077470,   # 0.375" OD - 2(0.035") = 0.305"
    "1/2_TUBE_035": 0.0109220,   # 0.500" OD - 2(0.035") = 0.430"
}


class FeedSystemConfig(BaseModel):
    """Feed system configuration for one branch (O or F).

    The feed system is the PLUMBING between tank and injector — line bore plus lumped loss
    coefficients. It sets how much tank pressure is spent getting propellant to the injector
    face, so it directly moves the required tank pressure. It is vehicle hardware and is
    deliberately independent of which propellant flows through it.

    Give ``line_size`` (preferred — a name from FEED_LINE_SIZES) and the bore and area are
    derived for you. ``d_inlet``/``A_hydraulic`` remain available for a non-standard passage,
    and an explicitly-given area always wins over the derived one.
    """
    line_size: Optional[str] = Field(
        default=None,
        description=(
            "Named feed-line size, e.g. '3/8_NPT'. Sets d_inlet (and hence A_hydraulic) from "
            f"the standard bore table. Valid: {', '.join(sorted(FEED_LINE_SIZES))}."
        ),
    )
    d_inlet: float = Field(
        gt=0,
        description=(
            "Inlet flow-path diameter [m] — the actual bore, not a thread size. Normally derived "
            "from line_size; set directly only for a non-standard passage."
        ),
    )
    A_hydraulic: float = Field(
        gt=0,
        description="Flow area of the feed line [m²]. Derived as πd²/4 from d_inlet when omitted.",
    )
    K0: float = Field(ge=0, description="Base loss coefficient")
    K1: float = Field(ge=0, description="Pressure dependence coefficient")
    phi_type: Literal["none", "sqrtP", "logP"] = Field(
        default="none",
        description="Pressure function type"
    )
    length: Optional[float] = Field(
        default=None,
        gt=0,
        description=(
            "Feed-line length from tank outlet to injector manifold [m]. Sets the line inertance "
            "(length / area) in the chug model. Leave unset and the stability model records a "
            "0.305 m assumption instead of using it silently."
        ),
    )
    K_exit: float = Field(
        default=1.0,
        ge=0,
        description=(
            "Loss where the line discharges into the injector manifold, in velocity heads of the "
            "exit bore (d_exit). 1.0: a plenum takes the whole velocity head (Borda-Carnot, "
            "(1 - A_exit/A_manifold)^2 -> 1; Crane TP-410 pipe exit K = 1.0). Set 0 only when K0 "
            "already counts it."
        ),
    )
    d_exit: Optional[float] = Field(
        default=None,
        gt=0,
        description=(
            "Bore that discharges into the manifold [m], e.g. the 1/2 NPT fitting after a 1/2 in "
            "tube run. None => the line itself (A_hydraulic)."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _resolve_line_size(cls, data):
        """Fill d_inlet from line_size, and A_hydraulic from d_inlet, before validation.

        d_inlet and A_hydraulic describe ONE passage two ways, and both used to be required and
        independently editable, so nothing stopped them from disagreeing -- a stale area silently
        outlived the diameter next to it. Deriving here means the pair cannot drift, while an
        explicit A_hydraulic still wins for a genuinely non-circular passage.
        """
        if not isinstance(data, dict):
            return data
        d = dict(data)

        size = d.get("line_size")
        if size is not None:
            key = str(size).strip().replace(" ", "_").replace("-", "_").upper()
            bore = FEED_LINE_SIZES.get(key)
            if bore is None:
                raise ValueError(
                    f"Unknown feed line_size {size!r}. Valid sizes: {', '.join(sorted(FEED_LINE_SIZES))}. "
                    f"For a non-standard passage give d_inlet directly instead."
                )
            d["line_size"] = key
            if d.get("d_inlet") is None:
                d["d_inlet"] = bore
            elif abs(float(d["d_inlet"]) - bore) > 1e-9:
                raise ValueError(
                    f"feed line_size={key} implies d_inlet={bore:.7f} m but d_inlet="
                    f"{float(d['d_inlet']):.7f} m was also given. Drop one -- a named size and a "
                    f"contradicting bore is exactly the drift this field exists to prevent."
                )

        di = d.get("d_inlet")
        if di is not None and d.get("A_hydraulic") is None:
            d["A_hydraulic"] = float(np.pi) / 4.0 * float(di) ** 2
        elif di is None and d.get("A_hydraulic") is not None:
            # Area alone (twin line, non-circular passage): the equal-area bore.
            d["d_inlet"] = float(np.sqrt(4.0 * float(d["A_hydraulic"]) / np.pi))
        return d

    @model_validator(mode="after")
    def _warn_area_diameter_mismatch(self):
        """Flag an A_hydraulic that does not match its own d_inlet (>1% off)."""
        implied = float(np.pi) / 4.0 * self.d_inlet ** 2
        if implied > 0 and abs(self.A_hydraulic - implied) / implied > 0.01:
            import logging
            logging.getLogger(__name__).warning(
                "feed_system: A_hydraulic=%.6e m2 disagrees with pi/4*d_inlet^2=%.6e m2 "
                "(d_inlet=%.6f m, %.1f%% off). Intentional only for a non-circular passage; "
                "otherwise omit A_hydraulic and let it derive.",
                self.A_hydraulic, implied, self.d_inlet,
                100.0 * (self.A_hydraulic - implied) / implied,
            )
        return self


class RegenCoolingConfig(BaseModel):
    """Regenerative cooling channel configuration"""
    enabled: bool = Field(default=False, description="Enable regen cooling model")
    d_inlet: float = Field(gt=0, description="Inlet pipe diameter [m] (e.g., 3/8\" = 0.009525 m)")
    L_inlet: float = Field(gt=0, description="Inlet pipe length [m]")
    n_channels: int = Field(gt=0, description="Number of parallel cooling channels")
    channel_width: float = Field(gt=0, description="Channel width [m]")
    channel_height: float = Field(gt=0, description="Channel height [m]")
    channel_length: float = Field(gt=0, description="Channel length [m] (typically chamber length)")
    d_outlet: Optional[float] = Field(default=None, description="Outlet pipe diameter [m] (default: same as inlet)")
    L_outlet: float = Field(gt=0, description="Outlet pipe length [m] (from merge to injector)")
    roughness: float = Field(default=0.0, ge=0, description="Surface roughness [m] (0 = smooth)")
    K_manifold_split: float = Field(default=0.5, ge=0, description="Manifold split loss coefficient")
    K_manifold_merge: float = Field(default=0.3, ge=0, description="Manifold merge loss coefficient")
    # Dynamic discharge coefficient configuration (similar to injector Cd)
    Cd_entrance_inf: float = Field(default=0.8, gt=0, le=1, description="Asymptotic Cd at high Re for channel entrance")
    a_Re_entrance: float = Field(default=0.1, ge=0, description="Reynolds correction parameter for entrance")
    Cd_entrance_min: float = Field(default=0.6, ge=0, le=1, description="Minimum Cd for entrance")
    Cd_exit_inf: float = Field(default=0.9, gt=0, le=1, description="Asymptotic Cd at high Re for channel exit")
    a_Re_exit: float = Field(default=0.1, ge=0, description="Reynolds correction parameter for exit")
    Cd_exit_min: float = Field(default=0.7, ge=0, le=1, description="Minimum Cd for exit")
    # Heat-transfer coupling (Phase 2)
    use_heat_transfer: bool = Field(default=False, description="Enable coupled heat-transfer calculations for regen cooling")
    wall_thickness: float = Field(default=0.002, gt=0, description="Hot-wall thickness between gas and coolant [m]")
    wall_thermal_conductivity: float = Field(default=300.0, gt=0, description="Wall material thermal conductivity [W/(m·K)]")
    chamber_inner_diameter: Optional[float] = Field(default=None, gt=0, description="Chamber inner diameter for hot-side area [m]")
    hot_gas_prandtl: float = Field(default=0.7, gt=0, description="Assumed hot-gas Prandtl number")
    hot_gas_viscosity: float = Field(default=4.0e-5, gt=0, description="Effective hot-gas viscosity [Pa·s]")
    hot_gas_thermal_conductivity: float = Field(default=0.1, gt=0, description="Effective hot-gas thermal conductivity [W/(m·K)]")
    radiation_emissivity_hot: float = Field(default=0.8, ge=0, le=1, description="Effective hot-side emissivity for radiation")
    radiation_view_factor: float = Field(default=1.0, ge=0, le=1, description="Radiation view factor to coolant surface")
    n_segments: int = Field(default=20, gt=0, description="Number of axial segments for heat-transfer integration")
    gas_turbulence_intensity: float = Field(default=0.1, ge=0, description="Estimated turbulence intensity of hot gas (0-1)")
    coolant_turbulence_intensity: float = Field(default=0.05, ge=0, description="Estimated turbulence intensity of coolant (0-1)")
    recovery_factor: Optional[float] = Field(default=None, gt=0, le=1, description="Turbulent boundary layer recovery factor for adiabatic wall temperature (Taw = Tc × recovery_factor). Typical range: 0.90-0.98. If None, uses default from constants.")


class FilmCoolingConfig(BaseModel):
    """Film cooling configuration"""
    enabled: bool = Field(default=False, description="Enable film cooling model")
    mass_fraction: float = Field(default=0.05, ge=0, le=0.5, description="Fraction of total mass flow used for film injection")
    injection_temperature: Optional[float] = Field(default=None, gt=0, description="Film injection temperature [K] (defaults to fuel temperature)")
    effectiveness_ref: float = Field(default=0.4, ge=0, le=1, description="Reference film effectiveness at injection location")
    decay_length: float = Field(default=0.1, gt=0, description="Characteristic decay length for film effectiveness [m]")
    apply_to_fraction_of_length: float = Field(default=1.0, gt=0, description="Portion of chamber length covered by film cooling")
    slot_height: float = Field(default=3.0e-4, gt=0, description="Annular slot height for film injection [m]")
    reference_blowing_ratio: float = Field(default=0.5, gt=0, description="Reference blowing ratio for effectiveness correlation")
    blowing_exponent: float = Field(default=0.6, gt=0, description="Exponent on blowing ratio for effectiveness correlation")
    turbulence_reference_intensity: float = Field(default=0.08, gt=0, description="Reference turbulence intensity for film erosion")
    turbulence_sensitivity: float = Field(default=1.0, ge=0, description="Sensitivity of film effectiveness to turbulence intensity")
    turbulence_exponent: float = Field(default=1.0, gt=0, description="Exponent governing turbulence erosion scaling")
    turbulence_min_multiplier: float = Field(default=0.4, ge=0, le=1, description="Minimum multiplier applied to effectiveness due to turbulence erosion")
    reference_wall_temperature: float = Field(default=1100.0, gt=0, description="Reference hot wall temperature used for heat-flux estimation [K]")
    density_override: Optional[float] = Field(default=None, gt=0, description="Override density for film coolant if different from bulk fuel [kg/m³]")
    cp_override: Optional[float] = Field(default=None, gt=0, description="Override specific heat for film coolant if different from bulk fuel [J/(kg·K)]")


class SurfaceReactionConfig(BaseModel):
    """Heterogeneous carbon-oxidiser rate A T^b exp(-E/RT) p^n [kg C/(m^2 s)], p in atm."""
    A: float = Field(gt=0, description="Pre-exponential factor [kg/(m^2 s atm^n K^b)]")
    E: float = Field(ge=0, description="Activation energy [J/mol]")
    n: float = Field(ge=0, description="Pressure exponent on the oxidiser partial pressure [-]")
    T_exponent: float = Field(default=0.0, description="Temperature exponent b [-]")


class GraphiteInsertConfig(BaseModel):
    """Graphite throat insert configuration (separate from chamber ablator)"""
    enabled: bool = Field(default=False, description="Enable graphite throat insert")
    material_density: float = Field(default=1800.0, gt=0, description="Graphite density [kg/m³] (typical: 1800-2200)")
    heat_of_ablation: float = Field(default=8.0e6, gt=0, description="Effective heat of ablation [J/kg] (graphite: ~8-12 MJ/kg)")
    thermal_conductivity: float = Field(default=100.0, gt=0, description="Graphite thermal conductivity [W/(m·K)] (typical: 50-150)")
    specific_heat: float = Field(default=710.0, gt=0, description="Graphite specific heat [J/(kg·K)]")
    initial_thickness: float = Field(default=0.005, gt=0, description="Initial graphite insert thickness [m]")
    surface_temperature_limit: float = Field(default=2500.0, gt=0, description="Maximum surface temperature before failure [K]")
    oxidation_temperature: float = Field(default=800.0, gt=0, description="Onset temperature for oxidation [K]")
    oxidation_rate: float = Field(default=1e-6, ge=0, description="Unused by the species model (kept so old configs load)")
    activation_energy: Optional[float] = Field(default=180e3, gt=0, description="Activation energy for Arrhenius oxidation rate [J/mol]. Typical: 150-200 kJ/mol")
    oxidation_reference_temperature: float = Field(default=1500.0, gt=0, description="Reference temperature where oxidation_rate is defined [K]. Typical: 1500-1800 K")
    oxidation_reference_pressure: float = Field(default=1.0e6, gt=0, description="Reference pressure where oxidation_rate is defined [Pa]. Typical: 1 MPa")
    recession_multiplier: Optional[float] = Field(default=None, gt=0, description="Recession multiplier vs chamber (if None, calculated from flow conditions). Typically 1.3-2.5")
    sizing_only_mode: bool = Field(default=False, description="If True, suppress recession for sizing iterations. Graphite does recede in reality; use only for design phase.")
    simplified_graphite_oxidation: bool = Field(default=False, description="If True, use the constant `simplified_oxidation_rate` instead of instead of the physics-based model.")
    simplified_oxidation_rate: float = Field(
        default=1.0e-5,
        ge=0.0,
        description=(
            "Radial recession rate used when `simplified_graphite_oxidation` is true [m/s]. "
            "Default 1e-5 m/s = 0.01 mm/s, which was hardcoded. Measure your own stock and set "
            "it here rather than inheriting a number from someone else's graphite."
        ),
    )
    sizing_recession_rate: float = Field(
        default=1.0e-8,
        ge=0.0,
        description=(
            "Recession rate assumed while SIZING the chamber [m/s]. Default 1e-8 is effectively "
            "zero -- the sizing pass has always treated graphite as non-eroding. Raise it if your "
            "insert measurably recedes over a burn and you want the bore sized for it."
        ),
    )
    axial_half_length_ratio: float = Field(
        default=0.75,
        gt=0.0,
        description=(
            "Graphite insert axial half-length as a multiple of throat DIAMETER, used when "
            "`axial_half_length` is unset. 0.75 was hardcoded in three geometry modules."
        ),
    )
    axial_half_length: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Explicit graphite insert axial half-length [m]. Overrides axial_half_length_ratio.",
    )
    char_layer_conductivity: float = Field(default=5.0, gt=0, description="Thermal conductivity of protective layer [W/(m·K)]")
    char_layer_thickness: float = Field(default=0.0005, gt=0, description="Thickness of protective layer [m]")
    coverage_fraction: float = Field(default=1.0, gt=0, le=1.0, description="Fraction of throat/nozzle with graphite insert")
    emissivity: Optional[float] = Field(default=None, ge=0, le=1, description="Surface emissivity for radiation (default: 0.8)")
    ambient_temperature: Optional[float] = Field(default=None, gt=0, description="Ambient temperature for radiation [K] (default: 300 K)")
    feedback_fraction_min: Optional[float] = Field(default=None, ge=0, le=1, description="Minimum oxidation heat feedback fraction (default: 0.0)")
    feedback_fraction_max: Optional[float] = Field(default=None, ge=0, le=1, description="Maximum oxidation heat feedback fraction (default: 0.2)")
    oxidation_enthalpy: Optional[float] = Field(default=None, gt=0, description="Unused: reaction enthalpies are per species (graphite_cooling.CARBON_OXIDISERS)")
    ablation_surface_temperature: Optional[float] = Field(default=None, gt=0, description="Surface temperature at which thermal ablation pins T_s [K] (default: 3000 K). Above this, T_s is fixed and m_dot_th balances energy.")
    ablation_transition_width: float = Field(default=200.0, gt=0, description="Temperature width [K] for smooth transition to thermal ablation regime.")
    oxidation_pressure_exponent: Optional[float] = Field(default=None, ge=0, description="Pressure exponent for oxidation kinetics (default: 0.5)")
    oxidation_pre_exponential: Optional[float] = Field(default=None, gt=0, description="Pre-exponential factor for Arrhenius oxidation (default: calculated from oxidation_rate)")
    mixture_mw: Optional[float] = Field(default=None, gt=0, description="Average molecular weight of combustion products [kg/mol] (default: 0.024)")
    oxidation_stoichiometry_ratio: Optional[float] = Field(default=None, gt=0, description="Moles of C per mole of O2 (1.0 for CO2, 2.0 for CO) (default: 1.0)")
    oxygen_mass_fraction: Optional[float] = Field(
        default=None,
        ge=0,
        le=1,
        description="Unused: the throat composition comes from CEA.",
    )
    oxygen_mole_fraction: Optional[float] = Field(
        default=None,
        ge=0,
        le=1,
        description="Unused: the throat composition comes from CEA.",
    )
    friction_coefficient_override: Optional[float] = Field(default=None, gt=0, description="Override skin friction coefficient Cf for blowing parameter calculation.")
    reference_diffusivity: Optional[float] = Field(default=None, gt=0, description="Reference O2 diffusivity [m²/s] at reference temperature and pressure.")
    reference_diffusivity_temperature: float = Field(default=1500.0, gt=0, description="Reference temperature [K] for oxygen diffusivity scaling.")
    reference_diffusivity_pressure: float = Field(default=1.0e6, gt=0, description="Reference pressure [Pa] for oxygen diffusivity scaling.")
    # Carbon oxidation by the throat gas (H2O, CO2, OH kinetic; O2, O diffusion-limited). Rates
    # of Bradley et al. 1984, as tabulated by Thakre & Yang, J. Propulsion Power 24(4), 2008.
    oxidation_H2O: SurfaceReactionConfig = Field(
        default_factory=lambda: SurfaceReactionConfig(A=4.8e5, E=288.0e3, n=0.5),
        description="C + H2O -> CO + H2 surface rate (Bradley 1984 via Thakre & Yang 2008)")
    oxidation_CO2: SurfaceReactionConfig = Field(
        default_factory=lambda: SurfaceReactionConfig(A=9.0e3, E=285.0e3, n=0.5),
        description="C + CO2 -> 2 CO surface rate (Bradley 1984 via Thakre & Yang 2008)")
    oxidation_OH: SurfaceReactionConfig = Field(
        default_factory=lambda: SurfaceReactionConfig(A=361.0, E=0.0, n=1.0, T_exponent=-0.5),
        description="C + OH -> CO + H surface rate (Bradley 1984 via Thakre & Yang 2008)")


class StainlessSteelCaseConfig(BaseModel):
    """Stainless steel case configuration (structural wall behind ablative/graphite)"""
    enabled: bool = Field(default=True, description="Enable stainless steel case")
    thickness: float = Field(default=0.003, gt=0, description="Stainless steel wall thickness [m]")
    thermal_conductivity: float = Field(default=15.0, gt=0, description="Thermal conductivity [W/(m·K)]")
    density: float = Field(default=8000.0, gt=0, description="Material density [kg/m³]")
    specific_heat: float = Field(default=500.0, gt=0, description="Specific heat [J/(kg·K)]")
    max_temperature: float = Field(default=1000.0, gt=0, description="Maximum allowable temperature [K] (melting point ~1700K, but limit lower for structural integrity)")
    emissivity: float = Field(default=0.3, ge=0, le=1, description="Surface emissivity")


class AblativeCoolingConfig(BaseModel):
    """Ablative cooling configuration for chamber liner (phenolic)"""
    enabled: bool = Field(default=False, description="Enable ablative cooling model")
    material_density: float = Field(default=1600.0, gt=0, description="Ablator (phenolic) density [kg/m³]")
    heat_of_ablation: float = Field(default=2.5e6, gt=0, description="Heat of ablation [J/kg]: energy per kg consumed beyond the sensible heat from ambient_temperature to ablation_surface_temperature (quasi-steady Landau balance)")
    thermal_conductivity: float = Field(default=0.35, gt=0, description="Ablator (phenolic) thermal conductivity [W/(m·K)]")
    specific_heat: float = Field(default=1500.0, gt=0, description="Ablator (phenolic) specific heat [J/(kg·K)]")
    initial_thickness: float = Field(default=0.01, gt=0, description="Initial ablative (phenolic) thickness [m]")
    surface_temperature_limit: float = Field(default=1200.0, gt=0, description="Allowable surface temperature [K]. A check only; the thermal model runs at ablation_surface_temperature")
    ablation_surface_temperature: float = Field(default=1986.0, gt=0, description="Char surface temperature while the liner ablates [K]. Default 1986 K is the SiO2 melting point (CRC Handbook), the bound on a silica-phenolic char surface; set it for the reinforcement actually used")
    coverage_fraction: float = Field(default=1.0, gt=0, le=1.0, description="Fraction of chamber surface protected by ablative liner")
    pyrolysis_temperature: float = Field(default=900.0, gt=0, description="Characteristic pyrolysis temperature of ablator [K]")
    blowing_efficiency: float = Field(default=0.8, ge=0, le=1, description="Effectiveness of ablative gases in blocking convective heat flux (legacy constant factor, used if use_physics_based_blowing=False)")
    use_physics_based_blowing: bool = Field(default=True, description="If True, use physics-based blowing parameter B = m_dot_pyrolysis/m_dot_external. If False, use constant blowing_efficiency factor.")
    blowing_coefficient: float = Field(default=0.5, gt=0, description="Blowing coefficient c in empirical function f(B) = 1/(1 + c*B). Typical range: 0.3-0.8. Higher values = stronger blowing effect.")
    blowing_min_reduction_factor: float = Field(default=0.1, ge=0, le=1, description="Minimum convective reduction factor (maximum blowing effectiveness). Prevents blowing from reducing convective heat transfer below this fraction. Default 0.1 means maximum 90% reduction. Lower values allow stronger blowing effect.")
    turbulence_reference_intensity: float = Field(default=0.08, gt=0, description="Unused: Bartz already carries the chamber's turbulence (kept so old configs load)")
    turbulence_sensitivity: float = Field(default=1.5, ge=0, description="Unused: Bartz already carries the chamber's turbulence (kept so old configs load)")
    turbulence_exponent: float = Field(default=1.0, gt=0, description="Unused: Bartz already carries the chamber's turbulence (kept so old configs load)")
    turbulence_max_multiplier: float = Field(default=3.0, gt=0, description="Unused: Bartz already carries the chamber's turbulence (kept so old configs load)")
    throat_recession_multiplier: Optional[float] = Field(default=None, gt=0, description="Throat recession multiplier vs chamber (if None, calculated from flow conditions). Typically 1.2-2.0")
    char_layer_conductivity: float = Field(default=0.2, gt=0, description="Thermal conductivity of char layer [W/(m·K)]")
    char_layer_thickness: float = Field(default=0.001, gt=0, description="Thickness of protective char layer [m]")
    surface_emissivity: float = Field(default=0.85, ge=0, le=1, description="Surface emissivity for radiative heat transfer (0-1, typical 0.8-0.9 for charred ablators)")
    ambient_temperature: float = Field(default=300.0, gt=0, description="Liner temperature at ignition [K] (the wall starts at ambient)")
    radiative_sink_minimum_threshold: float = Field(default=400.0, gt=0, description="Unused: the hot face radiates only to the gas (kept so old configs load)")
    radiative_sink_fallback_temperature: float = Field(default=600.0, gt=0, description="Unused: the hot face radiates only to the gas (kept so old configs load)")
    track_geometry_evolution: bool = Field(default=True, description="Enable time-varying geometry tracking (L* evolution)")
    nozzle_ablative: bool = Field(default=False, description="If True, nozzle exit also recedes (A_exit grows). If False, only throat recedes (expansion ratio decreases)")


class DischargeConfig(BaseModel):
    """Discharge coefficient configuration"""
    Cd_inf: float = Field(
        gt=0,
        le=1,
        description=(
            "Baseline Cd at infinite Re for the reference orifice diameter d_ref_m "
            "(thin-plate sharp hole, typically 0.60 for machined impinging jets)."
        ),
    )
    a_Re: float = Field(ge=0, description="Reynolds number correction parameter")
    Cd_min: float = Field(default=0.2, ge=0, le=1, description="Minimum Cd")
    use_geometry_cd: bool = Field(
        default=True,
        description=(
            "When True, Cd_inf is scaled from jet/orifice diameter d_hyd via cd_inf_from_orifice_diameter "
            "before the Re correction (impinging jets; pintle orifice OD / fuel gap hydraulic diameter)."
        ),
    )
    d_ref_m: float = Field(
        default=0.002,
        gt=0,
        description="Reference hole diameter [m] where Cd_inf equals the Cd_inf baseline (default 2 mm).",
    )
    cd_small_hole_exponent: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description=(
            "For d < d_ref: Cd_inf scales as Cd_inf * (d/d_ref)^exponent. 0 (default): the thin-plate "
            "asymptote holds below d_ref; ISO 5167 and Sutton & Biblarz Table 8-2 have small sharp "
            "holes flowing slightly more, not less, so the old 0.2 penalty had the wrong sign."
        ),
    )
    cd_large_hole_log_gain: float = Field(
        default=0.015,
        ge=0.0,
        description="For d > d_ref: Cd_inf += gain * ln(d/d_ref), capped at cd_inf_max.",
    )
    cd_inf_max: float = Field(
        default=0.62,
        gt=0,
        le=1,
        description="Upper cap on geometry-based Cd_inf (slightly radiused / large-hole asymptote).",
    )
    cd_inf_min_geom: float = Field(
        default=0.48,
        gt=0,
        le=1,
        description="Lower floor on geometry-based Cd_inf for very small holes.",
    )
    # --- Orifice inlet geometry: the real, per-orifice Cd knob -------------------------
    # Cd is set by what the INLET EDGE looks like and by L/d, not by hole diameter. Because
    # discharge.oxidizer and discharge.fuel are separate blocks, filleting only ONE side's
    # inlet raises that propellant's Cd and moves the momentum ratio / O/F without touching
    # hole size, element count or angles. One extra machining op, one tuning knob.
    # Both default to None => the existing diameter-based Cd_inf path is unchanged.
    inlet_geometry: Optional[str] = Field(
        default=None,
        description=(
            "Orifice inlet treatment: sharp (0.80) | chamfered (0.84) | conical (0.86) | "
            "rounded_light (0.85) | rounded (0.88) | bellmouth (0.95). Short-tube values at "
            "Re > 1e4 and L/d ~ 2-5 (engine.core.discharge.INLET_GEOMETRY_CD); the thin-plate "
            "0.61 is recovered by orifice_l_over_d -> 0. Overrides the "
            "diameter-scaled Cd_inf when set. Use inlet_radius_ratio instead for a "
            "continuous r/d."
        ),
    )
    inlet_radius_ratio: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Inlet fillet radius / orifice diameter (r/d). Continuous alternative to "
            "inlet_geometry: 0 = sharp (Cd 0.80 short tube), 0.125 = Cd 0.88, >= 0.2 = Cd 0.95 and "
            "saturating. Nurick (1976): cavitation inception margin also rises with inlet "
            "roundness, so this buys flow AND cavitation headroom."
        ),
    )
    orifice_l_over_d: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Orifice length / diameter. Lichtarowicz et al. (1965): Cd peaks near L/d ~ 2 "
            "where expansion past the vena contracta recovers dynamic pressure, falls below "
            "~1 (thin-plate, no recovery) and above ~10 (wall friction). Only applied when "
            "an inlet geometry is set. None => no length correction. With "
            "l_over_d_source='plate' this is the LAND the counterbore leaves, and the L/d the "
            "Cd model uses is what the plate actually gives."
        ),
    )
    l_over_d_source: Literal["declared", "plate"] = Field(
        default="declared",
        description=(
            "Where the orifice L/d comes from. 'declared' (default, previous behaviour): "
            "orifice_l_over_d as typed. 'plate': derived from the injector plate -- "
            "layer1_injector_plate_thickness_m and layer1_injector_counterbore_dia_m -- for the "
            "current hole: with a counterbore the land is min(orifice_l_over_d * d, t/cos theta); "
            "without one the small drill runs the whole passage, L/d = t / (d cos theta). Also "
            "applies the counterbore's velocity of approach and entrance loss (approach_beta)."
        ),
    )
    length_model: Literal["piecewise", "lichtarowicz"] = Field(
        default="lichtarowicz",
        description=(
            "Cd vs L/d. 'lichtarowicz' (default): the published sharp-inlet fit Cd_u = 0.827 - "
            "0.0085 L/d (Lichtarowicz, Duggins & Markland 1965, valid 2 <= L/d <= 10), "
            "normalised so the inlet table's short-tube value sits at L/d 3.18. 'piecewise' "
            "(legacy, unsourced): flat over L/d 2-5, linear roll-off above."
        ),
    )
    approach_beta: Optional[float] = Field(
        default=None, gt=0.0, lt=1.0,
        description=(
            "Orifice / feed-passage diameter ratio d/D when the orifice is fed from a "
            "counterbore, not a plenum. Applies the velocity of approach and a sharp entrance "
            "(K = 0.5, Idelchik) into the counterbore: Cd_eff = 1/sqrt((1-b^4)/Cd^2 + "
            "b^4 (1+K)). Set by l_over_d_source='plate'; None => fed from a plenum."
        ),
    )
    d_min_m: float = Field(
        default=0.0004,
        gt=0,
        description="Minimum diameter used in Cd_geom [m] (below this, clamp to d_min_m).",
    )
    # Pressure and temperature dependence (optional)
    use_pressure_correction: bool = Field(default=False, description="Enable pressure-dependent Cd (compressibility effects)")
    P_ref: float = Field(default=5.0e6, gt=0, description="Reference pressure for pressure correction [Pa]")
    a_P: float = Field(default=0.0, description="Pressure correction coefficient")
    use_temperature_correction: bool = Field(default=False, description="Enable temperature-dependent Cd (viscosity effects)")
    T_ref: float = Field(default=300.0, gt=0, description="Reference temperature for temperature correction [K]")
    a_T: float = Field(default=0.0, description="Temperature correction coefficient")


class SprayAngleConfig(BaseModel):
    """Spray angle model configuration"""
    model: Literal["J", "TMR"] = Field(default="TMR", description="Model type")
    k: float = Field(default=0.5, gt=0, description="J model coefficient")
    n: float = Field(default=0.5, gt=0, description="J model exponent")


class SMDConfig(BaseModel):
    """Sauter Mean Diameter configuration"""
    model: Literal["lefebvre", "nukiyama_tanasawa", "ingebo"] = Field(
        default="lefebvre",
        description=(
            "SMD model type. 'ingebo' is the established impinging-jet correlation "
            "D32 = C_ingebo·d·(We_g·Re_l)^(-1/4) driven by the impingement relative velocity "
            "(recommended for impinging doublets). 'lefebvre' is the legacy We^-m·(1+Oh)^p form."
        ),
    )
    C: float = Field(default=0.5, gt=0, description="Lefebvre constant C")
    m: float = Field(default=0.6, gt=0, description="Lefebvre exponent m")
    p: float = Field(default=0.0, description="Lefebvre exponent p (viscous term (1+Oh)^p)")
    C_ingebo: float = Field(
        default=3.9,
        gt=0,
        description=(
            "Prefactor for the Ingebo impinging-jet SMD correlation "
            "D32 = C_ingebo·d·(We_g·Re_l)^(-1/4). Literature reports ~3.9-5.0; "
            "calibrate against a reference/target SMD."
        ),
    )
    chamber_gas_R: float = Field(
        default=360.0,
        gt=0,
        description=(
            "Representative specific gas constant [J/(kg·K)] of the combustion gas, used only to "
            "estimate the chamber gas density (rho_g = Pc/(R·T)) for the aerodynamic Weber number "
            "in the Ingebo correlation. The injector solve runs before CEA chamber state is "
            "available, so this is a configured representative value (LOX/CH4 ≈ 360)."
        ),
    )
    chamber_gas_T: float = Field(
        default=3500.0,
        gt=0,
        description=(
            "Representative combustion-gas temperature [K] for the chamber gas density estimate "
            "rho_g = Pc/(R·T) used in the Ingebo aerodynamic Weber number (LOX/CH4 ≈ 3500)."
        ),
    )
    we_corr_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Optional cap applied to the liquid Weber number **only** when evaluating the "
            "Lefebvre-style ``smd_lefebvre`` correlation (D32). Full We is still used for "
            "``check_spray_constraints``. Jet-like impingement can produce enormous We with "
            "liquid ρ and mm jets, which drives D32 to sub-micron values outside the correlation's "
            "useful regime; capping We_corr is a pragmatic surrogate for secondary breakup / "
            "turbulence limits. Default None = no cap."
        ),
    )


class EvaporationConfig(BaseModel):
    """Evaporation model configuration"""
    model: Literal["derived", "constant"] = Field(
        default="derived",
        description=(
            "'derived' computes the d²-law constant from propellant properties and chamber "
            "state: k_evap = C·(8·ρ_g·D_v/ρ_l)·ln(1+B_M), so it responds to fuel volatility, "
            "chamber temperature and pressure. 'constant' uses the legacy fixed K, which was "
            "identical for ethanol, methane and RP-1 and did not move with Pc or Tc at all."
        ),
    )
    C_evap: float = Field(
        default=1.562,
        gt=0,
        description=(
            "Calibration constant for the derived evaporation model. Anchored so ethanol at "
            "3094 K / 450 psi reproduces k_evap = 3.33e-6 m²/s — the value the legacy fixed K "
            "implied, and within 10% of a T² extrapolation of measured ethanol droplet data."
        ),
    )
    cp_gas: float = Field(
        default=2200.0,
        gt=0,
        description="Representative combustion-gas cp [J/(kg·K)] for the Spalding number B_M.",
    )
    apply_tau_res_correction: bool = Field(
        default=False,
        description=(
            "[DEPRECATED — no effect on c*] The vaporization march (combustion_physics) follows "
            "the drops from the face and integrates their evaporation, so taking the spray length "
            "off the stay time would count it twice. Still read by the numba kernel until it is "
            "mirrored."
        ),
    )
    K: float = Field(
        default=3e5,
        gt=0,
        description=(
            "LEGACY fixed evaporation constant [s/m²] — note this is the RECIPROCAL of the "
            "textbook d²-law constant (k_evap = 1/K, so 3e5 ⇒ 3.33e-6 m²/s). Used only when "
            "model='constant', or as a fallback when a fluid lacks latent_heat/boiling_point."
        ),
    )
    x_star_limit: float = Field(default=0.05, gt=0, description="Max evaporation length [m]")
    use_constraint: bool = Field(default=True, description="Enable x* constraint")



class PintleSprayConfig(BaseModel):
    """Pintle-specific spray correlation parameters"""
    C: float = Field(default=15.0, gt=0, description="Correlation coefficient C")
    B: float = Field(default=2.0, ge=0, description="Ohnesorge multiplier B")
    n: float = Field(default=0.5, gt=0, description="Weber exponent n")
    p: float = Field(default=0.2, ge=0, description="Ohnesorge exponent p")


class SprayConfig(BaseModel):
    """Spray/mixing model configuration"""
    momentum_flux_ratio: bool = Field(default=True, description="Enable J calculation")
    spray_angle: SprayAngleConfig = Field(default_factory=SprayAngleConfig)
    weber: dict = Field(default_factory=lambda: {"We_min": 15.0})
    smd: SMDConfig = Field(default_factory=SMDConfig)
    pintle: PintleSprayConfig = Field(default_factory=PintleSprayConfig)
    evaporation: EvaporationConfig = Field(default_factory=EvaporationConfig)
    use_turbulence_corrections: bool = Field(default=False, description="Enable turbulence-dependent spray corrections")
    turbulence_breakup_gain: float = Field(default=1.0, ge=0, description="Gain applied to droplet breakup due to turbulence")
    turbulence_penetration_gain: float = Field(default=0.5, ge=0, description="Gain applied to evaporation length reduction due to turbulence")


class CEAConfig(BaseModel):
    use_parallel_cea_build: bool = Field(default=True, description="Use parallel processing for CEA cache building")
    cea_parallel_workers: Optional[int] = Field(default=None, description="Number of parallel workers (None = auto-detect, limited to 8)")
    """CEA (Chemical Equilibrium Analysis) configuration"""
    ox_name: str = Field(default="LOX", description="Oxidizer name")
    fuel_name: str = Field(default="RP-1", description="Fuel name")
    expansion_ratio: float = Field(gt=1, description="Nozzle expansion ratio (initial/default value)")
    cache_file: str = Field(default="cea_cache_LOX_RP1.npz", description="Cache filename")
    Pc_range: List[float] = Field(
        default=[2.0e6, 9.0e6],
        description="Chamber pressure range [Pa]"
    )
    MR_range: List[float] = Field(
        default=[2.0, 2.8],
        description="Mixture ratio range"
    )
    eps_range: Optional[List[float]] = Field(
        default=None,
        description="Expansion ratio range for 3D cache [min, max]. If None, uses 2D cache with fixed expansion_ratio"
    )
    n_points: int = Field(default=34, gt=0, description="Number of grid points per dimension (34³ ≈ 39,300 points for 3D cache, similar to old 2D cache with ~40k points)")


class CombustionEfficiencyConfig(BaseModel):
    """c* efficiency: eta_c* = eta_vap * eta_mix * eta_HL (engine/pipeline/combustion_physics.py,
    combustion_eff.py). Chemical kinetics carry no chamber c* loss."""
    model: Literal["constant", "linear", "exponential"] = Field(
        default="exponential",
        description="Vaporization term. exponential (legacy name): the Priem-Heidmann spray march, "
                    "eta_vap = fraction vaporized at the throat. constant: eta_vap = 1 - C. "
                    "linear: eta_vap = 1 - C (1 - L*/1 m)."
    )
    C: float = Field(default=0.3, ge=0, le=1, description="Vaporization loss for the constant and linear models only.")
    K: float = Field(default=0.15, ge=0, description="[DEPRECATED — no effect] Read by no model.")
    use_spray_correction: bool = Field(default=False, description="[DEPRECATED — no effect] Read by no model.")
    spray_penalty_factor: float = Field(default=0.8, ge=0, le=1, description="[DEPRECATED — no effect] Read by no model.")
    use_mixture_coupling: bool = Field(
        default=False,
        description="[DIAGNOSTICS ONLY] Enable mixture diagnostics logging (does NOT affect efficiency calculation)"
    )
    use_cooling_coupling: bool = Field(
        default=True,
        description="Charge heat lost through the chamber wall to c*: eta_HL = sqrt(1 - Q/(mdot cp Tc)) "
                    "(c* ~ sqrt(T0), Sutton eq. 3-32). Regenerative and film heat stay with the propellant."
    )
    use_turbulence_coupling: bool = Field(
        default=False,
        description="[DEPRECATED] Turbulence is folded into eta_mixing; the standalone eta_turbulence penalty was removed (non-physical/double-counted)."
    )
    # --- Mixing: eta_mix = Em_peak exp(-(ln sqrt(M/M_opt))^2 / (2 sigma^2)) ---
    # M = rho_O v_O^2 d_O / (rho_F v_F^2 d_F), Elverum & Morey (JPL Memo 30-5) eq. 1.
    Em_peak: float = Field(
        default=0.96, ge=0.5, le=1.0,
        description="ASSUMED c* mixing efficiency at M = rupe_M_opt; no correlation predicts it. "
                    "0.96 puts a well-atomized, balanced design in the 0.90-0.97 c* efficiency band "
                    "SP-8089 and Sutton report for unlike doublets. Replace it with hot-fire c*."
    )
    mixing_sigma: float = Field(
        default=1.5, gt=0.0,
        description="ASSUMED log-Gaussian width of the mixing falloff in ln sqrt(M) (the scale of "
                    "the old momentum-ratio model, sqrt(M) = R sqrt(d_O/d_F)); 1.5 costs 1 % at "
                    "M = 0.65 or 1.53. Not from data: Rupe's and Elverum & Morey's curves fix the "
                    "optimum, not the width."
    )
    rupe_M_opt: float = Field(
        default=1.0, gt=0.0,
        description="Elverum-Morey mixing parameter at which mixing is best: 1.0 for a 1-on-1 unlike "
                    "doublet (SP-8089 Table IV; 2-on-1 1.6, 3-on-1 3.5)."
    )
    R_opt: Optional[float] = Field(
        default=None,
        description="[DEPRECATED — no effect] The mixing optimum is rupe_M_opt; the resultant-tilt "
                    "momentum ratio no longer enters c*."
    )
    spray_size_spread_q: float = Field(
        default=3.0, gt=1.0,
        description="ASSUMED Rosin-Rammler spread q of each stream's drop sizes (volume basis, "
                    "X = D32 Gamma(1 - 1/q)) in the vaporization march. Lefebvre: 1.5-4 for most "
                    "sprays; larger q is a narrower spray."
    )
    mixture_efficiency_floor: float = Field(default=0.25, ge=0, le=1, description="[DEPRECATED] No longer used")
    cooling_efficiency_floor: float = Field(
        default=0.25, ge=0, le=1,
        description="Floor on the chamber solver's legacy cooling_efficiency diagnostic only; the c* "
                    "heat-loss factor has none."
    )
    turbulence_efficiency_floor: float = Field(default=0.3, ge=0, le=1, description="[DEPRECATED] No longer used")
    target_turbulence_intensity: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] Design target only, not used in efficiency calculation"
    )
    turbulence_penalty_exponent: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    target_smd_microns: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] Design target only, not used in efficiency calculation"
    )
    xstar_limit_mm: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    xstar_penalty_exponent: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    we_reference: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] Design target only, not used in efficiency calculation"
    )
    we_penalty_exponent: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    smd_penalty_exponent: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    use_advanced_model: bool = Field(
        default=False,
        description="Lets the numba accelerator run the chamber solve (engine/accel can_handle_chamber). "
                    "The physics is the same either way."
    )
    Pc_gate: float = Field(
        default=1000000.0,
        ge=0,
        description="[DEPRECATED — no effect] Read by no model."
    )
    use_finite_rate_chemistry: bool = Field(
        default=True,
        description="[DEPRECATED — no effect] Chamber kinetics carry no c* loss (products relax in "
                    "~1 us against a ~1 ms stay time); nozzle kinetics are bracketed by CEA's Cf."
    )
    use_shifting_equilibrium: bool = Field(
        default=True,
        description="[DEPRECATED — no effect] The iterative shifting-equilibrium nozzle was retired; "
                    "exit-composition shift is captured exactly by CEA's Cf_vac table "
                    "(RPA delivered thrust). Kept for config compatibility only."
    )
    # Retired RP-1 kinetics surrogate (tau_chem switched on O/F plateaus); read by no model.
    tau_ref: float = Field(default=1e-5, gt=0, description="[DEPRECATED — no effect] Retired kinetics surrogate [s].")
    tau_ref_P: float = Field(default=4.0e6, gt=0, description="[DEPRECATED — no effect] Retired kinetics surrogate [Pa].")
    tau_ref_T: float = Field(default=3500.0, gt=0, description="[DEPRECATED — no effect] Retired kinetics surrogate [K].")
    n_pressure: float = Field(default=0.8, ge=0, description="[DEPRECATED — no effect] Retired kinetics surrogate.")
    tau_Tc_floor_K: Optional[float] = Field(default=None, description="[DEPRECATED — no effect] Retired kinetics surrogate [K].")
    T_star_fuel_cap_K: float = Field(
        default=1000.0,
        gt=0,
        description="[DEPRECATED — no effect] Drops now evaporate at their saturation temperature at Pc "
                    "(Clausius-Clapeyron from fluids.*.boiling_point) [K]."
    )
    # Arrhenius kinetics parameters (fuel-specific, can be overridden per fuel type)
    A0_hydrocarbon: float = Field(
        default=1e7,
        gt=0,
        description="[Progress diagnostic only: reaction_chemistry, time-varying solver; no effect on c*] Pre-exponential factor for hydrocarbon fuels (RP-1, Kerosene) [1/s]. Default 1e7."
    )
    Ea_hydrocarbon: float = Field(
        default=80000.0,
        gt=0,
        description="[Progress diagnostic only: reaction_chemistry, time-varying solver; no effect on c*] Activation energy for hydrocarbon fuels (RP-1, Kerosene) [J/mol]. Default 80 kJ/mol."
    )
    n_pre_hydrocarbon: float = Field(
        default=0.3,
        ge=0,
        description="[Progress diagnostic only: reaction_chemistry, time-varying solver; no effect on c*] Pre-exponential pressure exponent for hydrocarbons. Default 0.3."
    )
    A0_ethanol: float = Field(
        default=5e7,
        gt=0,
        description="[Progress diagnostic only: reaction_chemistry, time-varying solver; no effect on c*] Pre-exponential factor for ethanol [1/s]. Default 5e7 (faster than RP-1)."
    )
    Ea_ethanol: float = Field(
        default=140000.0,
        gt=0,
        description="[Progress diagnostic only: reaction_chemistry, time-varying solver; no effect on c*] Activation energy for ethanol [J/mol]. Default 140 kJ/mol (higher than RP-1)."
    )
    n_pre_ethanol: float = Field(
        default=0.25,
        ge=0,
        description="[Progress diagnostic only: reaction_chemistry, time-varying solver; no effect on c*] Pre-exponential pressure exponent for ethanol. Default 0.25."
    )
    A0_hydrogen: float = Field(
        default=1e9,
        gt=0,
        description="[Progress diagnostic only: reaction_chemistry, time-varying solver; no effect on c*] Pre-exponential factor for hydrogen [1/s]. Default 1e9 (much faster than hydrocarbons)."
    )
    Ea_hydrogen: float = Field(
        default=40000.0,
        gt=0,
        description="[Progress diagnostic only: reaction_chemistry, time-varying solver; no effect on c*] Activation energy for hydrogen [J/mol]. Default 40 kJ/mol (lower than hydrocarbons)."
    )
    n_pre_hydrogen: float = Field(
        default=0.2,
        ge=0,
        description="[Progress diagnostic only: reaction_chemistry, time-varying solver; no effect on c*] Pre-exponential pressure exponent for hydrogen. Default 0.2."
    )


class CombustionConfig(BaseModel):
    """Combustion configuration"""
    cea: CEAConfig = Field(default_factory=CEAConfig)
    efficiency: CombustionEfficiencyConfig = Field(default_factory=CombustionEfficiencyConfig)


class StabilityConfig(BaseModel):
    """Inputs to the combustion / feed stability model that belong to neither the propellant
    (``fluids``) nor the plumbing (``feed_system``): the combustion-response calibration, the
    nozzle-entrance Mach the acoustic damping uses, the acoustic damping coefficients, and the
    dome-regulator dynamics. A ``None`` here means "derive it" and the derivation is recorded in
    the assumptions registry (rich report -> assumptions.fallbacks_used), never substituted silently.
    """
    n_interaction: float = Field(
        default=0.5, gt=0,
        description="Crocco interaction index n (calibration range 0.3-0.6). The forward-mode slider overrides it per run.",
    )
    chi_acoustic: float = Field(
        default=0.15, gt=0, le=1,
        description="Sensitive-lag fraction chi: tau_sens = chi * tau_vap for the acoustic n-tau driving.",
    )
    mach_nozzle_entrance: Optional[float] = Field(
        default=None, gt=0, lt=1,
        description="Mean Mach at the nozzle entrance (sets nozzle damping). None = solve it from the contraction ratio (isentropic, subsonic).",
    )
    damping_injector_frac: float = Field(
        default=0.02, ge=0,
        description="Injector-face acoustic damping as a fraction of pi*f [-]. ASSUMED, uncalibrated (no source); calibrate against a cold ring-down test (T7).",
    )
    damping_twophase_frac: float = Field(
        default=0.03, ge=0,
        description="Two-phase (droplet) acoustic damping as a fraction of pi*f*droplet_loading [-]. ASSUMED, uncalibrated (no source).",
    )
    droplet_loading: float = Field(
        default=1.0, ge=0,
        description="Relative liquid loading near the injector face for the two-phase damping term [-].",
    )
    acoustic_gate_alpha_offset: float = Field(
        default=350.0, ge=0,
        description=(
            "UNUSED. Was an allowance that let a mode growing at up to this rate [1/s] pass the old "
            "tanh-remapped acoustic gate. The acoustic margin is now damping/driving (1 = neutral) and "
            "stability.acoustic_gate decides whether it gates. Kept so older configs still load."
        ),
    )
    acoustic_gate: Literal["report_only", "nominal_phase", "worst_phase"] = Field(
        default="report_only",
        description=(
            "Which acoustic (HF) margin reaches the stability gate. 'report_only': none -- the modes, "
            "damping budget and margins are reported but gate nothing, because the injector-face and "
            "two-phase damping are uncalibrated and omega*tau_sens spans many periods of 2*pi (Harrje & "
            "Reardon SP-194 rate HF stability by test). 'nominal_phase': damping/driving at the model's "
            "tau_sens. 'worst_phase': damping/driving at omega*tau = pi (Crocco's n_min/n)."
        ),
    )
    time_lag_model: Literal["leonardi_dtl", "d2_law"] = Field(
        default="leonardi_dtl",
        description=(
            "Named model for the injection->heat-release conversion lag that drives the chug loop. "
            "'leonardi_dtl' is the double-time-lag decomposition tau_atom + tau_vap + tau_mix of "
            "Leonardi et al., Acta Astronautica 139 (2017); 'd2_law' is STAR's historical quiescent "
            "droplet lifetime, kept for reproducing older results. See "
            "scripts/chug_timelag_benchmark.py for the measurement that chose the default."
        ),
    )
    convection_model: Literal["none", "leonardi_eq8", "ranz_marshall"] = Field(
        default="none",
        description=(
            "Convective speed-up applied to the droplet lifetime. Default 'none': the Leonardi eq. 9 "
            "evaporation constant is already calibrated against real chamber data, and applying "
            "eq. 8 on top of it triples the chug-frequency error against the reference experiment."
        ),
    )
    mixing_lag_fraction: float = Field(
        default=0.5, ge=0.0, le=3.0,
        description=(
            "Mixing lag as a fraction of the rate-limiting vaporization lag, shared by every stream "
            "(a gaseous propellant carries this and nothing else). Default 0.5 is Leonardi's own "
            "calibration for the validation engine: tau_mix = 2.2 ms at tau_vap = 4.4 ms. Set 0 to "
            "drop the mixing lag entirely."
        ),
    )
    regulator_enabled: bool = Field(default=True, description="Model the dome regulator upstream of each tank in the chug loop.")
    regulator_corner_hz: float = Field(default=3.0, gt=0, description="Regulator response corner frequency [Hz].")
    chug_band_mixing_lag_fraction_min: Optional[float] = Field(
        default=0.0, ge=0.0, le=3.0,
        description=(
            "Low end of the mixing-lag fraction band the chug gate must hold over. The fraction's only "
            "source is Leonardi 2017's GH2/LOX coaxial rig (0.5); nothing measures it for this "
            "propellant or injector, so the gate takes the lowest gain margin over [min, max]. Set both "
            "ends null to gate on mixing_lag_fraction alone once it is measured. leonardi_dtl only."
        ),
    )
    chug_band_mixing_lag_fraction_max: Optional[float] = Field(
        default=1.0, ge=0.0, le=3.0,
        description="High end of the chug gate's mixing-lag fraction band (see the _min field).",
    )
    regulator_Z_hf: float = Field(
        default=0.0, ge=0,
        description=(
            "Regulator high-frequency series impedance [Pa*s/kg]. 0 = regulator NOT MODELLED: the feed "
            "sees an ideal pressure source, and the report says so instead of printing a with/without "
            "pair. Set it only from a measured step response (T6)."
        ),
    )
    regulator_max_excursion_psi: float = Field(
        default=0.0, ge=0,
        description="Regulator outlet pressure excursion bound [psi]. Reporting only; not a pole-shifter.",
    )


class ChamberGeometryConfig(BaseModel):
    """
    Unified chamber geometry configuration for solve_chamber_geometry_with_cea.
    Groups all design inputs (chamber + nozzle) in one place.
    """
    # Design requirements
    design_pressure: float = Field(gt=0, description="Target chamber pressure Pc [Pa]")
    design_thrust: float = Field(gt=0, description="Target thrust F [N]")
    design_MR: float = Field(gt=0, description="Design mixture ratio O/F")
    
    # Chamber dimensions
    chamber_diameter: float = Field(gt=0, description="Inner chamber diameter [m]")
    Lstar: float = Field(gt=0, description="Characteristic length [m] (0.95-1.27 for LOX/RP-1)")
    
    # Nozzle dimensions
    exit_diameter: float = Field(gt=0, description="Nozzle exit diameter [m]")
    expansion_ratio: float = Field(gt=1, description="Area ratio A_exit/A_throat")
    nozzle_efficiency: float = Field(default=0.95, ge=0, le=1, description="Nozzle efficiency (0.94-0.98)")
    
    # Solver outputs (populated after running solver)
    A_throat: Optional[float] = Field(default=None, gt=0, description="Throat area [m²] - SOLVED")
    A_exit: Optional[float] = Field(default=None, gt=0, description="Exit area [m²] - SOLVED")
    volume: Optional[float] = Field(default=None, gt=0, description="Chamber volume [m³] - SOLVED")
    length: Optional[float] = Field(default=None, gt=0, description="Total chamber length [m] - SOLVED")
    length_cylindrical: Optional[float] = Field(default=None, gt=0, description="Cylindrical section length [m] - SOLVED")
    length_contraction: Optional[float] = Field(default=None, gt=0, description="Contraction section length [m] - SOLVED")
    Cf: Optional[float] = Field(default=None, gt=0, description="Thrust coefficient - SOLVED")


class ChamberConfig(BaseModel):
    """Chamber geometry configuration"""
    volume: float = Field(gt=0, description="Chamber volume [m³]")
    A_throat: float = Field(gt=0, description="Throat area [m²]")
    length: Optional[float] = Field(default=None, gt=0, description="Total chamber length [m]")
    length_cylindrical: Optional[float] = Field(default=None, gt=0, description="Cylindrical section length [m]")
    length_contraction: Optional[float] = Field(default=None, gt=0, description="Contraction section length [m]")
    Lstar: Optional[float] = Field(
        default=None,
        gt=0,
        description="Characteristic length [m] = V_chamber / A_throat. If not specified, calculated from volume and A_throat."
    )
    chamber_inner_diameter: Optional[float] = Field(default=None, gt=0, description="Chamber inner diameter [m]")
    exit_diameter: Optional[float] = Field(default=None, gt=0, description="Nozzle exit diameter [m] for geometry solver")
    
    # Design parameters for solve_chamber_geometry_with_cea
    design_pressure: Optional[float] = Field(default=None, gt=0, description="Design chamber pressure [Pa] (Pc_design)")
    design_thrust: Optional[float] = Field(default=None, gt=0, description="Design thrust [N] (F_design)")
    design_MR: Optional[float] = Field(default=None, gt=0, description="Design mixture ratio O/F for CEA solver")
    design_force_coefficient: Optional[float] = Field(default=None, gt=0, description="Solved thrust coefficient Cf (output from solver)")


class NozzleConfig(BaseModel):
    """Nozzle configuration"""
    A_throat: float = Field(gt=0, description="Throat area [m²]")
    A_exit: float = Field(gt=0, description="Exit area [m²]")
    expansion_ratio: float = Field(gt=1, description="Expansion ratio (A_exit/A_throat)")
    exit_diameter: Optional[float] = Field(default=None, gt=0, description="Nozzle exit diameter [m]")
    efficiency: float = Field(default=0.98, ge=0, le=1, description="Nozzle efficiency")


class ClosureConfig(BaseModel):
    """Closure iteration configuration"""
    max_iterations: int = Field(default=6, gt=0, description="Max closure iterations")
    Cd_reduction_factor: float = Field(
        default=1.0,
        ge=0,
        le=1,
        description=(
            "Multiplier applied to the injector Cd each time the spray constraints are "
            "violated. 1.0 = OFF, which is the default and the physical answer. "
            "WAS 0.95, and that is not a discharge coefficient -- a drilled orifice does "
            "not flow less because its spray is long. Measured on the 8 kN ethalox point: "
            "the loop shrank Cd from 0.6017 to 0.4658 (0.6055 * 0.95^5, exactly), a 23% "
            "error that propagates straight into orifice sizing, and at a realistic Cd the "
            "same hardware then makes +11.9% thrust with dP/Pc falling to 0.164, under the "
            "0.20 chug floor. Worse, the feedback has the WRONG SIGN: lower Cd means lower "
            "jet velocity, larger SMD and a LONGER evaporation length, so x* went from "
            "0.1256 m to 0.1338 m while the limit it was chasing is 0.05 m. It never "
            "converged -- it just exhausted max_iterations. An x* violation is an "
            "infeasibility to report (it is in diagnostics as x_star), not something to "
            "fudge the discharge coefficient for. Set below 1.0 only to reproduce a legacy run."
        ),
    )
    tolerance: float = Field(default=1e-4, gt=0, description="Convergence tolerance")


class SolverConfig(BaseModel):
    """Solver configuration"""
    method: Literal["brentq", "secant", "newton"] = Field(
        default="brentq",
        description="Root finding method"
    )
    Pc_bounds: List[float] = Field(
        default=[100000.0, 8000000.0],
        description="Chamber pressure bounds [Pa]"
    )
    tolerance: float = Field(default=1e-6, gt=0, description="Root finding tolerance")
    max_iterations: int = Field(default=100, gt=0, description="Max iterations")
    closure: ClosureConfig = Field(default_factory=ClosureConfig)


InjectorConfig = Union[PintleInjectorConfig, CoaxialInjectorConfig, ImpingingInjectorConfig]


# Flight simulation configuration classes
class LOXTankConfig(BaseModel):
    """LOX tank geometry configuration for flight simulation"""
    lox_h: float = Field(gt=0, description="LOX tank height (internal cylindrical length, not including end caps) [m]")
    lox_radius: float = Field(gt=0, description="LOX tank internal radius [m]")
    ox_tank_pos: float = Field(description="LOX tank center position relative to nozzle exit (positive = above nozzle) [m]")
    mass: Optional[float] = Field(default=None, gt=0, description="Initial LOX PROPELLANT mass [kg] (liquid only, not tank structure). Depletes during burn.")
    initial_pressure_psi: Optional[float] = Field(default=None, gt=0, description="Initial LOX tank pressure [psi]")
    tank_volume_m3: Optional[float] = Field(default=None, gt=0, description="LOX tank volume [m³]. If not provided, will be calculated from lox_h and lox_radius using π×r²×h")
    # The T-0 ullage: V_tank - m/rho_liquid of gas at initial_pressure_psi (absolute, as the engine
    # solver reads it) and this temperature, from CoolProp. Ground pre-pressurisation charges it, so
    # it is carried on top of press_tank.initial_gas_mass; the COPV then only refills what drains.
    ullage_gas: str = Field(default="Nitrogen", description="CoolProp name of the pressurant in the ullage (GN2 system)")
    ullage_gas_temperature_K: float = Field(default=293.15, gt=0, description="Ullage gas temperature [K] at T-0 and as the regulator refills it. Default: pressurant at ambient (bottle) temperature, not a measured ullage; gas chilled by LOX is denser.")


class FuelTankConfig(BaseModel):
    """Fuel tank geometry configuration for flight simulation. The rp1_* field names are legacy; the tank holds whichever fuel the config names."""
    rp1_h: float = Field(gt=0, description="Fuel tank height (internal cylindrical length, not including end caps) [m]")
    rp1_radius: float = Field(gt=0, description="Fuel tank internal radius [m]")
    fuel_tank_pos: float = Field(description="Fuel tank center position relative to nozzle exit (positive = above, negative = below nozzle) [m]")
    mass: Optional[float] = Field(default=None, gt=0, description="Initial fuel PROPELLANT mass [kg] (liquid only, not tank structure). Depletes during burn.")
    initial_pressure_psi: Optional[float] = Field(default=None, gt=0, description="Initial fuel tank pressure [psi]")
    tank_volume_m3: Optional[float] = Field(default=None, gt=0, description="Fuel tank volume [m³]. If not provided, will be calculated from rp1_h and rp1_radius using π×r²×h (field names are legacy)")
    # The T-0 ullage: V_tank - m/rho_liquid of gas at initial_pressure_psi (absolute, as the engine
    # solver reads it) and this temperature, from CoolProp. Ground pre-pressurisation charges it, so
    # it is carried on top of press_tank.initial_gas_mass; the COPV then only refills what drains.
    ullage_gas: str = Field(default="Nitrogen", description="CoolProp name of the pressurant in the ullage (GN2 system)")
    ullage_gas_temperature_K: float = Field(default=293.15, gt=0, description="Ullage gas temperature [K] at T-0 and as the regulator refills it. Default: pressurant at ambient (bottle) temperature, not a measured ullage; gas chilled by LOX is denser.")


class PressTankConfig(BaseModel):
    """Pressurant (COPV) tank configuration for flight simulation.
    
    For gaseous nitrogen (GN2) pressurization system.
    - dry_mass: COPV tank structure mass (walls, fittings)
    - initial_gas_mass: Initial N2 gas mass from COPV sizing
    - free_volume_L: COPV free internal volume in liters
    """
    press_h: float = Field(gt=0, description="Pressurant tank height (internal cylindrical length) [m]")
    press_radius: float = Field(gt=0, description="Pressurant tank internal radius [m]")
    pres_tank_pos: float = Field(description="Pressurant tank center position relative to nozzle exit (positive = above nozzle) [m]")
    dry_mass: Optional[float] = Field(default=None, gt=0, description="COPV tank structure mass (tank walls only, no gas) [kg]")
    initial_gas_mass: Optional[float] = Field(default=None, gt=0, description="Initial N2 pressurant gas mass [kg] (from COPV sizing)")
    mass: Optional[float] = Field(default=None, gt=0, description="LEGACY: Use initial_gas_mass instead")
    free_volume_L: Optional[float] = Field(default=4.5, gt=0, description="COPV free internal volume [L]")


class FinsConfig(BaseModel):
    """Fins configuration for flight simulation"""
    no_fins: int = Field(gt=0, description="Number of fins (typically 3 or 4)")
    root_chord: float = Field(gt=0, description="Root chord length (fin edge attached to body) [m]")
    tip_chord: float = Field(gt=0, description="Tip chord length (outer fin edge) [m]")
    fin_span: float = Field(gt=0, description="Fin span (height from body to fin tip) [m]")
    fin_position: float = Field(description="Fin leading edge position from rocket tail (z=0) [m]")


class MotorConfig(BaseModel):
    """Motor configuration for flight simulation (LEGACY - use propulsion_dry_mass instead)"""
    dry_mass: float = Field(gt=0, description="Motor dry mass [kg]")
    inertia: List[float] = Field(description="Motor inertia [kg·m²]")


class RocketConfig(BaseModel):
    """Rocket configuration for flight simulation.
    
    NEW Mass Model (recommended):
    - airframe_mass: Rocket body without propulsion (fuselage, fins, nosecone, avionics, payload)
    - engine_mass: Engine + ALL plumbing (chamber, nozzle, injector, valves, fittings, lines)
    - lox_tank_structure_mass: Empty LOX tank only (walls, no fittings)
    - fuel_tank_structure_mass: Empty fuel tank only (walls, no fittings)
    - copv_dry_mass: Empty COPV tank only (walls, no pressurant gas)
    - engine_cm_offset: Height of engine CM above nozzle exit
    - rocket_length: Total rocket length (tail to nose tip) for MoI estimation
    
    propulsion_dry_mass and propulsion_cm_offset are COMPUTED from the above.
    
    Total dry mass = airframe_mass + engine_mass + lox_tank_structure_mass + fuel_tank_structure_mass + copv_dry_mass
    Total wet mass = dry mass + lox_tank.mass + fuel_tank.mass (propellants) + press_tank.initial_gas_mass
    
    LEGACY fields (mass, motor.dry_mass) still supported for backward compatibility.
    """
    # NEW detailed mass model
    airframe_mass: Optional[float] = Field(default=None, gt=0, description="Airframe mass (fuselage, fins, nosecone, avionics, payload) - NO propulsion [kg]")
    engine_mass: Optional[float] = Field(default=None, gt=0, description="Engine + plumbing mass (chamber, nozzle, injector, valves, ALL fittings & lines) [kg]")
    lox_tank_structure_mass: Optional[float] = Field(default=None, gt=0, description="Empty LOX tank only (walls, no fittings) [kg]")
    fuel_tank_structure_mass: Optional[float] = Field(default=None, gt=0, description="Empty fuel tank only (walls, no fittings) [kg]")
    engine_cm_offset: float = Field(default=0.15, ge=0, description="Height of engine+plumbing CM above nozzle exit [m]. Typical: 0.1-0.3m.")
    
    # COMPUTED fields (calculated from detailed breakdown)
    propulsion_dry_mass: Optional[float] = Field(default=None, gt=0, description="COMPUTED: Total propulsion dry mass (engine + tanks) [kg]")
    propulsion_cm_offset: float = Field(default=0.3, description="COMPUTED: Propulsion system CM above nozzle exit [m]")
    
    # COPV tank structure mass (for blowdown systems)
    copv_dry_mass: Optional[float] = Field(default=None, gt=0, description="COPV tank structure mass (tank walls only, no pressurant gas) [kg]")
    
    # Common parameters
    inertia: List[float] = Field(description="AIRFRAME inertia only (without motor/propulsion), relative to airframe CM [Ixx, Iyy, Izz] [kg·m²]. Motor inertia is added separately by RocketPy from propulsion_dry_mass.")
    radius: float = Field(gt=0, description="Rocket body radius (outer diameter / 2) [m]")
    rocket_length: Optional[float] = Field(default=None, gt=0, description="Total rocket length from tail to nose tip [m]. Used for MoI estimation.")
    motor_position: float = Field(default=0.0, description="Nozzle exit position from rocket tail (z=0 at tail, positive toward nose) [m]")
    fins: Optional[FinsConfig] = Field(default=None, description="Fins configuration")
    # Nosecone: von Kármán (LD-Haack) is the minimum-drag transonic ogive. Length is derived from the
    # fineness ratio (nose length / body DIAMETER) — ~4.5 is a good low-drag transonic/supersonic value.
    # Set nose_length to override the derived value.
    nose_kind: str = Field(default="vonKarman", description="Nosecone profile (RocketPy): vonKarman | lvhaack | ogive | conical | …")
    nose_fineness_ratio: float = Field(default=4.5, gt=0, description="Nose length / body diameter (von Kármán ~4.5:1 is near-optimal transonic). Used when nose_length is unset.")
    nose_length: Optional[float] = Field(default=None, gt=0, description="Explicit nosecone length [m]. Overrides nose_fineness_ratio when set.")
    avionics_payload_length_m: float = Field(default=4.0, ge=0, description="Length of avionics/payload/recovery section ABOVE the propulsion stack, before the nosecone [m].")

    # Drag. Either Cd(M) tables with their source (OpenRocket / RASAero export, wind tunnel, flight
    # data), or the component build-up of engine/pipeline/vehicle_drag.py on the vehicle the sim
    # assembles. There is no constant Cd. The three build-up inputs default to OpenRocket's own
    # component defaults, not to this vehicle's drawing; the flight report lists them.
    drag_curve_power_off: Optional[List[List[float]]] = Field(default=None, description="Axial Cd with the motor off, [[Mach, Cd], ...]. Replaces the build-up; needs drag_curve_power_on and drag_curve_source.")
    drag_curve_power_on: Optional[List[List[float]]] = Field(default=None, description="Axial Cd while thrusting, [[Mach, Cd], ...]. Give the power-off table again if the source has only one.")
    drag_curve_source: Optional[str] = Field(default=None, description="Where the drag tables came from: tool and version, file, test.")
    surface_roughness_m: float = Field(default=60e-6, ge=0, description="Skin roughness height for the drag build-up [m]. Default 60 um is OpenRocket's default finish, 'regular paint' (Niskanen 2013 table 3.2); 20 um smooth paint, 0 hydraulically smooth.")
    fin_thickness_m: float = Field(default=0.003, gt=0, description="Fin thickness for the drag build-up [m]. Default 3 mm is OpenRocket's default fin, not the drawing.")
    fin_profile: Literal["square", "rounded", "airfoil"] = Field(default="square", description="Fin edge profile for the drag build-up (Niskanen 2013 sec. 3.4.4). Default 'square' is OpenRocket's default, not the drawing.")
    rail_button_upper_pos_m: Optional[float] = Field(default=None, description="Forward rail button, distance from the tail [m]. With the lower button set, rail exit is when this one leaves the rail; unset, the full rail length is flown.")
    rail_button_lower_pos_m: Optional[float] = Field(default=None, description="Aft rail button, distance from the tail [m].")

    @model_validator(mode="after")
    def _drag_tables_complete(self):
        tables = (self.drag_curve_power_off, self.drag_curve_power_on)
        if all(t is None for t in tables):
            return self
        if any(t is None for t in tables) or not (self.drag_curve_source or "").strip():
            raise ValueError("rocket.drag_curve_power_off, drag_curve_power_on and drag_curve_source go together")
        for name, table in zip(("drag_curve_power_off", "drag_curve_power_on"), tables):
            if len(table) < 2 or any(len(row) != 2 for row in table):
                raise ValueError(f"rocket.{name} must be at least two [Mach, Cd] rows")
            mach = [row[0] for row in table]
            if mach[0] < 0 or any(b <= a for a, b in zip(mach, mach[1:])) or any(row[1] <= 0 for row in table):
                raise ValueError(f"rocket.{name}: Mach must start >= 0 and increase, Cd must be > 0")
        return self

    # LEGACY fields - kept for backward compatibility
    mass: Optional[float] = Field(default=None, gt=0, description="LEGACY: Airframe mass. Use airframe_mass instead.")
    cm_wo_motor: Optional[float] = Field(default=None, description="LEGACY: CM without motor. Now auto-calculated from airframe_mass and propulsion positions.")
    dry_mass: Optional[float] = Field(default=None, gt=0, description="LEGACY: Unused field.")
    motor_inertia: Optional[List[float]] = Field(default=None, description="LEGACY: Motor inertia. Now estimated from propulsion_dry_mass.")
    motor: Optional[MotorConfig] = Field(default=None, description="LEGACY: Motor config. Use propulsion_dry_mass instead.")


class EnvironmentConfig(BaseModel):
    """Environment configuration for flight simulation"""
    date: List[int] = Field(description="Launch date and time [year, month, day, hour (0-23 UTC)]")
    latitude: float = Field(ge=-90, le=90, description="Launch site latitude (positive = North, negative = South) [deg]")
    longitude: float = Field(ge=-180, le=180, description="Launch site longitude (positive = East, negative = West) [deg]")
    elevation: float = Field(description="Launch site elevation above sea level (ground level) [m]")
    # Atmosphere model: 'standard_atmosphere' (deterministic ISA 1976, no network — DEFAULT for a design
    # tool) or 'forecast' (live GFS weather for date/location — realistic but needs internet & a near date).
    atmosphere_model: Literal["standard_atmosphere", "forecast"] = Field(
        default="standard_atmosphere",
        description="Atmospheric model: 'standard_atmosphere' (ISA, offline, deterministic) or 'forecast' (live GFS)")
    # Launch. Defaults are the literals the flight sim flew before these fields existed, not the FAR rail.
    rail_length_m: float = Field(default=3.35, gt=0, description="Launch rail length [m]. Default 3.35 m is the old hardcoded value, not a measured rail.")
    launch_inclination_deg: float = Field(default=90.0, gt=0, le=90, description="Rail elevation from horizontal [deg]; 90 is vertical.")
    launch_heading_deg: float = Field(default=0.0, ge=0, lt=360, description="Rail azimuth [deg from north].")


class ThrustConfig(BaseModel):
    """Thrust configuration for flight simulation"""
    burn_time: float = Field(gt=0, description="Burn time [s]")
    reference_pressure_pa: Optional[float] = Field(default=None, gt=0, description="Ambient pressure the thrust curve was computed at [Pa]; the flight adds (p_ref - p(z))*A_exit. Unset: compute_ambient_pressure_from_elevation(environment.elevation), the engine solver's own reference.")


class FrozenParametersConfig(BaseModel):
    """Frozen parameter values for Layer 1 optimization.
    
    When a parameter is set (not None), the optimizer will use that exact
    value instead of optimizing it. Values use user-friendly units.
    """
    # Chamber geometry
    A_throat_mm2: Optional[float] = Field(default=None, gt=0, description="Frozen throat area [mm²]")
    Lstar_mm: Optional[float] = Field(default=None, gt=0, description="Frozen characteristic length L* [mm]")
    expansion_ratio: Optional[float] = Field(default=None, gt=1, description="Frozen expansion ratio (A_exit/A_throat)")
    D_chamber_outer_mm: Optional[float] = Field(default=None, gt=0, description="Frozen chamber outer diameter [mm]")
    
    # Injector geometry — PINTLE (applies when injector.type == 'pintle')
    d_pintle_tip_mm: Optional[float] = Field(default=None, gt=0, description="[pintle] Frozen pintle tip diameter [mm]")
    h_gap_mm: Optional[float] = Field(default=None, gt=0, description="[pintle] Frozen annular gap height [mm]")
    n_orifices: Optional[int] = Field(default=None, gt=0, description="[pintle] Frozen number of LOX orifices")
    d_orifice_mm: Optional[float] = Field(default=None, gt=0, description="[pintle] Frozen LOX orifice diameter [mm]")
    # Injector geometry — IMPINGING / doublet (applies when injector.type == 'impinging'). These were
    # already honored by the Layer-1 frozen-param mapping; the schema just needed to declare them so the
    # UI offers them and they validate (INJECTOR_PARITY_PLAN W1). Key names match the optimizer mapping.
    n_doublets: Optional[int] = Field(default=None, gt=0, description="[impinging] Frozen number of paired unlike doublets")
    d_jet_O_mm: Optional[float] = Field(default=None, gt=0, description="[impinging] Frozen LOX jet diameter [mm]")
    d_jet_F_mm: Optional[float] = Field(default=None, gt=0, description="[impinging] Frozen fuel jet diameter [mm]")
    impingement_angle_O_deg: Optional[float] = Field(default=None, gt=0, le=180, description="[impinging] Frozen LOX jet angle from the chamber axis [deg] (not the included angle)")
    impingement_angle_F_deg: Optional[float] = Field(default=None, gt=0, le=180, description="[impinging] Frozen fuel jet angle from the chamber axis [deg] (not the included angle)")
    spacing_O_mm: Optional[float] = Field(default=None, gt=0, description="[impinging] Frozen LOX element spacing [mm]")
    spacing_F_mm: Optional[float] = Field(default=None, gt=0, description="[impinging] Frozen fuel element spacing [mm]")
    
    # Initial tank pressures
    P_O_start_psi: Optional[float] = Field(default=None, gt=0, description="Frozen initial LOX tank pressure [psi]")
    P_F_start_psi: Optional[float] = Field(default=None, gt=0, description="Frozen initial fuel tank pressure [psi]")


class DesignRequirementsConfig(BaseModel):
    """Design requirements for optimizer"""
    # Performance targets
    target_thrust: float = Field(default=7000.0, gt=0, description="Target peak thrust [N]")
    target_chamber_pressure_psi: Optional[float] = Field(
        default=None, gt=0,
        description="Optional target chamber pressure [psi]. Pc is emergent in a pressure-fed engine, so "
                    "this is a soft objective target (not a hard constraint): when set, the Layer-1 optimizer "
                    "drives tank pressure to land Pc near this value and sizes the throat for the thrust target, "
                    "instead of pushing Pc higher to make thrust. Leave null to let Pc float freely.")
    target_apogee: Optional[float] = Field(default=3048.0, gt=0, description="Target apogee above ground level [m]")
    # Flight limits. Unset means reported, not checked: no waiver or range rule is assumed here.
    max_apogee_m: Optional[float] = Field(default=None, gt=0, description="Apogee ceiling (waiver) [m], in max_apogee_datum. Checked on a vertical, windless flight at the low-drag end of the finish.")
    max_apogee_datum: Optional[Literal["AGL", "MSL"]] = Field(default=None, description="Datum of max_apogee_m: 'AGL' above the pad or 'MSL' above sea level. Required with max_apogee_m.")
    min_rail_exit_velocity_m_s: Optional[float] = Field(default=None, gt=0, description="Minimum velocity leaving the rail [m/s] (e.g. 30.48 = 100 ft/s, Spaceport America Cup DTEG).")
    min_static_margin_cal: Optional[float] = Field(default=None, description="Minimum static margin [cal], at rail exit and at burnout.")
    max_static_margin_cal: Optional[float] = Field(default=None, description="Maximum static margin [cal]; above it the vehicle weathercocks hard into wind.")

    @model_validator(mode="after")
    def _apogee_ceiling_has_datum(self):
        if self.max_apogee_m is not None and self.max_apogee_datum is None:
            raise ValueError("design_requirements.max_apogee_m needs max_apogee_datum ('AGL' or 'MSL')")
        lo, hi = self.min_static_margin_cal, self.max_static_margin_cal
        if lo is not None and hi is not None and hi <= lo:
            raise ValueError("max_static_margin_cal must exceed min_static_margin_cal")
        return self

    optimal_of_ratio: float = Field(default=2.3, gt=0, description="Target oxidizer-to-fuel mixture ratio")
    target_burn_time: float = Field(default=10.0, gt=0, description="Target burn time [s]")
    
    # Tank pressures
    max_lox_tank_pressure_psi: float = Field(default=700.0, gt=0, description="Maximum LOX tank pressure [psi]")
    max_fuel_tank_pressure_psi: float = Field(default=850.0, gt=0, description="Maximum fuel tank pressure [psi]")
    max_P_tank_O: Optional[float] = Field(default=None, gt=0, description="Maximum LOX tank pressure [Pa] (auto-converted from psi if None)")
    max_P_tank_F: Optional[float] = Field(default=None, gt=0, description="Maximum fuel tank pressure [Pa] (auto-converted from psi if None)")
    
    # Geometry constraints
    max_engine_length: float = Field(default=0.5, gt=0, description="Maximum total engine length (chamber + nozzle) [m]")
    max_chamber_outer_diameter: float = Field(default=0.15, gt=0, description="Maximum chamber outer diameter [m]")
    metal_wall_thickness_per_side_m: float = Field(
        default=0.00635, gt=0,
        description="Chamber metal case thickness per side [m] (geometry envelope; default 0.25 in). "
                    "Layer 1 derives the total OD -> gas-side wall as 2 * (this + ablative liner "
                    "thickness when ablative cooling is enabled) — see optimizer.utils.total_wall_thickness_m. "
                    "There is no separate lump wall field: the ablative share tracks "
                    "ablative_cooling.initial_thickness automatically after Layer 3 sizes it. "
                    "Distinct from stainless_steel_case.thickness (thermal-model conduction wall, often null).")
    max_nozzle_exit_diameter: float = Field(default=0.101, gt=0, description="Maximum nozzle exit diameter [m]")
    
    # L* constraints
    min_Lstar: float = Field(default=0.95, gt=0, description="Minimum characteristic length [m]")
    max_Lstar: float = Field(default=1.27, gt=0, description="Maximum characteristic length [m]")
    
    # Stability requirements (new comprehensive analysis)
    min_stability_score: float = Field(default=0.75, ge=0, le=1, description="Minimum stability score (0-1)")
    require_stable_state: bool = Field(default=True, description="Require 'stable' state (not just 'marginal')")
    stability_margin_handicap: float = Field(default=0.0, ge=0, le=1, description="Stability requirement relaxation factor (0=strict, 1=any)")
    
    # Stability requirements (legacy margins)
    min_stability_margin: float = Field(
        default=1.2, gt=0,
        description=(
            "Minimum combustion-stability gain margin [-], 1 = neutral: the chug loop's Nyquist gain "
            "margin (low end of the mixing-lag band), and the acoustic damping/driving ratio when "
            "stability.acoustic_gate gates it. 2.0 = 6 dB. Not the flight static margin."
        ),
    )
    chugging_margin_min: float = Field(default=0.2, ge=0, description="Minimum chugging stability margin")
    acoustic_margin_min: float = Field(default=0.1, ge=0, description="Minimum acoustic stability margin")
    feed_stability_min: float = Field(default=0.15, ge=0, description="Minimum feed system stability margin")
    
    # Tank capacities (for optimizer bounds and flight-sim mass caps)
    lox_tank_capacity_kg: Optional[float] = Field(default=None, gt=0, description="LOX tank capacity [kg]")
    fuel_tank_capacity_kg: Optional[float] = Field(default=None, gt=0, description="Fuel tank capacity [kg]")
    propellant_tank_fill_factor: float = Field(
        default=0.90,
        gt=0.0,
        le=1.0,
        description="Max liquid fill fraction of tank internal volume for flight simulation (e.g. 0.90 = 90% ullage margin)",
    )
    
    # COPV
    copv_free_volume_L: Optional[float] = Field(default=4.5, gt=0, description="COPV free internal volume [L]")
    copv_free_volume_m3: Optional[float] = Field(default=None, gt=0, description="COPV free volume [m³] (auto-converted from L if None)")
    
    # Injector ΔP_inj / Pc soft penalty bands (Layer 1); quadratic hinge outside each interval
    injector_dp_ratio_O_min: float = Field(
        default=0.20,
        ge=0.0,
        description="Preferred lower edge for oxidizer ΔP_inj/Pc (soft hinge)",
    )
    injector_dp_ratio_O_max: float = Field(
        default=0.40,
        gt=0.0,
        description="Preferred upper edge for oxidizer ΔP_inj/Pc (soft hinge)",
    )
    injector_dp_ratio_F_min: float = Field(
        default=0.20,
        ge=0.0,
        description="Preferred lower edge for fuel ΔP_inj/Pc (soft hinge)",
    )
    injector_dp_ratio_F_max: float = Field(
        default=0.40,
        gt=0.0,
        description="Preferred upper edge for fuel ΔP_inj/Pc (soft hinge)",
    )
    feed_pressure_model: str = Field(
        default="dome_regulated",
        description="Tank pressure time model: blowdown (decaying segments) or dome_regulated (eq. 6.2)",
    )
    regulator_supply_pressure_effect: Optional[float] = Field(
        default=None, ge=0.0,
        description=(
            "Dome regulator supply-pressure effect: outlet rise per unit inlet drop [psi/psi]. A property "
            "of the regulator: Aqua 1092 datasheet 0.010, TB 1031 ~0.017. Unset = 0.010 (Aqua 1092), "
            "recorded as an assumption until the regulator is confirmed."
        ),
    )
    regulator_supply_pressure_effect_source: Optional[str] = Field(
        default=None,
        description="Where regulator_supply_pressure_effect came from (datasheet, flow test).",
    )
    regulator_min_differential_psi: Optional[float] = Field(
        default=None, ge=0.0,
        description=(
            "Inlet-minus-outlet pressure below which the regulator can no longer hold its outlet [psi]; "
            "the dome-regulated curve raises instead of drawing through it. Unset = 0 (outlet <= inlet)."
        ),
    )
    W_geom_ao_af_momentum: float = Field(
        default=0.0,
        ge=0.0,
        description=(
            "Layer 1 impinging-only: weight × (relative error)² steering A_geom_O/A_geom_F toward "
            "MR/√(ρ_O/ρ_F) (consistent with R≈1 for bulk velocities). 0 disables."
        ),
    )
    # Layer 1 impinging-only (optional overrides; omit or null to use optimizer code defaults).
    W_MOM: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Weight on momentum_ratio_R quadratic hinge relative to bands below "
            "(default in layer1_static_optimization.py is 75 when unset)."
        ),
    )
    impinging_momentum_R_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred lower edge for momentum_ratio_R hinge R (impinging-only). None disables.",
    )
    impinging_momentum_R_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred upper edge for momentum_ratio_R validation gate (impinging-only).",
    )
    layer1_momentum_log_deadband_rel: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Multiplicative deadband for Layer-1 log-space momentum pull toward R=1 "
            "(optimizer soft term). Default when unset: 0.0 "
            "(layer1_static_optimization._LAYER1_DEFAULT_MOMENTUM_LOG_DEADBAND_REL)."
        ),
    )
    layer1_impinging_angle_deg_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        lt=180.0,
        description="Preferred lower edge for effective impingement angle hinge [deg] (impinging-only).",
    )
    layer1_impinging_jet_angle_min_deg: Optional[float] = Field(
        default=None,
        gt=0.0,
        lt=90.0,
        description=(
            "HARD lower bound on a SINGLE jet's inclination from the chamber axis [deg]. "
            "Distinct from layer1_impinging_angle_deg_min, which bounds the INCLUDED angle "
            "(the sum of the two jets). The per-jet search box is widened by the permitted "
            "asymmetry and can fall to 10 deg or below, and the optimiser will use it -- the "
            "8 kN ethalox point returned theta_O = 13 deg, which is not drillable on a flat "
            "face without a spot-face or jig. Manufacturing, not physics, so nothing in the "
            "objective knows about it. None => no floor beyond the derived box. 20 deg is a "
            "reasonable default for conventional drilling."
        ),
    )
    layer1_impinging_angle_deg_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        lt=180.0,
        description="Preferred upper edge for effective impingement angle hinge [deg] (impinging-only).",
    )
    W_IMPINGING_ANGLE: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 impinging-only weight on effective impingement angle hinge term "
            "(uses layer1_impinging_angle_deg_min/max when both are set)."
        ),
    )
    # Paired-doublet realism: constrain how far oxidizer vs fuel jet inclinations may diverge.
    W_IMPINGING_JET_ASYM: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Impinging paired jets only: weight on normalized excess [|θ_O−θ_F| − "
            "`layer1_impinging_jet_angle_max_asym_deg`]₊ squared (paired-doublet coherence preference)."
        ),
    )
    layer1_impinging_jet_angle_max_asym_deg: Optional[float] = Field(
        default=None,
        gt=0.0,
        lt=180.0,
        description=(
            "Impinging paired jets only: allowable |θ_O−θ_F| before asymmetry hinge activates [deg]. "
            "Unset ⇒ optimizer defaults (see layer1_static_optimization)."
        ),
    )
    # Layer 1 impinging-only: SMD (atomization) objective. Penalizes the mass-flux-weighted
    # effective Sauter mean diameter (taken directly from the injector-physics Ingebo D32, which
    # already captures aerodynamic Weber, liquid Reynolds/viscosity, and impingement angle via the
    # law-of-cosines relative velocity) when it falls outside a *two-sided* band around the target.
    W_SMD: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 impinging-only weight on the SMD range penalty. 0/None disables. The penalty is "
            "a two-sided deadband: zero inside [target·(1−tol), target·(1+tol)], squared outside."
        ),
    )
    target_smd_microns: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Target effective Sauter mean diameter [µm] for the SMD objective (e.g. 50).",
    )
    layer1_smd_rel_tol: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Half-width of the SMD deadband as a fraction of target (e.g. 0.20 ⇒ band is "
            "target·[0.8, 1.2]). Unset ⇒ optimizer default (0.20)."
        ),
    )
    # Layer 1 impinging-only: equal feed/tank pressure objective. Drives the LOX and fuel tank
    # stagnation pressures together. This is a SEPARATE objective from R≈1 — equal tank pressure does
    # NOT imply momentum matching because the two sides have different densities, feed-line losses,
    # and injector ΔP (different hole sizes/angles).
    W_TANK_EQUAL: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 impinging-only weight on ((P_tank_O − P_tank_F)/scale)². 0/None disables."
        ),
    )
    layer1_tank_equal_scale_psi: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Normalizing scale [psi] for the equal-tank-pressure penalty. Unset ⇒ 100 psi.",
    )
    layer1_chamber_od_increment_in: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Snap the chamber OUTER diameter to this increment in INCHES (e.g. 0.5 for "
            "half-inch stock). Ablative sleeve, chamber tube and case are bought in fixed "
            "sizes, so a continuous optimum like 4.2 in is not purchasable — you build 4.0 or "
            "4.5 and the engine you build is not the one that was optimised. Snapping inside "
            "the evaluation means every candidate scored is one you can order, instead of "
            "rounding afterwards and silently moving contraction ratio, L* and wall thickness "
            "off the optimum. Unset/0 ⇒ continuous search."
        ),
    )
    layer1_lock_tank_pressures: Optional[bool] = Field(
        default=None,
        description=(
            "Treat the two tank pressures as ONE optimizer variable — the fuel tank follows "
            "the LOX tank exactly. 'Match tank pressures' says they are one quantity, so "
            "searching them separately and penalizing the gap makes the optimizer pay forever "
            "for a degree of freedom it was told not to use. Unset ⇒ follows the match-tanks "
            "checkbox (W_TANK_EQUAL > 0)."
        ),
    )
    layer1_thrust_deadband_rel: Optional[float] = Field(
        default=None, ge=0.0,
        description=(
            "Relative thrust deadband in the objective. Unset ⇒ 0.1% when the throat is solved "
            "from thrust (the derivation lands on target; a wide band only lets edge-sitting "
            "designs through 2-3% off), 2% when the throat is searched."
        ),
    )
    layer1_derive_tank_from_dp_ratio: Optional[bool] = Field(
        default=None,
        description=(
            "With tanks locked, solve the single tank pressure from the injector ΔP/Pc target "
            "(P_tank = Pc·(1+r) + ΔP_feed) instead of searching it. Makes the ΔP/Pc band exact "
            "but removes the pressure's Isp anchor, so Pc and Isp fall. Unset ⇒ OFF."
        ),
    )
    layer1_dp_ratio_target: Optional[float] = Field(
        default=None, gt=0.0,
        description="ΔP/Pc target for the tank-pressure derivation. Unset ⇒ mid-band.",
    )
    layer1_derive_fuel_jet_from_of: Optional[bool] = Field(
        default=None,
        description=(
            "Solve the fuel jet diameter from the O/F target (equal-ΔP area ratio). "
            "Experimental — the one-step secant overshoots when Pc moves with it. Unset ⇒ OFF."
        ),
    )
    layer1_tank_equal_inband_frac: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Weak always-on pull toward equal tank pressures INSIDE the match tolerance, as a "
            "fraction of the out-of-band weight. A pure deadband is flat inside the band, so "
            "nothing separates 1 psi from 9.9 psi and the optimizer parks on the edge — which "
            "is how a 10 psi requirement comes back at 10.1 psi. Unset ⇒ 0.05; 0 restores the "
            "flat deadband."
        ),
    )
    layer1_chamber_od_snap_target: Optional[str] = Field(
        default=None,
        description=(
            "Which diameter the stock increment applies to: 'outer' (the tube you buy) or "
            "'bore' (the gas-side diameter). Only one can land on the increment, because "
            "bore = OD - wall and the wall is rarely a whole increment — a 1.13 in wall "
            "turns a 6.00 in OD into a 4.87 in bore. Unset ⇒ 'outer'."
        ),
    )
    layer1_Lstar_from_smd: Optional[bool] = Field(
        default=None,
        description=(
            "Derive the L* target from the spray SMD instead of using a fixed number. L* buys "
            "residence time and the residence time you NEED is set by how long the droplets "
            "take to evaporate (d²-law: τ_vap ∝ SMD²), so L*_target ∝ SMD². Treating them as "
            "independent knobs is what makes a good design look like a failed one. Unset ⇒ ON."
        ),
    )
    layer1_Lstar_smd_ref_um: Optional[float] = Field(
        default=None, gt=0.0,
        description="SMD anchor for the L* correlation [µm]. Unset ⇒ 99.",
    )
    layer1_Lstar_ref_m: Optional[float] = Field(
        default=None, gt=0.0,
        description="L* target at the SMD anchor [m]. Unset ⇒ 1.10 (i.e. 99 µm ⇒ 1.05–1.15).",
    )
    layer1_Lstar_smd_exponent: Optional[float] = Field(
        default=None,
        description=(
            "Exponent in L*_target ∝ SMD^n. Unset ⇒ 2.0, which is the d²-law, not a fit — "
            "change it only to model a different evaporation regime."
        ),
    )
    layer1_Lstar_deadband_m: Optional[float] = Field(
        default=None, ge=0.0,
        description=(
            "Total width of the free window around the L* target [m]. Unset ⇒ 0.1 (±0.05), "
            "which is finer than the correlation's own accuracy."
        ),
    )
    layer1_impingement_Ld_target: Optional[float] = Field(
        default=None, gt=0.0,
        description=(
            "Where the jets of a doublet should meet, in JET DIAMETERS from the injector face. "
            "Too close and the collision erodes the injector plate; too far and the sheet "
            "spreads before it breaks up. Published practice for unlike doublets is 3–7. "
            "Unset ⇒ 4."
        ),
    )
    layer1_resultant_tilt_max_deg: Optional[float] = Field(
        default=None,
        description=(
            "Largest OUTWARD tilt of the doublet's spray resultant, in degrees from the "
            "chamber axis, before the design is treated as infeasible. This is the real "
            "ablative guard: the fan follows the vector sum of the two streams, and a fan "
            "aimed at the liner erodes it. Positive is toward the wall. Unset ⇒ 0 (never "
            "outward). The momentum-flux ratio R is NOT this quantity — p_O/p_F = R²·A_O/A_F, "
            "so R = 1 is not balance."
        ),
    )
    layer1_resultant_tilt_gate_tol_deg: Optional[float] = Field(
        default=None, ge=0.0,
        description=(
            "Tolerance added to the outward-tilt limit for the VALIDATION gate only, so "
            "whole-degree jet angles cannot fail a design by rounding. Unset ⇒ 1°."
        ),
    )
    layer1_resultant_tilt_scale_deg: Optional[float] = Field(
        default=None, gt=0.0,
        description="Normalizing scale [deg] for the resultant-tilt violation. Unset ⇒ 2.",
    )
    layer1_W_TILT: Optional[float] = Field(
        default=None, ge=0.0,
        description=(
            "Weight of the resultant-spray-tilt preference: W (tilt/scale)^2 around 0 deg, with the "
            "outward (wall) side multiplied by layer1_resultant_tilt_outward_multiplier. Inward lean "
            "is allowed at a mild cost; the hard wall guard (layer1_resultant_tilt_max_deg / reach) "
            "still applies. Unset or 0 = off."
        ),
    )
    layer1_resultant_tilt_outward_multiplier: Optional[float] = Field(
        default=None, ge=1.0,
        description="Outward-side multiplier on the tilt preference (layer1_W_TILT). Unset ⇒ 25.",
    )
    layer1_momentum_wall_side_multiplier: Optional[float] = Field(
        default=None, ge=1.0,
        description=(
            "How much more a momentum-ratio miss costs when it throws the spray toward the "
            "chamber WALL than toward the core. With LOX inboard, R > 1 means the LOX stream "
            "wins the collision and the fan deflects outward onto the ablative; R < 1 sends "
            "it into the core, which only costs mixing. Unset ⇒ 10."
        ),
    )
    layer1_momentum_scale: Optional[float] = Field(
        default=None, gt=0.0,
        description="Normalizing scale for the momentum-ratio deviation (in log R). Unset ⇒ 0.10.",
    )
    layer1_momentum_gate_safe_slack: Optional[float] = Field(
        default=None, ge=1.0,
        description=(
            "Widens the momentum validation band symmetrically about 1, as a multiple of the "
            "configured half-width. Unset ⇒ 1 (the gate is the configured band)."
        ),
    )
    layer1_derive_impingement_spacing: Optional[bool] = Field(
        default=None,
        description=(
            "Solve the fuel-ring hole pitch so the doublet meets at exactly "
            "layer1_impingement_Ld_target jet diameters, instead of searching it. One "
            "equation, one unknown: |s_F − s_O| = 2π·k·d_avg·(tanθ_O + tanθ_F)/n. Removes an "
            "optimizer dimension and makes the standoff exact rather than a penalty the "
            "search negotiates with. Turn OFF to search the fuel pitch freely. Unset ⇒ ON."
        ),
    )
    layer1_impingement_Ld_tol: Optional[float] = Field(
        default=None, ge=0.0,
        description=(
            "Free window around the impingement target, in jet diameters. Only meaningful "
            "when the spacing derivation is OFF — when it is on the target is hit exactly. "
            "Unset ⇒ 0 with the derivation on, 1.0 with it off."
        ),
    )
    layer1_ring_order_fuel_outboard: Optional[bool] = Field(
        default=None,
        description=(
            "Put the FUEL ring outboard of the LOX ring on the injector face. Whatever passes "
            "the impingement point on the outer ring is what reaches the chamber wall, and a "
            "fuel-rich wall film is what an ablative liner wants — an oxidizer-rich one attacks "
            "it. The impingement physics uses |ΔD_pitch| and is indifferent to the order, so "
            "this costs nothing. Unset ⇒ ON."
        ),
    )
    layer1_integer_jet_angles: Optional[bool] = Field(
        default=None,
        description=(
            "Snap impinging-doublet jet angles to whole degrees. A drill jig is indexed in "
            "whole degrees, so a 43.7° optimum is not machinable, and rounding it afterwards "
            "moves impingement distance, momentum ratio and SMD off the scored point. "
            "Impinging injectors only (pintle has no angle DOF). Unset ⇒ ON."
        ),
    )
    layer1_derive_expansion_ratio: Optional[bool] = Field(
        default=None,
        description=(
            "Solve the expansion ratio for a perfectly expanded exit (Pe = ambient) instead "
            "of searching it. Closed-form isentropic inversion of Pc/Pe, so the exit plane "
            "lands on ambient exactly and one optimizer dimension disappears. Turn OFF only "
            "to size deliberately over/under-expanded nozzles, or to explore a range of "
            "expansion ratios against fixed hardware. Unset ⇒ ON."
        ),
    )
    layer1_derive_throat_from_thrust: Optional[bool] = Field(
        default=None,
        description=(
            "Solve the throat area from the thrust requirement instead of searching it. "
            "Thrust is monotonic in throat area, so a short root-find lands the target "
            "exactly and removes an optimizer dimension. Turn OFF when the throat is fixed "
            "hardware (an existing graphite insert) and thrust is an output rather than a "
            "requirement. Unset ⇒ ON."
        ),
    )
    layer1_derive_max_iters: Optional[float] = Field(
        default=None,
        ge=1.0,
        description=(
            "Cap on root-find iterations per candidate when solving the derived DOFs; the solve "
            "exits once thrust is within layer1_derive_thrust_tol_rel and eps has stopped moving. "
            "Unset ⇒ 8. (2 fixed steps left a 0.4-0.9 % thrust miss that depended on the start.)"
        ),
    )
    layer1_derive_thrust_tol_rel: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Relative thrust tolerance for the derived-throat solve; iteration stops inside "
            "this band. Unset ⇒ 1e-3 (0.1%)."
        ),
    )
    layer1_tank_equal_tol_psi: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Tank-pressure delta [psi] that costs nothing — set it to your PT margin of error. "
            "Without it any nonzero delta is squared, so matching to 1.93 psi (a success against "
            "a 10 psi spec) still carried 11 objective points and read as non-convergence. "
            "Unset ⇒ 0 (no deadband, historical behaviour)."
        ),
    )
    layer1_of_deadband_rel: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Relative O/F error that costs nothing, e.g. 0.02 for ±2%. Without it, landing at "
            "1.6646 against a 1.65 target (+0.9%, far inside the 15% validation gate) still "
            "carried 4.7 objective points. Unset ⇒ 0."
        ),
    )
    layer1_exit_pressure_deadband_rel: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Relative deadband around ambient inside which exit-pressure error is free. Was "
            "hardcoded at 0.05 — for a 13.64 psi target that made 12.96–14.33 psi cost nothing, "
            "so runs settled at 14.6 psi and still reported converged. Tighten (e.g. 0.005) when "
            "exit pressure is a real requirement. Unset ⇒ 0.05."
        ),
    )
    layer1_W_LSTAR: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 weight on L* ABOVE layer1_Lstar_target_m: ((L*-target)/target)², one-sided. "
            "L* is the only design variable with no opposing force in the objective — more "
            "residence time is pure reward — so it pinned to its max bound in every run. A chamber "
            "mass penalty does NOT substitute: wall mass scales as D·L while volume scales as D²·L, "
            "so charging for mass buys a fatter chamber at the same L*. Unset/0 ⇒ disabled."
        ),
    )
    layer1_Lstar_target_m: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "L* [m] above which layer1_W_LSTAR starts charging. At or below it is free. "
            "Unset ⇒ 1.0 m."
        ),
    )
    layer1_W_MASS: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 weight on chamber dry mass, (m/layer1_chamber_mass_ref_kg)², the "
            "counterweight to layer1_W_ISP. Unset ⇒ priced like propellant: at the reference mass "
            "1 kg of chamber costs what 1 kg of propellant does at fixed total impulse, "
            "W_MASS = W_ISP·m_ref/(2·m_prop_ideal). 0 ⇒ disabled."
        ),
    )
    layer1_W_ISP: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 figure of merit: weight on the propellant the delivered Isp costs beyond an "
            "ideal engine for the required total impulse, W_ISP·(Isp_ideal/Isp − 1) (Sutton & "
            "Biblarz ch. 2: m_prop = F·t_b/(g0·Isp)). O/F and a Pc target are held at their "
            "requirement inside it, so it cannot pull them off target. Reported as isp_penalty "
            "(1000 ⇒ tenths of a percent of the ideal propellant). Unset ⇒ 1000; 0 ⇒ off."
        ),
    )
    layer1_contraction_half_angle_deg: Optional[float] = Field(
        default=None,
        gt=0,
        lt=90,
        description=(
            "Convergent half-angle [deg] for the chamber contraction. Was hardcoded at 45 deg. "
            "45 deg is the LENGTH-optimal angle; it is not the MASS-optimal one, because a "
            "shallower cone is longer but moves volume out of the full-diameter barrel (which "
            "carries the whole wall stack) into the tapering cone shell. 30 deg measured lighter "
            "at equal L* on the 8 kN ethalox point. Conventional band 25-45 deg. None = 45."
        ),
    )
    layer1_min_Lcyl_over_D: Optional[float] = Field(
        default=None,
        gt=0,
        description=(
            "Minimum CYLINDRICAL-length-to-bore ratio, enforced as infeasibility (not a penalty). "
            "layer1_chamber_ld_ratio_min gates TOTAL chamber length, which lets the convergent "
            "cone masquerade as mixing length; the constant-area section is where impinging "
            "sprays actually mix. Pair with spray.evaporation.x_star_limit. None = not enforced."
        ),
    )
    layer1_max_element_pitch_m: Optional[float] = Field(
        default=None,
        gt=0,
        description=(
            "Maximum injector element pitch sqrt(A_chamber/n_elements) [m], enforced as "
            "infeasibility. eta_mixing (Rupe) sees only momentum ratio, so nothing otherwise "
            "charges for spreading a fixed element count over a larger face -- the optimiser can "
            "buy chamber diameter for free. None = not enforced."
        ),
    )
    layer1_chamber_wall_density_kg_m3: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Effective density of the chamber wall stack (metal + ablative + graphite) for the "
            "layer1_W_MASS proxy. Unset ⇒ 2000 kg/m³."
        ),
    )
    layer1_chamber_mass_ref_kg: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Normalising chamber mass [kg] for the layer1_W_MASS penalty — the mass at which the "
            "term equals 1.0. Unset ⇒ 5 kg."
        ),
    )
    layer1_W_EXIT: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 weight on the nozzle exit-pressure term (P_exit vs ambient). Was hardcoded "
            "at 2e2 in two places, i.e. ~300x weaker than layer1_W_THRUST (6e4), so exit pressure "
            "never bound. Unset ⇒ optimizer default (2e2)."
        ),
    )
    # Layer 1 impinging-only: injector geometry / vaporization-fit objective. Couples the impingement
    # standoff (where the streams meet) and the droplet vaporization length to the available chamber
    # length, and penalizes ring overflow / element overlap. Gives the ``spacing`` design variable a
    # real physical effect (impingement distance + pitch-circle diameter).
    W_IMP_GEOM: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 impinging-only weight on the geometry/vaporization-fit penalty (normalized "
            "squared violations of: L_imp+x* within the evaporation budget, ring pitch diameter "
            "within the chamber bore, and element non-overlap). 0/None disables."
        ),
    )
    layer1_exit_pressure_inside_quad_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Inside the nominal plus-or-minus 5 percent exit-pressure deadband, multiply W_EXIT by this "
            "coefficient times (ΔP_exit/P_tgt) squared to steer toward atmospheric-matched nozzle exit pressure."
        ),
    )
    layer1_impinging_n_doublets_max: Optional[int] = Field(
        default=None,
        ge=5,
        description=(
            "Layer 1 impinging: max paired LOX/fuel element count (n_doublets). "
            "The bore-derived ceiling from ``impinging_n_elements_hi_int`` is clipped to this value when set."
        ),
    )
    layer1_random_seed: Optional[int] = Field(
        default=None,
        description=(
            "Layer 1 integer seed for NumPy restart perturbations and CMA-ES ``seed`` "
            "(each restart uses seed + restart_index × 1_000_003). Omit or null → base 42."
        ),
    )
    layer1_cma_warmstart_trials: Optional[int] = Field(
        default=None,
        ge=0,
        description=(
            "Before legacy CMA-ES, evaluate this many clipped/snapped candidates around ``x0`` "
            "(same worker objective as CMA). 0 disables. Default 16 in optimizer when unset."
        ),
    )
    layer1_cma_warmstart_sigma_frac: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=0.5,
        description=(
            "Per-dimension Gaussian scale for warm-start perturbations: ``sigma_frac × (upper−lower)``. "
            "Default 0.04 when unset."
        ),
    )
    layer1_cma_restart0_sigma_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "After warm-start, multiply legacy CMA-ES initial step size (restart 0 only) by this factor "
            "so the first population stays near the feasible mean (default 0.48 in code when unset)."
        ),
    )
    layer1_lbfgs_gtol: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Gradient norm tolerance for the L-BFGS-B local refinement after CMA-ES (default 1e-9 in code). "
            "Tighter values can reduce the weighted objective; they do not target a specific absolute objective magnitude."
        ),
    )
    layer1_lbfgs_second_pass: Optional[bool] = Field(
        default=None,
        description=(
            "If true, run a second L-BFGS-B from the first local optimum with a tighter ``gtol`` (default true in code)."
        ),
    )
    W_DP: Optional[float] = Field(default=None, ge=0.0, description="Layer 1 fallback injector ΔP weight.")
    W_DP_O: Optional[float] = Field(default=None, ge=0.0, description="Layer 1 oxidizer stream ΔP hinge weight.")
    W_DP_F: Optional[float] = Field(default=None, ge=0.0, description="Layer 1 fuel stream ΔP hinge weight.")
    W_DP_HIGH: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 weight on injector ΔP hinge term when both ΔP/Pc streams exceed their bands "
            "(used together with W_DP_O/W_DP_F in weighted injector ΔP penalty)."
        ),
    )
    # ------------------------------------------------------------------------------------
    # Keys Layer 1 ALREADY READS that were never declared here. A pydantic model silently
    # DROPS unknown keys, so `PUT /api/config` with any of these returned 200 and discarded
    # them -- and four of them have a labelled control in the Configuration editor that
    # therefore did nothing at all. Declared here as Optional[...] = None so behaviour is
    # unchanged (None => the optimizer's own default, quoted in each description), but they
    # are now settable. Found by diffing _requirement_*/requirements.get() call sites in
    # layer1_static_optimization.py against this class.
    W_DP_CENTER: Optional[float] = Field(default=None, ge=0.0,
        description="Weight pulling injector dP/Pc toward the centre of its band. None => 500.0")
    W_DP_O_FLOOR: Optional[float] = Field(default=None, ge=0.0,
        description="Weight on the oxidiser dP/Pc soft floor. None => 0.0 (disabled)")
    injector_dp_ratio_O_soft_floor: Optional[float] = Field(default=None, gt=0.0, lt=1.0,
        description="Soft floor on dP_O/Pc, penalised below this. None => not enforced")
    layer1_A_throat_mm2_min: Optional[float] = Field(default=None, gt=0.0,
        description="Lower bound on the throat-area search variable [mm^2]. None => derived")
    layer1_A_throat_mm2_max: Optional[float] = Field(default=None, gt=0.0,
        description="Upper bound on the throat-area search variable [mm^2]. None => derived")
    layer1_cf_upper_bound_for_throat_floor: Optional[float] = Field(default=None, gt=0.0,
        description="Cf ceiling used when deriving the throat-area floor. None => 1.8")
    layer1_pc_fraction_for_throat_floor: Optional[float] = Field(default=None, gt=0.0, le=1.0,
        description="Fraction of target Pc used when deriving the throat floor. None => 0.75")
    layer1_enforce_ring_geometry: Optional[bool] = Field(default=None,
        description="Enforce doublet ring fit / element gap / impingement standoff from the "
                    "DESIGN VARIABLES. None => True. Note the older diagnostics-driven term "
                    "(_impinging_geometry_fit_squared) is inert because the numba accelerator "
                    "emits none of the keys it reads -- this flag governs the live one.")
    # ---- INJECTOR FACE REAL ESTATE -------------------------------------------------------
    # Where the two rings SIT radially was an exactly flat direction in the objective: the
    # standoff derivation fixes the ring GAP (dr = Ld*d_avg*(tan th_O + tan th_F)) but nothing
    # fixed the pair's radius, so s_O drifted onto its own lower bound (0.003 m) and parked the
    # whole element ring against the axis. Measured on ethalox_8kN_FINAL: D_pitch_O 26.90 mm,
    # every doublet impinging on a 41.79 mm circle inside a 127.00 mm bore -- 10.8 % of the
    # chamber area, and NARROWER THAN THE 49.57 mm THROAT. These three keys give that direction
    # an opinion. All are measured against the orifice's ELLIPTICAL trace on the face: a hole of
    # diameter d inclined th from the chamber axis cuts the face as an ellipse whose RADIAL
    # (major) axis is d/cos(th), which at th = 69 deg is 2.8x the drill diameter.
    layer1_injector_spray_radius_frac: Optional[float] = Field(default=None, gt=0.0, le=1.0,
        description="Target impingement radius as a fraction of the chamber bore RADIUS. Every "
                    "doublet on one ring collides on the same circle r_imp = r_inner + L_imp * "
                    "tan(theta_inner), and that circle is where the propellant is actually put "
                    "into the chamber. Nothing constrained it: the ring pair is free to slide "
                    "radially (the standoff derivation fixes the ring GAP, not its radius), so "
                    "it parks on whatever bound it meets. Measured: r_imp/r_wall 0.33, feeding "
                    "10.8 % of the chamber area through a circle NARROWER THAN THE THROAT; and "
                    "again at 0.44 once only a lower bound existed. The natural target is the "
                    "EQUAL-AREA radius 1/sqrt(2) = 0.7071, which splits the chamber cross-"
                    "section in half. None => inert.")
    layer1_injector_spray_radius_tol: Optional[float] = Field(default=None, gt=0.0,
        description="Half-width of the free band around layer1_injector_spray_radius_frac, in "
                    "the same fraction-of-radius units. None => 0.08.")
    layer1_injector_plate_thickness_m: Optional[float] = Field(default=None, gt=0.0,
        description="Injector face plate thickness [m]. An orifice inclined theta from the "
                    "chamber axis runs t/cos(theta) through it -- 2.79x the plate at 69 deg. "
                    "Used for the drilled-passage and face-incidence machining checks. "
                    "None => the checks are inert.")
    layer1_injector_min_face_incidence_deg: Optional[float] = Field(default=None, ge=0.0, le=90.0,
        description="Minimum angle between an orifice axis and the face PLANE [deg], i.e. "
                    "90 - theta. A drill entering a flat at shallow incidence walks; below this "
                    "the entry needs a spot-face milled normal to the hole axis. None => 0 "
                    "(inert). NOTE this is a per-jet ceiling on theta, complementary to "
                    "layer1_impinging_jet_angle_min_deg which is the floor.")
    layer1_injector_counterbore_dia_m: Optional[float] = Field(default=None, gt=0.0,
        description="Feed-passage (counterbore) diameter behind each orifice [m]. The orifice "
                    "itself is only a short LAND of discharge.orifice_l_over_d diameters at the "
                    "face end; the rest of the passage is this larger bore. Without it the "
                    "drilled depth reads as if the orifice diameter ran the whole plate, which "
                    "reported L/d 13.5 on a design whose small drill only goes 6.6 mm. "
                    "None => the passage check uses the orifice diameter (conservative).")
    layer1_injector_center_clear_dia_m: Optional[float] = Field(default=None, gt=0.0,
        description="Clear circle that must remain unobstructed at the centre of the injector "
                    "face [m] -- igniter boss, centre-body or instrumentation port. The inner "
                    "edge of the innermost orifice ring must stay outside it. None => 0.0 "
                    "(no centre reservation). A 3/8-18 NPT spark igniter is 17.15 mm across the "
                    "thread crest, so ~0.028 m of boss plus clearance is a realistic entry.")
    layer1_injector_min_back_web_m: Optional[float] = Field(default=None, ge=0.0,
        description="Minimum land between neighbouring passage entries on the BACK (manifold) "
                    "face of the plate [m]. An inclined hole walks t*tan(theta) radially through "
                    "the plate and the inner ring's entries crowd toward the axis: on "
                    "ethalox_8kN_SHIP the LOX counterbores leave 1.61 mm on the back against a "
                    "6.40 mm face web. Needs layer1_injector_plate_thickness_m. None => inert "
                    "(the drawing still warns against the face web floor).")
    layer1_injector_min_web_m: Optional[float] = Field(default=None, ge=0.0,
        description="Minimum land (web) between adjacent orifices on the SAME ring [m]. The only "
                    "prior guard was spacing >= d_jet, i.e. a web of exactly zero. None => 0.0.")
    layer1_injector_wall_clearance_m: Optional[float] = Field(default=None, ge=0.0,
        description="Minimum radial gap from the outermost orifice's face trace to the chamber "
                    "bore [m] -- manifold land, and the room a fuel barrier row would need. "
                    "None => 0.0.")
    layer1_resultant_tilt_from_reach: Optional[bool] = Field(default=None,
        description="Derive the permitted outward spray tilt from the design's own geometry "
                    "instead of taking layer1_resultant_tilt_max_deg as a constant. An outward "
                    "fan is only a hazard if it REACHES the liner while the spray is still "
                    "liquid, and the angle at which it does depends on the impingement radius -- "
                    "which the optimizer is free to move underneath a fixed allowance. When true "
                    "the limit is atan((r_wall - r_imp) / (margin * L_chamber)). None => False "
                    "(the constant is used, previous behaviour exactly).")
    layer1_resultant_tilt_reach_margin: Optional[float] = Field(default=None, gt=0.0,
        description="Safety factor on chamber length for layer1_resultant_tilt_from_reach. "
                    "1.5 means the fan may not reach the liner inside 1.5 chamber lengths. "
                    "None => 1.5.")
    layer1_impingement_Ld_min: Optional[float] = Field(default=None, gt=0.0,
        description="Min impingement standoff in orifice diameters. None => Ld_target - Ld_tol")
    layer1_impingement_Ld_max: Optional[float] = Field(default=None, gt=0.0,
        description="Max impingement standoff in orifice diameters. None => Ld_target + Ld_tol")
    layer1_momentum_band_width: Optional[float] = Field(default=None, gt=0.0,
        description="Half-width of the log-symmetric momentum-ratio preference band. None => 0.05")
    layer1_momentum_low_side_multiplier: Optional[float] = Field(default=None, ge=0.0,
        description="Extra weight on momentum-ratio misses below the band. None => 10.0")
    layer1_generations_per_restart: Optional[float] = Field(default=None, gt=0.0,
        description="CMA-ES generations per restart. None => 50.0")
    max_chamber_length_m: Optional[float] = Field(default=None, gt=0.0,
        description="Hard cap on chamber length (injector face to throat) [m]. None => 0.50")
    objective_cache_rel: Optional[float] = Field(default=None, gt=0.0,
        description="Relative tolerance for the objective memo cache. None => 1e-5")
    report_every_n: Optional[int] = Field(default=None, gt=0,
        description="Progress reporting stride in evaluations. None => 1")
    # ------------------------------------------------------------------------------------
    layer1_infeasibility_gate_eps: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Treat infeasibility_score ≤ eps as feasible for thrust/MR/ΔP objective blending (code default 0.002).",
    )
    layer1_W_THRUST: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Layer 1 weight on thrust penalty term (code default 1e4 when unset).",
    )
    layer1_W_PC: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Layer 1 weight on the chamber-pressure target penalty — an exact (L1) penalty on "
                    "|Pc - target|, so Pc lands ON the target (only active when target_chamber_pressure_psi "
                    "is set; code default 1e4 when unset). Raise to hold Pc tighter, lower to let thrust win ties.",
    )
    layer1_W_OF: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Layer 1 weight on relative MR error squared (code default 1e4 when unset).",
    )
    layer1_W_OF_low_MR_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "When MR is below optimal_of_ratio, multiply the O/F penalty by max(1, this scale) "
            "(default 1: no extra weight on fuel-rich side)."
        ),
    )
    layer1_W_OF_high_MR_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "When MR exceeds optimal_of_ratio, multiply the O/F penalty by max(1, this scale) "
            "(default 1: symmetric with low‑MR tuning optional)."
        ),
    )
    layer1_of_validation_tol: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Relative MR error cap used for Layer‑1 bookkeeping and for ``pressure_candidate_valid`` "
            "O/F gate (default 0.15)."
        ),
    )
    layer1_thrust_validation_rel_tol: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Relative thrust error gate for ``pressure_candidate_valid``. "
            "If unset, uses ``tolerances['thrust']`` passed into ``run_layer1_optimization`` (default 10%)."
        ),
    )
    W_CHAMBER_SHAPE: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Layer 1 weight on chamber-shape regularization (D_chamber/D_throat and L_chamber/D_chamber).",
    )
    layer1_chamber_dt_ratio_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred lower bound for chamber-to-throat diameter ratio D_chamber_inner/D_throat.",
    )
    layer1_chamber_dt_ratio_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred upper bound for chamber-to-throat diameter ratio D_chamber_inner/D_throat.",
    )
    layer1_chamber_ld_ratio_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred lower bound for chamber length ratio L_chamber/D_chamber_inner.",
    )
    layer1_chamber_ld_ratio_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred upper bound for chamber length ratio L_chamber/D_chamber_inner.",
    )

    layer1_stagnation_pressure_frac_min: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Layer 1 search-box lower edge as a fraction of each tank cap: "
            "P_O ∈ [max_lox×f_min, max_lox×f_max], P_F similarly (unless overridden below). "
            "Default when unset: 0.35 (the cap is the limit; the old 0.65 left the bottom of "
            "the band unsearched)."
        ),
    )
    layer1_stagnation_pressure_frac_max: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Companion upper fraction for stagnation-pressure box. Default when unset: 1.0 "
                    "(the search reaches the cap itself).",
    )
    layer1_expansion_ratio_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional lower bound for Layer 1 expansion-ratio search box (default when unset: 4.0).",
    )
    layer1_expansion_ratio_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional upper bound for Layer 1 expansion-ratio search box (default when unset: 12.0).",
    )
    layer1_P_O_start_psi_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional absolute LOX stagnation pressure lower bound [psi] for Layer 1 (overrides frac box).",
    )
    layer1_P_O_start_psi_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional absolute LOX stagnation upper bound [psi].",
    )
    layer1_P_F_start_psi_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional fuel stagnation lower bound [psi].",
    )
    layer1_P_F_start_psi_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional fuel stagnation upper bound [psi].",
    )

    # Frozen parameters (optional - for locking specific values during optimization)
    frozen_parameters: Optional[FrozenParametersConfig] = Field(
        default=None,
        description="Optional frozen parameter values for Layer 1 optimization. When set, these values are used instead of being optimized."
    )

    @model_validator(mode="after")
    def _injector_dp_bands_ordered(self):
        # Normalize the legacy ΔP/Pc band [0.15, 0.35] -> [0.20, 0.40] (M6 recalibration) on the
        # CONFIG object itself, so the optimizer and the UI validation card agree. Previously only
        # the optimizer migrated this (injector_dp_bands_from_requirements), while the frontend read
        # the raw [0.15, 0.35] from the config -> a design that passed at 0.2-0.4 showed an X against
        # the stale 0.15-0.35 display.
        # DEF-10: this rewrites a band a user can type on purpose. The shipped configs are migrated
        # (default.yaml carries 0.20/0.40 as used); removing the rewrite needs the optimizer's copy
        # (injector_dp_penalty.injector_dp_bands_from_requirements) removed in the same change, or
        # the UI and the optimizer disagree again. Until then it is at least not silent.
        import logging
        _LEGACY = (0.15, 0.35)
        _NEW = (0.20, 0.40)
        if (abs(self.injector_dp_ratio_O_min - _LEGACY[0]) < 1e-9
                and abs(self.injector_dp_ratio_O_max - _LEGACY[1]) < 1e-9):
            self.injector_dp_ratio_O_min, self.injector_dp_ratio_O_max = _NEW
            logging.getLogger(__name__).warning(
                "injector_dp_ratio_O band 0.15-0.35 read as the legacy default and replaced by "
                "0.20-0.40; the optimizer applies the same rewrite")
        if (abs(self.injector_dp_ratio_F_min - _LEGACY[0]) < 1e-9
                and abs(self.injector_dp_ratio_F_max - _LEGACY[1]) < 1e-9):
            self.injector_dp_ratio_F_min, self.injector_dp_ratio_F_max = _NEW
            logging.getLogger(__name__).warning(
                "injector_dp_ratio_F band 0.15-0.35 read as the legacy default and replaced by "
                "0.20-0.40; the optimizer applies the same rewrite")
        if self.injector_dp_ratio_O_max <= self.injector_dp_ratio_O_min:
            raise ValueError("injector_dp_ratio_O_max must exceed injector_dp_ratio_O_min")
        if self.injector_dp_ratio_F_max <= self.injector_dp_ratio_F_min:
            raise ValueError("injector_dp_ratio_F_max must exceed injector_dp_ratio_F_min")
        rlo, rhi = self.impinging_momentum_R_min, self.impinging_momentum_R_max
        if (rlo is not None) ^ (rhi is not None):
            raise ValueError("Set both impinging_momentum_R_min and impinging_momentum_R_max or neither.")
        if rlo is not None and rhi is not None and float(rhi) <= float(rlo):
            raise ValueError("impinging_momentum_R_max must exceed impinging_momentum_R_min.")
        alo, ahi = self.layer1_impinging_angle_deg_min, self.layer1_impinging_angle_deg_max
        if (alo is not None) ^ (ahi is not None):
            raise ValueError("Set both layer1_impinging_angle_deg_min and layer1_impinging_angle_deg_max or neither.")
        if alo is not None and ahi is not None and float(ahi) <= float(alo):
            raise ValueError("layer1_impinging_angle_deg_max must exceed layer1_impinging_angle_deg_min.")
        fmn, fmx = self.layer1_stagnation_pressure_frac_min, self.layer1_stagnation_pressure_frac_max
        if fmn is not None and fmx is not None and float(fmx) <= float(fmn):
            raise ValueError("layer1_stagnation_pressure_frac_max must exceed layer1_stagnation_pressure_frac_min.")
        ermn, ermx = self.layer1_expansion_ratio_min, self.layer1_expansion_ratio_max
        if ermn is not None and ermx is not None and float(ermx) <= float(ermn):
            raise ValueError("layer1_expansion_ratio_max must exceed layer1_expansion_ratio_min.")
        dtr_lo, dtr_hi = self.layer1_chamber_dt_ratio_min, self.layer1_chamber_dt_ratio_max
        if (dtr_lo is not None) ^ (dtr_hi is not None):
            raise ValueError("Set both layer1_chamber_dt_ratio_min and layer1_chamber_dt_ratio_max or neither.")
        if dtr_lo is not None and dtr_hi is not None and float(dtr_hi) <= float(dtr_lo):
            raise ValueError("layer1_chamber_dt_ratio_max must exceed layer1_chamber_dt_ratio_min.")
        ldr_lo, ldr_hi = self.layer1_chamber_ld_ratio_min, self.layer1_chamber_ld_ratio_max
        if (ldr_lo is not None) ^ (ldr_hi is not None):
            raise ValueError("Set both layer1_chamber_ld_ratio_min and layer1_chamber_ld_ratio_max or neither.")
        if ldr_lo is not None and ldr_hi is not None and float(ldr_hi) <= float(ldr_lo):
            raise ValueError("layer1_chamber_ld_ratio_max must exceed layer1_chamber_ld_ratio_min.")
        return self


class HybridOptimizerConfig(BaseModel):
    """Configuration for Hybrid CMA + Block Re-optimization"""
    elite_k: int = Field(default=50, gt=0, description="Size of elite pool for block building")
    
    block_method: Literal["random", "corr_greedy"] = Field(
        default="random",
        description="Method to build variable blocks: 'random' or 'corr_greedy' (correlation-based)"
    )
    num_blocks: int = Field(default=3, gt=0, description="Number of blocks")
    overlap_fraction: float = Field(default=0.0, ge=0.0, le=0.5, description="Fraction of block indices that overlap with the previous block")
    
    cycles: int = Field(default=3, gt=0, description="Number of re-optimization cycles")
    
    # Soft freezing / Penalty parameters.
    #
    # NOT WIRED. ``run_hybrid_optimization`` computes ``base_lambda`` and ``f_scale`` from
    # these every cycle and then never applies them: the block objective stitches the block's
    # coordinates into the incumbent and evaluates the plain objective, with no penalty on
    # leaving the incumbent. Blocks are therefore hard-frozen, and changing any of these four
    # fields changes nothing. Kept so shipped configs still validate; do not tune them.
    lambda0: float = Field(default=1e-3, gt=0, description="Initial penalty weight base (currently unused -- see note above)")
    lambda_mult: float = Field(default=10.0, gt=1.0, description="Multiplier for lambda per cycle")
    lambda_max: float = Field(default=1.0, gt=0, description="Maximum lambda (relative to f-scale)")
    lambda_normalize: bool = Field(default=True, description="Normalize lambda using objective function scale magnitude")
    
    # Budgeting
    per_block_budget_fraction: float = Field(default=0.5, gt=0.0, le=0.9, description="Fraction of TOTAL budget allocated to block optimization cycles")
    
    # Global Refresh
    refresh_every_pass: bool = Field(default=True, description="Run a global refresh after every full pass of blocks")
    refresh_budget_fraction: float = Field(default=0.1, gt=0.0, le=1.0, description="Fraction of initial global budget for each refresh")
    refresh_sigma_scale: float = Field(default=0.2, gt=0.0, le=1.0, description="Scale of sigma for refresh relative to initial sigma")
    
    # Multi-track
    num_tracks: int = Field(default=1, gt=0, description="Number of independent optimization tracks")


class OptimizerConfig(BaseModel):
    """Main Optimizer Configuration"""
    mode: Literal["cma", "hybrid_cma_blocks"] = Field(
        default="cma",
        description="Optimization mode: 'cma' (baseline) or 'hybrid_cma_blocks'"
    )
    hybrid: Optional[HybridOptimizerConfig] = Field(default=None, description="Configuration for hybrid mode")


class PressureSegmentConfig(BaseModel):
    """Single segment of a pressure curve"""
    length_ratio: float = Field(gt=0, le=1, description="Fraction of total burn time for this segment (0-1)")
    type: Literal["linear", "blowdown"] = Field(description="Segment type: 'linear' or 'blowdown'")
    start_pressure_pa: float = Field(gt=0, description="Pressure at segment start [Pa]")
    end_pressure_pa: float = Field(gt=0, description="Pressure at segment end [Pa]")
    k: Optional[float] = Field(default=None, gt=0, description="Blowdown parameter k (only used for blowdown type, typically 0.1-2.0)")


class PressureCurvesConfig(BaseModel):
    """Optimized pressure curves from Layer 2 optimization"""
    n_points: int = Field(default=200, gt=0, description="Number of points in the generated pressure curve arrays")
    target_burn_time_s: float = Field(gt=0, description="Target burn time [s] used for optimization")
    initial_lox_pressure_pa: float = Field(gt=0, description="Initial LOX tank pressure [Pa]")
    initial_fuel_pressure_pa: float = Field(gt=0, description="Initial fuel tank pressure [Pa]")
    lox_segments: List[PressureSegmentConfig] = Field(description="LOX tank pressure curve segments")
    fuel_segments: List[PressureSegmentConfig] = Field(description="Fuel tank pressure curve segments")


class PintleEngineConfig(BaseModel):
    """Complete pintle engine configuration"""
    # Propellant preset name (configs/propellants/<name>.yaml). Resolved by io.load_config BEFORE
    # validation: preset supplies fluids/CEA baseline, explicit YAML fields override. Plain str (not
    # Literal) on purpose — adding a new propellant must require zero code changes (UNIFICATION P7).
    propellant_preset: Optional[str] = Field(default=None, description="Propellant preset to merge (e.g. 'methalox', 'ethalox', 'kerolox'); explicit fields win over preset")
    fluids: Dict[str, FluidConfig]
    injector: InjectorConfig
    feed_system: Dict[str, FeedSystemConfig]  # "oxidizer" and "fuel"
    regen_cooling: Optional[RegenCoolingConfig] = Field(default=None, description="Regenerative cooling configuration (fuel only)")
    film_cooling: Optional[FilmCoolingConfig] = Field(default=None, description="Film cooling configuration")
    ablative_cooling: Optional[AblativeCoolingConfig] = Field(default=None, description="Ablative cooling configuration for chamber liner")
    graphite_insert: Optional[GraphiteInsertConfig] = Field(default=None, description="Graphite throat insert configuration (separate from chamber ablator)")
    stainless_steel_case: Optional[StainlessSteelCaseConfig] = Field(default=None, description="Stainless steel case configuration (structural wall behind ablative/graphite)")
    discharge: Dict[str, DischargeConfig]  # "oxidizer" and "fuel"
    spray: SprayConfig = Field(default_factory=SprayConfig)
    combustion: CombustionConfig = Field(default_factory=CombustionConfig)
    # Chamber geometry - unified section for solve_chamber_geometry_with_cea
    chamber_geometry: Optional[ChamberGeometryConfig] = Field(default=None, description="Unified chamber geometry config (design inputs + solver outputs)")
    # Legacy chamber/nozzle sections (for backward compatibility - optional if chamber_geometry is provided)
    chamber: Optional[ChamberConfig] = Field(default=None, description="Legacy chamber config (use chamber_geometry instead)")
    nozzle: Optional[NozzleConfig] = Field(default=None, description="Legacy nozzle config (use chamber_geometry instead)")
    solver: SolverConfig = Field(default_factory=SolverConfig)
    stability: StabilityConfig = Field(default_factory=StabilityConfig, description="Combustion / feed stability model inputs (calibration, regulator, acoustic damping)")
    optimizer: Optional[OptimizerConfig] = Field(default=None, description="Optimizer configuration")
    # Flight simulation fields (optional)
    lox_tank: Optional[LOXTankConfig] = Field(default=None, description="LOX tank configuration for flight simulation")
    fuel_tank: Optional[FuelTankConfig] = Field(default=None, description="Fuel tank configuration for flight simulation")
    press_tank: Optional[PressTankConfig] = Field(default=None, description="Pressurant tank configuration for flight simulation")
    rocket: Optional[RocketConfig] = Field(default=None, description="Rocket configuration for flight simulation")
    environment: Optional[EnvironmentConfig] = Field(default=None, description="Environment configuration for flight simulation")
    thrust: Optional[ThrustConfig] = Field(default=None, description="Thrust configuration for flight simulation")
    design_requirements: Optional[DesignRequirementsConfig] = Field(default=None, description="Design requirements for optimizer")
    pressure_curves: Optional[PressureCurvesConfig] = Field(default=None, description="Optimized pressure curves from Layer 2 optimization")
    # Provenance stamp: which {injector, propellant} the current chamber was last solved/seeded for.
    # Forward mode warns ("needs re-optimization") when the live injector/propellant no longer match —
    # see engine.pipeline.config_switch.design_staleness. Set on canonical load & propellant overlay.
    design_valid_for: Optional[Dict[str, Optional[str]]] = Field(default=None, description="{'injector','propellant'} the chamber geometry was solved for (forward-mode staleness flag)")

    @field_validator("feed_system", "discharge")
    @classmethod
    def validate_branches(cls, v):
        """Ensure both oxidizer and fuel branches are present"""
        if "oxidizer" not in v or "fuel" not in v:
            raise ValueError("Must specify both 'oxidizer' and 'fuel' branches")
        return v

    @model_validator(mode="after")
    def injector_aware_geometry_cd_default(self):
        """FINDING F1 fix (UNIFICATION P3): ``use_geometry_cd`` schema-defaults to True (drilled
        impinging orifices). For PINTLE the geometry-Cd correlation doesn't apply (annulus/orifice
        Cd is fixed Cd_inf; the solver never calls it) — so when the field was NOT explicitly given,
        derive False for pintle. Explicit YAML values are respected (model_fields_set check)."""
        if getattr(getattr(self, "injector", None), "type", None) == "pintle":
            for side in ("oxidizer", "fuel"):
                d = self.discharge.get(side) if isinstance(self.discharge, dict) else None
                if d is not None and "use_geometry_cd" not in d.model_fields_set:
                    d.use_geometry_cd = False
        return self

    @model_validator(mode="after")
    def align_expansion_ratio_with_exit_throat_areas(self):
        """Nozzle thrust uses eps == A_exit/A_throat (strict); YAML often labels eps rounded."""
        cg = self.chamber_geometry
        if cg is None:
            return self
        at = cg.A_throat
        ae = cg.A_exit
        if at is None or ae is None:
            return self
        try:
            at_f = float(at)
            ae_f = float(ae)
        except (TypeError, ValueError):
            return self
        if not np.isfinite(at_f) or not np.isfinite(ae_f) or at_f <= 0 or ae_f <= 0:
            return self
        eps_geo = ae_f / at_f
        if eps_geo <= 1.0:
            return self
        cg.expansion_ratio = float(eps_geo)
        try:
            self.combustion.cea.expansion_ratio = float(eps_geo)
        except Exception:
            pass
        nz = self.nozzle
        if nz is not None:
            try:
                nz.expansion_ratio = float(eps_geo)
            except Exception:
                pass
        return self

    @model_validator(mode="after")
    def sync_burn_time_fields(self):
        """Keep thrust.burn_time and pressure_curves.target_burn_time_s aligned with design_requirements."""
        from engine.pipeline.burn_time_sync import sync_burn_time_fields

        sync_burn_time_fields(self)
        return self

    model_config = ConfigDict(extra="allow")


def ensure_chamber_geometry(config: PintleEngineConfig) -> ChamberGeometryConfig:
    """
    Ensure chamber_geometry exists, creating from legacy sections if needed.
    
    This helper function provides backward compatibility by creating chamber_geometry
    from legacy chamber/nozzle sections if chamber_geometry doesn't exist.
    
    Parameters:
    -----------
    config : PintleEngineConfig
        Configuration object
        
    Returns:
    --------
    ChamberGeometryConfig
        The chamber_geometry config (created if needed)
        
    Raises:
    -------
    ValueError
        If neither chamber_geometry nor legacy sections exist
    """
    if config.chamber_geometry is not None:
        return config.chamber_geometry
    
    # Create from legacy sections if they exist
    if config.chamber is None or config.nozzle is None:
        raise ValueError(
            "Must provide either 'chamber_geometry' section or both 'chamber' and 'nozzle' sections"
        )
    
    # Create chamber_geometry from legacy sections
    chamber = config.chamber
    nozzle = config.nozzle
    
    # Get design parameters (use defaults if not in legacy sections)
    design_pressure = getattr(chamber, 'design_pressure', 2.0e6)
    design_thrust = getattr(chamber, 'design_thrust', 5000.0)
    design_MR = getattr(chamber, 'design_MR', 2.55)
    
    # Get dimensions
    chamber_diameter = getattr(chamber, 'chamber_inner_diameter', 0.08)
    Lstar = getattr(chamber, 'Lstar', 1.0)
    exit_diameter = getattr(chamber, 'exit_diameter', None) or getattr(nozzle, 'exit_diameter', 0.1)
    expansion_ratio = getattr(nozzle, 'expansion_ratio', 8.0)
    nozzle_efficiency = getattr(nozzle, 'efficiency', 0.95)
    
    # Get solved outputs (if available)
    A_throat = getattr(chamber, 'A_throat', None) or getattr(nozzle, 'A_throat', None)
    A_exit = getattr(nozzle, 'A_exit', None)
    volume = getattr(chamber, 'volume', None)
    length = getattr(chamber, 'length', None)
    length_cylindrical = getattr(chamber, 'length_cylindrical', None)
    length_contraction = getattr(chamber, 'length_contraction', None)
    Cf = getattr(chamber, 'design_force_coefficient', None)
    
    # Create and assign chamber_geometry
    config.chamber_geometry = ChamberGeometryConfig(
        design_pressure=design_pressure,
        design_thrust=design_thrust,
        design_MR=design_MR,
        chamber_diameter=chamber_diameter,
        Lstar=Lstar,
        exit_diameter=exit_diameter,
        expansion_ratio=expansion_ratio,
        nozzle_efficiency=nozzle_efficiency,
        A_throat=A_throat,
        A_exit=A_exit,
        volume=volume,
        length=length,
        length_cylindrical=length_cylindrical,
        length_contraction=length_contraction,
        Cf=Cf,
    )

    return config.chamber_geometry


# Injector-agnostic alias (UNIFICATION P3 naming): the config models any bipropellant engine
# (pintle / impinging / coaxial), not just pintle. New code should prefer `EngineConfig`; the
# `PintleEngineConfig` name is retained for backward compatibility with the 57 existing references.
EngineConfig = PintleEngineConfig

"""What feed-twin needs from an engine design, and nothing more.

An EngineDesign Layer-1 config is a large document -- ablative cooling, spray
SMD correlations, optimizer weights, CEA cache paths, structural margins. Almost
none of that is a feed-system boundary condition. What a feed system needs to
know about the engine at its end is small and specific:

* the **effective flow area** each propellant sees at the injector face,
* the **discharge coefficient** on each side and how it moves with Reynolds,
* which **propellants** those are, so the property layer can be asked,
* the **throat area**, which converts total flow into chamber pressure,
* and the **design point** -- thrust, mixture ratio, chamber pressure -- so the
  import can be checked against what Layer 1 thought it had designed.

:class:`EngineDesign` is that subset, and it is deliberately a plain record
rather than a live handle on an EngineDesign object. Two reasons. It can be
serialised into a feed-twin scenario, so a run is reproducible without the other
repo present. And it makes the coupling *explicit*: every quantity crossing the
boundary is named in one place, so nobody has to read two codebases to find out
what the engine is being told.

Injector types are not interchangeable
--------------------------------------
The area calculation is the one genuinely type-specific piece, and getting it
from the wrong formula is silent -- a wrong area is a wrong flow is a wrong
chamber pressure, and every number downstream stays plausible. So each type has
its own extractor, registered by name, and an unrecognised type is refused
rather than guessed at:

``impinging``
    ``n_elements`` round jets per side. ``A = n . pi d_jet^2 / 4``.

``pintle``
    Oxidiser through discrete orifices, fuel through the annulus between the
    pintle tip and the reservoir wall. The two sides use *different formulae*,
    which is exactly the trap.

``coaxial``
    Core ports and an outer annulus, same asymmetry.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Mapping

#: EngineDesign propellant names to feed-twin species. Kept explicit rather than
#: lower-cased and hoped for: "LOX" and "oxygen" are the same fluid under two
#: naming conventions, and a silent miss here would fall back to a default fluid
#: and quietly change every density in the feed system.
PROPELLANT_ALIASES: dict[str, str] = {
    "lox": "oxygen",
    "o2": "oxygen",
    "oxygen": "oxygen",
    "liquid oxygen": "oxygen",
    "ethanol": "ethanol",
    "etoh": "ethanol",
    "c2h5oh": "ethanol",
    "methane": "methane",
    "ch4": "methane",
    "lch4": "methane",
    "lng": "methane",
}


class UnknownPropellant(KeyError):
    """A propellant name that does not map to a feed-twin species."""

    def __init__(self, name: str) -> None:
        import difflib

        close = difflib.get_close_matches(name.lower(), PROPELLANT_ALIASES, n=3)
        hint = f" Did you mean: {', '.join(close)}?" if close else ""
        super().__init__(
            f"no feed-twin species for propellant {name!r}.{hint} Known names: "
            f"{', '.join(sorted(PROPELLANT_ALIASES))}. Add one with "
            "register_propellant_alias() rather than renaming it in the engine "
            "config -- the engine config is the source of truth for what the "
            "engine burns."
        )


def register_propellant_alias(name: str, species: str) -> None:
    """Map an engine-config propellant name onto a feed-twin species."""
    PROPELLANT_ALIASES[name.lower()] = species


def species_for(name: str) -> str:
    key = name.strip().lower()
    if key not in PROPELLANT_ALIASES:
        raise UnknownPropellant(name)
    return PROPELLANT_ALIASES[key]


@dataclass(frozen=True, slots=True)
class DischargeModel:
    """Reynolds- and geometry-dependent discharge coefficient.

    ``Cd(Re) = Cd_inf(d) - a_Re / sqrt(Re)``, clamped to ``[Cd_min, Cd_inf(d)]``,
    with optional pressure and temperature corrections. Reproduced rather than
    re-derived: this must agree with EngineDesign's own answer at the same
    operating point or the two tools are modelling different injectors, and a
    boundary that disagrees with the thing it bounds is worse than no boundary.

    ``Cd_inf`` depends on hole size when ``use_geometry_cd`` is set, which it is
    on the current vehicle's config. Small drilled holes lose a little to their
    rougher relative edge; large well-rounded ports gain a little. Leaving it out
    was worth about six points of injector stiffness on the real engine --
    enough to move a design from inside its 20-30% band to outside it, which is
    exactly the kind of quiet disagreement between two tools that costs an
    afternoon to find.
    """

    cd_inf: float = 0.6
    a_re: float = 0.0
    cd_min: float = 0.15
    use_pressure_correction: bool = False
    p_ref: float = 5.0e6
    a_p: float = 0.0
    use_temperature_correction: bool = False
    t_ref: float = 90.0
    a_t: float = 0.0
    use_geometry_cd: bool = False
    d_ref: float = 2.0e-3
    d_min: float = 4.0e-4
    cd_small_hole_exponent: float = 0.20
    cd_large_hole_log_gain: float = 0.015
    cd_inf_max: float = 0.62
    cd_inf_min_geom: float = 0.48

    def cd_infinite(self, diameter: float | None = None) -> float:
        """High-Reynolds ``Cd`` for a hole of this size."""
        if not self.use_geometry_cd or diameter is None or diameter <= 0.0:
            return self.cd_inf
        if self.d_ref <= 0.0:
            return min(max(self.cd_inf, self.cd_inf_min_geom), self.cd_inf_max)
        ratio = max(diameter, self.d_min) / self.d_ref
        value = (
            self.cd_inf * ratio ** max(self.cd_small_hole_exponent, 0.0)
            if ratio < 1.0
            else self.cd_inf + self.cd_large_hole_log_gain * math.log(ratio)
        )
        return min(max(value, self.cd_inf_min_geom), self.cd_inf_max)

    def cd(
        self,
        reynolds: float,
        *,
        pressure: float | None = None,
        temperature: float | None = None,
        diameter: float | None = None,
    ) -> float:
        ceiling = self.cd_infinite(diameter)
        if reynolds <= 0.0:
            return self.cd_min
        value = ceiling - self.a_re / math.sqrt(max(reynolds, 1e-6))
        if self.use_pressure_correction and pressure is not None and self.p_ref > 0.0:
            value *= 1.0 + self.a_p * (pressure / self.p_ref - 1.0)
        if (
            self.use_temperature_correction
            and temperature is not None
            and self.t_ref > 0.0
        ):
            value *= 1.0 + self.a_t * (temperature / self.t_ref - 1.0)
        return float(min(max(value, self.cd_min), ceiling))


@dataclass(frozen=True, slots=True)
class InjectorSide:
    """One propellant's path through the injector face.

    Args:
        propellant: Feed-twin species name.
        area: Total effective flow area [m^2] -- all elements, summed.
        hydraulic_diameter: Characteristic bore for the Reynolds number [m].
            Not the same as a jet diameter for an annulus, which is why it is
            carried separately rather than derived from the area.
        discharge: Cd model.
        element_count: How many elements. Reporting only; the area already has
            it folded in.
        temperature: Design propellant temperature [K], from the engine config.
    """

    propellant: str
    area: float
    hydraulic_diameter: float
    discharge: DischargeModel
    element_count: int = 1
    temperature: float = 0.0
    stiffness_band: tuple[float, float] = (0.0, 0.0)
    """``(min, max)`` injector pressure drop as a fraction of chamber pressure,
    from the engine config's own design requirements. ``(0, 0)`` means the
    config did not state one.

    Worth carrying rather than assuming, because the usual "20% and up" is a
    rule of thumb and *this* number is the band the optimiser was actually
    constrained by. Checking a delivered stiffness against the rule when the
    engine states its own is checking against the wrong thing -- and it has an
    upper bound too, which the rule of thumb does not: an injector that is too
    stiff is throwing away tank pressure it paid structural mass for."""

    def cd_at(
        self, mdot: float, rho: float, mu: float, pressure: float | None = None
    ) -> float:
        """Discharge coefficient at an operating point."""
        if self.area <= 0.0 or rho <= 0.0 or mu <= 0.0:
            return self.discharge.cd_inf
        velocity = abs(mdot) / (rho * self.area)
        reynolds = rho * velocity * self.hydraulic_diameter / mu
        return self.discharge.cd(
            reynolds,
            pressure=pressure,
            temperature=self.temperature or None,
            diameter=self.hydraulic_diameter,
        )


@dataclass(frozen=True, slots=True)
class EngineDesign:
    """A Layer-1 engine, reduced to its feed-system boundary.

    Args:
        name: Where this came from -- a config path, usually.
        injector_type: ``impinging``, ``pintle`` or ``coaxial``.
        oxidiser: Ox side of the injector face.
        fuel: Fuel side.
        throat_area: ``A_t`` [m^2]. Converts total flow into chamber pressure.
        expansion_ratio: ``A_e / A_t``.
        chamber_volume: For the chamber's own filling dynamics [m^3].
        design_chamber_pressure: What Layer 1 sized it at [Pa].
        design_mixture_ratio: O/F by mass.
        design_thrust: [N].
        cstar: Characteristic velocity [m/s] at the design point. A single
            number is the honest default: the real ``c*`` moves with mixture
            ratio, and :class:`~feedtwin.engine.chamber.Chamber` takes a curve
            when one is available.
        provenance: Where each number came from, keyed by field. Import fills
            this so a run can say which numbers were read and which defaulted.
    """

    name: str
    injector_type: str
    oxidiser: InjectorSide
    fuel: InjectorSide
    throat_area: float
    expansion_ratio: float = 0.0
    chamber_volume: float = 0.0
    design_chamber_pressure: float = 0.0
    design_mixture_ratio: float = 0.0
    design_thrust: float = 0.0
    cstar: float = 0.0
    nozzle_efficiency: float = 1.0
    """``eta_n``, from the config. Multiplies the thrust coefficient. Left at 1
    the model reports ideal-nozzle thrust, which is a few percent above what
    Layer 1 predicts for the same flows -- a disagreement between the two tools
    with no cause visible in either."""

    cstar_efficiency: float = 1.0
    """``eta_c*``. Layer 1 computes this from a spray, mixing and finite-rate
    model that feed-twin does not have and should not reimplement, so it is 1
    unless somebody states one. See :attr:`warnings`, which says so."""

    provenance: Mapping[str, str] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()
    """Things the config says about itself that do not agree. Reported rather
    than resolved: only the person who ran the optimiser knows which field is
    the stale one, and picking for them would bury the disagreement."""

    @property
    def throat_diameter(self) -> float:
        return math.sqrt(4.0 * self.throat_area / math.pi)

    def summary(self) -> str:
        return (
            f"{self.name}: {self.injector_type} injector, "
            f"{self.oxidiser.propellant}/{self.fuel.propellant}, "
            f"A_t {self.throat_area * 1e6:.1f} mm^2, "
            f"A_inj ox {self.oxidiser.area * 1e6:.2f} mm^2 / "
            f"fuel {self.fuel.area * 1e6:.2f} mm^2, "
            f"design {self.design_thrust:.0f} N at "
            f"{self.design_chamber_pressure / 1e5:.1f} bar, O/F "
            f"{self.design_mixture_ratio:.2f}"
        )

    def __repr__(self) -> str:
        return f"EngineDesign({self.summary()})"


# --------------------------------------------------------------- injector areas

#: Extracts ``(area, hydraulic diameter, element count)`` for one side of one
#: injector type, from that type's geometry block. Registered by injector type
#: so a fourth type is a registration rather than a chain of ``if`` statements.
AreaExtractor = Callable[[Mapping[str, object], str], tuple[float, float, int]]

_EXTRACTORS: dict[str, AreaExtractor] = {}


def register_injector_type(name: str, extractor: AreaExtractor) -> None:
    _EXTRACTORS[name] = extractor


def registered_injector_types() -> list[str]:
    return sorted(_EXTRACTORS)


def injector_areas(
    injector_type: str, geometry: Mapping[str, object], side: str
) -> tuple[float, float, int]:
    """Effective area, hydraulic diameter and element count for one side.

    Raises:
        KeyError: unrecognised injector type. Refused rather than guessed:
            a wrong area is a wrong mass flow is a wrong chamber pressure, and
            every number downstream of it stays perfectly plausible.
    """
    if injector_type not in _EXTRACTORS:
        raise KeyError(
            f"unknown injector type {injector_type!r}; registered: "
            f"{', '.join(registered_injector_types())}. Add one with "
            "register_injector_type() -- do not fall back to a default area."
        )
    return _EXTRACTORS[injector_type](geometry, side)


def _as_float(block: Mapping[str, object], key: str, where: str) -> float:
    value = block.get(key)
    if value is None:
        raise KeyError(f"{where}: missing {key!r}")
    return float(value)  # type: ignore[arg-type]


def _impinging(geometry: Mapping[str, object], side: str) -> tuple[float, float, int]:
    """Round jets, ``n`` of them per side."""
    block = geometry.get(side)
    if not isinstance(block, Mapping):
        raise KeyError(
            f"impinging geometry has no {side!r} block; found: "
            f"{', '.join(sorted(str(k) for k in geometry))}"
        )
    d = _as_float(block, "d_jet", f"impinging.{side}")
    n = int(_as_float(block, "n_elements", f"impinging.{side}"))
    return n * math.pi * d * d / 4.0, d, n


def _pintle(geometry: Mapping[str, object], side: str) -> tuple[float, float, int]:
    """Discrete orifices on the ox side, an annulus on the fuel side.

    The asymmetry is the whole point, and it is where an injector-type-blind
    importer goes wrong: applying the orifice formula to a fuel annulus produces
    a number with the right units and the wrong value.
    """
    key = "lox" if side == "oxidizer" else side
    block = geometry.get(key)
    if not isinstance(block, Mapping):
        raise KeyError(
            f"pintle geometry has no {key!r} block; found: "
            f"{', '.join(sorted(str(k) for k in geometry))}"
        )
    if key == "lox":
        d = _as_float(block, "d_orifice", "pintle.lox")
        n = int(_as_float(block, "n_orifices", "pintle.lox"))
        return n * math.pi * d * d / 4.0, d, n

    tip = _as_float(block, "d_pintle_tip", "pintle.fuel")
    gap = _as_float(block, "h_gap", "pintle.fuel")
    r_inner = tip / 2.0
    r_outer = r_inner + gap
    area = math.pi * (r_outer * r_outer - r_inner * r_inner)
    # An annulus's hydraulic diameter is twice the gap, not the tip diameter.
    hydraulic = block.get("d_hydraulic")
    return area, float(hydraulic) if hydraulic else 2.0 * gap, 1


def _coaxial(geometry: Mapping[str, object], side: str) -> tuple[float, float, int]:
    """Core ports for one propellant, an outer annulus for the other.

    Convention follows EngineDesign's schema: the *core* carries the oxidiser
    and the annulus the fuel, which is the usual shear-coaxial arrangement.
    """
    if side == "oxidizer":
        block = geometry.get("core")
        if not isinstance(block, Mapping):
            raise KeyError("coaxial geometry has no 'core' block")
        d = _as_float(block, "d_port", "coaxial.core")
        n = int(_as_float(block, "n_ports", "coaxial.core"))
        return n * math.pi * d * d / 4.0, d, n

    block = geometry.get("annulus")
    if not isinstance(block, Mapping):
        raise KeyError("coaxial geometry has no 'annulus' block")
    inner = _as_float(block, "inner_diameter", "coaxial.annulus")
    gap = _as_float(block, "gap_thickness", "coaxial.annulus")
    r_inner = inner / 2.0
    r_outer = r_inner + gap
    return math.pi * (r_outer * r_outer - r_inner * r_inner), 2.0 * gap, 1


register_injector_type("impinging", _impinging)
register_injector_type("pintle", _pintle)
register_injector_type("coaxial", _coaxial)

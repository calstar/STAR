"""Reading an EngineDesign Layer-1 config into a feed-system boundary.

The contract this module keeps is narrow and worth stating: **an engine design
is imported, never re-typed, and never edited on the way in.** Whatever Layer 1
optimised to is what gets fired. If a number is missing the import says which
one and stops; it does not substitute a plausible default, because a plausible
default here produces a run that looks right and is not the engine anybody
designed.

What is read, and what is ignored
---------------------------------
Read: ``injector.type`` and ``injector.geometry``, ``discharge.*``,
``fluids.*.name`` and ``.temperature``, ``chamber_geometry.A_throat``,
``expansion_ratio``, ``volume``, ``design_pressure``, ``design_MR`` and
``design_thrust``.

Ignored, on purpose: ablative cooling, spray SMD correlations, optimizer
weights, structural margins, CEA cache paths, stability scores. None of them is
a feed-system boundary condition, and reading them would create a coupling that
has to be maintained for no benefit.

The file is YAML because EngineDesign writes YAML. That is the one place this
library touches it -- and it is read with ``safe_load`` into plain dicts, so an
engine config cannot execute anything on import.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from feedtwin.engine.design import (
    DischargeModel,
    EngineDesign,
    InjectorSide,
    injector_areas,
    registered_injector_types,
    species_for,
)


class EngineImportError(ValueError):
    """The config could not be read as a feed-system boundary.

    Always names the key and the file. An import failure that says only
    "missing field" sends someone hunting through a two-thousand-line YAML.
    """

    def __init__(self, source: str, detail: str) -> None:
        super().__init__(f"{source}: {detail}")
        self.source = source


def _require(config: Mapping[str, Any], path: str, source: str) -> Any:
    """Fetch a dotted path, or fail naming exactly what was missing."""
    node: Any = config
    walked: list[str] = []
    for part in path.split("."):
        if not isinstance(node, Mapping) or part not in node:
            available = (
                ", ".join(sorted(str(k) for k in node))
                if isinstance(node, Mapping)
                else "(not a mapping)"
            )
            at = ".".join(walked) or "(top level)"
            raise EngineImportError(
                source,
                f"missing {path!r} -- no {part!r} under {at}. Available there: "
                f"{available}",
            )
        walked.append(part)
        node = node[part]
    return node


def _optional(config: Mapping[str, Any], path: str, default: float = 0.0) -> float:
    node: Any = config
    for part in path.split("."):
        if not isinstance(node, Mapping) or part not in node:
            return default
        node = node[part]
    return default if node is None else float(node)


def _discharge(block: Mapping[str, Any] | None) -> DischargeModel:
    if not isinstance(block, Mapping):
        return DischargeModel()
    return DischargeModel(
        cd_inf=float(block.get("Cd_inf", 0.6)),
        a_re=float(block.get("a_Re", 0.0)),
        cd_min=float(block.get("Cd_min", 0.15)),
        use_pressure_correction=bool(block.get("use_pressure_correction", False)),
        p_ref=float(block.get("P_ref", 5.0e6) or 5.0e6),
        a_p=float(block.get("a_P", 0.0) or 0.0),
        use_temperature_correction=bool(block.get("use_temperature_correction", False)),
        t_ref=float(block.get("T_ref", 90.0) or 90.0),
        a_t=float(block.get("a_T", 0.0) or 0.0),
        use_geometry_cd=bool(block.get("use_geometry_cd", False)),
        d_ref=float(block.get("d_ref_m", 2.0e-3) or 2.0e-3),
        d_min=float(block.get("d_min_m", 4.0e-4) or 4.0e-4),
        cd_small_hole_exponent=float(block.get("cd_small_hole_exponent", 0.20) or 0.20),
        cd_large_hole_log_gain=float(
            block.get("cd_large_hole_log_gain", 0.015) or 0.015
        ),
        cd_inf_max=float(block.get("cd_inf_max", 0.62) or 0.62),
        cd_inf_min_geom=float(block.get("cd_inf_min_geom", 0.48) or 0.48),
    )


def engine_from_config(
    config: Mapping[str, Any], *, name: str = "engine"
) -> EngineDesign:
    """Build a feed-system boundary from an already-parsed engine config.

    Separated from :func:`load_engine` so a config that arrived over HTTP, or
    one assembled in a test, imports through exactly the same path as one read
    off disk. The parser is not the interesting part; the extraction is.
    """
    injector = _require(config, "injector", name)
    if not isinstance(injector, Mapping):
        raise EngineImportError(name, "'injector' is not a mapping")

    injector_type = str(_require(config, "injector.type", name))
    if injector_type not in registered_injector_types():
        raise EngineImportError(
            name,
            f"injector type {injector_type!r} has no area extractor; known types "
            f"are {', '.join(registered_injector_types())}. Register one rather "
            "than letting it fall back -- a wrong injector area is a wrong mass "
            "flow and every number after it stays plausible.",
        )
    geometry = _require(config, "injector.geometry", name)
    if not isinstance(geometry, Mapping):
        raise EngineImportError(name, "'injector.geometry' is not a mapping")

    discharge = config.get("discharge") or {}
    fluids = _require(config, "fluids", name)

    sides: dict[str, InjectorSide] = {}
    provenance: dict[str, str] = {
        "injector_type": f"{name}:injector.type",
        "throat_area": f"{name}:chamber_geometry.A_throat",
    }
    for side in ("oxidizer", "fuel"):
        fluid = _require(config, f"fluids.{side}", name)
        propellant = str(_require(config, f"fluids.{side}.name", name))
        try:
            species = species_for(propellant)
        except KeyError as exc:
            raise EngineImportError(name, str(exc)) from exc

        try:
            area, hydraulic, count = injector_areas(injector_type, geometry, side)
        except KeyError as exc:
            raise EngineImportError(name, f"{side} injector geometry: {exc}") from exc
        if area <= 0.0:
            raise EngineImportError(
                name, f"{side} injector area came out as {area}, which cannot flow"
            )

        # The band Layer 1 constrained this side to, keyed by O/F rather than
        # by the side's own name -- EngineDesign spells them
        # injector_dp_ratio_O_min and injector_dp_ratio_F_min.
        initial = "O" if side == "oxidizer" else "F"
        band = (
            _optional(config, f"design_requirements.injector_dp_ratio_{initial}_min"),
            _optional(config, f"design_requirements.injector_dp_ratio_{initial}_max"),
        )
        if band[0] > 0.0 or band[1] > 0.0:
            provenance[f"{side}.stiffness_band"] = (
                f"{name}:design_requirements.injector_dp_ratio_{initial}_min/max "
                f"= {band[0]:g}-{band[1]:g}"
            )

        side_discharge = discharge.get(side) if isinstance(discharge, Mapping) else None
        sides[side] = InjectorSide(
            propellant=species,
            area=area,
            hydraulic_diameter=hydraulic,
            discharge=_discharge(side_discharge),
            element_count=count,
            temperature=float(fluid.get("temperature") or 0.0),
            stiffness_band=band,
        )
        provenance[f"{side}.propellant"] = f"{name}:fluids.{side}.name = {propellant}"
        provenance[f"{side}.area"] = (
            f"derived from {injector_type} geometry ({count} element(s))"
        )
        provenance[f"{side}.Cd"] = (
            f"{name}:discharge.{side}"
            if side_discharge
            else "feedtwin default (no discharge block in the config)"
        )

    throat_area = float(_require(config, "chamber_geometry.A_throat", name))

    # A config carries the design point twice, in two places written at
    # different times, and they drift.
    #
    # `design_requirements` is the *intent* -- what the optimiser was told to
    # hit. `chamber_geometry` is what the geometry was last sized at, and on a
    # config that has been re-run or switched propellant pair it is a leftover.
    # So intent wins, for both the mixture ratio and the chamber pressure, and
    # which one was used is recorded rather than warned about: a disagreement
    # between the two is the normal state of a config that is being worked on,
    # and a warning that fires on healthy input teaches people to skim past the
    # ones that matter.
    warnings: list[str] = []
    design_mr = _optional(config, "chamber_geometry.design_MR")
    optimal_mr = _optional(config, "design_requirements.optimal_of_ratio")
    mixture_ratio = optimal_mr if optimal_mr > 0.0 else design_mr

    design_pc = _optional(config, "chamber_geometry.design_pressure")
    target_pc = _optional(config, "design_requirements.target_chamber_pressure_psi")
    target_pa = target_pc * 6894.757293168361 if target_pc > 0.0 else 0.0
    chamber_pressure = target_pa if target_pa > 0.0 else design_pc

    # Thrust follows the same rule as the two above, and did not before.
    #
    # `chamber_geometry.design_thrust` is an *output*: what the last Layer 1 run
    # achieved. `design_requirements.target_thrust` is the *input*: what was
    # asked for. They agree right after an optimisation and drift apart when a
    # target is edited without re-running, which is the ordinary state of a
    # config being worked on. Reading only the output meant the shipped ethalox
    # config imported as 7000 N against a delivered 7200 N -- 2.9% low, with no
    # warning, while the very next two fields resolved the same conflict
    # correctly.
    design_thrust_out = _optional(config, "chamber_geometry.design_thrust")
    target_thrust = _optional(config, "design_requirements.target_thrust")
    thrust = target_thrust if target_thrust > 0.0 else design_thrust_out

    provenance["design_thrust"] = (
        f"{name}:design_requirements.target_thrust = {target_thrust:g} N"
        if target_thrust > 0.0
        else f"{name}:chamber_geometry.design_thrust = {design_thrust_out:g} N"
    )
    if target_thrust > 0.0 and design_thrust_out > 0.0:
        if abs(target_thrust - design_thrust_out) / target_thrust > 0.005:
            provenance["design_thrust"] += (
                f" (chamber_geometry.design_thrust says {design_thrust_out:g} N; "
                "that is the last optimiser run's achievement, and the target wins)"
            )

    provenance["mixture_ratio"] = (
        f"{name}:design_requirements.optimal_of_ratio = {optimal_mr:g}"
        + (
            f" (chamber_geometry.design_MR says {design_mr:g}; intent wins)"
            if design_mr > 0.0
            and abs(design_mr - optimal_mr) / max(optimal_mr, 1e-9) > 0.05
            else ""
        )
        if optimal_mr > 0.0
        else f"{name}:chamber_geometry.design_MR = {design_mr:g} "
        "(no optimal_of_ratio in the config)"
    )
    provenance["design_chamber_pressure"] = (
        f"{name}:design_requirements.target_chamber_pressure_psi = {target_pc:.0f} psi"
        + (
            f" (chamber_geometry.design_pressure says "
            f"{design_pc / 6894.757:.0f} psi; intent wins)"
            if design_pc > 0.0
            and abs(design_pc - target_pa) / max(target_pa, 1e-9) > 0.05
            else ""
        )
        if target_pa > 0.0
        else f"{name}:chamber_geometry.design_pressure = "
        f"{design_pc / 6894.757:.0f} psi (no target in the config)"
    )

    # eta_n is a scalar in the config and is read. eta_c* is not: Layer 1
    # derives it from a spray, mixing and finite-rate chemistry model, and the
    # config carries that model's *settings* rather than its answer. Guessing a
    # number here would put a silent few percent between the two tools, so it
    # stays at one and says so.
    nozzle_efficiency = _optional(config, "chamber_geometry.nozzle_efficiency") or 1.0
    provenance["nozzle_efficiency"] = (
        f"{name}:chamber_geometry.nozzle_efficiency = {nozzle_efficiency:g}"
        if nozzle_efficiency < 1.0
        else "not stated; thrust and Isp are reported for an ideal nozzle"
    )
    # Provenance, not a warning. It is true of every import, and a warning that
    # fires on healthy input is noise -- which is the fastest way to teach
    # somebody to skim past the ones that matter.
    provenance["cstar_efficiency"] = (
        "1.0 -- EngineDesign derives eta_c* from a spray, mixing and "
        "finite-rate model that feed-twin does not carry, so chamber pressure "
        "here is an upper bound"
    )

    return EngineDesign(
        name=name,
        nozzle_efficiency=nozzle_efficiency,
        injector_type=injector_type,
        oxidiser=sides["oxidizer"],
        fuel=sides["fuel"],
        throat_area=throat_area,
        expansion_ratio=_optional(config, "chamber_geometry.expansion_ratio"),
        chamber_volume=_optional(config, "chamber_geometry.volume"),
        design_chamber_pressure=chamber_pressure,
        design_mixture_ratio=mixture_ratio,
        design_thrust=thrust,
        provenance=provenance,
        warnings=tuple(warnings),
    )


def load_engine(path: str | Path) -> EngineDesign:
    """Import a Layer-1 engine config from disk.

    The whole Phase 08 promise in one call: point it at what the optimizer
    wrote and get a feed-system boundary, with nothing retyped.

    Raises:
        EngineImportError: the file is unreadable as an engine boundary, naming
            the key that was missing and where it looked.
    """
    source = Path(path)
    if not source.exists():
        raise EngineImportError(str(source), "no such file")
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise EngineImportError(
            str(source),
            "PyYAML is needed to read EngineDesign configs. Note that feed-twin's "
            "own configs are TOML precisely because YAML parses 1e-3 as a string; "
            "YAML here is a boundary format we read, not one we write.",
        ) from exc

    with source.open(encoding="utf-8") as handle:
        config = yaml.safe_load(handle)
    if not isinstance(config, Mapping):
        raise EngineImportError(str(source), "the file is not a YAML mapping")
    return engine_from_config(config, name=source.name)

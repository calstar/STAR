"""Phase 08: a Layer-1 engine dropped onto the end of a feed system.

The promise being tested is narrow and checkable: **point it at what the
optimizer wrote, and nothing gets retyped.** So most of these tests read real
EngineDesign configs off disk when the sibling repo is present, and fall back to
inline fixtures when it is not -- the fixtures are copied from the real schema,
so a schema change breaks the on-disk tests loudly rather than leaving the
inline ones passing against a format nobody uses any more.

The two things that fail silently get the most attention. An **injector area**
from the wrong formula is a wrong mass flow and every number downstream stays
plausible, so each injector type's area is checked against its closed form. And
a **combustion table read outside its range** returns a clamped number that
looks like a physical plateau, so extrapolation is surfaced rather than absorbed.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from feedtwin.comps import FlowConditions
from feedtwin.engine import (
    CEATable,
    Chamber,
    ConstantCStar,
    EngineImportError,
    InjectorLeg,
    UnknownPropellant,
    engine_from_config,
    injector_areas,
    injector_legs,
    load_engine,
    register_injector_type,
    register_propellant_alias,
    registered_injector_types,
    species_for,
)

ENGINE_DESIGN = Path("/Users/carlton/Downloads/STAR_ASF/STAR/EngineDesign")
REAL_CONFIG = ENGINE_DESIGN / "configs" / "impinging_lox_ch4_8000N_optimal.yaml"
REAL_CACHE = ENGINE_DESIGN / "output" / "cache" / "cea_cache_LOX_CH4_3D.npz"

needs_engine_design = pytest.mark.skipif(
    not REAL_CONFIG.exists(), reason="EngineDesign configs not present"
)
needs_cea = pytest.mark.skipif(
    not REAL_CACHE.exists(), reason="EngineDesign CEA cache not present"
)


def impinging_config() -> dict[str, object]:
    """The real schema, trimmed to what the importer reads."""
    return {
        "injector": {
            "type": "impinging",
            "geometry": {
                "oxidizer": {
                    "n_elements": 18,
                    "d_jet": 0.0029682419398978075,
                    "impingement_angle": 76.4,
                    "spacing": 0.0115,
                },
                "fuel": {
                    "n_elements": 18,
                    "d_jet": 0.0020731739365082054,
                    "impingement_angle": 71.7,
                    "spacing": 0.0051,
                },
            },
        },
        "discharge": {
            "oxidizer": {"Cd_inf": 0.4, "a_Re": 0.15, "Cd_min": 0.15},
            "fuel": {"Cd_inf": 0.4, "a_Re": 0.15, "Cd_min": 0.15},
        },
        "fluids": {
            "oxidizer": {"name": "LOX", "temperature": 90.0},
            "fuel": {"name": "Methane", "temperature": 112.0},
        },
        "chamber_geometry": {
            "A_throat": 0.0013982470588664619,
            "expansion_ratio": 7.01837178880855,
            "volume": 0.002081806580056309,
            "design_pressure": 2413166.0,
            "design_MR": 3.5,
            "design_thrust": 8000.0,
        },
    }


# ------------------------------------------------------------- the import


@needs_engine_design
def test_a_real_layer1_config_imports_with_nothing_retyped() -> None:
    """The Phase 08 promise, against the file the optimizer actually wrote."""
    design = load_engine(REAL_CONFIG)
    assert design.injector_type == "impinging"
    assert design.oxidiser.propellant == "oxygen"
    assert design.fuel.propellant == "methane"
    assert design.throat_area > 0.0
    assert design.design_thrust == 8000.0
    assert design.design_mixture_ratio == 3.5
    # Every quantity crossing the boundary says where it came from.
    assert "fluids.oxidizer.name" in design.provenance["oxidizer.propellant"]
    assert "discharge.oxidizer" in design.provenance["oxidizer.Cd"]


@needs_engine_design
def test_every_shipped_config_imports() -> None:
    """A schema drift in EngineDesign should break here, loudly."""
    configs = sorted((ENGINE_DESIGN / "configs").glob("*.yaml"))
    assert configs, "no configs found to check against"
    imported = 0
    for path in configs:
        try:
            design = load_engine(path)
        except EngineImportError:
            continue  # not every yaml in that folder is a full engine config
        assert design.throat_area > 0.0
        assert design.oxidiser.area > 0.0 and design.fuel.area > 0.0
        imported += 1
    assert imported >= 3


def test_import_from_a_parsed_config() -> None:
    design = engine_from_config(impinging_config(), name="inline")
    assert design.injector_type == "impinging"
    assert design.oxidiser.element_count == 18


def test_a_missing_key_names_itself_and_where_it_looked() -> None:
    """An import failure saying only 'missing field' sends someone hunting."""
    config = impinging_config()
    del config["chamber_geometry"]["A_throat"]  # type: ignore[index]
    with pytest.raises(EngineImportError, match="A_throat"):
        engine_from_config(config, name="inline")

    config = impinging_config()
    del config["injector"]["geometry"]["fuel"]  # type: ignore[index]
    with pytest.raises(EngineImportError, match="fuel"):
        engine_from_config(config, name="inline")


def test_an_unknown_propellant_is_refused_with_a_suggestion() -> None:
    config = impinging_config()
    config["fluids"]["fuel"]["name"] = "Methaine"  # type: ignore[index]
    with pytest.raises(EngineImportError, match="methane"):
        engine_from_config(config, name="inline")


def test_an_unknown_injector_type_is_refused_not_guessed() -> None:
    """A wrong area is a wrong mass flow, and everything after it looks fine."""
    config = impinging_config()
    config["injector"]["type"] = "swirl"  # type: ignore[index]
    with pytest.raises(EngineImportError, match="no area extractor"):
        engine_from_config(config, name="inline")


def test_propellant_aliases_cover_both_naming_conventions() -> None:
    assert species_for("LOX") == species_for("oxygen") == "oxygen"
    assert species_for("CH4") == species_for("Methane") == "methane"
    assert species_for("EtOH") == "ethanol"
    with pytest.raises(UnknownPropellant):
        species_for("unobtainium")
    register_propellant_alias("unobtainium", "helium")
    assert species_for("Unobtainium") == "helium"


# -------------------------------------------------------- injector geometry


def test_impinging_area_is_n_round_jets() -> None:
    geometry = impinging_config()["injector"]["geometry"]  # type: ignore[index]
    area, hydraulic, count = injector_areas("impinging", geometry, "oxidizer")
    d = 0.0029682419398978075
    assert area == pytest.approx(18 * math.pi * d * d / 4.0, rel=1e-12)
    assert hydraulic == pytest.approx(d)
    assert count == 18


def test_pintle_uses_orifices_on_one_side_and_an_annulus_on_the_other() -> None:
    """The asymmetry is the trap: one formula applied to both is silently wrong."""
    geometry = {
        "lox": {"n_orifices": 14, "d_orifice": 0.00272},
        "fuel": {"d_pintle_tip": 0.030, "h_gap": 0.0012},
    }
    ox_area, ox_d, ox_n = injector_areas("pintle", geometry, "oxidizer")
    assert ox_area == pytest.approx(14 * math.pi * 0.00272**2 / 4.0, rel=1e-12)
    assert ox_n == 14

    fuel_area, fuel_d, _ = injector_areas("pintle", geometry, "fuel")
    r_in, r_out = 0.015, 0.015 + 0.0012
    assert fuel_area == pytest.approx(math.pi * (r_out**2 - r_in**2), rel=1e-12)
    # An annulus's hydraulic diameter is twice the gap, not the tip diameter.
    assert fuel_d == pytest.approx(2 * 0.0012)

    # And the two sides genuinely differ -- the orifice formula on the fuel
    # annulus would give something else entirely.
    assert fuel_area != pytest.approx(ox_area)


def test_coaxial_uses_core_ports_and_an_outer_annulus() -> None:
    geometry = {
        "core": {"n_ports": 7, "d_port": 0.0018},
        "annulus": {"inner_diameter": 0.006, "gap_thickness": 0.0004},
    }
    ox_area, _, ox_n = injector_areas("coaxial", geometry, "oxidizer")
    assert ox_area == pytest.approx(7 * math.pi * 0.0018**2 / 4.0, rel=1e-12)
    assert ox_n == 7
    fuel_area, fuel_d, _ = injector_areas("coaxial", geometry, "fuel")
    assert fuel_area == pytest.approx(math.pi * (0.0034**2 - 0.003**2), rel=1e-12)
    assert fuel_d == pytest.approx(0.0008)


def test_injector_types_are_registered_not_hardcoded() -> None:
    assert set(registered_injector_types()) >= {"impinging", "pintle", "coaxial"}
    register_injector_type("slot", lambda geometry, side: (1e-5, 1e-3, 1))
    assert "slot" in registered_injector_types()
    assert injector_areas("slot", {}, "fuel") == (1e-5, 1e-3, 1)
    with pytest.raises(KeyError, match="unknown injector type"):
        injector_areas("vortex", {}, "fuel")


# --------------------------------------------------------------- discharge


def test_cd_follows_the_engine_design_correlation() -> None:
    """Must agree with EngineDesign's own answer or the two model different hardware."""
    design = engine_from_config(impinging_config(), name="inline")
    model = design.oxidiser.discharge
    for reynolds in (1e3, 1e4, 1e5, 1e6):
        expected = 0.4 - 0.15 / math.sqrt(reynolds)
        assert model.cd(reynolds) == pytest.approx(
            min(max(expected, 0.15), 0.4), rel=1e-12
        )


def test_cd_is_clamped_at_both_ends() -> None:
    design = engine_from_config(impinging_config(), name="inline")
    model = design.oxidiser.discharge
    # Cd = 0.4 - 0.15/sqrt(Re) only reaches the 0.15 floor below Re ~ 0.36,
    # which is deep creeping flow. The floor exists for exactly that region.
    assert model.cd(0.2) == pytest.approx(model.cd_min)
    assert model.cd(1.0) == pytest.approx(0.25)  # above the floor, unclamped
    assert model.cd(1e12) <= model.cd_inf
    assert model.cd(0.0) == model.cd_min
    assert model.cd(-5.0) == model.cd_min


def test_cd_rises_with_flow() -> None:
    """Low-Re Cd is materially below its high-Re value, which matters at startup."""
    design = engine_from_config(impinging_config(), name="inline")
    side = design.oxidiser
    low = side.cd_at(0.01, rho=1140.0, mu=1.8e-4)
    high = side.cd_at(2.0, rho=1140.0, mu=1.8e-4)
    assert low < high <= side.discharge.cd_inf


# ------------------------------------------------------------- the injector


def test_injector_leg_follows_the_orifice_relation() -> None:
    design = engine_from_config(impinging_config(), name="inline")
    ox, _ = injector_legs(design)
    flow = FlowConditions(rho=1140.0, mu=1.8e-4, p_upstream=4.0e6)
    mdot = 1.8
    area = ox.effective_area(mdot, flow)
    assert ox.pressure_drop(mdot, flow) == pytest.approx(
        mdot * mdot / (2.0 * 1140.0 * area * area), rel=1e-12
    )


def test_injector_dp_is_symmetric_and_quadratic() -> None:
    design = engine_from_config(impinging_config(), name="inline")
    ox, _ = injector_legs(design)
    flow = FlowConditions(rho=1140.0, mu=1.8e-4, p_upstream=4.0e6)
    assert ox.pressure_drop(1.0, flow) == pytest.approx(ox.pressure_drop(-1.0, flow))
    # Not exactly 4x, because Cd rises with Reynolds -- and that is the point.
    ratio = ox.pressure_drop(2.0, flow) / ox.pressure_drop(1.0, flow)
    assert 3.5 < ratio < 4.0


def test_injector_stiffness_at_the_design_point_is_sane() -> None:
    """A sanity check on the imported areas, in the units a designer thinks in."""
    design = engine_from_config(impinging_config(), name="inline")
    ox, fuel = injector_legs(design)
    lox = FlowConditions(rho=1140.0, mu=1.8e-4, p_upstream=4.0e6)
    ch4 = FlowConditions(rho=422.6, mu=1.2e-4, p_upstream=4.0e6)

    mdot_total = 1.9
    mr = design.design_mixture_ratio
    mdot_ox = mdot_total * mr / (1.0 + mr)
    mdot_fuel = mdot_total / (1.0 + mr)

    pc = design.design_chamber_pressure
    for leg, mdot, conditions in ((ox, mdot_ox, lox), (fuel, mdot_fuel, ch4)):
        stiffness = leg.pressure_drop(mdot, conditions) / pc
        assert 0.05 < stiffness < 1.0, f"{leg.id} stiffness {stiffness:.3f}"


# ----------------------------------------------------------------- chamber


def test_chamber_pressure_is_mdot_cstar_over_throat() -> None:
    chamber = Chamber(1.4e-3, ConstantCStar(cstar=1800.0, thrust_coefficient=1.5))
    result = chamber.evaluate(1.5, 0.4)
    assert result.pressure == pytest.approx(1.9 * 1800.0 / 1.4e-3, rel=1e-12)
    assert result.mixture_ratio == pytest.approx(1.5 / 0.4)
    assert result.thrust == pytest.approx(1.5 * result.pressure * 1.4e-3, rel=1e-12)


def test_a_shut_engine_sits_at_ambient_not_at_vacuum() -> None:
    """Not a numerical guard: a chamber is open to atmosphere through its nozzle.

    Without this the loop drives chamber pressure toward zero when nothing is
    flowing, and then asks the feed system to solve a 650 psi drop into 0.5 psi
    -- a state no hardware occupies and no solver enjoys.
    """
    chamber = Chamber(1.4e-3, ConstantCStar(cstar=1800.0, thrust_coefficient=1.5))
    assert chamber.evaluate(0.0, 0.0).pressure == pytest.approx(101325.0)
    trickle = chamber.evaluate(1e-6, 1e-6)
    assert trickle.pressure == pytest.approx(101325.0)
    assert trickle.thrust == 0.0  # and no thrust is reported for a shut engine
    assert not chamber.is_firing(trickle)
    assert chamber.is_firing(chamber.evaluate(1.5, 0.4))


def test_chamber_at_altitude_takes_a_different_floor() -> None:
    vacuum = Chamber(1.4e-3, ConstantCStar(cstar=1800.0), ambient_pressure=1.0)
    assert vacuum.evaluate(0.0, 0.0).pressure == pytest.approx(1.0)


def test_chamber_fill_time_is_milliseconds() -> None:
    """Why the chamber is quasi-steady: it responds 1000x faster than the feed."""
    chamber = Chamber(1.4e-3, ConstantCStar(cstar=1800.0), volume=2.08e-3)
    tau = chamber.fill_time(3.0e6, 3.5)
    assert 1e-4 < tau < 5e-3


@needs_cea
def test_cea_table_reproduces_real_combustion() -> None:
    table = CEATable(REAL_CACHE, expansion_ratio=7.0)
    assert table.propellants == ("LOX", "CH4")
    state = table.combustion(3.0e6, 3.5)
    assert 1700 < state.cstar < 1900
    assert 3200 < state.temperature < 3600
    assert 1.10 < state.gamma < 1.20
    assert 1.3 < state.thrust_coefficient < 1.8
    assert not state.extrapolated


@needs_cea
def test_cstar_peaks_below_the_stoichiometric_ratio() -> None:
    """A real physical shape, not a monotone fit: LOX/CH4 peaks near O/F 2.8."""
    table = CEATable(REAL_CACHE, expansion_ratio=7.0)
    ratios = [2.5, 2.8, 3.2, 3.6, 4.0]
    cstars = [table.combustion(3.0e6, mr).cstar for mr in ratios]
    peak = cstars.index(max(cstars))
    assert 0 <= peak <= 2, f"c* peaked at O/F {ratios[peak]}"
    assert cstars[-1] < max(cstars)


@needs_cea
def test_leaving_the_table_is_reported_not_absorbed() -> None:
    """A clamped c* looks like a physical plateau on a plot. It is a table edge."""
    table = CEATable(REAL_CACHE, expansion_ratio=7.0)
    inside = table.combustion(3.0e6, 3.5)
    assert not inside.extrapolated
    assert table.contains(3.0e6, 3.5)

    outside = table.combustion(3.0e6, 6.0)
    assert outside.extrapolated
    assert not table.contains(3.0e6, 6.0)
    # Clamped to the edge rather than extrapolated into fiction.
    edge = table.combustion(3.0e6, float(table.mixture_ratios[-1]))
    assert outside.cstar == pytest.approx(edge.cstar)


@needs_cea
def test_chamber_temperature_moves_with_mixture_ratio() -> None:
    """The output that makes O/F drift visible instead of merely tracked."""
    table = CEATable(REAL_CACHE, expansion_ratio=7.0)
    cold = table.combustion(3.0e6, 2.5).temperature
    hot = table.combustion(3.0e6, 3.6).temperature
    assert hot > cold + 100.0


# ------------------------------------------------------- the coupled engine


@needs_cea
@needs_engine_design
def test_the_chamber_loop_absorbs_part_of_an_upstream_change() -> None:
    """Why a pressure-fed engine is stable in the large.

    Raise the feed pressure and chamber pressure rises, but by *less*, because
    the rise eats into the injector's own pressure difference. If chamber
    pressure tracked feed pressure one-for-one there would be no loop.
    """
    design = load_engine(REAL_CONFIG)
    chamber = Chamber(
        design.throat_area, CEATable(REAL_CACHE, expansion_ratio=design.expansion_ratio)
    )
    ox, fuel = injector_legs(design)

    def fire(feed: float) -> tuple[float, float]:
        pc = 2.0e6
        for _ in range(200):
            lox = FlowConditions(rho=1140.0, mu=1.8e-4, p_upstream=feed)
            ch4 = FlowConditions(rho=422.6, mu=1.2e-4, p_upstream=feed)
            dp = max(feed - pc, 1.0)
            mdot_ox = math.sqrt(2.0 * 1140.0 * dp) * ox.effective_area(1.5, lox)
            mdot_fuel = math.sqrt(2.0 * 422.6 * dp) * fuel.effective_area(0.4, ch4)
            new = chamber.evaluate(mdot_ox, mdot_fuel).pressure
            if abs(new - pc) < 1.0:
                pc = new
                break
            pc += 0.3 * (new - pc)
        return pc, feed - pc

    low_pc, low_dp = fire(4.0e6)
    high_pc, high_dp = fire(5.0e6)

    assert high_pc > low_pc
    # The chamber absorbed part of the 1 MPa: it did not move the full amount.
    assert (high_pc - low_pc) < 1.0e6
    # And the rest went into injector stiffness.
    assert high_dp > low_dp


# ------------------------------------------------- a full coupled hot fire


def hot_fire_system(duration: float = 2.0):
    """Two tanks, two lines, two main valves, and an imported Layer-1 engine."""
    from feedtwin.comps import build_component
    from feedtwin.engine import EngineCoupling
    from feedtwin.model import ComponentInstance, Param, Provenance
    from feedtwin.model.units import get_unit
    from feedtwin.props import Fluid
    from feedtwin.solve.network import Network
    from feedtwin.transient import (
        Command,
        Coupling,
        Scenario,
        TankOwner,
        TransientSystem,
    )
    from feedtwin.vessels import ConductionCollapse, CylindricalTank, Tank

    psi = get_unit("psi").factor
    M, E, ME = Provenance.MANUFACTURER, Provenance.ESTIMATED, Provenance.MEASURED

    design = load_engine(REAL_CONFIG)
    chamber = Chamber(
        design.throat_area,
        CEATable(REAL_CACHE, expansion_ratio=design.expansion_ratio),
        volume=design.chamber_volume,
    )
    ox_leg, fuel_leg = injector_legs(design)

    def comp(cid: str, ctype: str, params: dict[str, object]):
        return build_component(ComponentInstance.build(cid, ctype, params))  # type: ignore[arg-type]

    net = Network()
    net.add_node("OXTANK", "oxygen", 90.0, pressure=650 * psi)
    net.add_node("FUTANK", "methane", 112.0, pressure=650 * psi)
    net.add_node("OXMID", "oxygen", 90.0)
    net.add_node("FUMID", "methane", 112.0)
    net.add_node("OXFACE", "oxygen", 90.0)
    net.add_node("FUFACE", "methane", 112.0)
    net.add_node("CHAMBER", "oxygen", 90.0, pressure=400 * psi)

    def line(cid: str, length: float, bore: float, k: float):
        return comp(
            cid,
            "pipe",
            {
                "length": Param(length, "m", ME, "routing"),
                "bore": Param(bore, "mm", M, "tube"),
                "roughness": Param(0.0015, "mm", M, "drawn"),
                "K_minor": Param(k, "-", E, "fitting tally"),
            },
        )

    def valve(cid: str, cv: float, bore: float):
        return comp(
            cid,
            "valve",
            {
                "Cv": Param(cv, "Cv", M, "ball"),
                "bore": Param(bore, "mm", M, "x"),
                "leak_closed": Param(0.001, "Cv", E, "seat"),
            },
        )

    net.add_branch("MV_OX", valve("MV-OX", 6.0, 12.7), "OXTANK", "OXMID")
    net.add_branch("MV_FU", valve("MV-FU", 4.0, 9.5), "FUTANK", "FUMID")
    net.add_branch("LINE_OX", line("FL-OX", 2.0, 12.7, 8.0), "OXMID", "OXFACE")
    net.add_branch("LINE_FU", line("FL-FU", 2.2, 9.5, 9.0), "FUMID", "FUFACE")
    net.add_branch("INJ_OX", ox_leg, "OXFACE", "CHAMBER")
    net.add_branch("INJ_FU", fuel_leg, "FUFACE", "CHAMBER")

    lox = Tank(
        Fluid("oxygen"),
        Fluid("nitrogen"),
        CylindricalTank(diameter=0.190, barrel_length=0.90),
        collapse=ConductionCollapse(),
    )
    ch4 = Tank(
        Fluid("methane"),
        Fluid("nitrogen"),
        CylindricalTank(diameter=0.190, barrel_length=0.60),
        collapse=ConductionCollapse(),
    )
    ox_tank = TankOwner(
        "OXTANK",
        lox,
        lox.initial_state(
            pressure=650 * psi,
            liquid_mass=20.0,
            liquid_temperature=90.0,
            gas_temperature=293.15,
        ),
    )
    fu_tank = TankOwner(
        "FUTANK",
        ch4,
        ch4.initial_state(
            pressure=650 * psi,
            liquid_mass=5.5,
            liquid_temperature=112.0,
            gas_temperature=293.15,
        ),
    )

    scenario = Scenario(
        duration=duration,
        name="hot fire",
        initial_signals={"MV-OX.command": 0.0, "MV-FU.command": 0.0},
        commands=[
            Command(0.10, "MV-OX.command", 1.0, travel_time=0.05),
            Command(0.14, "MV-FU.command", 1.0, travel_time=0.05),  # 40 ms ox lead
        ],
    )
    system = TransientSystem(
        net,
        [
            Coupling(ox_tank, "OXTANK", outflow_branches=("MV_OX",), liquid=True),
            Coupling(fu_tank, "FUTANK", outflow_branches=("MV_FU",), liquid=True),
        ],
        scenario,
        engine=EngineCoupling(chamber, "CHAMBER", "INJ_OX", "INJ_FU", relaxation=0.4),
    )
    return system, design


@needs_cea
@needs_engine_design
def test_a_layer1_engine_fires_on_a_real_feed_system() -> None:
    """The whole Phase 08 promise, end to end and in one test."""
    from feedtwin.transient import simulate

    system, design = hot_fire_system(duration=2.0)
    result = simulate(system, samples=40)
    assert result.converged

    # Ambient before ignition, and no thrust reported for a shut engine.
    assert result.engine("chamber_pressure")[0] == pytest.approx(101325.0, rel=1e-6)
    assert result.engine("thrust")[0] == 0.0

    firing = [s for s in result.samples if s.t > 0.4]
    assert firing, "nothing after the valves opened"
    for sample in firing:
        engine = sample.engine
        assert engine["chamber_pressure"] > 5.0e5
        assert engine["mdot_oxidiser"] > 0.0 and engine["mdot_fuel"] > 0.0
        assert 2500.0 < engine["chamber_temperature"] < 4000.0
        assert 1500.0 < engine["cstar"] < 2000.0
        assert engine["thrust"] > 0.0
        assert engine["loop_converged"] == 1.0


@needs_cea
@needs_engine_design
def test_mixture_ratio_drifts_over_a_burn() -> None:
    """The output that is invisible in a steady sizing calculation.

    The two propellant legs have different resistances, so they do not fall off
    together as the tanks drain -- and O/F walks. A model with a fixed c* would
    still show the ratio moving while nothing downstream of it responded.
    """
    from feedtwin.transient import simulate

    system, _ = hot_fire_system(duration=2.0)
    result = simulate(system, samples=40)

    firing = [s for s in result.samples if s.t > 0.4]
    ratios = [s.engine["mixture_ratio"] for s in firing]
    temperatures = [s.engine["chamber_temperature"] for s in firing]

    assert abs(ratios[-1] - ratios[0]) > 0.05, "O/F did not move at all"
    # And chamber temperature responded, which is what makes the drift matter.
    assert temperatures[0] != pytest.approx(temperatures[-1], rel=1e-4)


@needs_cea
@needs_engine_design
def test_chamber_pressure_moves_less_than_tank_pressure() -> None:
    """The feedback loop, seen in a real run.

    Chamber pressure rising eats into the injector's own pressure difference, so
    a fractional fall in tank pressure produces a smaller fractional fall in
    chamber pressure. If they moved together there would be no loop.
    """
    from feedtwin.transient import simulate

    system, _ = hot_fire_system(duration=2.0)
    result = simulate(system, samples=40)

    firing = [s for s in result.samples if s.t > 0.4]
    tank_drop = (
        firing[0].pressures["OXTANK"] - firing[-1].pressures["OXTANK"]
    ) / firing[0].pressures["OXTANK"]
    chamber_drop = (
        firing[0].engine["chamber_pressure"] - firing[-1].engine["chamber_pressure"]
    ) / firing[0].engine["chamber_pressure"]
    assert tank_drop > 0.0
    assert chamber_drop < tank_drop


@needs_cea
@needs_engine_design
def test_the_ox_lead_shows_up_in_the_trace() -> None:
    """A 40 ms lead is a real commanded sequence, and the model should see it."""
    from feedtwin.transient import simulate

    system, _ = hot_fire_system(duration=0.5)
    result = simulate(system, samples=120)

    # The window is between the ox command (0.10) and the fuel command (0.14),
    # not after both have travelled -- by 0.16 the fuel valve is 40% open and
    # flowing, which is the sequence working, not the lead.
    early = [s for s in result.samples if 0.12 <= s.t <= 0.14]
    assert early, "no samples during the lead window"
    # Oxidiser is already moving while fuel is still essentially shut.
    assert max(s.engine["mdot_oxidiser"] for s in early) > 10.0 * max(
        s.engine["mdot_fuel"] for s in early
    )


# ------------------------------------------------- the vehicle's own engine


ETHALOX = ENGINE_DESIGN / "configs" / "ethalox_doublet_7000N.yaml"
ETHALOX_CACHE = ENGINE_DESIGN / "output" / "cache" / "cea_cache_LOX_Ethanol_3D.npz"

needs_ethalox = pytest.mark.skipif(
    not ETHALOX.exists() or not ETHALOX_CACHE.exists(),
    reason="the ethalox config or its CEA cache is not present",
)


@needs_ethalox
def test_the_current_vehicle_engine_imports() -> None:
    """LOX/ethanol, impinging doublet. The engine actually being built."""
    design = load_engine(ETHALOX)
    assert design.injector_type == "impinging"
    assert design.oxidiser.propellant == "oxygen"
    assert design.fuel.propellant == "ethanol"
    assert design.oxidiser.element_count == 26
    assert design.fuel.element_count == 26
    # 7200, not the 7000 in `chamber_geometry.design_thrust`. That key holds the
    # last optimiser run's achievement; `design_requirements.target_thrust` holds
    # what was asked for, and intent wins here exactly as it already did for O/F
    # and chamber pressure. This assertion used to encode the gap.
    assert design.design_thrust == 7200.0


@needs_ethalox
def test_ethalox_cstar_peaks_where_the_optimiser_put_the_mixture_ratio() -> None:
    """A cross-check between the two tools, not a restatement of one of them.

    The config asks for ``optimal_of_ratio: 1.65``. Reading c* straight off the
    CEA table the optimiser used, the peak should land there — and if it does
    not, one of the two is looking at the wrong propellant pair.
    """
    design = load_engine(ETHALOX)
    table = CEATable(ETHALOX_CACHE, expansion_ratio=design.expansion_ratio)
    assert table.propellants == ("LOX", "Ethanol")

    ratios = [1.2, 1.4, 1.65, 1.9, 2.2]
    cstars = [table.combustion(2.9e6, mr).cstar for mr in ratios]
    peak = ratios[cstars.index(max(cstars))]
    assert peak == pytest.approx(1.65, abs=0.3)


@needs_ethalox
def test_ethalox_injector_stiffness_is_in_the_design_band() -> None:
    """The config asks for 20–30% injector stiffness on both legs."""
    design = load_engine(ETHALOX)
    ox, fuel = injector_legs(design)
    lox = FlowConditions(rho=1140.0, mu=1.8e-4, p_upstream=4.0e6)
    ethanol = FlowConditions(rho=789.0, mu=1.2e-3, p_upstream=4.0e6)

    # At the design point: 7000 N, Pc 420 psi, O/F 1.65.
    pc = 420.0 * 6894.757293168361
    table = CEATable(ETHALOX_CACHE, expansion_ratio=design.expansion_ratio)
    cstar = table.combustion(pc, 1.65).cstar
    mdot_total = pc * design.throat_area / cstar
    mdot_ox = mdot_total * 1.65 / 2.65
    mdot_fuel = mdot_total / 2.65

    for leg, mdot, conditions in ((ox, mdot_ox, lox), (fuel, mdot_fuel, ethanol)):
        stiffness = leg.pressure_drop(mdot, conditions) / pc
        assert 0.10 < stiffness < 0.60, f"{leg.id} stiffness {stiffness:.3f}"


@needs_ethalox
def test_a_config_that_disagrees_with_itself_resolves_to_intent_and_records_it() -> (
    None
):
    """The ethalox config carries its design point twice, and they disagree.

    ``chamber_geometry`` is what the geometry was last sized at:
    ``design_MR`` 2.55, a leftover from when this config was LOX/methane, and
    ``design_pressure`` 350 psi. ``design_requirements`` is what the optimiser
    was told to hit: ``optimal_of_ratio`` 1.65, where the LOX/ethanol c*
    actually peaks, and ``target_chamber_pressure_psi`` 420.

    **Intent wins**, for both. The geometry block goes stale every time a
    config is re-run or switches propellant pair, so a disagreement is the
    normal state of a config being worked on -- and this used to raise a
    warning on it, which is how a healthy config came to shout at its operator
    twice on every import.

    Not silently, though. Which field was used, and what the other one said, is
    recorded in provenance, so the choice is auditable without being noise.
    """
    design = load_engine(ETHALOX)

    assert design.design_mixture_ratio == pytest.approx(1.65)
    assert design.design_chamber_pressure / 6894.757293168361 == pytest.approx(
        420.0, abs=0.5
    )
    assert not design.warnings, "a config disagreeing with itself is not a warning"

    for key, stale in (
        ("mixture_ratio", "2.55"),
        ("design_chamber_pressure", "350"),
    ):
        note = design.provenance[key]
        assert "intent wins" in note, f"{key} does not say which field won"
        assert stale in note, f"{key} does not record what the stale field said"


@needs_engine_design
def test_a_consistent_config_warns_about_nothing() -> None:
    """A warning that fires on healthy input is noise, and noise gets ignored."""
    assert load_engine(REAL_CONFIG).warnings == ()


@needs_ethalox
def test_the_geometry_cd_model_is_honoured_when_the_config_asks_for_it() -> None:
    """`use_geometry_cd` is on in this config, so hole size moves Cd_inf."""
    design = load_engine(ETHALOX)
    model = design.oxidiser.discharge
    assert model.use_geometry_cd

    # 2 mm is the reference: no adjustment there.
    assert model.cd_infinite(2.0e-3) == pytest.approx(model.cd_inf, rel=1e-9)
    # Smaller holes lose a little, larger ones gain a little, both clamped.
    assert model.cd_infinite(1.0e-3) < model.cd_inf < model.cd_infinite(4.0e-3)
    assert model.cd_infinite(1.0e-6) >= model.cd_inf_min_geom
    assert model.cd_infinite(1.0) <= model.cd_inf_max


def _config_with(tmp_path, **overrides):
    """The shipped ethalox config with a couple of keys changed.

    Built from the real file rather than a hand-rolled dict: the importer
    legitimately requires a full injector geometry, and a synthetic fixture
    would be testing the fixture.
    """
    import yaml
    from feedtwin.engine.importer import load_engine

    raw = yaml.safe_load(ETHALOX.read_text())
    for dotted, value in overrides.items():
        section, key = dotted.split(".")
        if value is None:
            raw.get(section, {}).pop(key, None)
        else:
            raw.setdefault(section, {})[key] = value
    path = tmp_path / "e.yaml"
    path.write_text(yaml.safe_dump(raw))
    return load_engine(path)


@needs_ethalox
def test_thrust_resolves_like_mixture_ratio_and_chamber_pressure(tmp_path) -> None:
    """Intent wins for all three, or the rule is not a rule.

    `chamber_geometry.design_thrust` is the last optimiser run's achievement;
    `design_requirements.target_thrust` is what was asked for. The importer
    already preferred intent for O/F and Pc and read thrust bare, so the shipped
    ethalox config imported as 7000 N against a delivered 7200 N -- silently.
    """
    engine = _config_with(tmp_path)
    assert engine.design_thrust == pytest.approx(7200.0)
    assert "target_thrust" in engine.provenance["design_thrust"]
    assert "7000" in engine.provenance["design_thrust"], "name the value it overrode"


@needs_ethalox
def test_thrust_falls_back_when_no_target_is_stated(tmp_path) -> None:
    engine = _config_with(tmp_path, **{"design_requirements.target_thrust": None})
    assert engine.design_thrust == pytest.approx(7000.0)
    assert "chamber_geometry.design_thrust" in engine.provenance["design_thrust"]


@needs_ethalox
def test_agreeing_thrust_values_are_not_flagged(tmp_path) -> None:
    """A warning that fires on healthy input teaches people to skim past it."""
    engine = _config_with(tmp_path, **{"chamber_geometry.design_thrust": 7200.0})
    assert "that is the last optimiser run" not in engine.provenance["design_thrust"]

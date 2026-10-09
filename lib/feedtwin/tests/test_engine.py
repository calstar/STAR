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

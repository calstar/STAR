"""Phase 11: reading a drawing and building a network from it.

The two graphs are not the same shape, and every test here is about a place
where a naive relabelling would go wrong: an inline symbol that has to become a
branch, a tank that is one symbol and two pressures, a transducer that is a
label rather than plumbing, and a control regulator that sets a setpoint rather
than carrying flow.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from feedtwin.pid import (
    Diagram,
    DiagramError,
    build_network,
    load_diagram,
    read_diagram,
)
from feedtwin.solve.steady import solve_steady

PSI = 6894.757293168361

#: A realistic firing state for the shipped stand: mains and press open, every
#: vent shut. Naming the whole valve state matters now that the drawing carries
#: vents -- leaving them unstated defaults them open, which is a stand venting
#: its tanks to atmosphere while it fires, and no useful thing can be asserted
#: about that operating point.
FIRING = {
    "MV-OX.command": 1.0,
    "MV-FU.command": 1.0,
    "SV-LOX-PRESS.command": 1.0,
    "SV-FUEL-PRESS.command": 1.0,
    "SV-LOX-VENT.command": 0.0,
    "SV-FUEL-VENT.command": 0.0,
    "SV-GN2-VENT.command": 0.0,
    "SV-LOX-FILL.command": 0.0,
}
STAND = (
    Path(__file__).resolve().parents[3]
    / "feed-twin"
    / "backend"
    / "diagrams"
    / "ethalox_stand.json"
)
needs_stand = pytest.mark.skipif(not STAND.exists(), reason="stand drawing absent")


def P(value: float, unit: str, source: str = "manufacturer") -> dict[str, object]:
    return {"value": value, "unit": unit, "source": source, "reference": ""}


def node(nid: str, ctype: str, label: str, **data: object) -> dict[str, object]:
    return {
        "id": nid,
        "position": {"x": 0, "y": 0},
        "data": {"componentType": ctype, "label": label, **data},
    }


def edge(eid: str, a: str, b: str, **params: object) -> dict[str, object]:
    return {
        "id": eid,
        "source": a,
        "target": b,
        "data": {"lineType": "pipe", "params": params or LINE},
    }


LINE = {
    "length": P(1.0, "m"),
    "bore": P(9.5, "mm"),
    "roughness": P(0.0015, "mm"),
}


def minimal() -> dict[str, object]:
    """Bottle, valve, tank. The smallest thing that is a feed system."""
    return {
        "nodes": [
            node(
                "KB",
                "KBOTTLE",
                "KB-N2",
                fluid="nitrogen",
                params={"pressure": P(4500, "psi"), "temperature": P(293.15, "K")},
            ),
            node(
                "V1",
                "MAN",
                "MAN-01",
                params={"Cv": P(6.0, "Cv"), "bore": P(12.7, "mm")},
            ),
            node(
                "T1",
                "TANK",
                "OX-TANK",
                fluid="oxygen",
                params={
                    "pressure": P(500, "psi"),
                    "temperature": P(90.0, "K"),
                    "volume": P(17.5, "L"),
                },
            ),
            node("PT1", "PT", "PT-OX-UP", attachedTo="T1"),
        ],
        "edges": [edge("e1", "KB", "V1"), edge("e2", "V1", "T1")],
    }


# ------------------------------------------------------------ reading


def test_a_drawing_reads_into_typed_records() -> None:
    drawing = read_diagram(minimal(), name="minimal")
    assert len(drawing.nodes) == 4
    assert len(drawing.edges) == 2
    bottle = drawing.node("KB")
    assert bottle is not None and bottle.is_source
    assert bottle.params["pressure"].si == pytest.approx(4500 * PSI)


def test_a_parameter_with_no_provenance_is_refused() -> None:
    """The drawing always asks for a source, so a missing one is a format
    mismatch -- and calling it a default would turn that into a number nobody
    checked."""
    payload = minimal()
    payload["nodes"][0]["data"]["params"]["pressure"].pop("source")  # type: ignore[index]
    with pytest.raises(DiagramError, match="source"):
        read_diagram(payload, name="minimal")


def test_a_line_to_nowhere_is_refused() -> None:
    payload = minimal()
    payload["edges"].append(edge("ghost", "KB", "MISSING"))  # type: ignore[attr-defined]
    with pytest.raises(DiagramError, match="not on the drawing"):
        read_diagram(payload, name="minimal")


def test_a_drawing_with_no_source_is_refused() -> None:
    """A drawing missing its tank solves as an empty system and reports zero
    flow, which looks like an answer."""
    payload = minimal()
    payload["nodes"] = [n for n in payload["nodes"] if n["id"] != "KB"]  # type: ignore[index]
    payload["edges"] = [e for e in payload["edges"] if e["source"] != "KB"]  # type: ignore[index]
    drawing = read_diagram(payload, name="minimal")
    # The tank is still a source, so this one builds; strip it too and it must not.
    payload["nodes"] = [
        n for n in payload["nodes"] if n["data"]["componentType"] != "TANK"  # type: ignore[index]
    ]
    payload["edges"] = []
    with pytest.raises(DiagramError, match="declares a pressure"):
        build_network(read_diagram(payload, name="minimal"))
    assert drawing.nodes


# ------------------------------------------------- the topology rewrite


def test_an_inline_symbol_becomes_a_branch_with_a_node_either_side() -> None:
    """The case that matters. A drawing with six valves that solves as a
    drawing with none converges beautifully and means nothing."""
    built = build_network(read_diagram(minimal(), name="minimal"))
    assert "V1" in built.network.branches
    assert "V1.in" in built.network.nodes
    assert "V1.out" in built.network.nodes
    # And the lines that met at it attach to those, not to the symbol.
    assert built.network.branches["e1"].downstream == "V1.in"
    assert built.network.branches["e2"].upstream == "V1.out"


def test_a_tank_is_one_symbol_and_two_pressures() -> None:
    """Pressurant arrives at the top and propellant leaves the bottom."""
    built = build_network(read_diagram(minimal(), name="minimal"))
    ports = built.tanks["T1"]
    assert ports.ullage in built.network.nodes
    assert ports.outlet in built.network.nodes
    ullage = built.network.nodes[ports.ullage].pressure
    outlet = built.network.nodes[ports.outlet].pressure
    assert ullage is not None and outlet is not None
    # The outlet sits below the ullage by the liquid column: LOX is heavy, so
    # this is a real number, not a rounding artefact.
    assert outlet > ullage
    assert (outlet - ullage) / PSI == pytest.approx(1.5, abs=1.5)


def test_pressurant_lands_on_the_ullage_not_the_liquid_side() -> None:
    built = build_network(read_diagram(minimal(), name="minimal"))
    assert built.network.branches["e2"].downstream == built.tanks["T1"].ullage


def test_a_transducer_is_a_label_not_plumbing() -> None:
    """Making one a node puts a fictitious branch in every mass balance."""
    built = build_network(read_diagram(minimal(), name="minimal"))
    assert "PT1" not in built.network.nodes
    assert [i.tag for i in built.instruments] == ["PT-OX-UP"]
    assert built.instruments[0].node == built.tanks["T1"].ullage


def test_commandable_valves_are_found() -> None:
    payload = minimal()
    payload["nodes"][1]["data"]["componentType"] = "ROT"  # type: ignore[index]
    built = build_network(read_diagram(payload, name="minimal"))
    assert built.actuators == {"V1": "MAN-01.command"}


def test_a_manual_valve_is_not_an_actuator() -> None:
    """A hand valve is not something a scenario can command."""
    built = build_network(read_diagram(minimal(), name="minimal"))
    assert built.actuators == {}


# --------------------------------------------------- the real drawing


@needs_stand
def test_the_stand_drawing_builds_and_solves() -> None:
    built = build_network(load_diagram(STAND))
    assert len(built.network.nodes) > 15
    result = solve_steady(
        built.network,
        signals=FIRING,
        tol=1e-5,
        raise_on_failure=False,
    )
    assert result.converged
    assert result.max_mass_residual < 1e-9

    readings = {i.tag: result.pressures[i.node] / PSI for i in built.instruments}
    assert readings["PT-GN2-HI"] == pytest.approx(4500.0, abs=1.0)
    # The dome regulator holds its dome plus the 1092-50's 50 psi bias.
    assert readings["PT-GN2-REG"] == pytest.approx(500.0, abs=5.0)
    # And the feed lines cost something on the way to the injector.
    assert readings["PT-OX-DN"] < readings["PT-OX-UP"] - 10.0


@needs_stand
def test_the_control_regulator_sets_a_setpoint_rather_than_carrying_flow() -> None:
    """A dome line carries almost nothing; what it carries is a number."""
    built = build_network(load_diagram(STAND))
    assert "PR_C" not in built.network.branches
    assert any("loads the dome" in w for w in built.warnings)
    assert any(s.endswith(".dome") for s in built.actuators.values())


@needs_stand
def test_valve_position_moves_the_flow() -> None:
    built = build_network(load_diagram(STAND))
    flows = []
    for command in (0.0, 0.25, 1.0):
        result = solve_steady(
            built.network,
            signals={**FIRING, "MV-OX.command": command, "MV-FU.command": command},
            tol=1e-5,
            raise_on_failure=False,
        )
        assert result.converged
        flows.append(result.flows["l_ox2"])
    assert flows[0] < flows[1] < flows[2]


@needs_stand
def test_every_unstated_number_is_marked_as_such() -> None:
    """A drawing that omits a bore should produce an answer with a visible hole
    in it, not a confident one."""
    from feedtwin.model.param import assumed_params

    built = build_network(load_diagram(STAND))
    assumed = {
        (b.component.instance.id, name)
        for b in built.network.branches.values()
        for name in assumed_params(b.component.instance.params)
    }
    assert assumed, "the drawing does not state everything, and should say so"
    assert all(isinstance(a, tuple) for a in assumed)


@needs_stand
def test_temperature_travels_with_the_fluid() -> None:
    """The bug this test exists for was worth 25x in density.

    A feed line downstream of a LOX tank carries oxygen at 90 K. Inherit the
    species and leave the temperature at an ambient default and the line solves
    as *gaseous* oxygen at 46 kg/m^3 instead of liquid at 1140 -- so the flow
    comes out confidently wrong rather than obviously so, and the oxidiser leg
    of a bigger line reads as flowing less than the fuel leg of a smaller one.
    """
    built = build_network(load_diagram(STAND))
    # Every node on the ox leg, tank outlet to injector face. The check valve
    # that used to sit in the middle is not on the real stand and is gone; what
    # matters is that the species and the 90 K reach the *last* one, since that
    # is where an ambient default would do its damage.
    for node_id in ("OXT.out", "MVO.in", "MVO.out", "ENG"):
        node = built.network.nodes[node_id]
        assert node.fluid == "oxygen"
        assert node.temperature == pytest.approx(90.0, abs=1.0)

    result = solve_steady(
        built.network,
        signals=FIRING,
        tol=1e-5,
        raise_on_failure=False,
    )
    assert result.converged
    # The oxidiser must carry more -- but note *why*, because the old reason
    # went stale: both legs are now the same 1/2 in. tube, so it is not the
    # line. It is that the engine runs at O/F 1.65 and LOX is the denser fluid.
    assert abs(result.flows["l_ox2"]) > 1.5 * abs(result.flows["l_fu2"])


# ------------------------------------------- what the drawing did not say


def test_a_tank_with_no_fluid_says_so() -> None:
    """Downstream of a tank is a whole propellant leg. Defaulting it silently
    reprices every line on that side, and nothing in the answer looks wrong."""
    raw = minimal()
    tank = next(n for n in raw["nodes"] if n["id"] == "T1")  # type: ignore[index,union-attr]
    del tank["data"]["fluid"]  # type: ignore[index]
    built = build_network(read_diagram(raw))
    assert any(
        "does not say what it holds" in w and "OX-TANK" in w for w in built.warnings
    )


def test_a_role_without_a_fluid_is_named_as_a_role() -> None:
    """pid-designer colours a symbol by role -- fuel, lox, pressurant. That is
    not a species, and the difference is worth spelling out rather than letting
    somebody wonder why the colour they set had no effect."""
    raw = minimal()
    tank = next(n for n in raw["nodes"] if n["id"] == "T1")  # type: ignore[index,union-attr]
    del tank["data"]["fluid"]  # type: ignore[index]
    tank["data"]["fluidType"] = "lox"  # type: ignore[index]
    built = build_network(read_diagram(raw))
    note = next(w for w in built.warnings if "does not say what it holds" in w)
    assert "'lox'" in note and "role rather than a fluid" in note


def test_a_liquid_tank_solved_as_a_gas_is_reported() -> None:
    """The expensive one. A tank named for a cryogen, holding its species, at
    the ambient default: oxygen is then ~40 kg/m^3 where LOX is 1140, so every
    density and flow on that leg is out by thirty and the solve still
    converges on plausible-looking numbers."""
    raw = minimal()
    tank = next(n for n in raw["nodes"] if n["id"] == "T1")  # type: ignore[index,union-attr]
    del tank["data"]["params"]["temperature"]  # type: ignore[index]
    built = build_network(read_diagram(raw))
    note = next(w for w in built.warnings if "is a gas, not a liquid" in w)
    assert "OX-TANK" in note
    # The saturation temperature at tank pressure is the number the drawing is
    # missing, so it has to be in the message rather than left to be looked up.
    assert "condenses at about 14" in note


def test_a_tank_that_states_its_temperature_is_left_alone() -> None:
    """LOX at 90 K is exactly right, and a warning here would train people to
    ignore the one above."""
    built = build_network(read_diagram(minimal()))
    assert not any("is a gas, not a liquid" in w for w in built.warnings)
    assert not any("does not say what it holds" in w for w in built.warnings)


def test_a_warm_pressurant_bottle_is_not_warned_about() -> None:
    """Nitrogen at ambient is a gas because it is supposed to be. The check is
    for tanks, and a K-bottle is not one."""
    built = build_network(read_diagram(minimal()))
    assert not any("KB-N2" in w and "gas, not a liquid" in w for w in built.warnings)


# ------------------------------------------------ attaching a real engine


def _engine(oxidiser: str = "oxygen", fuel: str = "ethanol") -> object:
    from feedtwin.engine.design import DischargeModel, EngineDesign, InjectorSide

    return EngineDesign(
        name="fixture",
        injector_type="impinging",
        oxidiser=InjectorSide(oxidiser, 99e-6, 2.2e-3, DischargeModel(), 26),
        fuel=InjectorSide(fuel, 75e-6, 1.9e-3, DischargeModel(), 26),
        throat_area=1.7e-3,
        design_mixture_ratio=1.65,
    )


def _two_leg_stand() -> dict[str, object]:
    """Two tanks into one engine -- the smallest thing an engine can sit on."""
    return {
        "nodes": [
            node(
                "OXT",
                "TANK",
                "OX-TANK",
                fluid="oxygen",
                params={
                    "pressure": P(500, "psi"),
                    "temperature": P(90.0, "K"),
                    "volume": P(17.5, "L"),
                },
            ),
            node(
                "FUT",
                "TANK",
                "FU-TANK",
                fluid="ethanol",
                params={
                    "pressure": P(500, "psi"),
                    "temperature": P(293.15, "K"),
                    "volume": P(17.5, "L"),
                },
            ),
            node("ENG", "ENGINE", "ENG-01", params={"pressure": P(350, "psi")}),
        ],
        "edges": [edge("l1", "OXT", "ENG"), edge("l2", "FUT", "ENG")],
    }


def test_both_injector_legs_are_attached_by_fluid() -> None:
    built = build_network(read_diagram(_two_leg_stand()), engine=_engine())
    assert built.engine_ports["oxidiser"] == "ENG.oxidiser.injector"
    assert built.engine_ports["fuel"] == "ENG.fuel.injector"
    assert not any("no injector leg" in w for w in built.warnings)


def test_a_line_matching_neither_propellant_is_reported() -> None:
    """It used to be skipped in silence, which left the engine with one leg and
    a mixture ratio taken against a zero -- and every number after it looked
    perfectly ordinary."""
    raw = _two_leg_stand()
    fuel_tank = next(n for n in raw["nodes"] if n["id"] == "FUT")  # type: ignore[index,union-attr]
    fuel_tank["data"]["fluid"] = "methanol"  # type: ignore[index]
    built = build_network(read_diagram(raw), engine=_engine())

    assert "fuel" not in built.engine_ports
    assert any(
        "neither oxygen nor ethanol" in w and "FU-TANK" in w for w in built.warnings
    )
    assert any("no fuel leg" in w for w in built.warnings)


def test_an_engine_with_no_symbol_to_land_on_says_so() -> None:
    """Attaching a config to a drawing that has no engine leaves the run
    uncoupled. Reported, because 'coupled' is a claim about the physics."""
    built = build_network(read_diagram(minimal()), engine=_engine())
    assert built.engine_ports == {}
    assert any("no engine symbol" in w for w in built.warnings)


def _valve_with_one_side_open() -> dict:
    """The drawing pid-designer tells you to make for a vent.

    Its `components/pid/vents.ts` says so outright: "A valve open on one side is
    a vent to atmosphere. Not a symbol you place." It draws the arrow and passes
    its own checks on that basis -- but the inference feeds the arrow and the
    checks panel, not the export, so this arrived here as a valve with a dead end
    behind it and the network would not solve.
    """

    def p(value, unit, source):
        return {"value": value, "unit": unit, "source": source}

    return {
        "nodes": [
            {
                "id": "TK",
                "type": "TANK",
                "position": {"x": 0, "y": 0},
                "data": {
                    "componentType": "TANK",
                    "label": "TK-FU",
                    "fluid": "ethanol",
                    "params": {
                        "volume": p(8.67, "L", "measured"),
                        "pressure": p(550, "psi", "estimated"),
                        "temperature": p(293.15, "K", "measured"),
                    },
                },
            },
            {
                "id": "KB",
                "type": "KBOTTLE",
                "position": {"x": 0, "y": 300},
                "data": {
                    "componentType": "KBOTTLE",
                    "label": "KB-HE",
                    "fluid": "helium",
                    "params": {
                        "pressure": p(4500, "psi", "manufacturer"),
                        "temperature": p(293.15, "K", "measured"),
                        "volume": p(4.687, "L", "measured"),
                    },
                },
            },
            {
                "id": "SVP",
                "type": "SOL",
                "position": {"x": 200, "y": 300},
                "data": {
                    "componentType": "SOL",
                    "label": "SV-PRESS",
                    "fluid": "helium",
                    "params": {
                        "Cv": p(1.7, "Cv", "measured"),
                        "bore": p(6.35, "mm", "manufacturer"),
                    },
                },
            },
            {
                "id": "SV",
                "type": "SOL",
                "position": {"x": 200, "y": 0},
                "data": {
                    "componentType": "SOL",
                    "label": "SV-VENT",
                    "fluid": "ethanol",
                    "params": {
                        "Cv": p(3.8, "Cv", "estimated"),
                        "bore": p(9.53, "mm", "manufacturer"),
                    },
                },
            },
        ],
        "edges": [
            {
                "id": "l_p1",
                "source": "KB",
                "target": "SVP",
                "type": "smoothstep",
                "data": {
                    "lineType": "pipe",
                    "params": {
                        "length": p(0.5, "m", "estimated"),
                        "bore": p(6.35, "mm", "manufacturer"),
                        "roughness": p(0.0015, "mm", "manufacturer"),
                        "K_minor": p(0.5, "-", "estimated"),
                    },
                },
            },
            {
                "id": "l_p2",
                "source": "SVP",
                "target": "TK",
                "type": "smoothstep",
                "data": {
                    "lineType": "pipe",
                    "params": {
                        "length": p(0.5, "m", "estimated"),
                        "bore": p(6.35, "mm", "manufacturer"),
                        "roughness": p(0.0015, "mm", "manufacturer"),
                        "K_minor": p(0.0, "-", "estimated"),
                    },
                },
            },
            {
                "id": "l_v",
                "source": "TK",
                "target": "SV",
                "type": "smoothstep",
                "data": {
                    "lineType": "pipe",
                    "params": {
                        "length": p(0.4, "m", "estimated"),
                        "bore": p(9.53, "mm", "manufacturer"),
                        "roughness": p(0.0015, "mm", "manufacturer"),
                        "K_minor": p(0.5, "-", "estimated"),
                    },
                },
            },
        ],
    }


def test_a_valve_with_one_side_open_vents_to_atmosphere() -> None:
    built = build_network(read_diagram(_valve_with_one_side_open()))
    free = built.network.nodes["SV.out"]
    assert free.pressure is not None, "the open side must become a boundary"
    assert free.pressure == pytest.approx(101325.0)
    built.network.validate()


def test_the_inferred_vent_is_reported() -> None:
    """Inferring a boundary is a real modelling decision, so it is said aloud."""
    built = build_network(read_diagram(_valve_with_one_side_open()))
    assert any("venting to atmosphere" in w and "SV-VENT" in w for w in built.warnings)


def test_a_valve_plumbed_both_ends_is_not_a_vent() -> None:
    doc = _valve_with_one_side_open()
    # SV-PRESS has a line on each side; it must not acquire an ambient boundary.
    built = build_network(read_diagram(doc))
    assert built.network.nodes["SVP.in"].pressure is None
    assert built.network.nodes["SVP.out"].pressure is None
    assert not any("SV-PRESS" in w for w in built.warnings)


def test_a_spare_manifold_port_is_a_plug_not_a_vent() -> None:
    """The rule is valves only, for pid-designer's stated reason: a blanked tee
    branch or spare manifold port is a plug, and plugs are not drawn."""
    doc = _valve_with_one_side_open()
    doc["nodes"].append(
        {
            "id": "MF",
            "type": "MANIFOLD",
            "position": {"x": 400, "y": 300},
            "data": {
                "componentType": "MANIFOLD",
                "label": "MF-1",
                "fluid": "helium",
                "params": {
                    "Cv": {"value": 8.0, "unit": "Cv", "source": "estimated"},
                    "bore": {"value": 10.92, "unit": "mm", "source": "manufacturer"},
                },
            },
        }
    )
    doc["edges"].append(
        {
            "id": "l_mf",
            "source": "SVP",
            "target": "MF",
            "type": "smoothstep",
            "data": {
                "lineType": "pipe",
                "params": {
                    "length": {"value": 0.3, "unit": "m", "source": "estimated"},
                    "bore": {"value": 10.92, "unit": "mm", "source": "manufacturer"},
                    "roughness": {
                        "value": 0.0015,
                        "unit": "mm",
                        "source": "manufacturer",
                    },
                    "K_minor": {"value": 0.0, "unit": "-", "source": "estimated"},
                },
            },
        }
    )
    built = build_network(read_diagram(doc))
    assert not any("MF-1" in w for w in built.warnings)


def test_a_transducer_can_tap_the_downstream_side_of_a_valve() -> None:
    """A main valve's downstream PT is the pressure that sets injector delta-p.

    Instruments resolve to a symbol's *upstream* node by default, which is right
    for most taps and cannot express this one. Without `side: downstream` the
    only clip that resolved past a main valve was the ENGINE symbol -- a fixed
    boundary at the chamber -- so the gauge sat at design chamber pressure
    forever, including on a cold stand with every valve shut.
    """
    diagram = read_diagram(json.loads(STAND.read_text()))
    built = build_network(diagram)
    downstream = {i.tag: i.node for i in built.instruments if "-DN" in i.tag}
    assert downstream, "the shipped stand should carry downstream transducers"
    for tag, node in downstream.items():
        assert node.endswith(".out"), f"{tag} reads {node}, not a downstream node"
        assert node not in ("ENG", "ENGINE"), f"{tag} is reading the chamber boundary"


def test_upstream_is_still_the_default() -> None:
    """The option must not change where an unmarked instrument reads.

    Every instrument, not just the transducers. This stripped `PT` alone and
    then asserted over the whole list, so the first thermocouple to ask for a
    downstream node failed a test about transducers.
    """
    doc = json.loads(STAND.read_text())
    for node in doc.get("nodes", []):
        data = node.get("data", {})
        if data.get("componentType") in ("PT", "TC", "RTD", "FM"):
            data.pop("options", None)
    built = build_network(read_diagram(doc))
    for instrument in built.instruments:
        assert not instrument.node.endswith(
            ".out"
        ), f"{instrument.tag} moved downstream without being asked"


def test_thermocouples_and_rtds_are_instruments_like_any_other() -> None:
    """A TC clips to a node and reads it, the same way a transducer does."""
    built = build_network(read_diagram(json.loads(STAND.read_text())))
    thermal = [i for i in built.instruments if i.type in ("TC", "RTD")]
    assert thermal, "the shipped stand should carry thermocouples"
    for instrument in thermal:
        assert instrument.node in built.network.nodes


# ---------------------------------------------------------------------------
# Phase is declared by topology, not guessed from temperature
# ---------------------------------------------------------------------------


def test_ullage_side_nodes_are_declared_gas_and_the_outlet_liquid() -> None:
    """The property layer's fallback -- below the critical temperature means
    liquid -- is right for LOX and wrong for a vapour line. Only the drawing
    knows which side of the tank a line is on, so the drawing says."""
    built = build_network(read_diagram(json.loads(STAND.read_text())))
    net = built.network
    for ports in built.tanks.values():
        assert net.nodes[ports.ullage].phase == "gas"
        assert net.nodes[ports.outlet].phase == "liquid"
    # Every node the pressurant reaches, and every vent, is gas.
    gas = [n for n in net.nodes.values() if n.phase == "gas"]
    liquid = [n for n in net.nodes.values() if n.phase == "liquid"]
    assert len(gas) >= 4 and len(liquid) >= 2
    for node in gas:
        assert node.fluid in {
            "nitrogen",
            "helium",
        }, f"{node.id} is gas but holds {node.fluid}"
    for node in liquid:
        assert node.fluid in {
            "oxygen",
            "ethanol",
        }, f"{node.id} is liquid but holds {node.fluid}"


def test_a_declared_gas_is_priced_as_gas_below_its_critical_temperature() -> None:
    """Ethanol vapour at 400 K and 1 bar -- well above its 351 K boiling point
    and well below its 514 K critical temperature. Undeclared it is priced as
    liquid ethanol at ~700 kg/m^3; declared gas, at (p, T) it is ~1.4."""
    from feedtwin.comps.elements import conditions_from_fluid
    from feedtwin.props import Fluid

    ethanol = Fluid("ethanol")
    guessed = conditions_from_fluid(ethanol, 1.0e5, 400.0)
    declared = conditions_from_fluid(ethanol, 1.0e5, 400.0, phase="gas")
    assert guessed.rho > 600.0, "the temperature rule prices this as liquid"
    assert declared.rho < 5.0, "the declaration must win"
    still_liquid = conditions_from_fluid(ethanol, 1.0e5, 400.0, phase="liquid")
    assert still_liquid.rho == pytest.approx(guessed.rho)


def test_static_head_comes_from_the_tanks_own_geometry() -> None:
    """rho g h with h from the drawn volume and bore at the stated fill --
    not a bare 0.75 on an assumed 152 mm bore, which is what this was."""
    from feedtwin.pid.network import STATIC_HEAD_FILL
    from feedtwin.props import Fluid
    from feedtwin.vessels.geometry import cylindrical_from_volume, level_of_volume

    built = build_network(read_diagram(minimal(), name="minimal"))
    ports = built.tanks["T1"]
    net = built.network
    head = net.nodes[ports.outlet].pressure - net.nodes[ports.ullage].pressure
    tank = next(
        n for n in read_diagram(minimal(), name="minimal").nodes if n.id == "T1"
    )
    volume = tank.params["volume"].si
    bore = tank.params["diameter"].si if "diameter" in tank.params else 0.1524
    geometry = cylindrical_from_volume(volume, bore)
    level = level_of_volume(geometry, STATIC_HEAD_FILL * geometry.total_volume)
    rho = Fluid(net.nodes[ports.outlet].fluid).get(
        "rho", T=net.nodes[ports.outlet].temperature, q=0.0
    )
    assert head == pytest.approx(rho * 9.80665 * level, rel=1e-9)
    if "diameter" not in tank.params:
        assert any("static head assumes" in w for w in built.warnings)

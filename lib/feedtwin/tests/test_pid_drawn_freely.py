"""A drawing made in pid-designer the way a person makes one.

pid-designer's lines have no direction: "walking any line in either direction.
What 'upstream' means on a drawing with no arrows" (its `checks.ts`). Which end
is a line's ``source`` is only the end the mouse started at. The shipped stand
drawings were authored in flow order, so reading ``source -> target`` as
upstream to downstream happened to work on them; a drawing made freely broke on
it. Run a press line *from* the tank *to* its solenoid and both of the
solenoid's lines arrived at its inlet, its outlet hung open, and the press
valve was read as a vent from the regulator to atmosphere.

These pin the rule that replaced it -- the port a line was drawn on decides the
side, but only where the old reading left a side with nothing on it -- and the
two messages a user importing their own drawing actually needs.
"""

from __future__ import annotations

from typing import Any

import pytest

from feedtwin.pid import build_network, read_diagram
from feedtwin.session import assemble_model
from feedtwin.session.model import AssemblyError

AMBIENT = 101325.0


def P(value: float, unit: str, source: str = "measured") -> dict[str, object]:
    return {"value": value, "unit": unit, "source": source, "reference": ""}


def node(nid: str, ctype: str, label: str, **data: object) -> dict[str, object]:
    return {
        "id": nid,
        "position": {"x": 0, "y": 0},
        "data": {"componentType": ctype, "label": label, **data},
    }


def line(
    eid: str, a: str, b: str, from_port: str = "", to_port: str = ""
) -> dict[str, object]:
    out: dict[str, Any] = {
        "id": eid,
        "source": a,
        "target": b,
        "data": {
            "lineType": "pipe",
            "params": {
                "length": P(1.0, "m"),
                "bore": P(9.5, "mm"),
                "roughness": P(0.0015, "mm"),
            },
        },
    }
    if from_port:
        out["sourceHandle"] = from_port
    if to_port:
        out["targetHandle"] = to_port
    return out


def press_leg(*lines: dict[str, object], sol: dict[str, Any] | None = None) -> Any:
    """Bottle, press solenoid, fuel tank, with the two lines as given."""
    return {
        "nodes": [
            node(
                "KB",
                "KBOTTLE",
                "KB-N2",
                fluid="nitrogen",
                params={"pressure": P(4500, "psi"), "temperature": P(293.15, "K")},
            ),
            sol
            or node(
                "SV",
                "SOL",
                "SV-PRESS",
                params={"Cv": P(1.7, "Cv"), "bore": P(6.35, "mm")},
            ),
            node(
                "TK",
                "TANK",
                "TK-FUEL",
                fluid="ethanol",
                params={
                    "pressure": P(550, "psi"),
                    "temperature": P(293.15, "K"),
                    "volume": P(8.67, "L"),
                },
            ),
        ],
        "edges": list(lines),
    }


def built(payload: Any):  # type: ignore[no-untyped-def]
    return build_network(read_diagram(payload, name="press leg"))


# ------------------------------------------------------- which side of a valve


def test_a_press_line_drawn_from_the_tank_lands_on_the_valves_other_side() -> None:
    """Both lines drawn *into* the solenoid, on its two ports. The tank's line is
    on ``r``, so it is the outlet; nothing is vented, and the pressurant reaches
    the tank's ullage."""
    b = built(
        press_leg(
            line("bottle-sv", "KB", "SV", to_port="l"),
            line("tank-sv", "TK", "SV", from_port="t", to_port="r"),
        )
    )
    net = b.network
    assert net.branches["bottle-sv"].downstream == "SV.in"
    assert net.branches["tank-sv"].downstream == "SV.out"
    assert net.nodes["SV.out"].pressure is None, "the press valve was read as a vent"
    assert net.branches["tank-sv"].upstream == b.tanks["TK"].ullage
    assert not [w for w in b.warnings if "venting" in w]


def test_the_same_holds_when_both_lines_are_drawn_out_of_the_valve() -> None:
    b = built(
        press_leg(
            line("sv-bottle", "SV", "KB", from_port="l"),
            line("sv-tank", "SV", "TK", from_port="r", to_port="t"),
        )
    )
    net = b.network
    assert net.branches["sv-bottle"].upstream == "SV.in"
    assert net.branches["sv-tank"].upstream == "SV.out"
    assert net.nodes["SV.out"].pressure is None


def test_reading_the_ports_says_so() -> None:
    b = built(
        press_leg(
            line("bottle-sv", "KB", "SV", to_port="l"),
            line("tank-sv", "TK", "SV", from_port="t", to_port="r"),
        )
    )
    assert [w for w in b.warnings if "SV-PRESS" in w and "port" in w]


def test_a_valve_with_lines_on_both_sides_is_read_exactly_as_before() -> None:
    """The gate. Drawn in flow order, the ports are not consulted even when they
    disagree with the direction -- a drawing that worked yesterday builds the
    same network today."""
    flow_order = press_leg(
        line("bottle-sv", "KB", "SV", to_port="r"),
        line("sv-tank", "SV", "TK", from_port="l", to_port="t"),
    )
    b = built(flow_order)
    assert b.network.branches["bottle-sv"].downstream == "SV.in"
    assert b.network.branches["sv-tank"].upstream == "SV.out"
    assert not [w for w in b.warnings if "port" in w]


def test_without_ports_a_one_sided_valve_is_still_a_vent() -> None:
    """No port to read, so nothing to correct: the old reading stands."""
    b = built(
        press_leg(
            line("bottle-sv", "KB", "SV"),
            line("tank-sv", "TK", "SV"),
        )
    )
    assert b.network.nodes["SV.out"].pressure == pytest.approx(AMBIENT)


def test_a_fill_disconnect_left_capped_does_not_crash_the_solve() -> None:
    """A QD with no coefficient is a fitting, priced as a bend. Capped, it is a
    stub, and the solver back-fills a stub at exactly zero flow -- where the
    bend correlation (Rennels, via fluids) refuses a Reynolds number of zero.
    The ValueError escaped a solve asked not to raise, on every solve of any
    drawing with a fill QD on it."""
    from feedtwin.solve.steady import solve_steady

    payload = press_leg(line("bottle-sv", "KB", "SV"), line("sv-tank", "SV", "TK"))
    payload["nodes"].append(node("QD", "QD", "QD-FILL"))
    payload["edges"].append(line("tank-qd", "TK", "QD", from_port="b", to_port="l"))
    b = built(payload)
    result = solve_steady(
        b.network, signals={"SV-PRESS.command": 1.0}, raise_on_failure=False
    )
    assert result.converged
    assert result.flows["tank-qd"] == 0.0


# ------------------------------------------------------- what a user is told


def test_a_part_the_library_refuses_is_named_and_fails_the_assembly() -> None:
    """A solenoid with ``Cd = 20`` reached the API as an unhandled SpecError, a
    bare 500, and the message said "valve" rather than which one."""
    bad = node(
        "SV",
        "SOL",
        "FM_SOL_G",
        params={"Cd": P(20, "-", "estimated"), "bore": P(6.35, "mm")},
    )
    payload = press_leg(
        line("bottle-sv", "KB", "SV"), line("sv-tank", "SV", "TK"), sol=bad
    )
    with pytest.raises(AssemblyError, match="FM_SOL_G") as caught:
        assemble_model(read_diagram(payload, name="press leg"), diagram_id="t")
    assert "Cd" in str(caught.value)


def test_a_tank_full_of_gas_is_told_to_be_a_pressurant_bottle() -> None:
    """pid-designer offers ``copv`` as a tank *wall material*; the vessel that
    supplies the press lines is its Pressurant bottle (KBOTTLE). A COPV drawn as
    a TANK is read as a propellant tank, and nothing presses anything."""
    payload = press_leg(line("bottle-sv", "KB", "SV"), line("sv-tank", "SV", "TK"))
    payload["nodes"].append(
        node(
            "COPV",
            "TANK",
            "TK-1",
            fluid="nitrogen",
            options={"material": "copv"},
            params={"pressure": P(4000, "psi"), "temperature": P(293, "K")},
        )
    )
    b = built(payload)
    told = [w for w in b.warnings if w.startswith("TK-1")]
    assert any("KBOTTLE" in w and "Pressurant bottle" in w for w in told), told
    # A propellant tank that states a liquid temperature is not.
    assert not [w for w in b.warnings if w.startswith("TK-FUEL") and "KBOTTLE" in w]


def _stand_with_copv_tank(temperature: bool) -> Any:
    payload = press_leg(line("bottle-sv", "KB", "SV"), line("sv-tank", "SV", "TK"))
    params = {"pressure": P(4000, "psi")}
    if temperature:
        params["temperature"] = P(293, "K")
    payload["nodes"].append(
        node("COPV", "TANK", "TK-1", fluid="nitrogen", params=params)
    )
    return payload


def _open(payload: Any):  # type: ignore[no-untyped-def]
    from pathlib import Path

    from feedtwin.session import Session, load_machine
    from feedtwin.session.statemachine import bind

    tables = (
        Path(__file__).resolve().parents[3] / "feed-twin" / "backend" / "statemachines"
    )
    if not tables.is_dir():
        pytest.skip("state machine tables absent")
    model = assemble_model(read_diagram(payload, name="press leg"), diagram_id="t")
    machine = load_machine(tables=tables)
    return model, Session(model, machine, bind(machine, {}))


def test_a_copv_drawn_as_a_tank_is_read_as_the_pressurant_supply() -> None:
    """Nitrogen stated at 293 K is above its 126 K critical point: it can only be
    gas, so the TANK is the pressurant bottle. LE4 drew its COPV this way, and
    read as a propellant tank it could not even open (a propellant tank starts
    from a saturated liquid that does not exist there)."""
    model, session = _open(_stand_with_copv_tank(temperature=True))
    assert "COPV" in session.bottles and "COPV" not in session.tanks
    assert [w for w in model.report.warnings if w.startswith("TK-1") and "KBOTTLE" in w]


def test_a_bottle_with_no_volume_is_the_stands_copv_not_a_k_bottle() -> None:
    """LE4's COPV gives no volume. It was given a 44 L K-bottle, so a burn took
    250 psi out of a bottle that really loses thousands: 45 scf of air at 4500
    psi is a 4.64 L cylinder (4.6871 L with its fittings), the one the stand and
    the Study run."""
    _, session = _open(_stand_with_copv_tank(temperature=True))
    assert session.bottles["COPV"].volume.volume == pytest.approx(4.6871e-3)
    assert any("4.69 L assumed" in a for a in session.assumptions)


def test_a_tank_that_only_forgot_its_temperature_is_not_reread_and_says_why() -> None:
    """With no temperature the drawing has not ruled a liquid out, so nothing is
    re-read -- and the stand refuses to open with the tank named and the reason
    given, rather than CoolProp's "rhoV is invalid" as a bare 500."""
    with pytest.raises(AssemblyError, match="TK-1") as caught:
        _open(_stand_with_copv_tank(temperature=False))
    assert "critical temperature (126 K)" in str(caught.value)
    assert "KBOTTLE" in str(caught.value)


def test_a_capped_fitting_behind_a_shut_valve_does_not_make_the_solve_singular() -> (
    None
):
    """LE4's regulator dome line: a solenoid, then a quick-disconnect left open
    to nothing. With the solenoid shut that run is an island cut off from every
    fixed pressure. Peeled from both ends, the stubs met in the middle and left
    one node with no equation and no live end -- "the Jacobian could not be
    factorised" on every solve with the solenoid shut, which in a DAQ sequence
    that never commands it is every solve."""
    from feedtwin.solve.steady import solve_steady

    payload = press_leg(line("bottle-sv", "KB", "SV"), line("sv-tank", "SV", "TK"))
    payload["nodes"] += [
        node(
            "DS", "SOL", "DOME-SOL", params={"Cv": P(1.0, "Cv"), "bore": P(4.0, "mm")}
        ),
        node("QDX", "QD", "QD-DOME"),
        node("QDF", "QD", "QD-FILL"),
    ]
    payload["edges"] += [
        line("tank-fill", "TK", "QDF", from_port="b", to_port="l"),
        line("bottle-ds", "KB", "DS", to_port="l"),
        line("ds-qd", "DS", "QDX", from_port="r", to_port="l"),
    ]
    b = built(payload)
    for command in (0.0, 1.0):
        result = solve_steady(
            b.network,
            signals={"SV-PRESS.command": 1.0, "DOME-SOL.command": command},
            raise_on_failure=False,
        )
        assert result.converged, f"DOME-SOL at {command}"


# ------------------------------------------------- what the drawing means


def test_a_relief_valve_with_no_set_pressure_is_shut_not_a_hole() -> None:
    """A relief valve is shut until its set pressure; with none it never lifts.
    It used to be built as an always-open Cv valve -- a hole to atmosphere on
    the tank it guards, so the stand could never hold press."""
    payload = press_leg(line("bottle-sv", "KB", "SV"), line("sv-tank", "SV", "TK"))
    payload["nodes"] += [node("RV", "RV", "RV-F"), node("QDF", "QD", "QD-FILL")]
    payload["edges"] += [
        line("tank-rv", "TK", "RV", from_port="t", to_port="r"),
        line("tank-fill", "TK", "QDF", from_port="b", to_port="l"),
    ]
    b = built(payload)
    assert "RV" not in b.network.branches
    assert not [
        n for n, v in b.network.nodes.items() if n.startswith("RV.") and v.pressure
    ]
    assert [w for w in b.warnings if w.startswith("RV-F") and "read as shut" in w]


def test_the_engine_symbols_chamber_pressure_is_its_boundary() -> None:
    """pid-designer's engine dialog saves "Chamber pressure" as
    `chamber_pressure`; hand-written drawings say `pressure`. Both are read."""
    payload = press_leg(line("bottle-sv", "KB", "SV"), line("sv-tank", "SV", "TK"))
    payload["nodes"].append(
        node("ENG", "ENGINE", "ENG-1", params={"chamber_pressure": P(385, "psi")})
    )
    payload["edges"].append(
        line("tank-eng", "TK", "ENG", from_port="b", to_port="fuel")
    )
    b = built(payload)
    assert b.network.nodes["ENG"].pressure == pytest.approx(385 * 6894.757293168361)
    assert not [w for w in b.warnings if w.startswith("ENG-1 has no pressure")]


def _le4_like(fuel_main_label: str = "FM-R") -> Any:
    """Bottle, regulator-less press manifold, two tanks, two press solenoids,
    two mains to an engine -- tagged the way LE4 tags them."""
    payload = {
        "nodes": [
            node(
                "KB",
                "KBOTTLE",
                "TK-1",
                fluid="nitrogen",
                params={"pressure": P(4000, "psi"), "temperature": P(293, "K")},
            ),
            node("MF", "MANIFOLD", "MF-1"),
            node(
                "FT",
                "TANK",
                "TK-2",
                fluid="ethanol",
                params={
                    "pressure": P(580, "psi"),
                    "temperature": P(293, "K"),
                    "volume": P(8.19, "L"),
                },
            ),
            node(
                "OT",
                "TANK",
                "TK-3",
                fluid="oxygen",
                params={
                    "pressure": P(585, "psi"),
                    "temperature": P(90.19, "K"),
                    "volume": P(8.19, "L"),
                },
            ),
            node(
                "FP",
                "SOL",
                "FU_SOL_R",
                params={"Cv": P(4, "Cv"), "bore": P(6.35, "mm")},
            ),
            node(
                "OP",
                "SOL",
                "OU_SOL_R",
                params={"Cv": P(4, "Cv"), "bore": P(6.35, "mm")},
            ),
            node(
                "FM",
                "ROT",
                fuel_main_label,
                params={"Cv": P(20, "Cv"), "bore": P(12.7, "mm")},
            ),
            node(
                "OM", "ROT", "OM-R", params={"Cv": P(20, "Cv"), "bore": P(12.7, "mm")}
            ),
            node("ENG", "ENGINE", "ENG-1", params={"chamber_pressure": P(385, "psi")}),
        ],
        "edges": [
            line("kb-mf", "KB", "MF"),
            line("mf-fp", "MF", "FP", to_port="l"),
            line("ft-fp", "FT", "FP", from_port="t", to_port="r"),
            line("mf-op", "MF", "OP", to_port="l"),
            line("ot-op", "OT", "OP", from_port="t", to_port="r"),
            line("ft-fm", "FT", "FM", from_port="b", to_port="l"),
            line("fm-eng", "FM", "ENG", from_port="r", to_port="fuel"),
            line("ot-om", "OT", "OM", from_port="b", to_port="l"),
            line("om-eng", "OM", "ENG", from_port="r", to_port="t"),
        ],
    }
    return payload


def _machine():  # type: ignore[no-untyped-def]
    from pathlib import Path

    from feedtwin.session import load_machine

    tables = (
        Path(__file__).resolve().parents[3] / "feed-twin" / "backend" / "statemachines"
    )
    if not tables.is_dir():
        pytest.skip("state machine tables absent")
    return load_machine(tables=tables)


def test_each_commandable_valves_job_is_read_off_the_plumbing() -> None:
    b = built(_le4_like())
    assert b.valve_roles == {
        "FP": frozenset({"fuel", "press"}),
        "OP": frozenset({"lox", "press"}),
        "FM": frozenset({"fuel", "main"}),
        "OM": frozenset({"lox", "main"}),
    }


def test_valves_the_names_do_not_match_are_bound_by_what_they_do() -> None:
    """ "FU_SOL_R" shares no word with "Fuel Press", so LE4 bound nothing and
    Fire opened nothing. Bound by role, every press and main is commanded."""
    from feedtwin.session.statemachine import bind

    b = built(_le4_like())
    labels = {
        sid: label
        for sid, label in (
            ("FP", "FU_SOL_R"),
            ("OP", "OU_SOL_R"),
            ("FM", "FM-R"),
            ("OM", "OM-R"),
        )
    }
    machine = _machine()
    assert bind(machine, labels).to_symbol == {}  # names alone: nothing
    binding = bind(machine, labels, roles=b.valve_roles)
    assert {
        a: binding.to_symbol.get(a)
        for a in ("Fuel Press", "LOX Press", "Fuel Main", "LOX Main")
    } == {"Fuel Press": "FP", "LOX Press": "OP", "Fuel Main": "FM", "LOX Main": "OM"}
    assert set(binding.by_role) == {"Fuel Press", "LOX Press", "Fuel Main", "LOX Main"}
    assert binding.uncommanded == ()


def test_a_name_that_matches_still_wins_over_a_role() -> None:
    from feedtwin.session.statemachine import bind

    b = built(_le4_like(fuel_main_label="MV-FU"))
    labels = {"FP": "FU_SOL_R", "OP": "OU_SOL_R", "FM": "MV-FU", "OM": "OM-R"}
    binding = bind(_machine(), labels, roles=b.valve_roles)
    assert binding.to_symbol["Fuel Main"] == "FM"
    assert "Fuel Main" not in binding.by_role


def test_a_role_two_valves_share_binds_neither() -> None:
    """Two fuel press valves in parallel: which one "Fuel Press" means is not
    settled by the plumbing, so neither is guessed."""
    from feedtwin.session.statemachine import bind

    labels = {"FP": "FU_SOL_R", "FP2": "FU_SOL_R2"}
    roles = {"FP": frozenset({"fuel", "press"}), "FP2": frozenset({"fuel", "press"})}
    binding = bind(_machine(), labels, roles=roles)
    assert "Fuel Press" not in binding.to_symbol


def test_a_dome_nothing_loads_is_the_operators_setting() -> None:
    """LE4's regulator is dome-loaded, with its dome filled through a QD rather
    than by a drawn control regulator. Nothing exposed the dome, so the
    cockpit's dome knob did not reach it and Layer X could not solve the dome
    for a lockup ("Could not solve the dome setting"). It is a signal now --
    and the press valves are still found through the regulator."""
    payload = _le4_like()
    payload["nodes"].append(
        node(
            "REG",
            "PR",
            "DPR_HP",
            options={"domeLoaded": "yes"},
            params={
                "dome_pressure": P(535, "psi"),
                "dome_bias": P(50, "psi"),
                "Cv": P(0.8, "Cv"),
            },
        )
    )
    payload["edges"] = [e for e in payload["edges"] if e["id"] != "kb-mf"]
    payload["edges"] += [
        line("kb-reg", "KB", "REG", to_port="l"),
        line("reg-mf", "REG", "MF", from_port="r"),
    ]
    b = built(payload)
    assert b.actuators["REG"] == "DPR_HP.dome"
    assert b.valve_roles["FP"] == frozenset({"fuel", "press"})
    assert b.valve_roles["OP"] == frozenset({"lox", "press"})
    assert "REG" not in b.valve_roles


# ------------------------------------------------- a tank's top, and its GSE vent


def _le4_with_top_manifold(*, vent_valve: bool = False, rotation: int = 0) -> Any:
    """LE4's LOX tank top: a manifold on the tank's ``t2`` port carrying a
    transducer and a quick-disconnect with nothing beyond it -- the GSE vent
    couples there, and the vent valve is on the cart."""
    payload = _le4_like()
    if rotation:
        for n in payload["nodes"]:
            if n["id"] == "OT":
                n["data"]["rotation"] = rotation
    payload["nodes"] += [
        node("VM", "MANIFOLD", "MF-3"),
        node("PT", "PT", "QD_PT_R"),
        node("QD", "QD", "QD_OVA"),
    ]
    payload["edges"] += [
        line("ot-vm", "OT", "VM", from_port="t2"),
        line("vm-pt", "VM", "PT", to_port="b"),
        line("vm-qd", "VM", "QD", to_port="r"),
    ]
    if vent_valve:
        payload["nodes"].append(
            node(
                "OV",
                "SOL",
                "OV_SOL",
                params={"Cv": P(1.7, "Cv"), "bore": P(6.35, "mm")},
            )
        )
        payload["edges"].append(line("vm-ov", "VM", "OV", to_port="l"))
    return payload


def _tank_end(b, edge_id: str, tank: str) -> str:  # type: ignore[no-untyped-def]
    branch = b.network.branches[edge_id]
    ports = b.tanks[tank]
    return next(
        e
        for e in (branch.upstream, branch.downstream)
        if e in (ports.ullage, ports.outlet)
    )


def test_a_manifold_on_a_tanks_top_port_is_on_its_ullage() -> None:
    """It reaches no supply and no atmosphere, so topology alone hung it on the
    *liquid outlet*: LE4's LOX vent manifold read as full of LOX, and its
    transducer read the outlet. Drawn on the top port, it is on the ullage."""
    b = built(_le4_with_top_manifold())
    assert _tank_end(b, "ot-vm", "OT") == b.tanks["OT"].ullage
    assert b.network.nodes["VM"].phase == "gas"


def test_a_turned_tanks_ports_say_nothing_about_up() -> None:
    b = built(_le4_with_top_manifold(rotation=90))
    assert _tank_end(b, "ot-vm", "OT") == b.tanks["OT"].outlet


def test_a_capped_disconnect_on_an_unvented_tank_top_is_its_gse_vent() -> None:
    """No vent valve on the drawing: the pad's Ox Fill boiled TK-3 up to the
    717 psig critical pin and the sequence never left it. The disconnect is
    where the cart's vent couples, so the table's LOX Vent opens it."""
    from feedtwin.session.statemachine import bind

    b = built(_le4_with_top_manifold())
    assert b.actuators["QD"] == "QD_OVA.command"
    assert b.valve_roles["QD"] == frozenset({"lox", "vent"})
    branch = b.network.branches["QD"]
    ends = {branch.upstream, branch.downstream}
    assert any(b.network.nodes[e].pressure == AMBIENT for e in ends)
    assert any("QD_OVA" in w and "GSE vent" in w for w in b.warnings)
    labels = {
        "FP": "FU_SOL_R",
        "OP": "OU_SOL_R",
        "FM": "FM-R",
        "OM": "OM-R",
        "QD": "QD_OVA",
    }
    binding = bind(_machine(), labels, roles=b.valve_roles)
    assert binding.to_symbol["LOX Vent"] == "QD"


def test_a_drawn_vent_valve_leaves_the_disconnect_capped() -> None:
    b = built(_le4_with_top_manifold(vent_valve=True))
    assert b.valve_roles["OV"] == frozenset({"lox", "vent"})
    assert "QD" not in b.actuators
    assert type(b.network.branches["QD"].component).__name__ == "Fitting"
    assert not any("GSE vent" in w for w in b.warnings)


def test_ox_fill_vents_through_the_gse_disconnect() -> None:
    """The cockpit's own pad: Ox Fill with the LOX Vent bound to the disconnect
    holds the ullage near ambient instead of boiling it toward critical."""
    from feedtwin.session import Session, load_machine
    from feedtwin.session.gauge import psig
    from feedtwin.session.statemachine import bind

    _machine()  # skips when the tables are absent
    from pathlib import Path

    tables = (
        Path(__file__).resolve().parents[3] / "feed-twin" / "backend" / "statemachines"
    )
    payload = _le4_with_top_manifold()
    model = assemble_model(read_diagram(payload, name="le4 top"), diagram_id="t")
    machine = load_machine(tables=tables)
    labels = {
        n.id: n.label for n in model.diagram.nodes if n.id in model.built.actuators
    }
    session = Session(
        model, machine, bind(machine, labels, roles=model.built.valve_roles)
    )
    for state in ("Armed", "Ox Fill"):
        session.command_state(state)
    # A minute of fill: capped, the ullage is past 100 psig by now and climbing
    # toward the 717 psig critical pin; vented, it sits under 10.
    for _ in range(120):
        sample = session.step(0.5)
    ullage = model.built.tanks["OT"].ullage
    assert psig(sample.pressures[ullage]) < 50.0


# ------------------------------------------------------- lines the drawing did not size


def _sizeless(payload: Any, *edge_ids: str) -> Any:
    for e in payload["edges"]:
        if e["id"] in edge_ids:
            e["data"]["params"] = {}
    return payload


def test_a_line_with_no_size_is_a_direct_connection() -> None:
    """A line drawn with no length and no bore is two parts screwed together --
    a tank's port into its valve. It used to be solved as the fallback tube, a
    metre of 9.5 mm, which put 94 psi on a LOX feed that has none."""
    b = built(_sizeless(_le4_like(), "ot-om"))
    assert "ot-om" not in b.network.branches
    assert b.network.branches["OM"].upstream == b.tanks["OT"].outlet
    assert not [w for w in b.warnings if "fallback tube" in w]


def test_a_direct_line_into_the_engine_starts_the_injector_leg_at_the_valve() -> None:
    from feedtwin.engine.design import DischargeModel, EngineDesign, InjectorSide

    design = EngineDesign(
        name="fixture",
        injector_type="impinging",
        oxidiser=InjectorSide("oxygen", 99.245e-6, 2.2e-3, DischargeModel(), 26),
        fuel=InjectorSide("ethanol", 75.125e-6, 1.92e-3, DischargeModel(), 26),
        throat_area=1.7e-3,
        design_mixture_ratio=1.65,
    )
    payload = _sizeless(_le4_like(), "om-eng")
    b = build_network(read_diagram(payload, name="direct"), engine=design)
    leg = b.network.branches[b.engine_ports["oxidiser"]]
    assert leg.upstream == b.network.branches["OM"].downstream
    # Not read as a vent: an outlet with only the injector leg on it once
    # pinned at atmosphere and dumped the LOX overboard.
    assert b.network.nodes[leg.upstream].pressure is None
    assert not [w for w in b.warnings if "OM-R" in w and "venting" in w]
    assert leg.downstream == b.engine_ports["chamber"]
    assert "om-eng" not in b.network.branches
    assert b.valve_roles["OM"] == frozenset({"lox", "main"})


def test_a_line_with_half_a_size_takes_the_fallback_for_the_rest_and_says_so() -> None:
    payload = _le4_like()
    edge = next(e for e in payload["edges"] if e["id"] == "ot-om")
    edge["data"]["params"] = {"length": P(0.5, "m")}
    b = built(payload)
    assert "ot-om" in b.network.branches
    found = [w for w in b.warnings if "fallback" in w and "TK-3 -> OM-R" in w]
    assert found, b.warnings


def test_two_fixed_pressures_joined_directly_stay_a_line() -> None:
    """A bottle drawn straight into a tank: two pressures cannot be one place."""
    payload = _le4_like()
    payload["edges"].append(line("kb-ft", "KB", "FT", to_port="t2"))
    payload["edges"][-1]["data"]["params"] = {}
    b = built(payload)
    assert "kb-ft" in b.network.branches
    assert any("TK-1 -> TK-2" in w for w in b.warnings), b.warnings


def test_a_segment_with_a_zero_bore_is_reported() -> None:
    """A stated 0 mm passed the reader where a missing bore was reported, and the
    run then contributed no loss at all (LE4's fuel tank-to-main run)."""
    payload = _le4_like()
    edge = next(e for e in payload["edges"] if e["id"] == "ft-fm")
    edge["data"]["segments"] = [
        {
            "id": "seg_1",
            "method": "itemised",
            "bore": P(0, "mm", "estimated"),
            "length": P(429.5, "mm"),
        }
    ]
    b = built(payload)
    assert any("seg_1" in w and "no bore" in w for w in b.warnings), b.warnings


def test_two_tanks_on_one_direct_press_manifold_conserve_pressurant() -> None:
    """Press valves joined straight onto their tanks: the two ullages trade gas
    through the manifold, and what one sent and the other refused was handed
    to the bottle, whose draw cannot go negative -- so it vanished. LE4 lost
    7 g/s this way and emptied its COPV before ignition."""
    from feedtwin.session import Session, load_machine
    from feedtwin.session.burn import press_valves
    from feedtwin.session.statemachine import bind

    _machine()  # skips when the tables are absent
    from pathlib import Path

    tables = (
        Path(__file__).resolve().parents[3] / "feed-twin" / "backend" / "statemachines"
    )
    payload = _sizeless(_le4_like(), "ft-fp", "ot-op")
    payload["nodes"].append(
        node(
            "REG",
            "PR",
            "DPR_HP",
            options={"domeLoaded": "yes"},
            params={
                "dome_pressure": P(500, "psi"),
                "dome_bias": P(50, "psi"),
                "Cv": P(0.8, "Cv"),
            },
        )
    )
    payload["edges"] = [e for e in payload["edges"] if e["id"] != "kb-mf"]
    payload["edges"] += [
        line("kb-reg", "KB", "REG", to_port="l"),
        line("reg-mf", "REG", "MF", from_port="r"),
    ]
    model = assemble_model(read_diagram(payload, name="direct press"), diagram_id="t")
    machine = load_machine(tables=tables)
    labels = {
        n.id: n.label for n in model.diagram.nodes if n.id in model.built.actuators
    }
    session = Session(
        model, machine, bind(machine, labels, roles=model.built.valve_roles)
    )
    session.prime(fill_fraction=0.95, tank_psi=563.0, copv_psi=4000.0, state="Ready")
    for valve in press_valves(session):
        session.set_valve(valve, True)

    def pressurant() -> float:
        return sum(b.state.mass for b in session.bottles.values()) + sum(
            t.state.ullage.mass for t in session.tanks.values()
        )

    before = pressurant()
    for _ in range(40):
        session.step(0.05)
    assert pressurant() == pytest.approx(before, rel=1e-9)

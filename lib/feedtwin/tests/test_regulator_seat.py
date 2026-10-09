"""The regulator's compressible seat (``Setup.regulator_compressible_seat``).

The seat a dome regulator saturates against was ``K rho v^2 / 2`` at the inlet
density: no expansion factor, no choke (EngineDesign/docs/layerx/AUDIT.md 5.3).
On GN2 near burnout that passes 0.398 kg/s across the 441 psi a 1092-50 has, where
IEC 60534-2-1 with its expansion factor passes 0.319 (AUDIT.md 9.6 C3, by hand,
Cv 0.8, xT 0.7 assumed, gamma 1.40). On -- the default since 2026-10-08, pinned off
in the benchmark Study -- it reproduces that; off it is the old law exactly; on, a
regulator that is regulating -- helium at the LE4's hot-fire flows -- does not move.

States are the audit's (``scratchpad/audit/drawings/regcalc.py`` at the twin's
recorded ``PR_D.in``): GN2 at 3.62 s, 1054.78 psia and 199.95 K, outlet target
614.174 psia; He at 0.55 s and 3.478 s.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fluids.control_valve import size_control_valve_g
from fluids.fittings import Cv_to_K, Kv_to_Cv

from feedtwin.comps import build_component, conditions_from_fluid
from feedtwin.comps.iec_gas import XT_TYPICAL
from feedtwin.comps.regulator import SEAT_XT_SIGNAL, Regulator, _dynamic_head
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.props import Fluid
from feedtwin.session import PSI, Setup
from feedtwin.session.burn import burn_setup
from feedtwin.solve.network import Network
from feedtwin.solve.steady import solve_steady

STAR = Path(__file__).resolve().parents[3]
HE = STAR / "feed-twin" / "backend" / "diagrams" / "copv_study_he.json"

CV = 0.8
BORE = 0.23 * 0.0254  # TB 1031's 0.23 in orifice, as on the drawing
ON = {SEAT_XT_SIGNAL: XT_TYPICAL}


def _p(value: float, unit: str) -> Param:
    return Param(value, unit, Provenance.ESTIMATED, "test")


def _regulator(setpoint_psia: float, droop: bool = True) -> Regulator:
    params = {"setpoint": _p(setpoint_psia, "psi"), "Cv": _p(CV, "Cv")}
    params["bore"] = _p(BORE, "m")
    if droop:
        params["flow_droop"] = _p(8.3, "psi")
        params["rated_flow"] = _p(0.09646, "kg/s")
    component = build_component(
        ComponentInstance.build("PR-1", "regulator", params, model="droop")
    )
    assert isinstance(component, Regulator)
    return component


def _gas(name: str, psia: float, T: float, signals=None):  # type: ignore[no-untyped-def]
    return conditions_from_fluid(Fluid(name), psia * PSI, T, signals, phase="gas")


def test_on_in_the_cockpit_and_off_in_the_benchmark_study() -> None:
    """The team turned it on (2026-10-08); the benchmark keeps the law its
    expectations were stated at."""
    assert Setup().regulator_compressible_seat is True
    assert burn_setup().regulator_compressible_seat is False
    assert Setup().regulator_xT == pytest.approx(0.70)


def test_off_the_seat_is_the_incompressible_law_exactly() -> None:
    """Without the signal the saturated drop is K rho v^2/2 at the inlet density,
    bit for bit, however the gas is priced."""
    reg = _regulator(614.174, droop=False)
    flow = _gas("nitrogen", 1054.78, 199.95)
    for mdot in (0.30, 0.45, 0.70):
        # The pre-opt-in expression, verbatim.
        old = Cv_to_K(CV, BORE) * _dynamic_head(mdot, BORE, flow.rho)
        required = flow.p_upstream - reg.outlet_setpoint(mdot, flow)
        assert reg.pressure_drop(mdot, flow) == max(required, old)
        assert reg.pinned_flow(1.0e9, flow) is None


def _saturation_flow(reg: Regulator, flow) -> float:  # type: ignore[no-untyped-def]
    """The flow at which the wide-open seat takes the whole available drop."""
    lo, hi = 1e-6, 5.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        lo, hi = (lo, mid) if reg.is_saturated(mid, flow) else (mid, hi)
    return 0.5 * (lo + hi)


def test_gn2_capacity_near_burnout_falls_as_the_audit_says() -> None:
    """441 psi available at 1054.78 psia, 199.95 K: 0.398 kg/s incompressible,
    0.319 with IEC 60534-2-1's expansion factor (x = 0.418, Y = 0.801)."""
    reg = _regulator(614.174, droop=False)  # the audit's outlet target, flat
    off = _saturation_flow(reg, _gas("nitrogen", 1054.78, 199.95))
    on = _saturation_flow(reg, _gas("nitrogen", 1054.78, 199.95, ON))
    assert off == pytest.approx(0.398, abs=0.001)
    assert on == pytest.approx(0.319, abs=0.001)
    # Independently: fluids' IEC 60534-2-1 sizing returns the seat's Cv for the
    # flow the compressible seat passes at that drop.
    p1, p2 = 1054.78 * PSI, 614.174 * PSI
    flow = _gas("nitrogen", 1054.78, 199.95)
    molar_mass = 28.0134
    rho_normal = 101325.0 * molar_mass * 1e-3 / (8.314462618 * 273.15)
    kv = size_control_valve_g(
        T=199.95,
        MW=molar_mass,
        mu=flow.mu,
        gamma=1.40,
        Z=Fluid("nitrogen").get("Z", p=p1, T=199.95),
        P1=p1,
        P2=p2,
        Q=on / rho_normal,
        D1=BORE,
        D2=BORE,
        d=BORE,
        xT=XT_TYPICAL,
        allow_choked=True,
    )
    assert Kv_to_Cv(kv) == pytest.approx(CV, rel=3e-3)


@pytest.mark.parametrize(
    "psia, T, mdot, target",
    [(4081.45, 281.9, 0.02154, 583.512), (1633.75, 200.24, 0.03492, 623.972)],
)
def test_on_helium_at_le4_flows_the_outlet_does_not_move(
    psia: float, T: float, mdot: float, target: float
) -> None:
    """Regulating at 5-18 % of its choked capacity, the seat never binds: the
    outlet is the droop law with the opt-in on or off (< 0.1 psi; it is 0)."""
    reg = _regulator(target + 8.3 * mdot / 0.09646)  # outlet target at this flow
    off = _gas("helium", psia, T)
    on = _gas("helium", psia, T, ON)
    outlet_off = off.p_upstream - reg.pressure_drop(mdot, off)
    outlet_on = on.p_upstream - reg.pressure_drop(mdot, on)
    assert outlet_off == pytest.approx(target * PSI, abs=0.01 * PSI)
    assert abs(outlet_on - outlet_off) < 0.1 * PSI
    assert not reg.is_saturated(mdot, on)
    capacity = reg.seat_capacity(on)
    assert capacity is not None and 0.03 < mdot / capacity < 0.20
    # Not choked at the drop it regulates across: nothing pinned.
    assert reg.pinned_flow(on.p_upstream - target * PSI, on) is None


def test_wide_open_and_choked_the_solve_pins_the_capacity() -> None:
    """A GN2 bottle at 4039.76 psia, 284.84 K straight into a tank at 100 psia:
    the regulator is wide open and past F_gamma xT. The solve must carry the
    IEC choked flow, N6 C (2/3) sqrt(F_gamma xT p1 rho1) with N6 = 2.73
    (Cv; kg/h, kPa, kg/m^3); the incompressible law passes far more."""

    def solve(signals):  # type: ignore[no-untyped-def]
        net = Network()
        net.add_node("bottle", "nitrogen", 284.84, pressure=4039.76 * PSI)
        net.add_node("tank", "nitrogen", 284.84, pressure=100.0 * PSI)
        for node in net.nodes.values():
            node.phase = "gas"
        net.add_branch("PR", _regulator(600.0), "bottle", "tank")
        return solve_steady(net, signals=signals, tol=1e-10, max_iterations=200)

    rho1 = Fluid("nitrogen").get("rho", p=4039.76 * PSI, T=284.84)
    hand = 2.73 * CV * (2.0 / 3.0) * (0.70 * 4039.76 * PSI / 1e3 * rho1) ** 0.5
    hand /= 3600.0
    on = solve(ON)
    assert on.converged
    assert on.flows["PR"] == pytest.approx(hand, rel=3e-3)
    off = solve({})
    assert off.converged
    assert off.flows["PR"] > 1.3 * on.flows["PR"]


def test_the_seat_model_block() -> None:
    model = _regulator(600.0).seat_model()
    assert "IEC 60534-2-1" in model["source"]
    inputs = model["inputs"]
    assert inputs["xT"]["value"] == XT_TYPICAL  # type: ignore[index]
    assert "assumed" in inputs["xT"]["provenance"]  # type: ignore[index]


@pytest.mark.skipif(not HE.exists(), reason="helium drawing absent")
def test_the_drawn_1092_has_no_xt_so_the_setup_value_is_used() -> None:
    from feedtwin.pid import read_diagram
    from feedtwin.session import assemble_model

    model = assemble_model(
        read_diagram(json.loads(HE.read_text()), name="he"), diagram_id="he"
    )
    reg = model.built.network.branches["PR_D"].component
    assert isinstance(reg, Regulator) and "xT" not in reg.p
    flow = _gas("nitrogen", 1054.78, 199.95, {SEAT_XT_SIGNAL: 0.5})
    capacity_05 = reg.seat_capacity(flow, xT=0.5)
    assert capacity_05 is not None
    assert reg.pinned_flow(1054.0 * PSI, flow) == pytest.approx(capacity_05)


ENGINE = STAR / "EngineDesign" / "configs" / "ethalox_doublet_7000N.yaml"
CEA = STAR / "EngineDesign" / "output" / "cache" / "cea_cache_LOX_Ethanol_3D.npz"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"


@pytest.mark.skipif(
    not (HE.exists() and ENGINE.exists() and CEA.exists() and TABLES.is_dir()),
    reason="helium drawing, engine, CEA table or tables absent",
)
def test_a_helium_burn_is_unchanged_with_the_seat_on() -> None:
    """The helium hot-fire drawing burning: every tank, regulator-outlet and
    injector pressure within 0.1 psi with the opt-in on (it regulates
    throughout, so it is in fact identical)."""
    import yaml

    from feedtwin.engine.importer import engine_from_config
    from feedtwin.pid import read_diagram
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import BurnPlan, open_session, run_burn

    def fire(seat: bool):  # type: ignore[no-untyped-def]
        design = engine_from_config(yaml.safe_load(ENGINE.read_text()), name="7000N")
        model = assemble_model(
            read_diagram(json.loads(HE.read_text()), name="he"),
            diagram_id="he",
            engine=design,
            cea_cache=str(CEA),
        )
        session = open_session(
            model,
            load_machine(tables=TABLES),
            setup=burn_setup(regulator_compressible_seat=seat),
        )
        plan = BurnPlan(
            tank_psi=550.0,
            loads={"OXT": 6.0, "FUT": 4.0},
            settle=False,
            lead_in_s=0.1,
            horizon_s=0.3,
        )
        return run_burn(session, plan)

    off, on = fire(False), fire(True)
    assert len(on.t) == len(off.t)
    for node, column in off.pressure.items():
        for a, b in zip(column, on.pressure[node]):
            assert abs(a - b) < 0.1 * PSI, node
    for tank, columns in off.tank.items():
        for a, b in zip(columns["pressure_Pa"], on.tank[tank]["pressure_Pa"]):
            assert abs(a - b) < 0.1 * PSI, tank

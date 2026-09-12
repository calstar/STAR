#!/usr/bin/env python3
"""Run the closed-form half of docs/PHYSICS-BENCHMARK.md and check the numbers.

Tier 1 and Tier 2.3 only -- the checks that are fast, deterministic and localise a
fault to one component. The He/GN2 study (Tier 2.1/2.2) takes minutes and is run from
the Study tab or `backend.study.run_study` directly; this covers the parts there is no
excuse for skipping.

    python3 scripts/physics_benchmark.py

Exit status is 0 when every check passes, 1 otherwise, so it can gate a change.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib" / "feedtwin"))
sys.path.insert(0, str(ROOT / "feed-twin"))

PSI = 6894.757293168361
FAILURES: list[str] = []


def check(label: str, got: float, expect: float, tol: float, unit: str = "") -> None:
    """One comparison against a value from somewhere other than this code."""
    ok = abs(got - expect) <= tol
    mark = "PASS" if ok else "FAIL"
    print(
        f"  [{mark}] {label:52s} {got:14.6g} {unit:6s} (expect {expect:g} +/- {tol:g})"
    )
    if not ok:
        FAILURES.append(f"{label}: got {got:.6g}, expected {expect:g} +/- {tol:g}")


def exact(label: str, got: float, expect: float, unit: str = "") -> None:
    ok = got == expect
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {label:52s} {got:14.6g} {unit:6s} (expect exactly {expect:g})")
    if not ok:
        FAILURES.append(f"{label}: got {got!r}, expected exactly {expect!r}")


def truthy(label: str, got: bool, expect: bool) -> None:
    ok = got is expect
    print(f"  [{'PASS' if ok else 'FAIL'}] {label:52s} {str(got):>14s}")
    if not ok:
        FAILURES.append(f"{label}: got {got}, expected {expect}")


# --------------------------------------------------------------------- 1.1 / 1.2
def tier1_lines() -> None:
    from feedtwin.comps import build_component
    from feedtwin.comps.base import FlowConditions
    from feedtwin.comps.correlations import darcy_friction_factor
    from feedtwin.model import ComponentInstance, Param, Provenance
    from feedtwin.pid.segments import read_segments

    print("\n1.1  pipe friction vs Darcy-Weisbach by hand")
    rho, mu, mdot, bore, length = 789.0, 1.2e-3, 1.0, 0.0102, 1.6
    flow = FlowConditions(rho=rho, mu=mu, p_upstream=4.0e6, temperature=293.15)
    area = math.pi * bore * bore / 4.0
    v = mdot / (rho * area)
    Re = rho * v * bore / mu
    fd = darcy_friction_factor(Re, 1.5e-6 / bore, "Clamond")
    hand = fd * length / bore * 0.5 * rho * v * v

    pipe = build_component(
        ComponentInstance.build(
            "A",
            "pipe",
            {
                "length": Param(1.6, "m", Provenance.MEASURED),
                "bore": Param(10.2, "mm", Provenance.MEASURED),
            },
            model="darcy",
        )
    )
    check("velocity", v, 15.511, 0.001, "m/s")
    check("Reynolds", Re, 104023, 5.0)
    check("friction factor", fd, 0.01862, 1e-5)
    check("dp vs hand calculation", pipe.pressure_drop(mdot, flow), hand, 1e-6, "Pa")
    check(
        "dp vs recorded benchmark",
        pipe.pressure_drop(mdot, flow),
        277186.813,
        1e-3,
        "Pa",
    )

    print("\n1.2  one segment reduces exactly to the darcy pipe")
    seg = read_segments(
        [
            {
                "id": "s",
                "bore": {"value": 10.2, "unit": "mm", "source": "measured"},
                "length": {"value": 1.6, "unit": "m", "source": "measured"},
            }
        ],
        "bench",
    )
    segmented = build_component(
        ComponentInstance.build(
            "B", "pipe", {}, model="segmented", segments=seg.segments
        )
    )
    exact(
        "segmented == darcy, bit for bit",
        segmented.pressure_drop(mdot, flow) - pipe.pressure_drop(mdot, flow),
        0.0,
        "Pa",
    )


# --------------------------------------------------------------------------- 1.3
def tier1_choking() -> None:
    import fluids.control_valve as cv_lib
    from feedtwin.comps import build_component
    from feedtwin.comps.base import FlowConditions
    from feedtwin.model import ComponentInstance, Param, Provenance

    print("\n1.3  gas choking vs the library's own IEC 60534")
    R = 8.31446261815324 * 1000.0
    KV_PER_CV = 1.0 / 1.1560992283536566

    def reference(Cv, mw, gamma, p1, T, bore):
        r_specific = R / mw
        rho_std = 101325.0 / (r_specific * 288.15)
        sized = cv_lib.size_control_valve_g(
            T=T,
            MW=mw,
            mu=2.0e-5,
            gamma=gamma,
            Z=1.0,
            P1=p1,
            P2=101325.0,
            Q=1.0,
            D1=bore,
            D2=bore,
            d=bore,
            allow_choked=True,
            full_output=True,
        )
        return rho_std * (Cv * KV_PER_CV) / sized["Kv"]

    cases = [
        ("helium 3/8in", 3.8, 4.0026, 1.667, 550 * PSI, 293.15, 0.00953),
        ("helium reg", 1.6, 4.0026, 1.667, 4500 * PSI, 293.15, 0.00775),
        ("nitrogen 3/8in", 8.0, 28.014, 1.40, 1000 * PSI, 293.15, 0.00953),
        ("nitrogen cold", 1.7, 28.014, 1.40, 200 * PSI, 250.0, 0.00635),
        ("helium 1in dump", 60.0, 4.0026, 1.667, 550 * PSI, 293.15, 0.0254),
    ]
    worst = 0.0
    for name, Cv, mw, gamma, p1, T, bore in cases:
        r_specific = R / mw
        valve = build_component(
            ComponentInstance.build(
                "V",
                "valve",
                {
                    "Cv": Param(Cv, "Cv", Provenance.ESTIMATED),
                    "bore": Param(bore * 1000.0, "mm", Provenance.MANUFACTURER),
                },
                model="cv",
            )
        )
        flow = FlowConditions(
            rho=p1 / (r_specific * T),
            mu=2.0e-5,
            p_upstream=p1,
            temperature=T,
            gamma=gamma,
            r_specific=r_specific,
        )
        want = reference(Cv, mw, gamma, p1, T, bore)
        worst = max(worst, abs(valve.flow_ceiling(flow) - want) / want)
    check("worst error across 5 cases", worst * 100.0, 0.0, 1e-4, "%")

    liquid = FlowConditions(
        rho=1141.0, mu=1.9e-4, p_upstream=550 * PSI, temperature=90.0
    )
    lox_valve = build_component(
        ComponentInstance.build(
            "L",
            "valve",
            {
                "Cv": Param(26.1, "Cv", Provenance.ESTIMATED),
                "bore": Param(12.7, "mm", Provenance.MANUFACTURER),
            },
            model="cv",
        )
    )
    truthy(
        "a liquid valve still has no sonic ceiling",
        lox_valve.flow_ceiling(liquid) is None,
        True,
    )


# ------------------------------------------------------------------- 1.4 to 1.7
def tier1_thermal() -> None:
    from feedtwin.props import Fluid
    from feedtwin.vessels.geometry import CylindricalTank
    from feedtwin.vessels.tank import Tank, TankState
    from feedtwin.vessels.vapour import NoVapour, SaturatedVapour, latent_heat
    from feedtwin.vessels.volume import VesselState

    print("\n1.4  latent heats vs the handbook")
    check(
        "h_fg oxygen at 90 K",
        latent_heat(Fluid("oxygen"), 90.0) / 1e3,
        213.0,
        2.0,
        "kJ/kg",
    )
    check(
        "h_fg nitrogen at 77 K",
        latent_heat(Fluid("nitrogen"), 77.0) / 1e3,
        199.0,
        2.0,
        "kJ/kg",
    )
    check(
        "h_fg ethanol at 293 K",
        latent_heat(Fluid("ethanol"), 293.15) / 1e3,
        926.0,
        3.0,
        "kJ/kg",
    )

    lox, helium = Fluid("oxygen"), Fluid("helium")
    geometry = CylindricalTank(diameter=0.1524, barrel_length=0.531)

    def tank(**kw):
        return Tank(
            lox,
            helium,
            geometry,
            wall_mass=8.0,
            wall_capacity=900.0,
            wall_conductance=12.0,
            **kw,
        )

    def state(vapour_mass=0.0, wall=293.15):
        liquid_volume = 0.95 * geometry.total_volume
        ullage_volume = geometry.total_volume - liquid_volume
        rho = helium.get("rho", p=550 * PSI, T=200.0)
        return TankState(
            ullage=VesselState(
                mass=rho * ullage_volume,
                energy=rho * ullage_volume * helium.get("u", p=550 * PSI, T=200.0),
                wall_temperature=wall,
            ),
            liquid_mass=liquid_volume * lox.get("rho", T=90.0, q=0.0),
            liquid_temperature=90.0,
            contact_time=1.0,
            vapour_mass=vapour_mass,
        )

    print("\n1.5  boil-off is exactly q / h_fg")
    boiling = tank(vapour=SaturatedVapour()).rates(state())
    h_fg = latent_heat(lox, 90.0)
    check("interfacial heat", boiling.heat_to_liquid, 612.9, 1.0, "W")
    check("boil-off rate", boiling.evaporation * 1000.0, 2.874, 0.01, "g/s")
    check(
        "mdot - latent/h_fg",
        boiling.evaporation - boiling.latent_power / h_fg,
        0.0,
        1e-15,
    )
    check(
        "saturated liquid does not warm", boiling.liquid_temperature, 0.0, 1e-9, "K/s"
    )

    print("\n1.6  vapour partial pressure: positive, monotonic, linear")
    hot = tank(vapour=SaturatedVapour())
    previous, ok = 0.0, True
    for grams in (1e-6, 1e-4, 1e-3, 1e-2, 1e-1, 1.0, 5.0):
        partial = hot.vapour_pressure(state(vapour_mass=grams / 1000.0))
        if partial <= 0.0 or partial < previous:
            ok = False
        previous = partial
    truthy("positive and monotonic over 7 decades", ok, True)
    check(
        "1.0 g of oxygen in 0.531 L at 200 K",
        hot.vapour_pressure(state(vapour_mass=1e-3)) / PSI,
        14.16,
        0.1,
        "psi",
    )

    print("\n1.7  chilldown magnitudes")
    chilling = tank(vapour=SaturatedVapour(), wetted_conductance=50.0).rates(state())
    check("heat into the liquid", chilling.heat_to_wetted_wall, 2750.0, 150.0, "W")
    check("boil-off", chilling.evaporation * 1000.0, 15.8, 1.0, "g/s")
    check("wall cooling", chilling.ullage.wall_temperature, -0.537, 0.05, "K/s")

    print("\n4.1  vapour carries no foreign enthalpy into the ullage")
    dry = tank(vapour=NoVapour()).rates(state())
    wet = tank(vapour=SaturatedVapour()).rates(state())
    check(
        "ullage energy unchanged by vapour",
        (wet.ullage.energy - dry.ullage.energy) / abs(dry.ullage.energy),
        0.0,
        1e-12,
    )

    print("\n     defaults reproduce the pre-Phase-14 tank")
    plain = tank()
    exact("no vapour by default", plain.rates(state()).evaporation, 0.0, "kg/s")
    exact("no chilldown by default", plain.rates(state()).heat_to_wetted_wall, 0.0, "W")


# ------------------------------------------------------------------------- 2.3
def tier2_steady_fire() -> None:
    print("\n2.3  steady fire on the shipped stand")
    try:
        import backend.main as api
        import backend.study as study
        from backend.main import _cea_for, engine_from_bytes
    except Exception as exc:  # noqa: BLE001
        print(f"  [SKIP] feed-twin backend unavailable ({type(exc).__name__})")
        return
    engines = api.library.list("engine")
    if not engines or study.find_diagram(api.library, "gn2") is None:
        print("  [SKIP] the library has no engine or no gn2 study drawing")
        return

    engine = engines[0]
    design = engine_from_bytes(
        api.library.path(engine.id).read_bytes(), name=engine.name
    )
    session = study._stand(
        api.library, "gn2", engine.id, _cea_for(design), litres=None, collapse=False
    )
    session.state = "Fire"
    for _ in range(12):
        sample = session.step(0.05)
    net = session.model.built.network
    P, F = sample.pressures, sample.flows

    def drop(branch: str) -> float:
        b = net.branches[branch]
        return (P[b.upstream] - P[b.downstream]) / PSI

    ox, fuel = F.get("l_ox1", 0.0), F.get("l_fu1", 0.0)
    # Re-baselined 2026-09-10 when every stand-facing pressure became gauge:
    # the study primes the tanks at 550 psig, which is 564.7 psia where it had
    # been 550 psia, so the whole burn runs 14.7 psi higher in absolute terms
    # and chamber pressure follows (440.6 -> 452.1). The chamber value below is
    # absolute, as every pressure inside the model is.
    check("chamber pressure (abs)", sample.chamber.pressure / PSI, 452.1, 3.0, "psia")
    check("thrust", sample.chamber.thrust, 7730.0, 60.0, "N")
    check("total mass flow", ox + fuel, 3.131, 0.03, "kg/s")
    check("mixture ratio", ox / fuel, 1.695, 0.02)
    plumbing = drop("l_ox1") + drop("l_ox2")
    injector = drop("ENG.oxidiser.injector")
    check("ox plumbing dp", plumbing, 19.0, 2.0, "psi")
    check("ox injector dp", injector, 66.6, 3.0, "psi")
    truthy("the injector holds more than the plumbing", injector > plumbing, True)


def tier1_walls() -> None:
    """1.8  The line's own metal, and the icicles that gave it away."""
    import math

    from feedtwin.comps.wall import STAINLESS_DENSITY, LineWall, stainless_capacity

    print("\n1.8  stainless heat capacity vs NIST")
    check("316 cp at  77 K", stainless_capacity(77.0), 190.0, 1.0, "J/kg.K")
    check("316 cp at 100 K", stainless_capacity(100.0), 230.0, 1.0, "J/kg.K")
    check("316 cp at 293 K", stainless_capacity(293.0), 494.0, 1.0, "J/kg.K")
    check(
        "cp(293) / cp(77)",
        stainless_capacity(293.0) / stainless_capacity(77.0),
        2.6,
        0.1,
        "x",
    )

    bore, thickness = 0.010922, 0.000889
    outer = bore + 2.0 * thickness
    per_metre = math.pi / 4.0 * (outer**2 - bore**2) * STAINLESS_DENSITY
    check("1/2 in. x 0.035 wall tube", per_metre, 0.265, 0.02, "kg/m")

    print("\n1.9  wall exchange: NTU / effectiveness")
    line = LineWall(mass=0.4, area=math.pi * bore * 0.5, bore=bore)
    n2 = dict(
        density=50.0, viscosity=1.29e-5, conductivity=0.0185, heat_capacity=1080.0
    )
    warm = line.exchange(
        mdot=0.15, wall_temperature=293.0, inlet_temperature=200.0, **n2
    )
    # By hand, and the reason these are not "whatever it printed":
    #   Re = 4.mdot/(pi.d.mu) = 1.356e6,  Pr = cp.mu/k = 0.753
    #   Nu = 0.023 Re^0.8 Pr^0.4 = 1655,  h = Nu.k/d = 2803 W/m2K
    #   NTU = h.A/(mdot.cp) = 0.2967,     eff = 1 - exp(-NTU) = 0.2567
    check("effectiveness at 150 g/s", warm.effectiveness, 0.2567, 0.002)
    check("gas rise", warm.outlet_temperature - 200.0, 23.9, 0.3, "K")
    check(
        "Q = mdot.cp.dT",
        warm.heat - 0.15 * 1080.0 * (warm.outlet_temperature - 200.0),
        0.0,
        1e-9,
        "W",
    )

    still = line.exchange(
        mdot=0.0, wall_temperature=293.0, inlet_temperature=200.0, **n2
    )
    exact("no flow, no heat", still.heat, 0.0, "W")
    cold = line.exchange(
        mdot=0.15, wall_temperature=95.0, inlet_temperature=290.0, **n2
    )
    truthy(
        "a cold line chills the gas (frosting runs both ways)", cold.heat < 0.0, True
    )

    print("\n1.9b  the film coefficient against `ht`, not against itself")
    # CLAUDE.md: correlations are adapted, not invented. This one is written out
    # by hand in wall.py, so it has to be checked against the library every run.
    try:
        import ht
        from fluids.core import Prandtl, Reynolds

        velocity = 0.15 / (n2["density"] * math.pi * bore * bore / 4.0)
        re = Reynolds(V=velocity, D=bore, rho=n2["density"], mu=n2["viscosity"])
        pr = Prandtl(Cp=n2["heat_capacity"], mu=n2["viscosity"], k=n2["conductivity"])
        mine = 0.023 * re**0.8 * pr**0.4
        check(
            "vs ht.turbulent_Dittus_Boelter",
            100.0
            * (mine / ht.turbulent_Dittus_Boelter(Re=re, Pr=pr, heating=True) - 1.0),
            0.0,
            0.01,
            "%",
        )
        check(
            "vs ht.Nu_conv_internal (auto-selected)",
            100.0 * (mine / ht.Nu_conv_internal(Re=re, Pr=pr) - 1.0),
            0.0,
            3.0,
            "%",
        )
    except ImportError:
        print("  [SKIP] ht not installed")

    print("\n1.9c  lumped capacitance: where it holds and where it is knowingly wrong")
    # Bi = h.L/k. Under 0.1 the metal is isothermal; near 1 the core lags the
    # bore and the lumped wall over-credits the heat.
    h_film, k_316 = 2799.0, 15.0
    check("Bi across the 0.889 mm tube wall", h_film * 0.000889 / k_316, 0.17, 0.02)
    check("Bi across a 5 mm fitting body", h_film * 0.005 / k_316, 0.93, 0.05)
    truthy(
        "the tube is lumpable and the fittings are not",
        (h_film * 0.000889 / k_316 < 0.2) and (h_film * 0.005 / k_316 > 0.5),
        True,
    )
    alpha = k_316 / (STAINLESS_DENSITY * 500.0)
    check(
        "steel diffusion depth at 6 s", 1000.0 * math.sqrt(alpha * 6.0), 4.7, 0.2, "mm"
    )

    print("\n1.10  the icicle arithmetic: which path is worth modelling")
    mdot, cp = 0.15, 1080.0
    truthy(
        "path B (room, generously frosted at 32 W) under 0.25 K",
        32.0 / (mdot * cp) < 0.25,
        True,
    )
    truthy(
        "path A (the line's own 0.4 kg) over 1 K",
        warm.outlet_temperature - 200.0 > 1.0,
        True,
    )

    temperature, given = 293.0, 0.0
    for _ in range(120):
        step = line.exchange(
            mdot=mdot, wall_temperature=temperature, inlet_temperature=200.0, **n2
        )
        given += step.heat * 0.05
        temperature -= step.heat * 0.05 / line.capacity(temperature)
    # The wall relaxes toward the stream with tau = capacity/(eff.mdot.cp)
    #   = 187/(0.2567 x 162) = 4.50 s, so after 6 s it sits at
    #   200 + 93.exp(-6/4.5) = 224.5 K. Temperature-dependent cp moves it a
    #   kelvin below that, which is the point of having it.
    check("metal after a 6 s run", temperature, 223.6, 2.0, "K")
    held = line.capacity(0.5 * (293.0 + temperature)) * (293.0 - temperature)
    check("joules out == joules in", 100.0 * (given - held) / held, 0.0, 1.0, "%")


def main() -> int:
    print("=" * 78)
    print("physics benchmark -- docs/PHYSICS-BENCHMARK.md, tiers 1 and 2.3")
    print("=" * 78)
    tier1_lines()
    tier1_choking()
    tier1_thermal()
    tier1_walls()
    tier2_steady_fire()
    print("\n" + "=" * 78)
    if FAILURES:
        print(f"{len(FAILURES)} CHECK(S) FAILED")
        for line in FAILURES:
            print(f"  - {line}")
        print("\nThe sim is guilty until proven innocent. Do not adjust the expected")
        print("value until you can say why the physics moved.")
        return 1
    print("all checks passed")
    print("\nTier 2.1/2.2 (the He/GN2 study) is not run here -- it takes minutes.")
    print("Run it from the Study tab or backend.study.run_study at dt = 0.01.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

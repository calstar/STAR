"""Blowdown solver: per-tank polytropic n, Heun integration, and flameout handling (Phase 3.1/3.2).

Uses a synthetic ``evaluate_engine_fn`` so these are fast and deterministic — no CEA, no runner.
The synthetic engine reproduces the two behaviours that matter:
  * mdot falls as tank pressure falls (so the Euler over-drain bias is exercised), and
  * it RAISES below a floor pressure, exactly as the real chamber solver does
    ("No solution: Supply < Demand at all Pc"), which the solver must treat as flameout.
"""

import math
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from copv.blowdown_solver import simulate_coupled_blowdown  # noqa: E402

P_INIT = 3.0e6
P_FLAMEOUT = 1.0e6


def _config():
    return SimpleNamespace(
        fluids={
            "oxidizer": SimpleNamespace(density=1140.0),
            "fuel": SimpleNamespace(density=810.0),
        },
        injector=None,  # get_injector_area() falls back internally
    )


def _engine(mdot_ref=2.0, p_min=P_FLAMEOUT, coupled=True):
    """mdot ~ sqrt(dP); raises below p_min like the real chamber solver.

    ``coupled=True`` mimics reality: both streams key off the limiting tank, because chamber
    pressure is set by the combined flow. ``coupled=False`` gives each stream its own pressure,
    which is unphysical but lets a test isolate per-tank plumbing from genuine coupling.
    """

    def evaluate(P_lox, P_fuel):
        if min(P_lox, P_fuel) <= p_min:
            raise ValueError("No solution: Supply < Demand at all Pc")
        if coupled:
            P = min(P_lox, P_fuel)
            s_o = s_f = math.sqrt((P - p_min) / (P_INIT - p_min))
        else:
            s_o = math.sqrt((P_lox - p_min) / (P_INIT - p_min))
            s_f = math.sqrt((P_fuel - p_min) / (P_INIT - p_min))
        return mdot_ref * s_o, 0.5 * mdot_ref * s_f

    return evaluate


def _run(n_points=200, burn_s=5.0, n_lox=1.2, n_fuel=1.2, mdot_ref=2.0, vol=0.05, coupled=True):
    return simulate_coupled_blowdown(
        np.linspace(0.0, burn_s, n_points),
        _engine(mdot_ref=mdot_ref, coupled=coupled),
        P_INIT,
        P_INIT,
        _config(),
        n_polytropic_lox=n_lox,
        n_polytropic_fuel=n_fuel,
        use_real_gas=False,  # keep hermetic: no n2_Z_lookup.csv dependency
        lox_tank_volume_m3=vol,
        fuel_tank_volume_m3=vol,
        lox_propellant_mass_kg=30.0,
        fuel_propellant_mass_kg=15.0,
    )


def test_pressure_decays_monotonically_while_burning():
    h = _run()
    P = h["lox"]["P_Pa"]
    assert P[0] == pytest.approx(P_INIT), "curve must start at the Layer-1 anchor pressure"
    burning = ~h["engine_out"]
    dP = np.diff(P[burning])
    assert np.all(dP <= 1e-6), "tank pressure must decrease monotonically during the burn"
    assert np.all(np.diff(h["lox"]["V_ullage_m3"][burning]) >= -1e-12), "ullage must grow"


def test_higher_polytropic_n_decays_faster():
    """LOX sits on cryogenic liquid (heat sink) -> higher effective n -> faster decay.

    A shared n would make both tanks decay identically; this is the property that lets us model
    the LOX side conservatively.
    """
    soft = _run(n_lox=1.1)["lox"]["P_Pa"][-1]
    hard = _run(n_lox=1.4)["lox"]["P_Pa"][-1]
    assert hard < soft, (
        f"Higher polytropic n must decay faster: P_end(n=1.4)={hard:.0f} Pa should be below "
        f"P_end(n=1.1)={soft:.0f} Pa."
    )


def test_per_tank_n_is_wired_to_the_right_tank():
    """``n_polytropic_lox`` must drive the LOX tank only — a plumbing check.

    Uses the DECOUPLED engine deliberately. With the physical (coupled) engine, changing the LOX
    exponent legitimately moves the fuel tank too: LOX pressure feeds chamber pressure, which sets
    both streams' mdot, which changes how fast the fuel drains. That real coupling would mask a
    genuine plumbing bug, so we remove it here.
    """
    base = _run(n_lox=1.2, n_fuel=1.2, coupled=False)
    lox_only = _run(n_lox=1.45, n_fuel=1.2, coupled=False)
    assert lox_only["lox"]["P_Pa"][-1] < base["lox"]["P_Pa"][-1], "LOX exponent had no effect"
    assert lox_only["fuel"]["P_Pa"][-1] == pytest.approx(
        base["fuel"]["P_Pa"][-1], rel=1e-9
    ), "changing n_polytropic_lox must NOT reach the fuel tank"


def test_tanks_are_coupled_through_the_engine():
    """Sanity on the above: with the physical engine the tanks DO interact, as they must."""
    base = _run(n_lox=1.2, coupled=True)
    stiffer = _run(n_lox=1.45, coupled=True)
    assert stiffer["fuel"]["P_Pa"][-1] != pytest.approx(base["fuel"]["P_Pa"][-1], rel=1e-9), (
        "With a coupled engine, a faster-decaying LOX tank must change the fuel drain rate too."
    )


def test_heun_is_resolution_insensitive():
    """Second-order integration => a coarse grid must already agree with a fine one.

    The DE search runs at ~25 points; with forward Euler that carried a ~1% one-signed
    over-drain bias versus a fine grid. Heun should cut that to well under 0.5%.
    """
    coarse = _run(n_points=25)["lox"]["P_Pa"][-1]
    fine = _run(n_points=800)["lox"]["P_Pa"][-1]
    rel = abs(coarse - fine) / fine
    assert rel < 5e-3, (
        f"Coarse-grid (25 pt) end pressure {coarse:.0f} Pa differs from fine-grid (800 pt) "
        f"{fine:.0f} Pa by {rel:.3%}; expected <0.5% with predictor-corrector integration."
    )


def test_flameout_when_chamber_solver_cannot_close():
    """The real chamber solver raises once tank pressure is too low. That is a flameout, not a
    crash: the sim must survive, latch engine_out, and stop consuming propellant."""
    # Small ullage + high flow -> pressure craters through P_FLAMEOUT during the burn.
    h = _run(burn_s=30.0, mdot_ref=6.0, vol=0.033)

    assert h["engine_out"].any(), (
        "Expected the synthetic engine to stop closing as pressure decayed below "
        f"{P_FLAMEOUT:.0f} Pa, latching engine_out."
    )
    # Once out, stays out (pressure only falls further).
    first_out = int(np.argmax(h["engine_out"]))
    assert h["engine_out"][first_out:].all(), "engine_out must latch, not flicker"
    # And no propellant is consumed after flameout.
    m_after = h["lox"]["m_prop_kg"][first_out:]
    assert np.all(np.diff(m_after) >= -1e-9), "propellant must not drain after flameout"


def test_real_bugs_are_not_misread_as_flameout():
    """A genuine defect must PROPAGATE, not be silently reclassified as end-of-burn.

    The flameout catch keys on the chamber solver's "no solution / supply < demand" message. A
    TypeError from an actual bug shares nothing with that and must escape — otherwise the search
    would quietly treat broken candidates as "burn ended early", which is the silent-failure
    pattern this codebase has been bitten by repeatedly.
    """

    def broken(P_lox, P_fuel):
        raise TypeError("simulated bug in the engine model")

    with pytest.raises(TypeError, match="simulated bug"):
        simulate_coupled_blowdown(
            np.linspace(0.0, 5.0, 20),
            broken,
            P_INIT,
            P_INIT,
            _config(),
            use_real_gas=False,
            lox_tank_volume_m3=0.05,
            fuel_tank_volume_m3=0.05,
            lox_propellant_mass_kg=30.0,
            fuel_propellant_mass_kg=15.0,
        )


def test_no_solution_classifier_matches_the_real_message():
    from copv.blowdown_solver import is_no_solution_error

    real = ValueError(
        "No solution: Supply < Demand at all Pc. Residual at bounds: [-0.03, -1.10] kg/s. "
        "Insufficient mass flow. Check tank pressures and injector geometry."
    )
    assert is_no_solution_error(real) is True
    assert is_no_solution_error(TypeError("bad operand")) is False
    assert is_no_solution_error(ValueError("some unrelated validation failure")) is False


def test_start_pressure_that_cannot_light_is_handled():
    """If the engine cannot close even at the start pressure, return cleanly rather than raise."""
    h = simulate_coupled_blowdown(
        np.linspace(0.0, 5.0, 50),
        _engine(p_min=P_INIT * 1.5),  # floor above the start pressure
        P_INIT,
        P_INIT,
        _config(),
        use_real_gas=False,
        lox_tank_volume_m3=0.05,
        fuel_tank_volume_m3=0.05,
        lox_propellant_mass_kg=30.0,
        fuel_propellant_mass_kg=15.0,
    )
    assert h["engine_out"].all() or h["lox"]["mdot_kg_s"][0] == 0.0
    assert np.all(np.isfinite(h["lox"]["P_Pa"])), "pressure history must stay finite"

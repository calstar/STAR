"""Smoke test for the full multi-layer optimization orchestrator.

``run_full_engine_optimization_with_flight_sim`` (``engine/optimizer/main_optimizer.py``)
is the Streamlit/CLI "full optimize" entrypoint that chains Layers 1-4. It has no other
test coverage, and a use-before-assignment ``NameError`` (``max_lox_P_psi``) once made it
crash on *every* run right after Layer 1 — invisible to CI because nothing exercised it
(the backend/React path calls the layers directly).

This test stubs the heavy layer entrypoints and drives the orchestrator end-to-end with
``use_time_varying=False`` so the *glue* between layers — variable plumbing, the sample-based
interpolation fallback, and the final result assembly — is exercised in well under a second
without running a real optimization or touching CEA. It guards against that whole class of
orchestration-wiring regression (NameError / TypeError / bad result shape), which static
linting alone cannot fully cover (e.g. wrong call signatures).
"""

import pytest
from unittest.mock import patch, MagicMock

# The orchestrator imports the Streamlit/RocketPy/plotly UI chain at import time. These are
# installed in CI (requirements-ci.txt); skip cleanly if a minimal local env lacks them.
mo = pytest.importorskip("engine.optimizer.main_optimizer")
from engine.pipeline.io import load_config

CANONICAL_CONFIG = "configs/canonical/impinging.yaml"


def _fake_layer1(**kwargs):
    """Stand in for run_layer1_optimization: return a real config + minimal results dict."""
    cfg = load_config(CANONICAL_CONFIG)
    layer1_results = {
        "performance": {
            "F": 7000.0,
            "initial_thrust_error": 0.05,
            "initial_MR_error": 0.05,
            "pressure_candidate_valid": True,
        },
        "optimized_pressure_curves": {"lox_start_psi": 500.0, "fuel_start_psi": 500.0},
        "iteration_history": [],
        "convergence_info": {},
    }
    return cfg, layer1_results


def test_full_orchestrator_wiring_smoke():
    """The orchestrator runs entry -> Layer 1 -> result assembly without raising."""
    cfg = load_config(CANONICAL_CONFIG)

    # Stubbed runner: evaluate() returns a real numeric dict so the sample-based
    # interpolation fallback (interp1d over sampled thrust/Isp/Pc) gets real arrays.
    runner_stub = MagicMock()
    runner_stub.evaluate.return_value = {
        "F": 7000.0, "Isp": 250.0, "Pc": 2.0e6,
        "mdot_O": 1.0, "mdot_F": 0.4, "mdot_total": 1.4, "MR": 2.5,
    }

    requirements = {"target_thrust": 7000.0, "target_apogee": 3048.0, "optimal_of_ratio": 2.55}
    tolerances = {"thrust": 0.10, "apogee": 0.15}
    pressure_config = {
        "lox_start_psi": 500.0, "fuel_start_psi": 500.0,
        "max_lox_pressure_psi": 600.0, "max_fuel_pressure_psi": 600.0,
    }

    with patch.object(mo, "run_layer1_optimization", side_effect=_fake_layer1), \
         patch.object(mo, "PintleEngineRunner", return_value=runner_stub):
        out_cfg, results = mo.run_full_engine_optimization_with_flight_sim(
            config_obj=cfg,
            runner=runner_stub,
            requirements=requirements,
            target_burn_time=10.0,
            max_iterations=1,
            tolerances=tolerances,
            pressure_config=pressure_config,
            use_time_varying=False,
        )

    # Return contract: (config, results dict). The tail assembly — which lives past the
    # line that used to NameError — must run and stamp the pressure-curve config.
    assert out_cfg is not None
    assert isinstance(results, dict)
    assert "pressure_curve_config" in results

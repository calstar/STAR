"""Guardrail: the chug gate must come from the PHYSICAL stability model and must respond to
injector stiffness.

Regression cover for two defects found 2026-07-21:

  1. A heuristic chug "stability index" (Pc x L* x frequency-band, floored at 0.4 and mapped
     ``margin = index*1.5 + 0.4`` so the minimum achievable margin was 1.0) used to supply the
     chug margin. It was structurally blind to injector stiffness -- the dominant chug driver --
     and could not fail a real design.

  2. ``compute_physical_stability`` was wrapped in a bare ``try/except`` that fell back to
     neutral ~1.10 margins, so a stability-model failure silently PASSED the design.

These tests run the real canonical config (no mocks) so they exercise the actual live path.
"""

import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

PSI = 6894.757
CONFIG = ROOT / "configs" / "canonical" / "impinging.yaml"

# Two operating points on the canonical engine. Lower tank pressure -> lower mdot -> lower
# dP_inj/Pc -> the injector stiffness that drives chug degrades.
P_HIGH_PSI = 500.0
P_LOW_PSI = 450.0


@pytest.fixture(scope="module")
def stability_by_psi():
    """Evaluate once per operating point and share across tests (each eval is a few seconds)."""
    cwd = os.getcwd()
    os.chdir(ROOT)
    try:
        runner = PintleEngineRunner(load_config(str(CONFIG)))
        out = {}
        for psi in (P_HIGH_PSI, P_LOW_PSI):
            res = runner.evaluate(psi * PSI, psi * PSI, silent=True)
            out[psi] = res.get("stability") or res.get("stability_results") or {}
        return out
    finally:
        os.chdir(cwd)


def test_chug_margin_comes_from_physical_model(stability_by_psi):
    """The margin must be physically derived, not the fail-safe fallback."""
    st = stability_by_psi[P_HIGH_PSI]
    source = st.get("stability_source")
    assert source in ("native", "python"), (
        "The chug margin must be produced by the physical stability model. "
        f"stability_source={source!r}. 'fallback_failsafe' means compute_physical_stability "
        "threw, so the margin is not physically derived."
    )


def test_raw_gain_margin_is_reported(stability_by_psi):
    """The raw Nyquist gain margin must be surfaced, not only the squashed gate margin.

    The gate margin is ``1 + 0.30*tanh((GM-0.80)/0.20)``: it saturates at ~1.2999 for any
    GM >~ 1.3, so it cannot be reasoned about quantitatively. GM is the physical number.
    """
    gm = stability_by_psi[P_HIGH_PSI].get("chugging", {}).get("chug_gain_margin")
    assert gm is not None and np.isfinite(gm), (
        "chug_gain_margin (raw Nyquist gain margin, >1 == stable) must be reported alongside "
        f"the squashed gate margin. Got {gm!r}."
    )


def test_chug_margin_responds_to_injector_stiffness(stability_by_psi):
    """Degrading injector stiffness must degrade the chug margin.

    This is precisely the property the removed heuristic lacked. If this assertion fails, the
    chug gate has become blind to its dominant driver again -- which is how a blowdown design
    could sail through the gate while chugging at end of burn.
    """
    gm_high = stability_by_psi[P_HIGH_PSI]["chugging"]["chug_gain_margin"]
    gm_low = stability_by_psi[P_LOW_PSI]["chugging"]["chug_gain_margin"]

    assert np.isfinite(gm_high) and np.isfinite(gm_low), (
        f"Both gain margins must be finite. high={gm_high!r} low={gm_low!r}"
    )
    assert gm_low < gm_high, (
        "Chug gain margin must DEGRADE as injector stiffness degrades (lower tank pressure -> "
        f"lower mdot -> lower dP_inj/Pc). GM({P_HIGH_PSI:.0f} psi)={gm_high:.4f}, "
        f"GM({P_LOW_PSI:.0f} psi)={gm_low:.4f}. No response means the gate is blind to the "
        "dominant chug driver."
    )

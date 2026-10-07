"""The supply-pressure effect, measured from zero inlet.

``outlet = dome + bias - S x inlet``, the inlet in gauge: a 1092-50 loaded to
500 psi with 4,500 psi behind it at 17 psi per 1000 holds 473.5 psi, and comes
up as the bottle falls (the team, 2026-10-07). It used to be measured from a
datum -- a drawn ``inlet_reference``, or the COPV charge -- which zeroed it at a
full bottle; the study drawings declare one, 4,500 psi, and it is no longer
read.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

STAR = Path(__file__).resolve().parents[3]
HE = STAR / "feed-twin" / "backend" / "diagrams" / "copv_study_he.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"


def _drawing(datum: bool) -> dict:  # type: ignore[type-arg]
    raw = json.loads(HE.read_text())
    if datum:
        return raw
    raw = copy.deepcopy(raw)
    for node in raw["nodes"]:
        node["data"].get("params", {}).pop("inlet_reference", None)
    return raw


def _lockup(datum: bool, copv_psi: float) -> dict[str, float]:
    from feedtwin.pid import read_diagram
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import burn_setup, jump_to_t0, open_session

    model = assemble_model(read_diagram(_drawing(datum), name="he"), diagram_id="he")
    session = open_session(
        model, load_machine(tables=TABLES), setup=burn_setup(dome_psi=500.0)
    )
    return jump_to_t0(session, copv_psi=copv_psi, fill_fraction=0.95).lockup_psi


@pytest.mark.skipif(
    not (HE.exists() and TABLES.is_dir()), reason="helium drawing or tables absent"
)
def test_t0_lockup_is_dome_plus_bias_less_the_bottle() -> None:
    """Dome 500 + the 1092-50's 50 - 17 x 4.5 at a 4,500 psig bottle; 34 psi
    higher off a 2,500 psig one."""
    full = _lockup(True, 4500.0)
    half = _lockup(True, 2500.0)
    assert full and set(full) == set(half)
    for tank, psig in full.items():
        assert psig == pytest.approx(500.0 + 50.0 - 17.0 * 4.5, abs=0.5), tank
        assert half[tank] - psig == pytest.approx(17.0 * 2.0, abs=0.05), tank


@pytest.mark.skipif(
    not (HE.exists() and TABLES.is_dir()), reason="helium drawing or tables absent"
)
def test_a_drawn_inlet_reference_changes_nothing() -> None:
    assert _lockup(True, 3000.0) == _lockup(False, 3000.0)

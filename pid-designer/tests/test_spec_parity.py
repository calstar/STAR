"""`spec.ts` is a hand-maintained mirror of `components.toml`. Keep it honest.

The drawing tool declares what a component's fields are in TypeScript, and the
physics library declares the same thing in TOML. Nothing links them, so a
parameter added to the catalogue simply never appears in the UI -- which is
exactly what happened to the line-wall model: `wall_thickness` and
`fitting_mass` were catalogued, read by the solver, and unreachable from the
drawing tool, so the only way to set them was to hand-edit JSON.

This test is the link. It fails when the two drift.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "lib" / "feedtwin" / "feedtwin" / "model" / "components.toml"
SPEC = ROOT / "pid-designer" / "frontend" / "src" / "components" / "pid" / "spec.ts"

#: Catalogue entries the drawing tool is not expected to expose, with the reason.
#: Anything not listed here has to be reachable from the UI.
NOT_DRAWN = {
    # Solver-facing, chosen by the model rather than typed by a user.
    "model",
    # Second-order for a full-open ball valve; feed-twin's IEC defaults stand
    # and its report says they are assumed. Not a person-on-the-stand number.
    "xT", "FL", "leak_closed", "leak_reverse",
    # Regulator datasheet lines the team does not have and the solver defaults
    # sensibly: droop, its rated flow, lockup creep, dropout.
    "flow_droop", "rated_flow", "lockup_rise", "min_inlet_differential",
    # Check valves on this stand have no stated cracking pressure.
    "cracking_pressure",
    # Estimated by feed-twin from the ullage gas and the vessel (Phase 2); a
    # drawing may still carry a custom value, but it is not asked for.
    "wall_conductance",
    # Written by pid-designer from the material dropdown, never typed.
    "wall_capacity",
    # Vessel temperature is nominal on the drawing and optional.
    "temperature",
}


def catalogue() -> dict[str, set[str]]:
    if not CATALOG.exists():
        pytest.skip("components.toml is not present")
    data = tomllib.loads(CATALOG.read_text())
    out: dict[str, set[str]] = {}
    for name, body in data.items():
        params = body.get("params")
        if isinstance(params, dict):
            out[name] = set(params) - NOT_DRAWN
    return out


def spec_text() -> str:
    if not SPEC.exists():
        pytest.skip("spec.ts is not present")
    return SPEC.read_text()


@pytest.mark.parametrize("line", ["pipe", "flex_hose"])
def test_every_catalogued_line_param_is_reachable_in_the_ui(line: str) -> None:
    """A parameter the solver reads but the tool cannot set is invisible.

    It is worse than missing: the value silently stays at its default, the run
    completes, and the number that was never entered looks like a modelling
    result.
    """
    params = catalogue().get(line)
    if not params:
        pytest.skip(f"no {line} in the catalogue")
    text = spec_text()
    missing = sorted(p for p in params if f"'{p}'" not in text)
    assert not missing, (
        f"{line}: catalogued but unreachable from the drawing tool: "
        f"{', '.join(missing)}. Add them to LINE_SPECS in spec.ts."
    )


def test_the_thermal_params_specifically() -> None:
    """Named, because these are the ones it happened to."""
    text = spec_text()
    for param in ("wall_thickness", "fitting_count", "fitting_mass"):
        assert f"'{param}'" in text, f"{param} is not settable on a line"


def test_tank_wall_is_a_material_and_a_dry_mass() -> None:
    """The wall is what decides how much a vessel cools on blowdown. It used
    to be three bare numbers; now a tank states a material (which writes the
    specific heat) and a dry mass, and feed-twin estimates the conductance.
    Bottles and dewars carry none of it: they are boundaries."""
    text = spec_text()
    start = text.index("TANK: {")
    block = text[start : text.index("\n  },", start)]
    assert "'material'" in block, "TANK has no material dropdown"
    assert "'wall_mass'" in block, "TANK cannot declare its dry mass"
    assert "'wall_capacity'" in block, "TANK does not write wall_capacity from the material"
    for symbol in ("KBOTTLE: {", "DEWAR: {"):
        s2 = text.index(symbol)
        b2 = text[s2 : text.index("\n  },", s2)]
        assert "'wall_" not in b2, f"{symbol[:-3]} should not ask about its wall"


def test_spec_dimensions_are_ones_feedtwin_knows() -> None:
    """A dimension the unit table has never heard of cannot be converted."""
    units = ROOT / "lib" / "feedtwin" / "feedtwin" / "model" / "units.py"
    if not units.exists():
        pytest.skip("units.py is not present")
    known = set(re.findall(r'_u\("[^"]+",\s*"(\w+)"', units.read_text()))
    used = set(re.findall(r"P\('[\w]+',\s*'[^']*',\s*'(\w+)'", spec_text()))
    unknown = sorted(used - known - {"dimensionless"})
    assert not unknown, f"spec.ts uses dimensions feedtwin cannot convert: {unknown}"


#: Which drawing symbols stand for which catalogue components. The reader's
#: own table (`feedtwin.pid.network.BRANCH_KINDS`), restated here so this test
#: does not import the physics library to check a text file.
SYMBOL_OF = {
    "regulator": "PR",
    "valve": "MAN",
    "check_valve": "CV",
}


@pytest.mark.parametrize("component", sorted(SYMBOL_OF))
def test_every_catalogued_inline_param_is_reachable_in_the_ui(component: str) -> None:
    """The regulator is why this exists.

    `spec.ts` carried `supply_effect_out` and `supply_effect_in` -- two fields
    feed-twin never read, under names that appear nowhere in the catalogue --
    while `flow_droop`, `rated_flow`, `supply_coefficient` and
    `inlet_reference`, which it does read, were not settable at all. A
    datasheet number typed into the dialog went nowhere, and a regulator with
    no droop is one feed-twin cannot solve transiently. The line params were
    already guarded; the inline ones were not.
    """
    params = catalogue().get(component)
    if not params:
        pytest.skip(f"no {component} in the catalogue")
    text = spec_text()
    missing = sorted(p for p in params if f"'{p}'" not in text)
    assert not missing, (
        f"{component} ({SYMBOL_OF[component]}): catalogued but unreachable from "
        f"the drawing tool: {', '.join(missing)}. Add them to COMPONENT_SPECS."
    )


def test_spec_declares_no_param_the_catalogue_lacks_for_the_regulator() -> None:
    """The other direction: a field the drawing offers that the solver ignores
    is a number somebody typed that went nowhere. Regulator only, because that
    is where it happened; the tank carries drawing-side fields (MAWP) on
    purpose."""
    text = spec_text()
    start = text.index("PR: {")
    block = text[start : text.index("\n  },", start)]
    declared = set(re.findall(r"[PAD]\('(\w+)'", block))
    known = catalogue().get("regulator", set()) | {"model"}
    orphans = sorted(declared - known)
    assert not orphans, f"PR offers fields feed-twin never reads: {orphans}"

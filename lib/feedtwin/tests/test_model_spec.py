"""Component declarations: validation, fidelity models, and round-tripping.

Two exit criteria of Phase 02 live here -- a configuration round-trips
identically, and a component's schema is data rather than code. The rest is
validation: every check that can be made without solving anything, made at load
time, with all failures reported together.
"""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest

from feedtwin.model import (
    ComponentInstance,
    ComponentSpec,
    Param,
    ParamSpec,
    PortSpec,
    Provenance,
    SpecError,
    default_param,
    get_component_spec,
    load_component_specs,
    register_component_spec,
    registered_component_types,
)

MANUF = Provenance.MANUFACTURER


def _pipe(**overrides: Param) -> dict[str, Param]:
    params: dict[str, Param] = {
        "length": Param(0.5, "m", MANUF, "drawing"),
        "bore": Param(7.75, "mm", MANUF, "3/8 in. x 0.035 wall"),
    }
    params.update(overrides)
    return params


# --------------------------------------------------------------- shipped specs


def test_component_schemas_are_data() -> None:
    """The shipped declarations come from components.toml, not from Python.

    The same guard the species registry has: someone adds a component type by
    writing it into code because that felt quicker, and the data path quietly
    becomes decorative.
    """
    import tomllib

    from feedtwin.model import spec as spec_module

    table = Path(spec_module.__file__).with_name("components.toml")
    with table.open("rb") as handle:
        declared = set(tomllib.load(handle))

    assert {"pipe", "orifice", "valve"} <= declared
    assert declared <= set(registered_component_types())


def test_a_shipped_spec_describes_itself_completely() -> None:
    """Enough for a UI to render an editor without knowing what a pipe is."""
    described = get_component_spec("pipe").to_dict()

    assert described["type"] == "pipe"
    assert described["description"]
    assert [p["name"] for p in described["ports"]] == ["inlet", "outlet"]

    bore = next(p for p in described["params"] if p["name"] == "bore")
    assert bore["dimension"] == "length"
    assert bore["si_unit"] == "m"
    assert bore["required"] is True
    assert bore["description"]


# ------------------------------------------------------------------ validation


def test_defaults_are_filled_and_tagged_as_defaults() -> None:
    line = ComponentInstance.build("FL-01", "pipe", _pipe())
    assert line.params["roughness"].source is Provenance.DEFAULT
    assert "roughness" in line.assumptions()


def test_a_missing_required_parameter_is_named() -> None:
    with pytest.raises(SpecError, match="'bore' is required"):
        ComponentInstance.build(
            "FL-01", "pipe", {"length": Param(0.5, "m", MANUF, "drawing")}
        )


def test_all_problems_are_reported_at_once() -> None:
    """Six errors at a time beats six edit-run cycles."""
    with pytest.raises(SpecError) as excinfo:
        ComponentInstance.build(
            "FL-01",
            "pipe",
            {
                "bore": Param(500.0, "psi", MANUF, "wrong dimension"),
                "nonsense": Param(1.0, "m", MANUF, "not a pipe parameter"),
            },
        )
    message = str(excinfo.value)
    assert "length" in message  # missing
    assert "nonsense" in message  # unknown
    assert "pressure" in message  # wrong dimension


def test_a_wrong_dimension_is_caught_before_any_physics() -> None:
    with pytest.raises(SpecError, match="expected a length but 'psi' is a pressure"):
        ComponentInstance.build(
            "FL-01", "pipe", _pipe(bore=Param(500.0, "psi", MANUF, "oops"))
        )


def test_bounds_are_enforced_in_canonical_units() -> None:
    """A negative bore fails at load, not inside a Reynolds number."""
    with pytest.raises(SpecError, match="below the minimum"):
        ComponentInstance.build(
            "FL-01", "pipe", _pipe(bore=Param(-3.0, "mm", MANUF, "typo"))
        )

    with pytest.raises(SpecError, match="above the maximum"):
        ComponentInstance.build(
            "OR-01",
            "orifice",
            {
                "bore": Param(1.0, "mm", MANUF, "d"),
                "pipe_bore": Param(8.0, "mm", MANUF, "D"),
                "Cd": Param(1.4, "-", MANUF, "impossible"),
            },
        )


def test_an_unknown_component_type_lists_what_exists() -> None:
    with pytest.raises(SpecError, match="registered"):
        ComponentInstance.build("X-01", "flux_capacitor", {})


# -------------------------------------------------------------- fidelity models


def test_a_model_only_needs_its_own_parameters() -> None:
    """An orifice using ISO 5167 is not asked for a discharge coefficient.

    Cd belongs to the 'cd' model; the 'iso5167' model computes it from geometry
    and Reynolds number. Asking for it anyway would force a value that is then
    silently ignored -- the worst kind of parameter.
    """
    geometry = {
        "bore": Param(2.0, "mm", MANUF, "throat"),
        "pipe_bore": Param(8.0, "mm", MANUF, "line"),
    }
    iso = ComponentInstance.build("OR-01", "orifice", geometry, model="iso5167")
    assert "Cd" not in iso.params

    cd = ComponentInstance.build("OR-02", "orifice", geometry, model="cd")
    assert cd.params["Cd"].source is Provenance.DEFAULT


def test_an_unknown_model_is_rejected() -> None:
    with pytest.raises(SpecError, match="unknown model"):
        ComponentInstance.build("FL-01", "pipe", _pipe(), model="handwaving")


def test_a_spec_cannot_reference_a_model_it_does_not_declare() -> None:
    with pytest.raises(SpecError, match="unknown model"):
        ComponentSpec(
            type="broken",
            description="",
            models=("a",),
            params=(ParamSpec("x", "length", "", models=("b",)),),
        )


def test_duplicate_parameters_are_rejected() -> None:
    with pytest.raises(SpecError, match="duplicate"):
        ComponentSpec(
            type="broken",
            description="",
            params=(ParamSpec("x", "length", ""), ParamSpec("x", "mass", "")),
        )


# ---------------------------------------------------------------- round-tripping


def test_an_instance_round_trips_through_json_identically() -> None:
    """Phase 02's round-trip criterion.

    Through JSON specifically -- an in-memory copy would not catch a field that
    serialises but does not deserialise.
    """
    original = ComponentInstance.build(
        "SOL-01",
        "valve",
        {
            "Cv": Param(1.2, "Cv", MANUF, "SS-8BK-V51 rev C"),
            "bore": Param(0.375, "in", MANUF, "datasheet"),
        },
        model="cv",
        connections={"inlet": "n3", "outlet": "n4"},
    )

    restored = ComponentInstance.from_dict(json.loads(json.dumps(original.to_dict())))

    assert restored.to_dict() == original.to_dict()
    assert restored.params == original.params
    assert restored.connections == original.connections
    assert restored.model == original.model


def test_authored_units_survive_the_round_trip() -> None:
    """A file written in inches comes back in inches, not in converted floats."""
    line = ComponentInstance.build(
        "FL-01", "pipe", _pipe(length=Param(18.0, "in", MANUF, "tape"))
    )
    restored = ComponentInstance.from_dict(line.to_dict())
    assert restored.params["length"].unit == "in"
    assert restored.params["length"].value == 18.0
    assert restored.si("length") == pytest.approx(0.4572)


def test_round_trip_preserves_provenance_and_references() -> None:
    """Provenance lost on the first save is provenance that does not exist."""
    line = ComponentInstance.build(
        "FL-01",
        "pipe",
        _pipe(bore=Param(7.75, "mm", Provenance.MEASURED, "calipers, 2026-09-08")),
    )
    restored = ComponentInstance.from_dict(line.to_dict())
    assert restored.params["bore"].source is Provenance.MEASURED
    assert restored.params["bore"].reference == "calipers, 2026-09-08"


# ------------------------------------------------------------------- extension


def test_a_component_type_can_be_declared_from_outside(tmp_path: Path) -> None:
    """A project adds a component type without editing this package."""
    table = tmp_path / "extra_components.toml"
    table.write_text(textwrap.dedent("""
            [burst_disc]
            description = "A one-shot pressure relief."
            models = ["ideal"]

            [burst_disc.ports.inlet]
            description = "Upstream."

            [burst_disc.params.burst_pressure]
            dimension = "pressure"
            description = "Differential pressure at which it opens."
            minimum = 0.0
            """))

    loaded = load_component_specs(table)
    assert [s.type for s in loaded] == ["burst_disc"]

    disc = ComponentInstance.build(
        "BD-01",
        "burst_disc",
        {"burst_pressure": Param(1200.0, "psi", MANUF, "datasheet")},
    )
    assert disc.si("burst_pressure") == pytest.approx(8273708.75, rel=1e-6)


def test_a_component_type_can_be_registered_in_code() -> None:
    register_component_spec(
        ComponentSpec(
            type="test_filter",
            description="A filter element.",
            models=("clean",),
            ports=(PortSpec("inlet", "Up"), PortSpec("outlet", "Down")),
            params=(
                ParamSpec(
                    "clean_dp",
                    "pressure",
                    "Pressure drop when clean at rated flow.",
                    default=default_param(2.0, "psi", "illustrative"),
                ),
            ),
        )
    )
    element = ComponentInstance.build("FIL-01", "test_filter", {})
    assert element.params["clean_dp"].source is Provenance.DEFAULT


def test_unconnected_fluid_ports_are_reported() -> None:
    """A dead end is a singular system; naming it beats a linear-algebra error."""
    line = ComponentInstance.build(
        "FL-01", "pipe", _pipe(), connections={"inlet": "n1"}
    )
    assert line.unconnected_ports() == ["outlet"]


def test_signal_ports_are_not_expected_to_be_plumbed() -> None:
    """A valve's command port is not a leak."""
    valve = ComponentInstance.build(
        "SOL-01",
        "valve",
        {"Cv": Param(1.2, "Cv", MANUF, "d"), "bore": Param(0.375, "in", MANUF, "d")},
        connections={"inlet": "n1", "outlet": "n2"},
    )
    assert valve.unconnected_ports() == []

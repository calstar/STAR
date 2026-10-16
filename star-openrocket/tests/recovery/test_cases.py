"""§11.5 case construction past two devices.

The cases used to be "main fails" and "drogue fails", with the main guessed as
the largest CdS and the drogue as the first to fire. On a three-chute design
(drogue, small main, big main) "drogue fails" kept only the big main -- the
small main vanished with the drogue -- and opened it out of free fall at 1 MN.
A single-point failure is one device failing, so each case drops exactly one.
"""

import json
import os

import pytest

from physics.cases import build_case, case_ids, case_label, evaluate_all
from physics.schema import Config, TriggerKind

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "worked_example.json")


def three_chutes():
    """The worked vehicle with a second main between the drogue and the main,
    smaller than it and higher, as LE4 SD carries."""
    with open(FIXTURE, encoding="utf-8") as handle:
        raw = json.load(handle)
    drogue, main = raw["devices"]
    small = dict(main, name="small main", CdS=main["CdS"] / 4,
                 trigger={"kind": "ALTITUDE",
                          "value": main["trigger"]["value"] * 2})
    raw["devices"] = [drogue, small, dict(main, name="big main")]
    return Config.model_validate(raw)


def test_one_failure_case_per_device():
    config = three_chutes()
    assert case_ids(config.devices) == [
        "nominal", "simultaneous", "fail:0", "fail:1", "fail:2"]
    assert [case_label(config.devices, c)
            for c in case_ids(config.devices)[2:]] == [
        "drogue fails", "small main fails", "big main fails"]


@pytest.mark.parametrize("i", [0, 1, 2])
def test_a_failure_drops_exactly_that_device(i):
    config = three_chutes()
    names = [d.name for d in config.devices]
    kept = [d.name for d in build_case(config.devices, "fail:%d" % i)]
    assert kept == names[:i] + names[i + 1:]


def test_simultaneous_fires_every_device_at_the_first_trigger():
    config = three_chutes()
    first = config.devices[0].trigger
    for d in build_case(config.devices, "simultaneous"):
        assert d.trigger.kind is first.kind is TriggerKind.TIME
        assert d.trigger.value == first.value


def test_build_case_never_mutates_its_input():
    config = three_chutes()
    before = [d.model_dump() for d in config.devices]
    for c in case_ids(config.devices):
        build_case(config.devices, c)
    assert [d.model_dump() for d in config.devices] == before


def test_unknown_cases_are_refused():
    config = three_chutes()
    for bad in ("no_main", "no_drogue", "fail:3", "fail:x"):
        with pytest.raises(ValueError):
            build_case(config.devices, bad)


def test_three_chute_cases_all_run():
    results = evaluate_all(three_chutes(), "axial")
    assert list(results) == case_ids(three_chutes().devices)
    # The drogue failing leaves BOTH mains: the small one opens first.
    fired = [d.name for d in results["fail:0"].per_device if d.fired]
    assert fired == ["small main", "big main"]


def test_more_than_six_devices_is_refused():
    """Six keeps the cases to two rows of four buttons in the GUI."""
    from pydantic import ValidationError

    raw = three_chutes().model_dump(mode="json")
    base = raw["devices"][0]
    raw["devices"] = [dict(base, name="chute %d" % i) for i in range(6)]
    Config.model_validate(raw)
    raw["devices"].append(dict(base, name="chute 6"))
    with pytest.raises(ValidationError, match="at most 6"):
        Config.model_validate(raw)

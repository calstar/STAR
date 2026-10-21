"""The Configuration tab's section list (GET /api/config/parameters, engine/pipeline/parameter_registry).

Two sections were both labelled "Propellants" (fluids and propellant_preset), and the legacy
chamber/nozzle blocks and the app's own staleness stamp were listed beside the live sections as
if a person should fill them in.
"""

from pathlib import Path

from engine.pipeline.io import load_config
from engine.pipeline.parameter_registry import INTERNAL_SECTIONS, LEGACY_SECTIONS, SECTIONS, config_parameters

ROOT = Path(__file__).resolve().parents[1]


def test_section_labels_are_unique():
    labels = [label for _, label in SECTIONS]
    assert len(labels) == len(set(labels)), labels


def test_sections_say_which_are_legacy_and_internal():
    out = config_parameters(load_config(ROOT / "configs" / "default.yaml"))
    by_key = {s["key"]: s for s in out["sections"]}
    assert len({s["label"] for s in out["sections"]}) == len(out["sections"])
    for key, s in by_key.items():
        assert s["legacy"] is (key in LEGACY_SECTIONS)
        assert s["internal"] is (key in INTERNAL_SECTIONS)
    assert by_key["fluids"]["legacy"] is False and by_key["fluids"]["internal"] is False
    if "chamber" in by_key:
        assert by_key["chamber"]["legacy"] is True

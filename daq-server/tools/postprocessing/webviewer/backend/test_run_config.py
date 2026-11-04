"""Unit tests for the per-run config snapshot → human names.

The entity spellings asserted here are the ones DatabaseConfig.cpp actually writes, and
the slot arithmetic is LoadActiveBoards' (`board_id % 10`, 0 → 10). If either moves, this
file is where the viewer finds out.

Run: cd webviewer && .venv/bin/python -m pytest backend/test_run_config.py -q
"""

import pytest

from . import config, run_config

# A config shaped like config_base.toml, trimmed to what naming reads.
CONFIG_TOML = """
[boards.pt_board]
type = "PT"
board_id = 21

[boards.pt_board_2]
type = "PT"
board_id = 22

[boards.actuator_board_2]
type = "ACTUATOR"
board_id = 12

[boards.encoder_board]
type = "ENCODER"
board_id = 61

[sensor_roles_pt_board]
"Ox Upstream" = 5
"GN2 Regulated" = 6

[sensor_roles_pt_board_2]
"GSE High" = 1

[sensor_roles_encoder_board]
"Encoder 1" = 1

[actuator_roles]
"LOX Main" = ["NC", 1, 12]
"Fuel Vent" = ["NC", 2, 12]

[[states]]
id = 16
name = "Burn"
"""


@pytest.fixture
def elodin_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ELODIN_DIR", tmp_path)
    return tmp_path


def snapshot(elodin_dir, run_id: str, text: str) -> None:
    (elodin_dir / f"{run_id}.toml").write_text(text)


@pytest.fixture
def labels(elodin_dir):
    snapshot(elodin_dir, "daq_20260902_120000", CONFIG_TOML)
    return run_config.entity_labels(run_config.load("daq_20260902_120000"))


# ── entity naming ────────────────────────────────────────────────────────────


def test_sensor_role_names_raw_and_calibrated(labels):
    # Same physical channel, two VTables — both carry the role.
    assert labels["PT1.CH5"] == "Ox Upstream"
    assert labels["PT1_Cal.CH5"] == "Ox Upstream"


def test_board_id_last_digit_is_the_elodin_slot(labels):
    # board_id 21 → PT1, 22 → PT2, 12 → ACT2, 61 → ENC1. Not the ordinal, not the id.
    assert labels["PT2.CH1"] == "GSE High"
    assert labels["ENC1.CH1"] == "Encoder 1"
    assert "PT21.CH5" not in labels


def test_slot_zero_means_ten():
    # A board_id ending in 0 is slot 10, not slot 0 — the same 0→10 rule the C++ uses.
    assert run_config._slot(30) == 10
    assert run_config._slot(21) == 1


def test_actuator_role_names_sense_and_command_entities(labels):
    # The valve is the raw channel, its current sense, and what the sequencer commanded.
    assert labels["ACT2.CH1"] == "LOX Main"
    assert labels["ACT2_Cal.CH1"] == "LOX Main"
    assert labels["ACT_CMD.B2.CH1"] == "LOX Main"


def test_actuator_role_board_id_defaults_to_the_first_actuator_board(elodin_dir):
    # Two-element form (no board_id) predates multi-board actuators; it means board 11.
    snapshot(
        elodin_dir,
        "daq_20260902_120001",
        '[boards.actuator_board]\ntype = "ACTUATOR"\nboard_id = 11\n'
        '\n[actuator_roles]\n"Fuel Fill" = ["NC", 7]\n',
    )
    labels = run_config.entity_labels(run_config.load("daq_20260902_120001"))
    assert labels["ACT1.CH7"] == "Fuel Fill"


def test_actuator_role_wins_over_a_sensor_role_on_the_same_channel(elodin_dir):
    # An actuator board also reports sensors; on that channel the valve is the answer.
    snapshot(
        elodin_dir,
        "daq_20260902_120002",
        '[boards.actuator_board_2]\ntype = "ACTUATOR"\nboard_id = 12\n'
        '\n[sensor_roles_actuator_board_2]\n"Some Sense" = 1\n'
        '\n[actuator_roles]\n"LOX Main" = ["NC", 1, 12]\n',
    )
    labels = run_config.entity_labels(run_config.load("daq_20260902_120002"))
    assert labels["ACT2.CH1"] == "LOX Main"


def test_board_entities_are_keyed_by_board_id_not_slot(labels):
    # BOARD.HB_/SELF_TEST use the raw board_id — the slot rule is for channel entities.
    assert labels["BOARD.HB_21"] == "PT Board #1"
    assert labels["BOARD.HB_22"] == "PT Board #2"
    # One board of its type drops the ordinal, matching the config editor.
    assert labels["BOARD.HB_12"] == "Actuator Board"
    assert labels["BOARD.HB_61"] == "Encoder Board"


def test_self_test_entity_resolves_through_its_board(labels):
    # SELF_TEST entities carry a per-sensor suffix that config never names directly.
    assert run_config.label_for("SELF_TEST.BOARD_21.s3", labels) == "PT Board #1 sensor 3"


def test_unnamed_entities_get_no_label(labels):
    # Already-human entities and channels config says nothing about stay as they are.
    assert run_config.label_for("CONTROLLER.state", labels) == ""
    assert run_config.label_for("PT1.CH9", labels) == ""


# ── states ───────────────────────────────────────────────────────────────────


def test_states_override_the_builtin_table_entry_by_entry(labels, elodin_dir):
    names = run_config.state_names(run_config.load("daq_20260902_120000"))
    assert names[16] == "Burn"  # the snapshot renamed it
    assert names[1] == "Idle"  # everything else survives the partial list
    assert names[20] == "Press Standby"


def test_states_fall_back_to_the_builtin_table_with_no_snapshot():
    # Ids are a stable key by contract, so a run predating [[states]] still decodes.
    assert run_config.state_names({})[16] == "Fire"


def test_engine_state_is_not_a_state_field():
    # BOARD.HB_*.engine_state is the coarse daq::EngineState, a different enum.
    assert "engine_state" not in run_config.STATE_FIELDS
    assert run_config.STATE_FIELDS == {"current_state", "from_state", "to_state"}


# ── degradation ──────────────────────────────────────────────────────────────


def test_missing_snapshot_degrades_to_numbers(elodin_dir):
    assert run_config.load("daq_20260101_000000") == {}
    assert run_config.entity_labels({}) == {}


def test_malformed_snapshot_does_not_raise(elodin_dir):
    # A truncated copy must cost readability, never the ability to open the run.
    snapshot(elodin_dir, "daq_20260902_120003", "[boards.pt_board\ntype = ")
    assert run_config.load("daq_20260902_120003") == {}


def test_annotate_stamps_labels_and_state_metadata(elodin_dir):
    snapshot(elodin_dir, "daq_20260902_120004", CONFIG_TOML)
    index = {
        "components": [
            {"name": "PT1.CH5.pressure_psi", "entity": "PT1.CH5"},
            {"name": "CONTROLLER.state.to_state", "entity": "CONTROLLER.state"},
        ]
    }
    out = run_config.annotate(index, "daq_20260902_120004")
    assert out["components"][0]["label"] == "Ox Upstream"
    assert out["components"][1]["label"] == ""
    assert out["has_config"] is True
    assert out["states"]["16"] == "Burn"  # JSON keys are strings
    assert "to_state" in out["state_fields"]


def test_annotate_reports_a_run_with_no_snapshot(elodin_dir):
    out = run_config.annotate({"components": []}, "daq_20260101_000000")
    assert out["has_config"] is False
    assert out["states"]["16"] == "Fire"  # built-in table still names states

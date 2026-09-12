"""Human names for a run's numeric Elodin identities, from the run's config snapshot.

Elodin records only numeric identities — `PT1.CH5`, `ACT2.CH1`, `ACT_CMD.B2.CH1`,
`BOARD.HB_21` — and every state as a raw u8. The names live in config.toml, which the
backend copies beside the run dir as `<run_id>.toml` when the session starts
(service-controller.ts `snapshotRunConfig`). This module reads that snapshot back and
rebuilds the mapping, so a past run reads as "Ox Upstream" and "Fire" instead of
"PT1.CH5" and "16".

Everything here mirrors conventions that already exist elsewhere and must not drift:

* entity spelling — DatabaseConfig.cpp (`PT<n>.CH<c>`, `PT<n>_Cal.CH<c>`,
  `ACT_CMD.B<n>.CH<c>`, `BOARD.HB_<board_id>`, `SELF_TEST.BOARD_<board_id>`)
* Elodin slot `<n>` = `board_id % 10`, 0 → 10 — LoadActiveBoards.hpp / sensor-config.ts
* board display names — the config editor's `boardDisplayName` (app/config/page.tsx)

A run predating the snapshot has no `.toml` and keeps its numeric entity names. State
ids are the exception: they are stable by contract (see the `[[states]]` comment in
config_base.toml), so the built-in table below names them even with no snapshot, and
`[[states]]` overrides it the same way it overrides the C++ enum.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

from . import config

# The state ids as the C++ enum defines them (control/StateMachine.hpp), named the way
# config_base.toml's [[states]] does. Only a fallback: a snapshot's [[states]] wins.
# Debug (0) is no longer a state the machine can enter but stays here so old runs decode.
BUILTIN_STATES: dict[int, str] = {
    0: "Debug",
    1: "Idle",
    2: "Armed",
    3: "Fuel Fill",
    4: "Ox Fill",
    5: "GN2 Low Press",
    6: "GN2 Low Vent",
    7: "Fuel Press",
    8: "Fuel Vent",
    9: "Ox Press",
    10: "Ox Vent",
    11: "GN2 High Press",
    12: "GN2 High Vent",
    13: "Vent",
    14: "Calibrate",
    15: "Ready",
    16: "Fire",
    17: "Engine Abort",
    18: "GSE Abort",
    19: "Emergency Abort",
    20: "Press Standby",
    255: "Unknown",
}

# Fields whose value is a state id (see DatabaseConfig.cpp). BOARD.HB_*.engine_state is
# NOT one of these — it carries the coarse daq::EngineState (SAFE/PRESSURIZING/…) that
# heartbeat_service_main.cpp derives from the sequencer state, a different enum.
STATE_FIELDS = frozenset({"current_state", "from_state", "to_state"})

# Entity prefix per board `type`, as DatabaseConfig.cpp spells it.
_ENTITY_PREFIX = {
    "PT": "PT",
    "TC": "TC",
    "RTD": "RTD",
    "LC": "LC",
    "ACTUATOR": "ACT",
    "ENCODER": "ENC",
}

# Board `type` → the word the config editor uses for it.
_BOARD_TYPE_LABEL = {
    "PT": "PT",
    "ACTUATOR": "Actuator",
    "LC": "LC",
    "TC": "TC",
    "RTD": "RTD",
    "ENCODER": "Encoder",
}


def snapshot_path(run_id: str) -> Path:
    """The config copied beside the run dir at session start."""
    return config.ELODIN_DIR / f"{run_id}.toml"


def load(run_id: str) -> dict:
    """Parse the run's config snapshot. Missing or malformed → {} (names degrade to
    numbers; a viewer must never fail to open a run over its metadata)."""
    p = snapshot_path(run_id)
    try:
        with p.open("rb") as fh:
            return tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def _slot(board_id: int) -> int:
    """Elodin slot for a board_id: the last digit, with 0 meaning 10."""
    return board_id % 10 or 10


def _board_display_names(boards: dict) -> dict[int, str]:
    """board_id → "PT Board #2", numbered by position among boards of the same type
    (matching the config editor). A lone board of its type drops the ordinal."""
    out: dict[int, str] = {}
    for key, board in boards.items():
        if not isinstance(board, dict):
            continue
        btype = board.get("type")
        board_id = board.get("board_id")
        if not isinstance(btype, str) or not isinstance(board_id, int):
            continue
        same = [k for k, b in boards.items() if isinstance(b, dict) and b.get("type") == btype]
        label = _BOARD_TYPE_LABEL.get(btype, btype)
        out[board_id] = (
            f"{label} Board #{same.index(key) + 1}" if len(same) > 1 else f"{label} Board"
        )
    return out


def entity_labels(cfg: dict) -> dict[str, str]:
    """Entity name → the role it plays, for every entity config can name."""
    labels: dict[str, str] = {}
    boards = cfg.get("boards") or {}
    if not isinstance(boards, dict):
        return labels

    # Sensor channels: each board's own [sensor_roles_<board key>] maps role → connector.
    # Raw and calibrated entities are the same physical channel, so both take the role.
    for key, board in boards.items():
        if not isinstance(board, dict):
            continue
        prefix = _ENTITY_PREFIX.get(board.get("type"))
        board_id = board.get("board_id")
        if prefix is None or not isinstance(board_id, int):
            continue
        n = _slot(board_id)
        roles = cfg.get(f"sensor_roles_{key}") or {}
        if not isinstance(roles, dict):
            continue
        for role, ch in roles.items():
            if not isinstance(ch, int):
                continue
            labels[f"{prefix}{n}.CH{ch}"] = role
            labels[f"{prefix}{n}_Cal.CH{ch}"] = role

    # Actuators: [actuator_roles] is role = [NO|NC, channel, board_id]. It wins over any
    # sensor role on the same channel — on an actuator board the valve IS the channel.
    # board_id defaults to 11 (the first actuator board), as sensor-config.ts does.
    for role, spec in (cfg.get("actuator_roles") or {}).items():
        if not isinstance(spec, list) or len(spec) < 2 or not isinstance(spec[1], int):
            continue
        ch = spec[1]
        board_id = spec[2] if len(spec) >= 3 and isinstance(spec[2], int) else 11
        n = _slot(board_id)
        labels[f"ACT{n}.CH{ch}"] = role
        labels[f"ACT{n}_Cal.CH{ch}"] = role  # current sense on that valve
        labels[f"ACT_CMD.B{n}.CH{ch}"] = role  # what the sequencer commanded it to

    # Board-level entities are keyed by the raw board_id, not the Elodin slot.
    for board_id, name in _board_display_names(boards).items():
        labels[f"BOARD.HB_{board_id}"] = name
        labels[f"SELF_TEST.BOARD_{board_id}"] = name

    return labels


# A self-test entity is per-sensor: SELF_TEST.BOARD_<board_id>.s<sensor_id>. The board
# half is what config can name; the sensor index rides along.
_SELF_TEST_RE = re.compile(r"^(SELF_TEST\.BOARD_\d+)\.s(\d+)$")


def label_for(entity: str, labels: dict[str, str]) -> str:
    """The human name for one entity, or "" when config does not name it."""
    hit = labels.get(entity)
    if hit:
        return hit
    m = _SELF_TEST_RE.match(entity)
    if m and (board := labels.get(m.group(1))):
        return f"{board} sensor {m.group(2)}"
    return ""


def state_names(cfg: dict) -> dict[int, str]:
    """State id → name. `[[states]]` overrides the built-in table entry by entry, so a
    partial list cannot erase the machine's knowledge of its own states."""
    names = dict(BUILTIN_STATES)
    entries = cfg.get("states")
    if isinstance(entries, list):
        for e in entries:
            if isinstance(e, dict) and isinstance(e.get("id"), int) and isinstance(e.get("name"), str):
                names[e["id"]] = e["name"]
    return names


def annotate(index: dict, run_id: str) -> dict:
    """Attach the run's names to a component index, in place.

    Done at serve time rather than baked into the cached index: the snapshot is a
    separate file from the parquet cache, so one dropped in later (or a config fix)
    takes effect on the next open instead of needing the export thrown away.
    """
    cfg = load(run_id)
    labels = entity_labels(cfg)
    for comp in index.get("components", []):
        comp["label"] = label_for(comp.get("entity", ""), labels)
    index["has_config"] = bool(cfg)
    # JSON object keys are strings; the frontend indexes by String(value).
    index["states"] = {str(k): v for k, v in sorted(state_names(cfg).items())}
    index["state_fields"] = sorted(STATE_FIELDS)
    return index

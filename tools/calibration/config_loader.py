#!/usr/bin/env python3
"""
Shared configuration loader for the calibration stack.

Reads config/config.toml (the single source of truth) and exposes board IPs,
ports, sensor counts, calibration paths, and network settings so that every
calibration script derives its parameters from the same place.

Usage:
    from config_loader import load_config, get_board_by_type, get_calibration_config, get_abort_pts

    cfg = load_config()                          # full dict
    pt = get_board_by_type("PT")                 # {ip, send_port, num_sensors, …}
    cal = get_calibration_config("pt")           # {json_dir, csv_paths}
    abort_pts = get_abort_pts()                  # {"Fuel Upstream": 400, …} (PSI)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Locate config.toml ────────────────────────────────────────────────────
# Walk up from this file until we find config/config.toml
_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT: Optional[Path] = None
for _p in [_THIS_DIR] + list(_THIS_DIR.parents):
    if (_p / "config" / "config.toml").is_file():
        _REPO_ROOT = _p
        break

if _REPO_ROOT is None:
    # Fallback: assume repo root is two levels up from tools/calibration/
    _REPO_ROOT = _THIS_DIR.parent.parent

CONFIG_PATH = _REPO_ROOT / "config" / "config.toml"

# ── TOML parser (stdlib tomllib in 3.11+, fallback to toml/tomli) ─────────
_toml_load = None
try:
    import tomllib  # Python ≥ 3.11

    def _toml_load(path: Path) -> dict:  # noqa: F811
        with open(path, "rb") as f:
            return tomllib.load(f)

except ImportError:
    pass

if _toml_load is None:
    try:
        import tomli  # pip install tomli

        def _toml_load(path: Path) -> dict:  # noqa: F811
            with open(path, "rb") as f:
                return tomli.load(f)

    except ImportError:
        pass

if _toml_load is None:
    try:
        import toml  # pip install toml

        def _toml_load(path: Path) -> dict:  # noqa: F811
            return toml.load(str(path))

    except ImportError:
        pass

if _toml_load is None:
    # Minimal fallback: hand-roll a tiny TOML subset parser
    # (handles only what our config.toml actually uses)
    import re as _re

    def _toml_load(path: Path) -> dict:  # noqa: F811
        """Minimal TOML parser — enough for config.toml."""
        text = path.read_text()
        root: dict = {}
        current_section: dict = root

        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            # Section header
            m = _re.match(r"^\[([^\]]+)\]$", line)
            if m:
                keys = m.group(1).split(".")
                d = root
                for k in keys:
                    d = d.setdefault(k, {})
                current_section = d
                continue

            # Key = value
            m = _re.match(r'^"?([^"=]+?)"?\s*=\s*(.+)$', line)
            if not m:
                continue
            key = m.group(1).strip().strip('"')
            val_str = m.group(2).strip()
            current_section[key] = _parse_value(val_str)

        return root

    def _parse_value(s: str):
        s = s.strip()
        if s.lower() == "true":
            return True
        if s.lower() == "false":
            return False
        # Hex int
        if _re.match(r"^0x[0-9a-fA-F]+$", s):
            return int(s, 16)
        # Int
        try:
            return int(s)
        except ValueError:
            pass
        # Float
        try:
            return float(s)
        except ValueError:
            pass
        # String
        if (s.startswith('"') and s.endswith('"')) or (
            s.startswith("'") and s.endswith("'")
        ):
            return s[1:-1]
        # Array
        if s.startswith("["):
            inner = s.strip("[]").strip()
            if not inner:
                return []
            items = []
            for part in _re.split(r",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", inner):
                items.append(_parse_value(part.strip()))
            return items
        return s


# ── Public API ─────────────────────────────────────────────────────────────

_cached_config: Optional[dict] = None


def load_config(path: Optional[Path] = None) -> dict:
    """Load and cache the full config dict from config.toml."""
    global _cached_config
    if _cached_config is not None and path is None:
        return _cached_config
    p = path or CONFIG_PATH
    if not p.is_file():
        raise FileNotFoundError(f"Config not found: {p}")
    _cached_config = _toml_load(p)
    return _cached_config


def get_repo_root() -> Path:
    return _REPO_ROOT


def get_network_config() -> dict:
    """Return [network] section."""
    cfg = load_config()
    return cfg.get("network", {})


def get_database_config() -> dict:
    """Return [database] section."""
    cfg = load_config()
    return cfg.get("database", {})


def get_boards() -> Dict[str, dict]:
    """Return all [boards.*] as {board_name: {type, ip, …}}."""
    cfg = load_config()
    return cfg.get("boards", {})


def get_board_by_type(board_type: str) -> Optional[dict]:
    """Return the first enabled board matching the given type (PT, TC, RTD, LC, ACTUATOR).
    Returns None if no matching enabled board is found."""
    for name, board in get_boards().items():
        if board.get("type", "").upper() == board_type.upper():
            if board.get("enabled", True):
                return {**board, "name": name}
    # Also check disabled boards as fallback
    for name, board in get_boards().items():
        if board.get("type", "").upper() == board_type.upper():
            return {**board, "name": name}
    return None


def get_boards_by_type(board_type: str) -> List[dict]:
    """Return all boards matching the given type."""
    result = []
    for name, board in get_boards().items():
        if board.get("type", "").upper() == board_type.upper():
            result.append({**board, "name": name})
    return result


def decode_board_namespaced_low(low: int) -> Optional[tuple]:
    """
    Decode daq_bridge / Elodin low byte: (board_slot, connector_1_10, is_raw).
    Matches web-gui elodin-protocol decodeLow (PT/TC/RTD/LC 0x20–0x23).
    Returns None if not a valid raw/cal sensor slot.
    """
    if low < 1:
        return None
    block_offset = low & 0x1F
    is_raw = block_offset < 0x10
    board_slot = (low >> 5) + 1
    connector = block_offset & 0x0F
    if connector < 1 or connector > 10:
        return None
    return (board_slot, connector, is_raw)


def packet_ch_for_board_connector(
    stype: str, board_slot: int, connector: int
) -> Optional[int]:
    """
    Map physical board slot + connector to packet channel id (local connector 1–10; same as Elodin/daq_bridge).
    """
    for board in get_boards_by_type(stype):
        if not board.get("enabled", True):
            continue
        board_id = int(board.get("board_id", 1))
        mod = board_id % 10
        slot = 10 if mod == 0 else mod
        if slot != board_slot:
            continue
        active = board.get("active_connectors", [])
        if not active:
            num = int(board.get("num_sensors", 10) or 10)
            active = list(range(1, num + 1))
        if connector not in active:
            continue
        return int(connector)
    return None


def build_channel_to_orchestrator_key() -> Dict[tuple, tuple]:
    """
    Build mapping (stype, packet_channel_id) → (stype, unique_ch) for relay packets.
    Packet channel id is the local connector (1–10), matching daq_bridge / Elodin low-byte scheme.
    unique_ch = board_id * 100 + connector_id. Returns dict for PT, TC, RTD, LC.
    """
    mapping: Dict[tuple, tuple] = {}
    for stype in ("PT", "TC", "RTD", "LC"):
        for board in get_boards_by_type(stype):
            if not board.get("enabled", True):
                continue
            board_id = board.get("board_id", 1)
            active = board.get("active_connectors", [])
            if not active:
                num = board.get("num_sensors", 10)
                active = list(range(1, num + 1))
            for conn in active:
                packet_ch = conn
                unique_ch = board_id * 100 + conn
                mapping[(stype, packet_ch)] = (stype, unique_ch)
    return mapping


def get_hp_pt_packet_channels() -> Dict[int, dict]:
    """
    Return {packet_ch: {full_scale_psi, sense_resistor_ohms, adc_ref_voltage}} for HP PT channels.
    Used when robust stack excludes HP PTs — calibration_server applies 4-20 mA linear conversion.
    """
    result: Dict[int, dict] = {}
    for board in get_boards_by_type("PT"):
        if not board.get("enabled", True) or not board.get("hp_pt_connectors"):
            continue
        hp_conns = board.get("hp_pt_connectors", [])
        if not isinstance(hp_conns, (list, tuple)):
            continue
        cfg = {
            "full_scale_psi": float(board.get("hp_pt_full_scale_psi", 5000.0)),
            "sense_resistor_ohms": float(board.get("hp_pt_sense_resistor_ohms", 120.0)),
            "adc_ref_voltage": float(board.get("adc_ref_voltage", 2.5)),
        }
        for conn in hp_conns:
            result[conn] = cfg
    return result


def get_excitation_packet_channels() -> Dict[int, dict]:
    """
    Return {packet_ch: {adc_ref_voltage, divider_attenuation}} for boards with a
    dedicated excitation voltage monitor connector (excitation_connector_id >= 1).
    The calibration server uses this to publish the loop excitation voltage (V)
    instead of trying to apply pressure calibration to the channel.
    """
    result: Dict[int, dict] = {}
    for board in get_boards_by_type("PT"):
        if not board.get("enabled", True):
            continue
        exc_conn = board.get("excitation_connector_id", -1)
        if not isinstance(exc_conn, int) or exc_conn < 1:
            continue
        result[exc_conn] = {
            "adc_ref_voltage": float(board.get("adc_ref_voltage", 2.5)),
            "divider_attenuation": float(board.get("excitation_divider_attenuation", 1.0)),
        }
    return result


def build_orchestrator_key_to_packet_ch() -> Dict[tuple, int]:
    """Reverse: (stype, unique_ch) → packet_ch for legacy JSON keying."""
    mapping: Dict[tuple, int] = {}
    for stype in ("PT", "TC", "RTD", "LC"):
        for board in get_boards_by_type(stype):
            if not board.get("enabled", True):
                continue
            board_id = board.get("board_id", 1)
            active = board.get("active_connectors", [])
            if not active:
                num = board.get("num_sensors", 10)
                active = list(range(1, num + 1))
            for conn in active:
                packet_ch = conn
                unique_ch = board_id * 100 + conn
                mapping[(stype, unique_ch)] = packet_ch
    return mapping


def get_calibration_config(sensor_type: str) -> dict:
    """Return [calibration.<sensor_type>] section.
    sensor_type is case-insensitive (pt, tc, rtd, lc)."""
    cfg = load_config()
    cal = cfg.get("calibration", {})
    return cal.get(sensor_type.lower(), {})


def get_sensor_port() -> int:
    """Return the UDP port boards send sensor data to (default 5006)."""
    return get_network_config().get("sensor_port", 5006)


def get_display_config() -> dict:
    """Return [display] section."""
    cfg = load_config()
    return cfg.get("display", {})


def get_abort_pts() -> Dict[str, Any]:
    """Return [abort_pts] section: sensor role name → pressure threshold (PSI).
    Used when building ACTUATOR_CONFIG (threshold is converted to ADC code per PT calibration).
    """
    cfg = load_config()
    return cfg.get("abort_pts", {})


def resolve_path(rel_path: str) -> Path:
    """Resolve a repo-relative path from config to an absolute path."""
    p = Path(rel_path)
    if p.is_absolute():
        return p
    return _REPO_ROOT / p


# ── Convenience: print summary ─────────────────────────────────────────────


def print_config_summary():
    """Print a human-readable summary of the loaded config."""
    load_config()
    net = get_network_config()
    db = get_database_config()
    boards = get_boards()
    print(f"\n{'═'*70}")
    print("  Config Summary  ({})".format(CONFIG_PATH))
    print(f"{'═'*70}")
    print(
        f"  Network:   bind={net.get('bind_ip','?')}  sensor_port={net.get('sensor_port','?')}"
    )
    print(f"  Database:  {db.get('host','?')}:{db.get('port','?')}")
    print("  Boards:")
    for name, b in boards.items():
        status = "✅" if b.get("enabled", True) else "⬜"
        print(
            f"    {status} {name:<20s}  type={b.get('type', '?'):<8s}"
            f"  ip={b.get('ip', '?'):<16s}  sensors={b.get('num_sensors', '?')}"
        )
    print("  Calibration:")
    for st in ["pt", "tc", "rtd", "lc"]:
        cc = get_calibration_config(st)
        if cc:
            print(
                f"    {st.upper()}: json_dir={cc.get('json_dir','—')}  csv={cc.get('csv_paths',['—'])}"
            )
    print(f"{'═'*70}\n")


if __name__ == "__main__":
    print_config_summary()

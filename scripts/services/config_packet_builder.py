#!/usr/bin/env python3
"""
Build ACTUATOR_CONFIG and SENSOR_CONFIG packets from config.toml.
Replaces backend packet-building logic so config_broadcast_service is self-contained.

Packet formats match DAQv2-Comms / DiabloPacketUtils.cpp.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Add calibration scripts to path for config_loader
import sys

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent.parent
_cal_path = str(_REPO_ROOT / "scripts" / "calibration")
if _cal_path not in sys.path:
    sys.path.insert(0, _cal_path)

from config_loader import (
    load_config,
    get_boards,
    get_boards_by_type,
    get_abort_pts,
    get_calibration_config,
    resolve_path,
)

SENSOR_CONFIG = 5
ACTUATOR_CONFIG = 6
DEFAULT_LISTEN_PORT = 5005


def _ip_to_u32_le(ip: str) -> int:
    """Convert IP to uint32 (ip0<<24|ip1<<16|...) for little-endian wire format."""
    octets = [int(x) for x in ip.split(".")]
    if len(octets) != 4 or any(x < 0 or x > 255 for x in octets):
        raise ValueError(f"Invalid IP: {ip}")
    return (
        (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]
    ) & 0xFFFFFFFF


def _ip_to_u32_be(ip: str) -> int:
    """For SENSOR_CONFIG controller_ip: big-endian 4 bytes."""
    octets = [int(x) for x in ip.split(".")]
    if len(octets) != 4 or any(x < 0 or x > 255 for x in octets):
        raise ValueError(f"Invalid IP: {ip}")
    return (
        (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]
    ) & 0xFFFFFFFF


def load_pt_calibration_coeffs() -> Dict[str, Tuple[float, float, float, float]]:
    """Load PT calibration polynomials from latest JSON. Returns channel (str) -> [A,B,C,D]."""
    cal_pt = get_calibration_config("pt")
    json_dir = cal_pt.get("json_dir", "scripts/calibration/calibrations")
    cal_dir = resolve_path(json_dir)

    if not cal_dir.is_dir():
        return {}

    files = sorted(
        [f for f in cal_dir.glob("*.json") if "learned_prior" not in f.name],
        reverse=True,
    )

    for fpath in files:
        try:
            import json

            raw = json.loads(fpath.read_text())
            polys = raw.get("calibration_polynomials")
            if not polys:
                continue
            result = {}
            for ch, c in polys.items():
                if isinstance(c, (list, tuple)) and len(c) >= 4:
                    result[ch] = (float(c[0]), float(c[1]), float(c[2]), float(c[3]))
            if result:
                return result
        except Exception:
            continue
    return {}


def invert_pt_polynomial(
    coeffs: Tuple[float, float, float, float], target_psi: float
) -> Optional[int]:
    """Invert psi = A*x^3 + B*x^2 + C*x + D to find ADC code x. Binary search."""
    A, B, C, D = coeffs

    def eval_poly(x: float) -> float:
        return A * x * x * x + B * x * x + C * x + D

    for lo, hi in [(0, 2147483647), (-2147483648, 0)]:
        f_lo = eval_poly(lo)
        f_hi = eval_poly(hi)
        if not (min(f_lo, f_hi) <= target_psi <= max(f_lo, f_hi)):
            continue
        left, right = lo, hi
        for _ in range(64):
            mid = round((left + right) / 2)
            f_mid = eval_poly(mid)
            if abs(f_mid - target_psi) < 0.5:
                return int(mid)
            if f_lo < f_hi:
                if f_mid < target_psi:
                    left = mid
                else:
                    right = mid
            else:
                if f_mid > target_psi:
                    left = mid
                else:
                    right = mid
        return int(round((left + right) / 2))
    return None


def parse_vent_and_abort_from_csv() -> Tuple[Dict[str, int], Dict[str, int]]:
    """Parse state_machine_actuators.csv for Vent and Engine Abort columns.
    Returns (vent_map, abort_map): actuator_name -> 0|1 (CLOSED|OPEN).
    """
    vent_map: Dict[str, int] = {}
    abort_map: Dict[str, int] = {}

    cfg = load_config()
    csv_rel = cfg.get("state_machine", {}).get(
        "actuator_csv", "config/state_machine_actuators.csv"
    )
    csv_path = _REPO_ROOT / csv_rel
    if not csv_path.is_file():
        return vent_map, abort_map

    lines = csv_path.read_text().strip().split("\n")
    if len(lines) < 2:
        return vent_map, abort_map

    headers = [h.strip() for h in lines[0].split(",")[1:]]
    vent_col = next((i for i, h in enumerate(headers) if h == "Vent"), None)
    abort_col = next((i for i, h in enumerate(headers) if h == "Engine Abort"), None)

    if vent_col is None or abort_col is None:
        return vent_map, abort_map

    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) <= max(vent_col, abort_col) + 1:
            continue
        name = parts[0].strip()
        if not name or name == "Test Actuator 2":
            continue
        v = parts[vent_col + 1].strip().upper()
        a = parts[abort_col + 1].strip().upper()
        vent_map[name] = 1 if v == "OPEN" else 0
        abort_map[name] = 1 if a == "OPEN" else 0

    return vent_map, abort_map


def build_actuator_config_packet(
    is_abort_controller: int,
    enable_serial_printing: int,
    designated_survivor_ip: str,
) -> Optional[bytes]:
    """Build ACTUATOR_CONFIG packet (type 6). Returns None if no designated survivor."""
    cfg = load_config()
    actuator_roles = cfg.get("actuator_roles", {})
    sensor_roles = cfg.get("sensor_roles_pt_board", cfg.get("sensor_roles", {}))
    abort_pts = get_abort_pts()
    boards = cfg.get("boards", {})

    board_id_to_ip: Dict[int, str] = {}
    for key, board in boards.items():
        bid = board.get("id") or board.get("board_id")
        ip = board.get("ip") or (f"192.168.2.{bid}" if bid is not None else "")
        if bid is not None and ip:
            board_id_to_ip[int(bid)] = ip

    vent_map, abort_map = parse_vent_and_abort_from_csv()

    # Abort actuator blocks
    abort_actuators: List[Tuple[int, int, int, int]] = []
    for name, value in actuator_roles.items():
        if not isinstance(value, (list, tuple)) or len(value) < 2:
            continue
        actuator_id = int(value[1])
        if actuator_id < 1 or actuator_id > 255:
            continue
        actuator_ip = designated_survivor_ip
        if len(value) >= 3:
            if isinstance(value[2], int):
                actuator_ip = board_id_to_ip.get(value[2], actuator_ip)
            elif isinstance(value[2], str):
                actuator_ip = value[2]
        vent_state = vent_map.get(name, 0)
        abort_state = abort_map.get(name, 0)
        abort_actuators.append(
            (_ip_to_u32_le(actuator_ip), actuator_id, vent_state, abort_state)
        )

    # Abort PT blocks
    pt_board_ip = None
    for board in get_boards_by_type("PT"):
        if board.get("enabled", True):
            pt_board_ip = board.get("ip")
            break

    abort_pt_list: List[Tuple[int, int, int]] = []
    for sensor_name, threshold_psi in abort_pts.items():
        sensor_id = sensor_roles.get(sensor_name)
        if sensor_id is None:
            continue
        sensor_id = int(sensor_id)
        cal = load_pt_calibration_coeffs()
        coeffs = cal.get(str(sensor_id))
        if not coeffs:
            continue
        adc = invert_pt_polynomial(coeffs, float(threshold_psi))
        if adc is None:
            continue
        if pt_board_ip:
            abort_pt_list.append(
                (_ip_to_u32_le(pt_board_ip), sensor_id, adc & 0xFFFFFFFF)
            )

    N = min(len(abort_actuators), 255)
    X = min(len(abort_pt_list), 255)
    header_size = 6
    body_size = 1 + 1 + N * 7 + 1 + X * 9 + 1
    total = header_size + body_size

    buf = bytearray(total)
    timestamp = 0  # Config broadcast doesn't need real timestamp
    buf[0] = ACTUATOR_CONFIG
    buf[1] = 0
    struct.pack_into("<I", buf, 2, timestamp)

    offset = header_size
    buf[offset] = is_abort_controller
    offset += 1
    buf[offset] = N
    offset += 1
    for ip, aid, vent, abort in abort_actuators[:N]:
        struct.pack_into("<IBBB", buf, offset, ip, aid, vent, abort)
        offset += 7
    buf[offset] = X
    offset += 1
    for ip, sid, adc in abort_pt_list[:X]:
        struct.pack_into("<IBI", buf, offset, ip, sid, adc)
        offset += 9
    buf[offset] = 1 if enable_serial_printing else 0

    return bytes(buf)


def build_sensor_config_packet(
    sensor_channels: List[int],
    reference_voltage: int,
    necessary_for_abort: bool,
    designated_survivor_ip: str,
    enable_serial_printing: bool,
) -> bytes:
    """Build SENSOR_CONFIG packet (type 5)."""
    sanitized = [int(c) for c in sensor_channels if 1 <= int(c) <= 255]
    num_sensors = min(len(sanitized), 255)
    body_len = 1 + num_sensors + 1 + 1 + (4 if necessary_for_abort else 0) + 1
    total = 6 + body_len

    buf = bytearray(total)
    timestamp = 0
    buf[0] = SENSOR_CONFIG
    buf[1] = 0
    struct.pack_into("<I", buf, 2, timestamp)

    offset = 6
    buf[offset] = num_sensors
    offset += 1
    for c in sanitized[:num_sensors]:
        buf[offset] = c
        offset += 1
    buf[offset] = min(2, max(0, reference_voltage))
    offset += 1
    buf[offset] = 1 if necessary_for_abort else 0
    offset += 1
    if necessary_for_abort:
        struct.pack_into(">I", buf, offset, _ip_to_u32_be(designated_survivor_ip))
        offset += 4
    buf[offset] = 1 if enable_serial_printing else 0

    return bytes(buf)


def build_all_config_packets(config_path: Optional[Path] = None) -> List[Tuple[str, int, bytes, str, int]]:
    """Build (packet_type, board_id, packet, ip, listen_port) for all configured boards."""
    import config_loader as _cl

    if config_path is not None:
        _cl._cached_config = None
        _cl.load_config(config_path)
    cfg = load_config()
    boards = cfg.get("boards", {})

    # Find designated survivor
    designated_ip: Optional[str] = None
    designated_id: Optional[int] = None
    for key, board in boards.items():
        if (
            board.get("enabled", True)
            and board.get("type") == "ACTUATOR"
            and board.get("designated_survivor")
        ):
            designated_ip = board.get("ip") or f"192.168.2.{board.get('board_id', 12)}"
            designated_id = board.get("board_id") or board.get("id")
            break

    if not designated_ip:
        return []

    board_id_to_ip: Dict[int, str] = {}
    for key, board in boards.items():
        bid = board.get("board_id") or board.get("id")
        ip = board.get("ip") or (f"192.168.2.{bid}" if bid is not None else "")
        if bid is not None and ip:
            board_id_to_ip[int(bid)] = ip

    out: List[Tuple[str, int, bytes, str, int]] = []

    for key, board in boards.items():
        if board.get("enabled", True) is False:
            continue
        bid = int(board.get("board_id") or board.get("id", 0))
        ip = board.get("ip") or f"192.168.2.{bid}"
        btype = (board.get("type") or "").upper()
        listen_port = int(board.get("listen_port", DEFAULT_LISTEN_PORT))

        if btype == "ACTUATOR":
            is_abort = 1 if bid == designated_id else 0
            ser = 1 if board.get("enable_serial_printing", False) else 0
            pkt = build_actuator_config_packet(is_abort, ser, designated_ip)
            if pkt:
                out.append(("ACTUATOR_CONFIG", bid, pkt, ip, listen_port))

        elif btype in ("PT", "TC", "RTD", "LC", "ENCODER"):
            active = board.get("active_connectors", [])
            if not active:
                num = board.get("num_sensors", 10)
                active = list(range(1, num + 1))
            channels = [int(c) for c in active if 1 <= int(c) <= 255]
            ref = int(board.get("voltage_reference", 0))
            nec = bool(board.get("necessary_for_abort", False))
            ser = 1 if board.get("enable_serial_printing", False) else 0
            pkt = build_sensor_config_packet(channels, ref, nec, designated_ip, ser)
            out.append(("SENSOR_CONFIG", bid, pkt, ip, listen_port))

    return out

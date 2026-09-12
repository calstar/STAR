"""
Parse the STAR sense-board USB-serial debug stream into structured events.

The board streams the same state machine over its USB serial port that it runs
over Ethernet, printing (see firmware/Hotfire_Code/common/SensorHotfireCore.h,
firmware_hash.h, and LC_Hotfire/src/main.cpp):

    Firmware hash: <64 hex>
    Board ID and IP: 21 / 192.168.2.21
    Hardware: W5500
    Link status: Connected
    [ETH] DHCP lease acquired: 192.168.2.137
    UDP listening on port 5005
    State -> WaitingForServer   (also -> Active / SelfTest / StandaloneAbort)
    Sent: heartbeat to 192.168.2.20:5006
    Received packet from 192.168.2.20:5006 type 5 (SENSOR_CONFIG) len=...
    SENSOR_DATA contents:
      chunk 0 ts=12345 : (id=1, data=99999) (id=2, data=88888) (id=3, data=7)

``SerialParser.feed(line)`` returns a small event dict (or None) describing what
changed, so the GUI can update the same stat fields it uses for the UDP path.

Pure stdlib — run ``python -m boardgui.serial_parse`` for the self-test.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional

# State names as the firmware prints them -> our board-status text.
# Covers both the sense boards (SensorHotfireCore.h) and the actuator board
# (Actuator_Hotfire/src/main.cpp stateName()).
_STATE_MAP = {
    "WaitingForServer": "Setup (waiting for server)",
    "SelfTest": "Self Test",
    "Active": "Active",
    "StandaloneAbort": "Standalone Abort",
    "ConnectionLossDetected": "Connection Loss Detected",
    "NoConnectionAbort": "No-Connection Abort",
    "NoConnAbortFollower": "No-Conn Abort (follower)",
    "PTAbort": "PT Abort",
    "NoPTAbort": "No PT Abort",
    "AbortFinished": "Abort Finished",
}

_RE_FW_HASH = re.compile(r"Firmware hash:\s*([0-9A-Fa-f]{64})")
_RE_IDENTITY = re.compile(r"Board ID and IP:\s*(\d+)\s*/\s*([\d.]+)")
_RE_HARDWARE = re.compile(r"^Hardware:\s*(.+?)\s*$")
_RE_LINK = re.compile(r"^Link status:\s*(\w+)")
_RE_DHCP = re.compile(r"DHCP lease acquired:\s*([\d.]+)")
_RE_LOCAL_IP = re.compile(r"Stack IP \(Ethernet\.localIP\):\s*([\d.]+)")
_RE_STATE = re.compile(r"State ->\s*(\w+)")
_RE_UDP_PORT = re.compile(r"UDP listening on port\s*(\d+)")
_RE_PACKET_RX = re.compile(r"Received packet from\s*([\d.]+):(\d+)\s*type\s*(\d+)\s*\((\w+)\)")
_RE_IDDATA = re.compile(r"\(id=(\d+),\s*data=(\d+)\)")
# "chunk 0 ts=12345 : (id=1, data=...)" — the sample instant, not arrival time.
_RE_CHUNK_TS = re.compile(r"\bts=(\d+)")


class SerialParser:
    """Stateless-ish line parser; the GUI holds the resulting state."""

    def feed(self, line: str) -> Optional[Dict]:
        line = line.rstrip("\r\n")
        if not line:
            return None

        m = _RE_STATE.search(line)
        if m:
            raw = m.group(1)
            return {"kind": "state", "raw": raw, "value": _STATE_MAP.get(raw, raw)}

        m = _RE_FW_HASH.search(line)
        if m:
            return {"kind": "fw_hash", "value": m.group(1).lower()}

        m = _RE_IDENTITY.search(line)
        if m:
            return {"kind": "identity", "board_id": int(m.group(1)), "board_ip": m.group(2)}

        m = _RE_HARDWARE.search(line)
        if m:
            return {"kind": "eth", "field": "hardware", "value": m.group(1)}

        m = _RE_LINK.search(line)
        if m:
            return {"kind": "eth", "field": "link", "value": m.group(1)}

        m = _RE_DHCP.search(line)
        if m:
            return {"kind": "eth", "field": "ip", "value": m.group(1), "via": "DHCP"}

        m = _RE_LOCAL_IP.search(line)
        if m:
            return {"kind": "eth", "field": "ip", "value": m.group(1), "via": "static/stack"}

        m = _RE_UDP_PORT.search(line)
        if m:
            return {"kind": "udp_port", "value": int(m.group(1))}

        if line.startswith("Sent: heartbeat"):
            return {"kind": "heartbeat_sent"}

        if line.startswith("Sent: sensor_data"):
            return {"kind": "sensor_sent"}

        m = _RE_PACKET_RX.search(line)
        if m:
            return {"kind": "packet_rx", "src": m.group(1), "port": int(m.group(2)),
                    "ptype": int(m.group(3)), "name": m.group(4)}

        # Per-connector readings: any line carrying (id=.., data=..) pairs,
        # e.g. the "SENSOR_DATA contents" chunk lines.
        pairs = _RE_IDDATA.findall(line)
        if pairs:
            values: Dict[int, int] = {int(sid): int(data) for sid, data in pairs}
            m = _RE_CHUNK_TS.search(line)
            return {"kind": "readings", "values": values,
                    "timestamp_ms": int(m.group(1)) if m else None}

        if line.startswith("SENSOR_CONFIG received"):
            return {"kind": "sensor_config_received"}

        return None


# -----------------------------------------------------------------------------
def _self_test() -> None:
    p = SerialParser()

    e = p.feed("State -> Active")
    assert e == {"kind": "state", "raw": "Active", "value": "Active"}, e

    e = p.feed("State -> WaitingForServer")
    assert e["value"] == "Setup (waiting for server)"

    e = p.feed("State -> NoConnAbortFollower")   # actuator-board state
    assert e["value"] == "No-Conn Abort (follower)"

    e = p.feed("Firmware hash: " + "ab" * 32)
    assert e["kind"] == "fw_hash" and len(e["value"]) == 64

    e = p.feed("Board ID and IP: 21 / 192.168.2.21")
    assert e == {"kind": "identity", "board_id": 21, "board_ip": "192.168.2.21"}, e

    assert p.feed("Hardware: W5500") == {"kind": "eth", "field": "hardware", "value": "W5500"}
    assert p.feed("Link status: Connected") == {"kind": "eth", "field": "link", "value": "Connected"}
    assert p.feed("[ETH] DHCP lease acquired: 192.168.2.137")["value"] == "192.168.2.137"

    assert p.feed("UDP listening on port 5005") == {"kind": "udp_port", "value": 5005}
    assert p.feed("Sent: heartbeat to 192.168.2.20:5006") == {"kind": "heartbeat_sent"}
    assert p.feed("Sent: sensor_data to 192.168.2.20:5006") == {"kind": "sensor_sent"}

    e = p.feed("Received packet from 192.168.2.20:5006 type 5 (SENSOR_CONFIG) len=12 hex: 05 00")
    assert e["kind"] == "packet_rx" and e["ptype"] == 5 and e["name"] == "SENSOR_CONFIG"

    e = p.feed("  chunk 0 ts=12345 : (id=1, data=99999) (id=2, data=88888) (id=3, data=7)")
    assert e["kind"] == "readings" and e["values"] == {1: 99999, 2: 88888, 3: 7}, e
    assert e["timestamp_ms"] == 12345, e
    e = p.feed("(id=4, data=5)")          # no ts= on the line -> fall back to arrival
    assert e["timestamp_ms"] is None, e

    assert p.feed("") is None
    assert p.feed("some unrelated boot line") is None

    print("serial_parse self-test: OK")


if __name__ == "__main__":
    _self_test()

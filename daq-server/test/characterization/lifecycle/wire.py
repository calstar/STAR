"""Decode DAQ wire packets into one-field-per-line text for the lifecycle goldens.

Layouts follow lib/daq-protocol/src/DiabloPackets.h (all structs packed, little-endian host):

  PacketHeader             type u8 @0, version u8 @1, timestamp u32 @2          (6 bytes)
  BoardHeartbeatPacket     firmware_hash[32] @6, board_id @38, engine_state @39,
                           board_state @40
  ServerHeartbeatPacket    engine_state @6
  SensorDataPacket         num_chunks @6, num_sensors @7, then num_chunks x
                           (chunk timestamp u32, num_sensors x (sensor_id u8, data u32))
  ActuatorCommandPacket    num_commands @6, then N x (actuator_id, actuator_state)
  SensorConfigPacket       num_sensors @6, N x sensor_id, reference_voltage,
                           necessary_for_abort, [controller_ip 4B], enable_serial_printing
  ActuatorConfigPacket     is_abort_controller @6, num_abort_actuators @7, N x
                           AbortActuatorLocation (ip u32, actuator_id, vent_state, abort_state),
                           num_abort_pts, X x AbortPTLocation (ip u32, sensor_id, adc u32),
                           enable_serial_printing
  SelfTestPacket           adc_good @6, num_sensors @7, N x (sensor_id, result)
  StacklightCommandPacket  red @6, yellow @7, green @8, buzzer @9
  LOGS (create_log_packet) flags @6, text_len u16 @7, text @9

Header timestamps are never printed raw: they are classified (normalize.classify_ts), so a change
of clock source still shows up while the value itself does not.
"""

from __future__ import annotations

import struct

import normalize

PACKET_NAMES = {
    1: "BOARD_HEARTBEAT",
    2: "SERVER_HEARTBEAT",
    3: "SENSOR_DATA",
    4: "ACTUATOR_COMMAND",
    5: "SENSOR_CONFIG",
    6: "ACTUATOR_CONFIG",
    7: "ABORT",
    8: "ABORT_DONE",
    9: "CLEAR_ABORT",
    10: "PWM_ACTUATOR_COMMAND",
    11: "NO_CONNECTION_ABORT",
    12: "SELF_TEST",
    13: "ENVIRONMENTAL_DATA",
    14: "STACKLIGHT_COMMAND",
    15: "LOGS",
}


def ptype(data: bytes) -> str:
    if not data:
        return "EMPTY"
    return PACKET_NAMES.get(data[0], f"UNKNOWN({data[0]})")


def _ip_from_u32_le(raw: bytes) -> str:
    # config_broadcast stores (a<<24|b<<16|c<<8|d) with memcpy on a little-endian host.
    v = struct.unpack("<I", raw)[0]
    return f"{(v >> 24) & 0xFF}.{(v >> 16) & 0xFF}.{(v >> 8) & 0xFF}.{v & 0xFF}"


def _hex(b: bytes) -> str:
    return " ".join(f"{x:02X}" for x in b)


class _Lines:
    def __init__(self, data: bytes, indent: str):
        self.data = data
        self.indent = indent
        self.out: list[str] = []
        self.off = 0

    def field(
        self, name: str, size: int, value: str | None = None, masked: bool = False
    ) -> bytes:
        raw = self.data[self.off : self.off + size]
        if len(raw) < size:
            self.out.append(
                f"{self.indent}@{self.off:<3} {name}: TRUNCATED ({_hex(raw)})"
            )
            self.off = len(self.data)
            return raw
        shown = (
            value if value is not None else (str(raw[0]) if size == 1 else _hex(raw))
        )
        raw_shown = "" if masked else f"   [{_hex(raw)}]"
        self.out.append(f"{self.indent}@{self.off:<3} {name} = {shown}{raw_shown}")
        self.off += size
        return raw

    def u8(self, name: str) -> int:
        raw = self.field(name, 1)
        return raw[0] if raw else 0

    def tail(self):
        if self.off < len(self.data):
            self.out.append(
                f"{self.indent}@{self.off:<3} trailing {len(self.data) - self.off} bytes"
                f" [{_hex(self.data[self.off:])}]"
            )


def decode(
    data: bytes,
    indent: str = "    ",
    recv_epoch_ms: int | None = None,
    board_clock: bool = False,
) -> list[str]:
    """Field-per-line decode. recv_epoch_ms classifies the header timestamp; board_clock says it
    is a board's millis() (uptime, can be 0 or a few ms on the first packet) and masks it.
    """
    L = _Lines(data, indent)
    L.out.append(f"{indent}{ptype(data)} len={len(data)}")
    if len(data) < 6:
        L.tail()
        return L.out
    L.u8("type")
    L.u8("version")
    ts = struct.unpack("<I", data[2:6])[0]
    L.field(
        "timestamp",
        4,
        "<board-ms>" if board_clock else normalize.classify_ts(ts, recv_epoch_ms),
        masked=True,
    )
    t = data[0]
    if t == 1:
        L.field("firmware_hash", 32, "zero" if data[6:38] == bytes(32) else "nonzero")
        L.u8("board_id")
        L.u8("engine_state")
        L.u8("board_state")
    elif t == 2:
        L.u8("engine_state")
    elif t == 3:
        nch = L.u8("num_chunks")
        ns = L.u8("num_sensors")
        for c in range(nch):
            L.field(f"chunk[{c}].timestamp", 4, "<board-ms>", masked=True)
            for s in range(ns):
                L.u8(f"chunk[{c}].sensor[{s}].id")
                L.field(f"chunk[{c}].sensor[{s}].data", 4, "<sample>", masked=True)
    elif t == 4:
        n = L.u8("num_commands")
        for i in range(n):
            L.u8(f"cmd[{i}].actuator_id")
            L.u8(f"cmd[{i}].actuator_state")
    elif t == 5:
        n = L.u8("num_sensors")
        for i in range(n):
            L.u8(f"sensor_id[{i}]")
        L.u8("reference_voltage")
        nfa = L.u8("necessary_for_abort")
        if nfa:
            raw = data[L.off : L.off + 4]
            L.field("controller_ip(BE)", 4, ".".join(str(x) for x in raw))
        L.u8("enable_serial_printing")
    elif t == 6:
        L.u8("is_abort_controller")
        n = L.u8("num_abort_actuators")
        for i in range(n):
            raw = data[L.off : L.off + 4]
            L.field(f"act[{i}].ip", 4, _ip_from_u32_le(raw) if len(raw) == 4 else None)
            L.u8(f"act[{i}].actuator_id")
            L.u8(f"act[{i}].vent_state")
            L.u8(f"act[{i}].abort_state")
        x = L.u8("num_abort_pts")
        for i in range(x):
            raw = data[L.off : L.off + 4]
            L.field(f"pt[{i}].ip", 4, _ip_from_u32_le(raw) if len(raw) == 4 else None)
            L.u8(f"pt[{i}].sensor_id")
            raw = data[L.off : L.off + 4]
            L.field(
                f"pt[{i}].threshold_adc",
                4,
                str(struct.unpack("<I", raw)[0]) if len(raw) == 4 else None,
            )
        L.u8("enable_serial_printing")
    elif t == 12:
        L.u8("adc_good")
        n = L.u8("num_sensors")
        for i in range(n):
            L.u8(f"result[{i}].sensor_id")
            L.u8(f"result[{i}].result")
    elif t == 14:
        L.u8("red")
        L.u8("yellow")
        L.u8("green")
        L.u8("buzzer")
    elif t == 15:
        L.u8("flags")
        raw = data[L.off : L.off + 2]
        n = struct.unpack("<H", raw)[0] if len(raw) == 2 else 0
        L.field("text_len", 2, str(n))
        text = data[L.off : L.off + n].decode("utf-8", "replace")
        L.out.append(f"{indent}@{L.off:<3} text = {normalize.log_text(text)!r}")
        L.off += n
    L.tail()
    return L.out


def sensor_data_summary(data: bytes) -> dict:
    """num_chunks, num_sensors, sensor ids and per-id values of the first chunk."""
    if len(data) < 8 or data[0] != 3:
        return {}
    nch, ns = data[6], data[7]
    ids, vals = [], {}
    off = 8 + 4
    for _ in range(ns):
        if off + 5 > len(data):
            break
        sid = data[off]
        val = struct.unpack("<I", data[off + 1 : off + 5])[0]
        ids.append(sid)
        vals[sid] = val
        off += 5
    return {"num_chunks": nch, "num_sensors": ns, "ids": ids, "values": vals}


def server_heartbeat(engine_state: int = 0, ts: int = 0) -> bytes:
    return struct.pack("<BBIB", 2, 0, ts & 0xFFFFFFFF, engine_state)


def actuator_command(cmds: list[tuple[int, int]], ts: int = 0) -> bytes:
    body = struct.pack("<B", len(cmds)) + b"".join(
        struct.pack("<BB", a, s) for a, s in cmds
    )
    return struct.pack("<BBI", 4, 0, ts & 0xFFFFFFFF) + body

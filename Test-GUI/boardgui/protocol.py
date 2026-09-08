"""
DAQv2-Comms wire protocol — encode / decode.

This is the single source of truth for the packets exchanged between the STAR
avionics boards (firmware/) and this GUI, which plays the role of the ground
DAQ server. It mirrors, byte-for-byte, the C++ implementation in
``firmware/libraries/DAQv2-Comms`` (DiabloPackets.h / DiabloPacketUtils.cpp).

Every message is a small packed binary struct: a 6-byte header followed by a
type-specific body. All multi-byte fields are little-endian, matching the
boards' native (ESP32) layout.

    +---------------- PacketHeader (6 bytes) ----------------+
    | packet_type : u8   version : u8   timestamp : u32 (ms) |
    +--------------------------------------------------------+
                             |
                             v
                  type-specific body (fixed or variable)

This module has **no GUI / third-party dependencies** (stdlib only) so it can
be unit-tested headlessly. Run ``python -m boardgui.protocol`` to execute the
built-in round-trip self-test.
"""

from __future__ import annotations

import struct
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# -----------------------------------------------------------------------------
# Protocol constants  (keep in lock-step with DAQv2-Comms.h / DiabloEnums.h)
# -----------------------------------------------------------------------------
DIABLO_COMMS_VERSION = 0
MAX_PACKET_SIZE = 512

PACKET_HEADER_FORMAT = "<BBI"          # packet_type, version, timestamp_ms
PACKET_HEADER_SIZE = 6

# Board heartbeat body: firmware_hash[32], board_id, engine_state, board_state
BOARD_HEARTBEAT_BODY_FORMAT = "<32sBBB"
BOARD_HEARTBEAT_BODY_SIZE = 35

# Sensor data
SENSOR_DATA_HEADER_FORMAT = "<BB"      # num_chunks, num_sensors
SENSOR_DATA_HEADER_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = "<I"        # chunk timestamp (ms)
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = "<BI"        # sensor_id, raw u32 value
SENSOR_DATAPOINT_SIZE = 5

# Actuator command / PWM command (DiabloPackets.h, packed little-endian)
ACTUATOR_COMMAND_FORMAT = "<BB"        # actuator_id, actuator_state
ACTUATOR_COMMAND_SIZE = 2
PWM_ACTUATOR_COMMAND_FORMAT = "<BIff"  # actuator_id, duration_ms, duty, freq
PWM_ACTUATOR_COMMAND_SIZE = 13

# Actuator config (abort) — see ActuatorConfigPacket in DiabloPackets.h.
# The u32 IPs are the firmware's "logical" big-endian value (a<<24|b<<16|c<<8|d)
# stored little-endian on the wire, i.e. wire bytes are [d, c, b, a].
ABORT_ACTUATOR_LOCATION_FORMAT = "<IBBB"  # ip, actuator_id, vent, abort
ABORT_ACTUATOR_LOCATION_SIZE = 7
ABORT_PT_LOCATION_FORMAT = "<IBI"         # ip, sensor_id, threshold_adc
ABORT_PT_LOCATION_SIZE = 9


class PacketType:
    """PacketType enum (DiabloEnums.h). board <-> server."""
    BOARD_HEARTBEAT = 1       # board -> server : liveness + fw hash + state
    SERVER_HEARTBEAT = 2      # server -> board : liveness + engine state
    SENSOR_DATA = 3           # board -> server : load-cell / sensor readings
    ACTUATOR_COMMAND = 4
    SENSOR_CONFIG = 5         # server -> board : which connectors + identity
    ACTUATOR_CONFIG = 6
    ABORT = 7                 # server -> board : trigger abort
    ABORT_DONE = 8
    CLEAR_ABORT = 9           # server -> board : release abort
    PWM_ACTUATOR_COMMAND = 10
    NO_CONNECTION_ABORT = 11  # board <-> board : autonomous abort
    SELF_TEST = 12            # board -> server : startup self-test results
    ENVIRONMENTAL_DATA = 13
    STACKLIGHT_COMMAND = 14


class BoardState:
    """A board's own state-machine value (DiabloEnums.h)."""
    SETUP = 1
    ACTIVE = 2
    CONNECTION_LOSS_DETECTED = 3
    NO_CONNECTION_ABORT = 4
    NO_CONN_ABORT_FOLLOWER = 5
    PT_ABORT = 6
    NO_PT_ABORT = 7
    ABORT_FINISHED = 8
    STANDALONE_ABORT = 9
    SELF_TEST = 10


class EngineState:
    """System-wide engine state the server broadcasts (DiabloEnums.h)."""
    SAFE = 0
    PRESSURIZING = 1
    LOX_FILL = 2
    FIRING = 3
    POST_FIRE = 4


BOARD_STATE_NAMES: Dict[int, str] = {
    BoardState.SETUP: "Setup (waiting for server)",
    BoardState.ACTIVE: "Active",
    BoardState.CONNECTION_LOSS_DETECTED: "Connection Loss Detected",
    BoardState.NO_CONNECTION_ABORT: "No-Connection Abort",
    BoardState.NO_CONN_ABORT_FOLLOWER: "No-Conn Abort (follower)",
    BoardState.PT_ABORT: "PT Abort",
    BoardState.NO_PT_ABORT: "No PT Abort",
    BoardState.ABORT_FINISHED: "Abort Finished",
    BoardState.STANDALONE_ABORT: "Standalone Abort",
    BoardState.SELF_TEST: "Self Test",
}

ENGINE_STATE_NAMES: Dict[int, str] = {
    EngineState.SAFE: "Safe",
    EngineState.PRESSURIZING: "Pressurizing",
    EngineState.LOX_FILL: "LOX Fill",
    EngineState.FIRING: "Firing",
    EngineState.POST_FIRE: "Post Fire",
}

PACKET_TYPE_NAMES: Dict[int, str] = {
    PacketType.BOARD_HEARTBEAT: "BOARD_HEARTBEAT",
    PacketType.SERVER_HEARTBEAT: "SERVER_HEARTBEAT",
    PacketType.SENSOR_DATA: "SENSOR_DATA",
    PacketType.ACTUATOR_COMMAND: "ACTUATOR_COMMAND",
    PacketType.SENSOR_CONFIG: "SENSOR_CONFIG",
    PacketType.ACTUATOR_CONFIG: "ACTUATOR_CONFIG",
    PacketType.ABORT: "ABORT",
    PacketType.ABORT_DONE: "ABORT_DONE",
    PacketType.CLEAR_ABORT: "CLEAR_ABORT",
    PacketType.PWM_ACTUATOR_COMMAND: "PWM_ACTUATOR_COMMAND",
    PacketType.NO_CONNECTION_ABORT: "NO_CONNECTION_ABORT",
    PacketType.SELF_TEST: "SELF_TEST",
    PacketType.ENVIRONMENTAL_DATA: "ENVIRONMENTAL_DATA",
    PacketType.STACKLIGHT_COMMAND: "STACKLIGHT_COMMAND",
}


def board_state_name(state: int) -> str:
    return BOARD_STATE_NAMES.get(state, f"Unknown ({state})")


def engine_state_name(state: int) -> str:
    return ENGINE_STATE_NAMES.get(state, f"Unknown ({state})")


def packet_type_name(ptype: int) -> str:
    return PACKET_TYPE_NAMES.get(ptype, f"UNKNOWN ({ptype})")


# -----------------------------------------------------------------------------
# Parsed-packet dataclasses (what the receiver hands to the GUI)
# -----------------------------------------------------------------------------
@dataclass
class PacketHeader:
    packet_type: int
    version: int
    timestamp_ms: int


@dataclass
class BoardHeartbeat:
    header: PacketHeader
    firmware_hash: bytes  # 32-byte SHA-256 of the running firmware
    board_id: int
    engine_state: int
    board_state: int

    @property
    def firmware_hash_hex(self) -> str:
        return self.firmware_hash.hex()


@dataclass
class SensorDatapoint:
    sensor_id: int
    raw: int  # unsigned 32-bit ADC code as sent on the wire


@dataclass
class SensorDataChunk:
    timestamp_ms: int
    datapoints: List[SensorDatapoint] = field(default_factory=list)


@dataclass
class SensorData:
    header: PacketHeader
    num_chunks: int
    num_sensors: int
    chunks: List[SensorDataChunk] = field(default_factory=list)


@dataclass
class SelfTestResult:
    sensor_id: int
    passed: bool


@dataclass
class SelfTest:
    header: PacketHeader
    adc_good: bool
    results: List[SelfTestResult] = field(default_factory=list)


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def now_ms() -> int:
    """Millisecond timestamp truncated to u32, matching the boards' millis()."""
    return int(time.time() * 1000) & 0xFFFFFFFF


def raw_to_signed(raw_u32: int) -> int:
    """Reinterpret a u32 ADC code as signed int32 (ADS126X is a signed ADC)."""
    return struct.unpack("<i", struct.pack("<I", raw_u32 & 0xFFFFFFFF))[0]


def raw_to_voltage(raw_u32: int, ref_voltage: float) -> float:
    """Convert a raw u32 ADC code to volts, assuming a signed 32-bit full scale."""
    return (raw_to_signed(raw_u32) * ref_voltage) / 2147483648.0


def raw_to_float(raw_u32: int) -> float:
    """Reinterpret a u32 as an IEEE-754 float (actuator current-sense volts).

    The actuator board memcpy()s a float voltage into the u32 datapoint field
    (see Actuator_Hotfire readCurrentSensePinsAndSend), unlike the sense
    boards which send signed ADC codes.
    """
    return struct.unpack("<f", struct.pack("<I", raw_u32 & 0xFFFFFFFF))[0]


def float_to_raw(value: float) -> int:
    """Inverse of raw_to_float (used by the demo actuator board)."""
    return struct.unpack("<I", struct.pack("<f", value))[0]


def ip_str_to_u32(ip: str) -> int:
    """Dotted-quad -> the firmware's logical big-endian u32 (a<<24|b<<16|c<<8|d)."""
    parts = [int(x) for x in ip.strip().split(".")]
    if len(parts) != 4 or not all(0 <= p <= 255 for p in parts):
        raise ValueError(f"invalid IPv4 address: {ip!r}")
    return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]


def u32_to_ip_str(ip: int) -> str:
    """Inverse of ip_str_to_u32."""
    return f"{(ip >> 24) & 0xFF}.{(ip >> 16) & 0xFF}.{(ip >> 8) & 0xFF}.{ip & 0xFF}"


# -----------------------------------------------------------------------------
# Encode  (server -> board control packets)
# -----------------------------------------------------------------------------
def _make_header(packet_type: int, timestamp_ms: Optional[int] = None) -> bytes:
    ts = now_ms() if timestamp_ms is None else (timestamp_ms & 0xFFFFFFFF)
    return struct.pack(PACKET_HEADER_FORMAT, packet_type, DIABLO_COMMS_VERSION, ts)


def build_server_heartbeat(engine_state: int = EngineState.SAFE,
                           timestamp_ms: Optional[int] = None) -> bytes:
    """SERVER_HEARTBEAT: header + u8 engine_state."""
    return _make_header(PacketType.SERVER_HEARTBEAT, timestamp_ms) + \
        struct.pack("<B", engine_state & 0xFF)


def build_sensor_config(sensor_ids: List[int],
                        reference_voltage: int = 0,
                        necessary_for_abort: bool = False,
                        controller_ip: Optional[str] = None,
                        enable_serial_printing: bool = True,
                        timestamp_ms: Optional[int] = None) -> bytes:
    """
    SENSOR_CONFIG (type 5) — tells the board which connectors to read and its
    identity/behaviour. Wire layout after the 6-byte header:

        u8   num_sensors (N)
        N x  u8 sensor_id
        u8   reference_voltage   (0=2.5V internal, 1=VDD, 2=5V absolute)
        u8   necessary_for_abort (0/1)
        [u32 controller_ip]      (big-endian, ONLY if necessary_for_abort)
        u8   enable_serial_printing (0/1)
    """
    clean_ids: List[int] = [int(s) & 0xFF for s in sensor_ids if 0 <= int(s) <= 255][:255]

    body = bytearray()
    body.append(len(clean_ids) & 0xFF)
    body.extend(bytes(clean_ids))
    body.append(reference_voltage & 0xFF)
    body.append(1 if necessary_for_abort else 0)
    if necessary_for_abort and controller_ip:
        parts = [int(x) for x in controller_ip.strip().split(".")]
        if len(parts) == 4 and all(0 <= p <= 255 for p in parts):
            ip_be = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]
            body.extend(struct.pack(">I", ip_be))
    body.append(1 if enable_serial_printing else 0)

    pkt = _make_header(PacketType.SENSOR_CONFIG, timestamp_ms) + bytes(body)
    return pkt[:MAX_PACKET_SIZE]


def build_header_only(packet_type: int, timestamp_ms: Optional[int] = None) -> bytes:
    """ABORT (7), CLEAR_ABORT (9), NO_CONNECTION_ABORT (11): header only."""
    return _make_header(packet_type, timestamp_ms)


@dataclass
class SensorConfig:
    header: PacketHeader
    sensor_ids: List[int]
    reference_voltage: int
    necessary_for_abort: bool
    controller_ip: int
    enable_serial_printing: bool


def parse_sensor_config(data: bytes) -> Optional[SensorConfig]:
    """Inverse of build_sensor_config (used by the demo board / tests)."""
    header = parse_header(data)
    if header is None or header.packet_type != PacketType.SENSOR_CONFIG:
        return None
    if len(data) < PACKET_HEADER_SIZE + 4:
        return None
    off = PACKET_HEADER_SIZE
    n = data[off]
    off += 1
    if len(data) < off + n + 3:
        return None
    ids = list(data[off:off + n])
    off += n
    ref = data[off]; off += 1
    necessary = data[off] != 0; off += 1
    controller_ip = 0
    if necessary:
        if len(data) < off + 5:
            return None
        controller_ip = struct.unpack(">I", data[off:off + 4])[0]
        off += 4
    if len(data) < off + 1:
        return None
    enable_serial = data[off] != 0
    return SensorConfig(header, ids, ref, necessary, controller_ip, enable_serial)


# -----------------------------------------------------------------------------
# Actuator packets (server -> actuator board), mirroring DiabloPacketUtils.cpp
# -----------------------------------------------------------------------------
@dataclass
class ActuatorCommand:
    actuator_id: int
    actuator_state: int  # 1 = on, 0 = off


@dataclass
class PWMActuatorCommand:
    actuator_id: int
    duration_ms: int
    duty_cycle: float  # 0.0 - 1.0
    frequency_hz: float


@dataclass
class AbortActuatorLocation:
    ip: str            # dotted quad of the board this actuator lives on
    actuator_id: int
    vent_state: int    # 1 = on, 0 = off
    abort_state: int   # 1 = on, 0 = off


@dataclass
class AbortPTLocation:
    ip: str
    sensor_id: int
    pressure_threshold_adc: int


@dataclass
class ActuatorConfig:
    header: PacketHeader
    is_abort_controller: bool
    abort_actuators: List[AbortActuatorLocation]
    abort_pts: List[AbortPTLocation]
    enable_serial_printing: bool


def build_actuator_command(commands: List[ActuatorCommand],
                           timestamp_ms: Optional[int] = None) -> bytes:
    """ACTUATOR_COMMAND (type 4): header + u8 num_commands + N x (id, state)."""
    if not 1 <= len(commands) <= 255:
        raise ValueError("num_commands must be between 1 and 255")
    body = bytearray([len(commands)])
    for cmd in commands:
        body += struct.pack(ACTUATOR_COMMAND_FORMAT,
                            cmd.actuator_id & 0xFF, 1 if cmd.actuator_state else 0)
    return _make_header(PacketType.ACTUATOR_COMMAND, timestamp_ms) + bytes(body)


def parse_actuator_command(data: bytes) -> Optional[List[ActuatorCommand]]:
    header = parse_header(data)
    if header is None or header.packet_type != PacketType.ACTUATOR_COMMAND:
        return None
    if len(data) < PACKET_HEADER_SIZE + 1:
        return None
    n = data[PACKET_HEADER_SIZE]
    off = PACKET_HEADER_SIZE + 1
    if len(data) < off + n * ACTUATOR_COMMAND_SIZE:
        return None
    out: List[ActuatorCommand] = []
    for _ in range(n):
        aid, state = struct.unpack(ACTUATOR_COMMAND_FORMAT,
                                   data[off:off + ACTUATOR_COMMAND_SIZE])
        out.append(ActuatorCommand(aid, state))
        off += ACTUATOR_COMMAND_SIZE
    return out


def build_pwm_actuator_command(commands: List[PWMActuatorCommand],
                               timestamp_ms: Optional[int] = None) -> bytes:
    """PWM_ACTUATOR_COMMAND (type 10): header + u8 num + N x (id, dur, duty, freq)."""
    if not 1 <= len(commands) <= 255:
        raise ValueError("num_commands must be between 1 and 255")
    body = bytearray([len(commands)])
    for cmd in commands:
        body += struct.pack(PWM_ACTUATOR_COMMAND_FORMAT,
                            cmd.actuator_id & 0xFF, cmd.duration_ms & 0xFFFFFFFF,
                            float(cmd.duty_cycle), float(cmd.frequency_hz))
    return _make_header(PacketType.PWM_ACTUATOR_COMMAND, timestamp_ms) + bytes(body)


def parse_pwm_actuator_command(data: bytes) -> Optional[List[PWMActuatorCommand]]:
    header = parse_header(data)
    if header is None or header.packet_type != PacketType.PWM_ACTUATOR_COMMAND:
        return None
    if len(data) < PACKET_HEADER_SIZE + 1:
        return None
    n = data[PACKET_HEADER_SIZE]
    off = PACKET_HEADER_SIZE + 1
    if len(data) < off + n * PWM_ACTUATOR_COMMAND_SIZE:
        return None
    out: List[PWMActuatorCommand] = []
    for _ in range(n):
        aid, dur, duty, freq = struct.unpack(
            PWM_ACTUATOR_COMMAND_FORMAT, data[off:off + PWM_ACTUATOR_COMMAND_SIZE])
        out.append(PWMActuatorCommand(aid, dur, duty, freq))
        off += PWM_ACTUATOR_COMMAND_SIZE
    return out


def build_actuator_config(is_abort_controller: bool,
                          abort_actuators: List[AbortActuatorLocation],
                          abort_pts: List[AbortPTLocation],
                          enable_serial_printing: bool = True,
                          timestamp_ms: Optional[int] = None) -> bytes:
    """
    ACTUATOR_CONFIG (type 6) — activates an actuator board. Wire layout after
    the 6-byte header (all little-endian, packed):

        u8   is_abort_controller (0/1)
        u8   num_abort_actuators (N)
        N x  { u32 ip, u8 actuator_id, u8 vent_state, u8 abort_state }
        u8   num_abort_pts (X)
        X x  { u32 ip, u8 sensor_id, u32 pressure_threshold_adc }
        u8   enable_serial_printing (0/1)
    """
    body = bytearray([1 if is_abort_controller else 0, len(abort_actuators) & 0xFF])
    for loc in abort_actuators:
        body += struct.pack(ABORT_ACTUATOR_LOCATION_FORMAT, ip_str_to_u32(loc.ip),
                            loc.actuator_id & 0xFF, 1 if loc.vent_state else 0,
                            1 if loc.abort_state else 0)
    body.append(len(abort_pts) & 0xFF)
    for pt in abort_pts:
        body += struct.pack(ABORT_PT_LOCATION_FORMAT, ip_str_to_u32(pt.ip),
                            pt.sensor_id & 0xFF, pt.pressure_threshold_adc & 0xFFFFFFFF)
    body.append(1 if enable_serial_printing else 0)
    pkt = _make_header(PacketType.ACTUATOR_CONFIG, timestamp_ms) + bytes(body)
    return pkt[:MAX_PACKET_SIZE]


def parse_actuator_config(data: bytes) -> Optional[ActuatorConfig]:
    """Inverse of build_actuator_config (used by the demo board / tests)."""
    header = parse_header(data)
    if header is None or header.packet_type != PacketType.ACTUATOR_CONFIG:
        return None
    if len(data) < PACKET_HEADER_SIZE + 4:
        return None
    off = PACKET_HEADER_SIZE
    is_controller = data[off] != 0
    n = data[off + 1]
    off += 2
    if len(data) < off + n * ABORT_ACTUATOR_LOCATION_SIZE + 2:
        return None
    actuators: List[AbortActuatorLocation] = []
    for _ in range(n):
        ip, aid, vent, abort = struct.unpack(
            ABORT_ACTUATOR_LOCATION_FORMAT,
            data[off:off + ABORT_ACTUATOR_LOCATION_SIZE])
        actuators.append(AbortActuatorLocation(u32_to_ip_str(ip), aid, vent, abort))
        off += ABORT_ACTUATOR_LOCATION_SIZE
    x = data[off]
    off += 1
    if len(data) < off + x * ABORT_PT_LOCATION_SIZE + 1:
        return None
    pts: List[AbortPTLocation] = []
    for _ in range(x):
        ip, sid, threshold = struct.unpack(
            ABORT_PT_LOCATION_FORMAT, data[off:off + ABORT_PT_LOCATION_SIZE])
        pts.append(AbortPTLocation(u32_to_ip_str(ip), sid, threshold))
        off += ABORT_PT_LOCATION_SIZE
    enable_serial = data[off] != 0
    return ActuatorConfig(header, is_controller, actuators, pts, enable_serial)


# -----------------------------------------------------------------------------
# Decode  (board -> server packets)
# -----------------------------------------------------------------------------
def parse_header(data: bytes) -> Optional[PacketHeader]:
    if len(data) < PACKET_HEADER_SIZE:
        return None
    try:
        ptype, version, ts = struct.unpack(PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE])
    except struct.error:
        return None
    return PacketHeader(ptype, version, ts)


def parse_board_heartbeat(data: bytes) -> Optional[BoardHeartbeat]:
    header = parse_header(data)
    if header is None or header.packet_type != PacketType.BOARD_HEARTBEAT:
        return None
    if len(data) < PACKET_HEADER_SIZE + BOARD_HEARTBEAT_BODY_SIZE:
        return None
    try:
        fw_hash, board_id, engine_state, board_state = struct.unpack(
            BOARD_HEARTBEAT_BODY_FORMAT,
            data[PACKET_HEADER_SIZE:PACKET_HEADER_SIZE + BOARD_HEARTBEAT_BODY_SIZE],
        )
    except struct.error:
        return None
    return BoardHeartbeat(header, fw_hash, board_id, engine_state, board_state)


def parse_sensor_data(data: bytes) -> Optional[SensorData]:
    header = parse_header(data)
    if header is None or header.packet_type != PacketType.SENSOR_DATA:
        return None
    if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_HEADER_SIZE:
        return None
    offset = PACKET_HEADER_SIZE
    try:
        num_chunks, num_sensors = struct.unpack(
            SENSOR_DATA_HEADER_FORMAT, data[offset:offset + SENSOR_DATA_HEADER_SIZE])
    except struct.error:
        return None
    offset += SENSOR_DATA_HEADER_SIZE

    per_chunk = SENSOR_DATA_CHUNK_SIZE + num_sensors * SENSOR_DATAPOINT_SIZE
    expected = PACKET_HEADER_SIZE + SENSOR_DATA_HEADER_SIZE + num_chunks * per_chunk
    if len(data) < expected:
        return None

    chunks: List[SensorDataChunk] = []
    for _ in range(num_chunks):
        (chunk_ts,) = struct.unpack(
            SENSOR_DATA_CHUNK_FORMAT, data[offset:offset + SENSOR_DATA_CHUNK_SIZE])
        offset += SENSOR_DATA_CHUNK_SIZE
        points: List[SensorDatapoint] = []
        for _ in range(num_sensors):
            sid, raw = struct.unpack(
                SENSOR_DATAPOINT_FORMAT, data[offset:offset + SENSOR_DATAPOINT_SIZE])
            offset += SENSOR_DATAPOINT_SIZE
            points.append(SensorDatapoint(sid, raw))
        chunks.append(SensorDataChunk(chunk_ts, points))
    return SensorData(header, num_chunks, num_sensors, chunks)


def parse_self_test(data: bytes) -> Optional[SelfTest]:
    header = parse_header(data)
    if header is None or header.packet_type != PacketType.SELF_TEST:
        return None
    if len(data) < PACKET_HEADER_SIZE + 2:
        return None
    adc_good = data[PACKET_HEADER_SIZE]
    num_sensors = data[PACKET_HEADER_SIZE + 1]
    expected = PACKET_HEADER_SIZE + 2 + num_sensors * 2
    if len(data) < expected:
        return None
    offset = PACKET_HEADER_SIZE + 2
    results: List[SelfTestResult] = []
    for _ in range(num_sensors):
        sid = data[offset]
        passed = data[offset + 1]
        results.append(SelfTestResult(sid, bool(passed)))
        offset += 2
    return SelfTest(header, bool(adc_good), results)


# -----------------------------------------------------------------------------
# Headless self-test: encode -> decode round-trip for every packet we handle.
# -----------------------------------------------------------------------------
def _self_test() -> None:
    import os

    # --- SERVER_HEARTBEAT round-trip via a hand-built board heartbeat -----
    fw = os.urandom(32)
    hb_wire = _make_header(PacketType.BOARD_HEARTBEAT, 1234) + \
        struct.pack(BOARD_HEARTBEAT_BODY_FORMAT, fw, 41, EngineState.SAFE, BoardState.ACTIVE)
    hb = parse_board_heartbeat(hb_wire)
    assert hb is not None, "heartbeat parse failed"
    assert hb.board_id == 41 and hb.board_state == BoardState.ACTIVE
    assert hb.firmware_hash == fw
    assert hb.header.timestamp_ms == 1234

    # --- SENSOR_DATA round-trip (mirror create_sensor_data_packet) --------
    num_sensors = 3
    ids = [1, 2, 3]
    vals = [0x00000001, 0xFFFFFFFF, 0x12345678]  # includes a negative (signed) code
    body = bytearray(struct.pack(SENSOR_DATA_HEADER_FORMAT, 2, num_sensors))
    for chunk_ts in (100, 110):
        body += struct.pack(SENSOR_DATA_CHUNK_FORMAT, chunk_ts)
        for sid, v in zip(ids, vals):
            body += struct.pack(SENSOR_DATAPOINT_FORMAT, sid, v)
    sd_wire = _make_header(PacketType.SENSOR_DATA, 999) + bytes(body)
    sd = parse_sensor_data(sd_wire)
    assert sd is not None, "sensor data parse failed"
    assert sd.num_chunks == 2 and sd.num_sensors == 3
    assert sd.chunks[0].datapoints[1].raw == 0xFFFFFFFF
    assert raw_to_signed(0xFFFFFFFF) == -1
    assert abs(raw_to_voltage(0xFFFFFFFF, 2.5)) < 1e-6  # -1 code ~ 0 V

    # --- SELF_TEST round-trip ---------------------------------------------
    st_wire = _make_header(PacketType.SELF_TEST, 5) + \
        struct.pack("<BB", 1, 2) + struct.pack("<BBBB", 1, 1, 2, 0)
    st = parse_self_test(st_wire)
    assert st is not None and st.adc_good is True
    assert st.results[0].passed is True and st.results[1].passed is False

    # --- SENSOR_CONFIG structure (decode the parts we wrote) --------------
    cfg = build_sensor_config([1, 2, 3], reference_voltage=1,
                              necessary_for_abort=False, enable_serial_printing=True)
    assert cfg[0] == PacketType.SENSOR_CONFIG
    assert cfg[PACKET_HEADER_SIZE] == 3                      # num_sensors
    assert list(cfg[PACKET_HEADER_SIZE + 1:PACKET_HEADER_SIZE + 4]) == [1, 2, 3]
    assert cfg[PACKET_HEADER_SIZE + 4] == 1                  # reference_voltage
    assert cfg[PACKET_HEADER_SIZE + 5] == 0                  # necessary_for_abort
    assert cfg[PACKET_HEADER_SIZE + 6] == 1                  # enable_serial_printing

    # --- SENSOR_CONFIG with abort controller IP (adds 4 BE bytes) ---------
    cfg2 = build_sensor_config([7], reference_voltage=0, necessary_for_abort=True,
                               controller_ip="192.168.2.20", enable_serial_printing=False)
    base = PACKET_HEADER_SIZE + 1 + 1 + 1 + 1  # hdr + n + id + ref + abort_flag
    assert list(cfg2[base:base + 4]) == [192, 168, 2, 20]   # big-endian IP
    assert cfg2[base + 4] == 0                               # enable_serial_printing

    # --- header-only control packets --------------------------------------
    assert len(build_header_only(PacketType.ABORT)) == PACKET_HEADER_SIZE
    assert build_server_heartbeat(EngineState.FIRING)[PACKET_HEADER_SIZE] == EngineState.FIRING

    # --- SENSOR_CONFIG build -> parse round-trip --------------------------
    sc = parse_sensor_config(cfg)
    assert sc is not None and sc.sensor_ids == [1, 2, 3]
    assert sc.reference_voltage == 1 and sc.necessary_for_abort is False
    assert sc.enable_serial_printing is True
    sc2 = parse_sensor_config(cfg2)
    assert sc2 is not None and sc2.necessary_for_abort is True
    assert sc2.controller_ip == ((192 << 24) | (168 << 16) | (2 << 8) | 20)
    assert sc2.enable_serial_printing is False

    # --- ACTUATOR_COMMAND build -> parse round-trip -----------------------
    ac = build_actuator_command([ActuatorCommand(1, 1), ActuatorCommand(7, 0)])
    assert ac[0] == PacketType.ACTUATOR_COMMAND
    assert ac[PACKET_HEADER_SIZE] == 2                       # num_commands
    cmds = parse_actuator_command(ac)
    assert cmds is not None and len(cmds) == 2
    assert cmds[0].actuator_id == 1 and cmds[0].actuator_state == 1
    assert cmds[1].actuator_id == 7 and cmds[1].actuator_state == 0

    # --- PWM_ACTUATOR_COMMAND build -> parse round-trip -------------------
    pwm = build_pwm_actuator_command(
        [PWMActuatorCommand(3, duration_ms=2000, duty_cycle=0.5, frequency_hz=10.0)])
    assert pwm[0] == PacketType.PWM_ACTUATOR_COMMAND
    assert len(pwm) == PACKET_HEADER_SIZE + 1 + PWM_ACTUATOR_COMMAND_SIZE
    pcmds = parse_pwm_actuator_command(pwm)
    assert pcmds is not None and pcmds[0].actuator_id == 3
    assert pcmds[0].duration_ms == 2000
    assert abs(pcmds[0].duty_cycle - 0.5) < 1e-9
    assert abs(pcmds[0].frequency_hz - 10.0) < 1e-9

    # --- ACTUATOR_CONFIG build -> parse round-trip ------------------------
    acfg = build_actuator_config(
        is_abort_controller=True,
        abort_actuators=[AbortActuatorLocation("192.168.2.11", 2, 1, 0)],
        abort_pts=[AbortPTLocation("192.168.2.21", 5, 123456)],
        enable_serial_printing=True)
    assert acfg[0] == PacketType.ACTUATOR_CONFIG
    # The u32 IP must land little-endian on the wire ([d,c,b,a]) so the
    # firmware's memcpy'd uint32_t equals its logical a<<24|b<<16|c<<8|d.
    assert list(acfg[PACKET_HEADER_SIZE + 2:PACKET_HEADER_SIZE + 6]) == [11, 2, 168, 192]
    pc = parse_actuator_config(acfg)
    assert pc is not None and pc.is_abort_controller is True
    assert pc.abort_actuators[0].ip == "192.168.2.11"
    assert pc.abort_actuators[0].actuator_id == 2
    assert pc.abort_actuators[0].vent_state == 1 and pc.abort_actuators[0].abort_state == 0
    assert pc.abort_pts[0].ip == "192.168.2.21" and pc.abort_pts[0].sensor_id == 5
    assert pc.abort_pts[0].pressure_threshold_adc == 123456
    assert pc.enable_serial_printing is True

    # --- float-encoded datapoints (actuator current sense) ----------------
    assert abs(raw_to_float(float_to_raw(1.234)) - 1.234) < 1e-6
    assert ip_str_to_u32("192.168.2.20") == ((192 << 24) | (168 << 16) | (2 << 8) | 20)
    assert u32_to_ip_str(ip_str_to_u32("10.0.0.1")) == "10.0.0.1"

    print("protocol self-test: OK (all round-trips passed)")


if __name__ == "__main__":
    _self_test()

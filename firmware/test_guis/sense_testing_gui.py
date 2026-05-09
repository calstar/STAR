#!/usr/bin/env python3
"""
Sense Testing GUI
Receives BOARD_HEARTBEAT and SENSOR_DATA UDP packets from DAQv2-Comms boards.
- Plots sensor data as voltage over time.
- Tracks board heartbeat rate, current board state, and connection status (lost when heartbeats stop).
- Send server heartbeat, sensor config, and abort packets to boards.

Requirements: pip install pyqt6 pyqtgraph numpy
"""

import json
import os
import socket
import struct
import subprocess
import sys
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Callable
import shutil

LEADERBOARD_JSON = Path(__file__).resolve().parent / "sense_testing_leaderboard.json"

# Fix Qt platform on macOS
if sys.platform == 'darwin':
    import os
    _qt_plugins = os.environ.get('QT_QPA_PLATFORM_PLUGIN_PATH')
    if not _qt_plugins or not os.path.isdir(_qt_plugins):
        _candidates = [
            '/opt/homebrew/share/qt/plugins/platforms',
            '/opt/homebrew/opt/qt/share/qt/plugins/platforms',
            '/usr/local/share/qt/plugins/platforms',
            '/usr/local/opt/qt/share/qt/plugins/platforms',
            '/opt/homebrew/Cellar/qtbase/6.10.1/share/qt/plugins/platforms',
        ]
        if os.path.isdir('/opt/homebrew/Cellar/qtbase'):
            for _name in sorted(os.listdir('/opt/homebrew/Cellar/qtbase'), reverse=True):
                _p = os.path.join('/opt/homebrew/Cellar/qtbase', _name, 'share', 'qt', 'plugins', 'platforms')
                if os.path.isdir(_p):
                    _candidates.insert(1, _p)
                    break
        for _p in _candidates:
            if os.path.isdir(_p) and any(_f.startswith('libqcocoa') for _f in os.listdir(_p)):
                os.environ['QT_QPA_PLATFORM_PLUGIN_PATH'] = _p
                break

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np

# Protocol constants (DAQv2-Comms)
MAX_PACKET_SIZE = 512
PACKET_HEADER_FORMAT = '<BBI'
PACKET_HEADER_SIZE = 6
BOARD_HEARTBEAT_BODY_FORMAT = '<32sBBB'   # firmware_hash[32], board_id, engine_state, board_state
BOARD_HEARTBEAT_BODY_SIZE = 35
PacketType = type('PacketType', (), {
    'BOARD_HEARTBEAT': 1,
    'SERVER_HEARTBEAT': 2,
    'SENSOR_DATA': 3,
    'SENSOR_CONFIG': 5,
    'ABORT': 7,
    'CLEAR_ABORT': 9,
    'NO_CONNECTION_ABORT': 11,
    'SELF_TEST': 12,
})()
BoardState = type('BoardState', (), {
    'SETUP': 1, 'ACTIVE': 2,
    'CONNECTION_LOSS_DETECTED': 3, 'NO_CONNECTION_ABORT': 4,
    'NO_CONN_ABORT_FOLLOWER': 5, 'PT_ABORT': 6, 'NO_PT_ABORT': 7,
    'ABORT_FINISHED': 8, 'STANDALONE_ABORT': 9, 'SELF_TEST': 10,
})()
DIABLO_COMMS_VERSION = 0
SENSOR_DATA_PACKET_FORMAT = '<BB'
SENSOR_DATA_PACKET_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = '<I'
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = '<BI'
SENSOR_DATAPOINT_SIZE = 5

DEFAULT_PORT = 5006
DEFAULT_REF_VOLTAGE = 2.5  # Internal ref / PT typical; use 3.3 for TC_Board VDD reference
DEFAULT_WINDOW_SECONDS = 10.0
MAX_POINTS = 10000
MAX_DISPLAY_CHANNELS = 10  # checkboxes Ch 1 .. Ch 10
UPDATE_INTERVAL_MS = 50
HEARTBEAT_TIMEOUT_SEC = 2.5  # Show "Connection: Lost" after this many seconds without a heartbeat
HEARTBEAT_RATE_WINDOW = 20  # number of heartbeats to compute rate
SERVER_HEARTBEAT_INTERVAL_MS = 500  # send server heartbeat every 500 ms when enabled
DEFAULT_SEND_PORT = 5005  # boards typically listen on 5005 for server packets
DEFAULT_TARGET_IP = "192.168.2.101"  # Stream_ADC_Data board default static IP

SENSOR_COLORS = [
    (255, 80, 80), (80, 255, 80), (80, 150, 255), (255, 200, 80),
    (200, 80, 255), (80, 255, 255), (255, 150, 150), (150, 255, 150),
    (150, 200, 255), (255, 255, 80),
]


def parse_sensor_ids_from_text(text: str) -> List[int]:
    """Parse a comma/space-separated list of sensor IDs into a cleaned uint8 list."""
    if not text:
        return []
    ids: List[int] = []
    for token in text.replace(",", " ").split():
        try:
            v = int(token, 10)
        except ValueError:
            continue
        if 0 <= v <= 255:
            ids.append(v)
    # Deduplicate while preserving order
    seen = set()
    unique_ids: List[int] = []
    for v in ids:
        if v not in seen:
            seen.add(v)
            unique_ids.append(v)
    return unique_ids


class OTAWorker(QtCore.QThread):
    progress = QtCore.pyqtSignal(str)
    finished = QtCore.pyqtSignal(bool, str)

    def __init__(self, project_dir: Path, env_name: str, ip: str, port: int, board_id: Optional[int] = None):
        super().__init__()
        self._project_dir = project_dir
        self._env_name = env_name
        self._ip = ip
        self._port = port
        self._board_id = board_id

    def run(self):
        try:
            if self.isInterruptionRequested():
                self.finished.emit(False, "OTA cancelled.")
                return
            self.progress.emit("[OTA] Compiling firmware...")
            bin_path = compile_firmware(self._project_dir, self._env_name, board_id=self._board_id)
            if self.isInterruptionRequested():
                self.finished.emit(False, "OTA cancelled.")
                return
            self.progress.emit(f"[OTA] Build OK: {bin_path}")
            self.progress.emit("[OTA] Starting upload...")
            upload_firmware_to_esp32(bin_path, self._ip, self._port, progress_cb=self.progress.emit)
            if self.isInterruptionRequested():
                self.finished.emit(False, "OTA cancelled.")
                return
            self.finished.emit(True, "OTA upload finished.")
        except Exception as e:
            self.finished.emit(False, f"OTA error: {e}")


def parse_packet_header(data: bytes) -> Optional[Tuple[int, int, int]]:
    if len(data) < PACKET_HEADER_SIZE:
        return None
    try:
        return struct.unpack(PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE])
    except struct.error:
        return None


def parse_board_heartbeat_packet(data: bytes) -> Optional[Tuple[tuple, bytes, int, int, int]]:
    """Returns (header, firmware_hash, board_id, engine_state, board_state) or None.

    firmware_hash is the 32-byte SHA-256 of the running firmware binary.
    """
    if len(data) < PACKET_HEADER_SIZE + BOARD_HEARTBEAT_BODY_SIZE:
        return None
    header = parse_packet_header(data)
    if header is None or header[0] != PacketType.BOARD_HEARTBEAT:
        return None
    try:
        body = struct.unpack(
            BOARD_HEARTBEAT_BODY_FORMAT,
            data[PACKET_HEADER_SIZE:PACKET_HEADER_SIZE + BOARD_HEARTBEAT_BODY_SIZE],
        )
    except struct.error:
        return None
    # body: (firmware_hash_bytes, board_id, engine_state, board_state)
    return (header, body[0], body[1], body[2], body[3])


def parse_self_test_packet(data: bytes) -> Optional[Tuple[dict, List[dict]]]:
    """
    Parse SELF_TEST packet sent by Hotfire boards.

    Wire format (after 6-byte header):
      - uint8  adc_good
      - uint8  num_sensors (N)
      - N * (uint8 sensor_id, uint8 result)
    """
    if len(data) < PACKET_HEADER_SIZE + 2:
        return None
    header = parse_packet_header(data)
    if header is None or header[0] != PacketType.SELF_TEST:
        return None
    offset = PACKET_HEADER_SIZE
    try:
        adc_good = data[offset]
        num_sensors = data[offset + 1]
    except IndexError:
        return None
    offset += 2
    expected_size = PACKET_HEADER_SIZE + 2 + (num_sensors * 2)
    if len(data) < expected_size:
        return None
    results: List[dict] = []
    for _ in range(num_sensors):
        if offset + 2 > len(data):
            return None
        sensor_id = data[offset]
        result = data[offset + 1]
        results.append({"sensor_id": sensor_id, "result": result})
        offset += 2
    header_dict = {
        "packet_type": header[0],
        "version": header[1],
        "timestamp": header[2],
        "adc_good": adc_good,
        "num_sensors": num_sensors,
    }
    return (header_dict, results)


def board_state_name(state: int) -> str:
    names = {
        BoardState.SETUP:                    "Setup",
        BoardState.ACTIVE:                   "Active",
        BoardState.CONNECTION_LOSS_DETECTED: "Conn Loss",
        BoardState.NO_CONNECTION_ABORT:      "No Conn Abort",
        BoardState.NO_CONN_ABORT_FOLLOWER:   "No Conn Follower",
        BoardState.PT_ABORT:                 "PT Abort",
        BoardState.NO_PT_ABORT:              "No PT Abort",
        BoardState.ABORT_FINISHED:           "Abort Finished",
        BoardState.STANDALONE_ABORT:         "Standalone Abort",
        BoardState.SELF_TEST:                "Self Test",
    }
    return names.get(state, f"Unknown ({state})")


def parse_sensor_data_packet(data: bytes) -> Optional[Tuple[dict, List[dict]]]:
    if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE:
        return None
    header = parse_packet_header(data)
    if header is None or header[0] != PacketType.SENSOR_DATA:
        return None
    offset = PACKET_HEADER_SIZE
    try:
        num_chunks, num_sensors = struct.unpack(
            SENSOR_DATA_PACKET_FORMAT,
            data[offset:offset + SENSOR_DATA_PACKET_SIZE]
        )
    except struct.error:
        return None
    offset += SENSOR_DATA_PACKET_SIZE
    per_chunk_size = SENSOR_DATA_CHUNK_SIZE + (num_sensors * SENSOR_DATAPOINT_SIZE)
    expected_size = PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE + (num_chunks * per_chunk_size)
    if len(data) < expected_size:
        return None
    chunks = []
    for _ in range(num_chunks):
        chunk_ts, = struct.unpack(SENSOR_DATA_CHUNK_FORMAT, data[offset:offset + SENSOR_DATA_CHUNK_SIZE])
        offset += SENSOR_DATA_CHUNK_SIZE
        datapoints = []
        for _ in range(num_sensors):
            sensor_id, raw_data = struct.unpack(SENSOR_DATAPOINT_FORMAT, data[offset:offset + SENSOR_DATAPOINT_SIZE])
            offset += SENSOR_DATAPOINT_SIZE
            datapoints.append({'sensor_id': sensor_id, 'data': raw_data})
        chunks.append({'timestamp': chunk_ts, 'datapoints': datapoints})
    return (header, chunks)


def code_to_voltage(code_uint32: int, ref_voltage: float) -> float:
    """Convert raw ADC code to voltage. Assumes 32-bit signed ADC."""
    code_int32 = struct.unpack('i', struct.pack('I', code_uint32))[0]
    return (code_int32 * ref_voltage) / 2147483648.0


# K-type thermocouple: voltage (V) -> temperature (°C), ITS-90 rational polynomial (Mosaic/NIST-style)
# Each row: (v_min_mV, v_max_mV, T0, V0, p1, p2, p3, p4, q1, q2, q3)
_K_TYPE_INVERSE = (
    (-6.404, -3.554, -121.47164, -4.1790858, 36.069513, 30.722076, 7.791386, 0.52593997, 0.93939547, 0.2779128, 0.02516334),
    (-3.554, 4.096, -8.7935962, -0.34489914, 25.678719, -0.49887904, -0.44705222, -0.044869202, 0.00023893439, -0.02039775, -0.0018424107),
    (4.096, 16.397, 310.18976, 12.631386, 24.061949, 4.0158622, 0.26853917, -0.0097188544, 0.16995872, 0.011413069, -0.00039275155),
    (16.397, 33.275, 605.72562, 25.148718, 23.539401, 0.046547228, 0.0134444, 0.0005923685, 0.00083445513, 0.0004612144, 0.00002548812),
    (33.275, 69.553, 1018.4705, 41.99385, 25.783239, -1.8363403, 0.05617666, 0.000185324, -0.074803355, 0.002384186, 0.0),
)


def k_type_voltage_to_temperature_c(v_volts: float) -> Optional[float]:
    """Convert K-type thermocouple voltage (in V) to temperature (°C). Returns None if out of range."""
    v_mv = v_volts * 1000.0
    for row in _K_TYPE_INVERSE:
        v_lo, v_hi, t0, v0, p1, p2, p3, p4, q1, q2, q3 = row
        if v_lo <= v_mv <= v_hi:
            x = v_mv - v0
            num = p1 + x * (p2 + x * (p3 + x * p4))
            den = 1.0 + x * (q1 + x * (q2 + x * q3))
            if abs(den) < 1e-20:
                return None
            return t0 + x * num / den
    return None


# Pt1000 RTD: differential voltage (V) -> resistance -> temperature (°C), IEC 60751
# RTD_Testing uses ADS126X_IDAC_MAG_1000 = 1000 µA (both IDAC1 and IDAC2 set to 1000 µA).
# R = |V_diff| / I_excitation (use |V| so reversed wiring still gives valid R).
# R(T) = R0*(1 + A*T + B*T^2) for T >= 0; solve for T
PT1000_R0 = 1000.0   # ohms at 0°C
PT1000_A = 3.9083e-3
PT1000_B = -5.775e-7
PT1000_EXCITATION_UA = 1000.0  # match RTD_Testing: ADS126X_IDAC_MAG_1000


def pt1000_voltage_to_temperature_c(v_volts: float, excitation_ua: float = 1000.0) -> Optional[float]:
    """Convert Pt1000 RTD differential voltage (V) to temperature (°C). excitation_ua = IDAC current in µA (default 1000). Returns None if out of range."""
    if excitation_ua <= 0:
        return None
    # Use abs so reversed differential polarity (e.g. one channel wired opposite) still gives valid R
    r_ohm = (abs(v_volts) * 1e6) / excitation_ua  # R = V/I, I in A = excitation_ua * 1e-6
    rr = r_ohm / PT1000_R0
    d = PT1000_A * PT1000_A - 4 * PT1000_B * (1 - rr)
    if d < 0:
        return None
    sqrt_d = d ** 0.5
    # Use the root that lies in physical range: (-A + sqrt_d)/(2*B) gives 0–850°C for rr>=1, <0°C for rr<1
    t = (-PT1000_A + sqrt_d) / (2 * PT1000_B)
    # Allow wide range so both channels display (e.g. ch1 negative voltage -> cold reading)
    if -400 <= t <= 1100:
        return t
    return None


# 32-bit signed ADC full-scale magnitude (codes)
ADC32_FULL_SCALE = 2147483648.0


def code_to_force(
    code_uint32: int,
    adc_ref_voltage: float,
    excitation_voltage: float,
    sensitivity_mv_per_v: float,
    pga_gain: float,
    full_scale_force: float,
) -> Optional[float]:
    """
    Ratiometric load-cell force from raw 32-bit ADC code (no voltage conversion).
    Assumes 32-bit signed ADC: code / 2^31 = (V_ADC_input / V_ref).
    At full-scale force: V_bridge_fs = excitation * (sensitivity_mV_V / 1000),
    V_ADC_fs = V_bridge_fs * pga_gain, so code_fs = (V_ADC_fs / V_ref) * 2^31.
    Force = (code / code_fs) * full_scale_force.
    """
    if adc_ref_voltage <= 0 or pga_gain <= 0 or excitation_voltage <= 0 or sensitivity_mv_per_v <= 0:
        return None
    code_int32 = struct.unpack("i", struct.pack("I", code_uint32))[0]
    # code_fs = (V_exc * sens/1000 * pga_gain / V_ref) * 2^31
    code_fs = (excitation_voltage * (sensitivity_mv_per_v / 1000.0) * pga_gain / adc_ref_voltage) * ADC32_FULL_SCALE
    if code_fs <= 0:
        return None
    proportion = code_int32 / code_fs
    return proportion * full_scale_force


def find_pio_command() -> str:
    """Try to find the 'pio' command in PATH or common installation locations (Windows)."""
    pio_path = shutil.which("pio")
    if pio_path:
        return pio_path

    if sys.platform == "win32":
        user_profile = os.environ.get("USERPROFILE", "")
        paths_to_check = [
            os.path.join(user_profile, ".platformio", "penv", "Scripts", "pio.exe"),
            os.path.join(user_profile, "AppData", "Local", "Programs", "Python", "Python313", "Scripts", "pio.exe"),
            "C:\\Python313\\Scripts\\pio.exe",
        ]
        for path in paths_to_check:
            if os.path.isfile(path):
                return path

    return "pio"


def compile_firmware(project_dir: Path, env_name: str, board_id: Optional[int] = None) -> Path:
    """Compile a PlatformIO project and return firmware.bin path.

    If board_id is provided, append a BOARD_ID build flag so Hotfire
    firmware uses that ID instead of the default. This is done via the
    PLATFORMIO_BUILD_FLAGS environment variable so it doesn't require changes
    to platformio.ini.
    """
    env = os.environ.copy()
    if board_id is not None:
        try:
            bid = int(board_id)
        except (TypeError, ValueError):
            bid = None
        if bid is not None and 0 <= bid <= 254:
            extra_flag = f"-DBOARD_ID={bid}"
            existing = env.get("PLATFORMIO_BUILD_FLAGS", "").strip()
            env["PLATFORMIO_BUILD_FLAGS"] = f"{existing} {extra_flag}".strip() if existing else extra_flag
    pio_cmd = find_pio_command()
    cmd = [pio_cmd, "run"]
    if env_name:
        cmd += ["-e", env_name]
    result = subprocess.run(
        cmd,
        cwd=str(project_dir),
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"PlatformIO build failed (exit {result.returncode}).")

    build_dir = project_dir / ".pio" / "build"
    if env_name:
        fw_path = build_dir / env_name / "firmware.bin"
        if fw_path.is_file():
            return fw_path
    # Fallback: first firmware.bin under .pio/build
    for root, _dirs, files in os.walk(build_dir):
        if "firmware.bin" in files:
            return Path(root) / "firmware.bin"
    raise FileNotFoundError("firmware.bin not found under .pio/build; check env name or PlatformIO config.")


def upload_firmware_to_esp32(
    bin_path: Path,
    ip: str,
    port: int,
    progress_cb: Optional[Callable[[str], None]] = None,
) -> None:
    """Send firmware binary to ESP32 over TCP using Ethernet OTA protocol."""
    def emit(msg: str) -> None:
        if progress_cb is not None:
            progress_cb(msg)

    file_size = bin_path.stat().st_size
    emit(f"[UPLOAD] Target {ip}:{port}, size {file_size} bytes")

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5.0)
    try:
        sock.connect((ip, port))
    except Exception as e:
        sock.close()
        raise RuntimeError(f"Failed to connect to {ip}:{port}: {e}") from e

    sock.settimeout(30.0)
    try:
        header = struct.pack(">I", file_size)
        sock.sendall(header)
        emit("[UPLOAD] Sent size header")

        sent = 0
        last_percent = -1
        start_time = time.time()
        with open(bin_path, "rb") as f:
            while sent < file_size:
                chunk = f.read(4096)
                if not chunk:
                    break
                sock.sendall(chunk)
                sent += len(chunk)
                percent = int(sent * 100 / file_size)
                if percent // 5 != last_percent // 5:
                    last_percent = percent
                    elapsed = max(time.time() - start_time, 1e-6)
                    rate_kb = sent / elapsed / 1024.0
                    emit(f"[UPLOAD] {percent}% ({sent}/{file_size} bytes, {rate_kb:.1f} KB/s)")

        emit("[UPLOAD] Transfer complete, waiting for OK...")
        try:
            resp = sock.recv(1024).decode(errors="ignore").strip()
        except socket.timeout:
            resp = ""
        if "OK" in resp:
            emit("[UPLOAD] ESP32 reported OK, rebooting.")
        else:
            emit(f"[UPLOAD] No explicit OK from ESP32 (response='{resp}')")
    finally:
        sock.close()


def _make_header(packet_type: int) -> bytes:
    """Build 6-byte packet header: type, version, timestamp (little-endian)."""
    ts = int(time.time() * 1000) & 0xFFFFFFFF
    return struct.pack(PACKET_HEADER_FORMAT, packet_type, DIABLO_COMMS_VERSION, ts)


def build_server_heartbeat_packet() -> bytes:
    """Server heartbeat: header + 1 byte engine_state (0 = SAFE)."""
    return _make_header(PacketType.SERVER_HEARTBEAT) + struct.pack('<B', 0)


def build_sensor_config_packet(
    sensor_ids: List[int],
    necessary_for_abort: bool,
    controller_ip: Optional[str],
    reference_voltage: int = 0,
    enable_serial_printing: int = 0,
) -> bytes:
    """Build SENSOR_CONFIG packet matching DAQv2-Comms SensorConfigPacket layout.

    Wire format after standard 6-byte header:
      - uint8  num_sensors (N)
      - N x uint8 sensor_id
      - uint8  reference_voltage  (0 = 2.5V internal, 1 = VDD, 2 = ignore/board default)
      - uint8  necessary_for_abort (0/1)
      - if necessary_for_abort: uint32 controller_ip (big-endian)
      - uint8  enable_serial_printing (0/1)
    """
    # Clamp/clean sensor IDs to uint8
    clean_ids: List[int] = []
    for sid in sensor_ids:
        try:
            v = int(sid)
        except (TypeError, ValueError):
            continue
        if 0 <= v <= 255:
            clean_ids.append(v)

    if len(clean_ids) > 255:
        clean_ids = clean_ids[:255]

    header = _make_header(PacketType.SENSOR_CONFIG)
    body = bytearray()

    # num_sensors + sensor_ids
    body.append(len(clean_ids) & 0xFF)
    body.extend(bytes(clean_ids))

    # reference_voltage and necessary_for_abort
    body.append(reference_voltage & 0xFF)
    body.append(1 if necessary_for_abort else 0)

    # optional controller_ip (big-endian) if necessary_for_abort is set and IP provided
    if necessary_for_abort and controller_ip:
        parts = [int(x) for x in controller_ip.strip().split('.')]
        if len(parts) == 4 and all(0 <= p <= 255 for p in parts):
            ip_be = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]
            body.extend(struct.pack('>I', ip_be))

    # enable_serial_printing byte
    body.append(1 if enable_serial_printing else 0)

    pkt = header + bytes(body)
    if len(pkt) > MAX_PACKET_SIZE:
        # Truncate rather than crash; board will treat as malformed.
        pkt = pkt[:MAX_PACKET_SIZE]
    return pkt


def build_header_only_packet(packet_type: int) -> bytes:
    """Abort, Clear Abort, No Connection Abort: header only."""
    return _make_header(packet_type)


class UDPReceiver(QtCore.QThread):
    sensor_data_received = QtCore.pyqtSignal(dict, list, str)
    sensor_data_packet_status = QtCore.pyqtSignal(str, bool)  # source_ip, parsed_ok (True=ok, False=malformed)
    board_heartbeat_received = QtCore.pyqtSignal(float, int, int, int, str, bytes)  # timestamp, board_id, board_state, engine_state, source_ip, firmware_hash
    status_update = QtCore.pyqtSignal(str)
    self_test_received = QtCore.pyqtSignal(dict, list, str)  # header_dict, results, source_ip

    def __init__(self, port: int, bind_address: str = '0.0.0.0', sock: Optional[socket.socket] = None):
        super().__init__()
        self.port = port
        self.bind_address = bind_address
        self.sock = sock  # if provided, use shared socket (main thread uses it for sendto too)
        self._owned_socket = sock is None
        self._stop = False
        self.total_packets = 0
        self.total_bytes = 0
        self.start_time = None

    def stop(self):
        self._stop = True
        if self._owned_socket and self.sock:
            try:
                self.sock.close()
            except Exception:
                pass

    def get_stats(self) -> Dict:
        if self.start_time is None:
            return {'packets': 0, 'bytes': 0, 'packets_per_sec': 0.0, 'bytes_per_sec': 0.0}
        elapsed = time.time() - self.start_time
        return {
            'packets': self.total_packets,
            'bytes': self.total_bytes,
            'packets_per_sec': self.total_packets / elapsed if elapsed > 0 else 0,
            'bytes_per_sec': self.total_bytes / elapsed if elapsed > 0 else 0,
        }

    def run(self):
        if self.sock is None:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.sock.settimeout(0.1)
            try:
                self.sock.bind((self.bind_address, self.port))
                self.status_update.emit(f"Listening on {self.bind_address}:{self.port}")
            except OSError as e:
                self.status_update.emit(f"Error binding: {e}")
                return
        else:
            self.sock.settimeout(0.1)
            self.status_update.emit(f"Listening on {self.bind_address}:{self.port}")
        self.start_time = time.time()
        while not self._stop:
            try:
                data, addr = self.sock.recvfrom(MAX_PACKET_SIZE)
                self.total_packets += 1
                self.total_bytes += len(data)
                header = parse_packet_header(data)
                if not header:
                    continue
                if header[0] == PacketType.BOARD_HEARTBEAT:
                    result = parse_board_heartbeat_packet(data)
                    if result:
                        _h, firmware_hash, board_id, engine_state, board_state = result
                        self.board_heartbeat_received.emit(
                            time.time(), board_id, board_state, engine_state, addr[0], firmware_hash
                        )
                elif header[0] == PacketType.SELF_TEST:
                    result = parse_self_test_packet(data)
                    if result:
                        header_dict, results = result
                        self.self_test_received.emit(header_dict, results, addr[0])
                elif header[0] == PacketType.SENSOR_DATA:
                    result = parse_sensor_data_packet(data)
                    self.sensor_data_packet_status.emit(addr[0], result is not None)
                    if result:
                        header_tuple, chunks_list = result
                        header_dict = {'packet_type': header_tuple[0], 'version': header_tuple[1], 'timestamp': header_tuple[2]}
                        self.sensor_data_received.emit(header_dict, chunks_list, addr[0])
            except socket.timeout:
                continue
            except Exception as e:
                if not self._stop:
                    self.status_update.emit(f"Error: {e}")
        if self._owned_socket and self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
        self.sock = None
        self.status_update.emit("Stopped")


class SenseTestingGUIWindow(QtWidgets.QMainWindow):
    def __init__(self, port: int = DEFAULT_PORT, ref_voltage: float = DEFAULT_REF_VOLTAGE):
        super().__init__()
        self.setWindowTitle("Sense Testing GUI")
        self.resize(1000, 620)

        self.ref_voltage = ref_voltage
        self.show_temperature_k_type = False
        self.show_temperature_pt1000 = False
        self.stats_start_time = None
        self.sensor_data: Dict[int, deque] = {}
        self.sensor_plots: Dict[int, pg.PlotDataItem] = {}
        self.plot_enabled: Dict[int, bool] = {i: True for i in range(1, MAX_DISPLAY_CHANNELS + 1)}
        self.channel_checkboxes: Dict[int, QtWidgets.QCheckBox] = {}
        self.network_stats = {'packets': '0', 'pps': '0.0', 'bytes': '0 B', 'bps': '0.0 B/s'}
        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.force_leaderboard: List[Tuple[str, float]] = []  # (name, force) sorted by force desc

        # Board status (heartbeats)
        self.heartbeat_timestamps: deque = deque(maxlen=HEARTBEAT_RATE_WINDOW)
        self.last_heartbeat_time: Optional[float] = None
        self.board_id: Optional[int] = None
        self.board_state: Optional[int] = None
        self.board_source_ip: Optional[str] = None
        self.firmware_hash: Optional[bytes] = None

        # One UDP socket bound to port: receiver uses it for recvfrom, we use it for sendto.
        # Board sends board heartbeats to (our IP, this port), so we must send from this port.
        self._send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._send_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._send_sock.settimeout(0.5)
        try:
            self._send_sock.bind(('', port))
            self._shared_sock = self._send_sock  # pass to receiver
        except OSError:
            self._send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._shared_sock = None  # receiver will create its own
        self._server_heartbeat_timer = QtCore.QTimer(self)
        self._server_heartbeat_timer.timeout.connect(self._send_server_heartbeat_once)

        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        layout = QtWidgets.QVBoxLayout(central)

        # Toolbar
        toolbar = QtWidgets.QHBoxLayout()
        toolbar.addWidget(QtWidgets.QLabel("Port:"))
        self.port_spin = QtWidgets.QSpinBox()
        self.port_spin.setRange(1024, 65535)
        self.port_spin.setValue(port)
        self.port_spin.setEnabled(False)
        toolbar.addWidget(self.port_spin)

        toolbar.addSpacing(20)
        toolbar.addWidget(QtWidgets.QLabel("Reference voltage (V):"))
        self.ref_voltage_spin = QtWidgets.QDoubleSpinBox()
        self.ref_voltage_spin.setRange(0.1, 10.0)
        self.ref_voltage_spin.setSingleStep(0.1)
        self.ref_voltage_spin.setValue(ref_voltage)
        self.ref_voltage_spin.setToolTip("Internal ref / PT: 2.5 V (default); TC_Board VDD: 3.3 V")
        self.ref_voltage_spin.valueChanged.connect(self._on_ref_voltage_changed)
        toolbar.addWidget(self.ref_voltage_spin)

        toolbar.addSpacing(20)
        toolbar.addWidget(QtWidgets.QLabel("Time window (s):"))
        self.window_seconds_spin = QtWidgets.QDoubleSpinBox()
        self.window_seconds_spin.setRange(0.5, 3600.0)
        self.window_seconds_spin.setSingleStep(1.0)
        self.window_seconds_spin.setValue(DEFAULT_WINDOW_SECONDS)
        self.window_seconds_spin.setDecimals(1)
        self.window_seconds_spin.setToolTip("X-axis time span (seconds) to display.")
        self.window_seconds_spin.valueChanged.connect(self._on_window_seconds_changed)
        toolbar.addWidget(self.window_seconds_spin)

        toolbar.addSpacing(20)
        self.show_temp_k_cb = QtWidgets.QCheckBox("Show temperature (K-type)")
        self.show_temp_k_cb.setToolTip("Convert voltage to °C using K-type thermocouple calibration.")
        self.show_temp_k_cb.stateChanged.connect(self._on_show_temperature_k_changed)
        toolbar.addWidget(self.show_temp_k_cb)

        self.show_temp_pt1000_cb = QtWidgets.QCheckBox("Show temperature (Pt1000 RTD)")
        self.show_temp_pt1000_cb.setToolTip("Convert differential voltage to °C for Pt1000 RTD (1000 µA excitation).")
        self.show_temp_pt1000_cb.stateChanged.connect(self._on_show_temperature_pt1000_changed)
        toolbar.addWidget(self.show_temp_pt1000_cb)

        toolbar.addSpacing(20)
        self.show_force_lc_cb = QtWidgets.QCheckBox("Show force (load cell)")
        self.show_force_lc_cb.setToolTip("Ratiometric: force from raw 32-bit ADC code (no voltage step). Uses Reference voltage (V) as ADC ref, plus excitation, sensitivity (mV/V), PGA gain, full scale force.")
        self.show_force_lc_cb.stateChanged.connect(self._on_show_force_lc_changed)
        toolbar.addWidget(self.show_force_lc_cb)

        self.show_encoder_angle_cb = QtWidgets.QCheckBox("Show angle (encoder)")
        self.show_encoder_angle_cb.setToolTip("Interpret raw uint32 as AS5600 12-bit angle (0–4095) and display as degrees (0–360°).")
        self.show_encoder_angle_cb.stateChanged.connect(self._on_show_encoder_angle_changed)
        toolbar.addWidget(self.show_encoder_angle_cb)

        toolbar.addSpacing(20)
        self.status_label = QtWidgets.QLabel("Starting…")
        self.status_label.setStyleSheet("color: #aaa;")
        toolbar.addWidget(self.status_label)
        toolbar.addStretch()

        layout.addLayout(toolbar)

        # Load cell force conversion inputs
        force_row = QtWidgets.QHBoxLayout()
        force_row.addWidget(QtWidgets.QLabel("Excitation (V):"))
        self.lc_excitation_spin = QtWidgets.QDoubleSpinBox()
        self.lc_excitation_spin.setRange(0.1, 24.0)
        self.lc_excitation_spin.setValue(5.0)
        self.lc_excitation_spin.setDecimals(2)
        self.lc_excitation_spin.setToolTip("Load cell excitation voltage in volts.")
        force_row.addWidget(self.lc_excitation_spin)
        force_row.addWidget(QtWidgets.QLabel("Sensitivity (mV/V):"))
        self.lc_sensitivity_spin = QtWidgets.QDoubleSpinBox()
        self.lc_sensitivity_spin.setRange(0.01, 100.0)
        self.lc_sensitivity_spin.setValue(2.0)
        self.lc_sensitivity_spin.setDecimals(3)
        self.lc_sensitivity_spin.setToolTip("Load cell sensitivity at full scale, mV per V of excitation.")
        force_row.addWidget(self.lc_sensitivity_spin)
        force_row.addWidget(QtWidgets.QLabel("PGA gain:"))
        self.lc_pga_gain_spin = QtWidgets.QDoubleSpinBox()
        self.lc_pga_gain_spin.setRange(1.0, 128.0)
        self.lc_pga_gain_spin.setValue(32.0)
        self.lc_pga_gain_spin.setDecimals(1)
        self.lc_pga_gain_spin.setToolTip("PGA gain used on the board (e.g. 32 for ADS126X_GAIN_32).")
        force_row.addWidget(self.lc_pga_gain_spin)
        force_row.addWidget(QtWidgets.QLabel("Full scale force:"))
        self.lc_full_scale_spin = QtWidgets.QDoubleSpinBox()
        self.lc_full_scale_spin.setRange(0.001, 1e9)
        self.lc_full_scale_spin.setValue(300.0)
        self.lc_full_scale_spin.setDecimals(2)
        self.lc_full_scale_spin.setToolTip("Force at full scale (same unit as desired display, e.g. N or lbf).")
        force_row.addWidget(self.lc_full_scale_spin)
        force_row.addStretch()
        layout.addLayout(force_row)

        # Network hint: board sends to 192.168.2.20:5006 — PC must be that IP to receive; board listens on 5005
        self.network_hint = QtWidgets.QLabel(
            "To receive data: set this PC's Ethernet adapter to 192.168.2.20, subnet 255.255.255.0. "
            "Boards send to 192.168.2.20:5006. Boards listen on port 5005 — set Target port to 5005 to send commands."
        )
        self.network_hint.setStyleSheet("color: #8ab; font-size: 11px;")
        self.network_hint.setWordWrap(True)
        layout.addWidget(self.network_hint)

        # Channel checkboxes (enable/disable graphing per channel)
        channel_row = QtWidgets.QHBoxLayout()
        channel_row.addWidget(QtWidgets.QLabel("Graph channels:"))
        for ch in range(1, MAX_DISPLAY_CHANNELS + 1):
            cb = QtWidgets.QCheckBox(f"Ch {ch}")
            cb.setChecked(True)
            r, g, b = SENSOR_COLORS[(ch - 1) % len(SENSOR_COLORS)]
            cb.setStyleSheet(f"QCheckBox {{ color: rgb({r},{g},{b}); font-weight: bold; }}")
            cb.stateChanged.connect(lambda state, c=ch: self._on_channel_toggled(c, state))
            self.channel_checkboxes[ch] = cb
            channel_row.addWidget(cb)
        channel_row.addStretch()
        layout.addLayout(channel_row)

        # Main content: plot + board status panel
        content = QtWidgets.QHBoxLayout()
        # Plot (dark background — make axis labels and ticks white so they stand out)
        self.plot_widget = pg.PlotWidget(background='#1e1e1e')
        _axis_style = {'color': '#FFFFFF', 'font-size': '11pt'}
        self.plot_widget.setLabel('left', 'Voltage (V)', **_axis_style)
        self.plot_widget.setLabel('bottom', 'Time (s)', **_axis_style)
        for axis_name in ('left', 'bottom'):
            ax = self.plot_widget.getPlotItem().getAxis(axis_name)
            try:
                if hasattr(ax, 'setStyle'):
                    ax.setStyle(tickTextColor='#FFFFFF', tickFont=QtGui.QFont(None, 10))
            except Exception:
                pass
            try:
                if hasattr(ax, 'label') and hasattr(ax.label, 'setColor'):
                    ax.label.setColor('#FFFFFF')
            except Exception:
                pass
        self.plot_widget.showGrid(x=True, y=True, alpha=0.3)
        self.plot_widget.enableAutoRange(axis='y')
        self.plot_widget.addLegend(offset=(10, 10))
        content.addWidget(self.plot_widget, stretch=1)

        # Board status panel
        board_panel = QtWidgets.QGroupBox("Board status")
        board_panel.setMinimumWidth(220)
        board_layout = QtWidgets.QVBoxLayout(board_panel)
        self.heartbeat_rate_label = QtWidgets.QLabel("Heartbeat rate: — Hz")
        self.heartbeat_rate_label.setStyleSheet("font-weight: bold;")
        board_layout.addWidget(self.heartbeat_rate_label)
        self.board_state_label = QtWidgets.QLabel("Board state: —")
        board_layout.addWidget(self.board_state_label)
        self.connection_label = QtWidgets.QLabel("Connection: —")
        self.connection_label.setStyleSheet("font-weight: bold;")
        board_layout.addWidget(self.connection_label)
        self.board_id_label = QtWidgets.QLabel("Board ID: —")
        board_layout.addWidget(self.board_id_label)
        self.board_ip_label = QtWidgets.QLabel("Source: —")
        board_layout.addWidget(self.board_ip_label)
        self.firmware_hash_label = QtWidgets.QLabel("Firmware hash: —")
        self.firmware_hash_label.setStyleSheet("color: #8ab; font-size: 11px; font-family: monospace;")
        board_layout.addWidget(self.firmware_hash_label)
        self.sensor_data_status_label = QtWidgets.QLabel("Sensor data packets: —")
        self.sensor_data_status_label.setStyleSheet("color: #8ab; font-size: 11px;")
        board_layout.addWidget(self.sensor_data_status_label)
        # Self-test results (from SELF_TEST packets)
        self.self_test_label = QtWidgets.QLabel("Self-test: —")
        self.self_test_label.setStyleSheet("font-weight: bold;")
        board_layout.addWidget(self.self_test_label)
        self.self_test_adc_label = QtWidgets.QLabel("ADC: —")
        board_layout.addWidget(self.self_test_adc_label)
        self.self_test_results_list = QtWidgets.QListWidget()
        self.self_test_results_list.setMaximumHeight(80)
        self.self_test_results_list.setStyleSheet("font-size: 11px;")
        board_layout.addWidget(self.self_test_results_list)
        board_layout.addStretch()
        content.addWidget(board_panel)

        # Server / Commands panel
        cmd_panel = QtWidgets.QGroupBox("Server & commands")
        cmd_panel.setMinimumWidth(260)
        cmd_layout = QtWidgets.QVBoxLayout(cmd_panel)

        self.send_heartbeat_cb = QtWidgets.QCheckBox("Send server heartbeat")
        self.send_heartbeat_cb.stateChanged.connect(self._on_send_heartbeat_changed)
        cmd_layout.addWidget(self.send_heartbeat_cb)


        target_row = QtWidgets.QHBoxLayout()
        target_row.addWidget(QtWidgets.QLabel("Target IP:"))
        self.target_ip_edit = QtWidgets.QLineEdit()
        self.target_ip_edit.setText(DEFAULT_TARGET_IP)
        self.target_ip_edit.setPlaceholderText("e.g. 192.168.2.101")
        target_row.addWidget(self.target_ip_edit)
        cmd_layout.addLayout(target_row)

        port_row = QtWidgets.QHBoxLayout()
        port_row.addWidget(QtWidgets.QLabel("Target port:"))
        self.target_port_spin = QtWidgets.QSpinBox()
        self.target_port_spin.setRange(1, 65535)
        self.target_port_spin.setValue(DEFAULT_SEND_PORT)
        self.target_port_spin.setToolTip("Board listens on 5005. Use 5005 to send server heartbeat and commands.")
        port_row.addWidget(self.target_port_spin)
        cmd_layout.addLayout(port_row)

        self.send_status_label = QtWidgets.QLabel("Send status: —")
        self.send_status_label.setStyleSheet("color: #8ab; font-size: 11px;")
        cmd_layout.addWidget(self.send_status_label)

        # Sensor config
        sens_grp = QtWidgets.QGroupBox("Sensor config packet")
        sens_layout = QtWidgets.QVBoxLayout(sens_grp)
        self.necessary_for_abort_cb = QtWidgets.QCheckBox("Necessary for abort")
        sens_layout.addWidget(self.necessary_for_abort_cb)
        self.enable_serial_printing_cb = QtWidgets.QCheckBox("Enable serial printing on board")
        self.enable_serial_printing_cb.setToolTip("If checked, sensor config packet tells the board to enable Serial output (DAQv2-Comms field).")
        sens_layout.addWidget(self.enable_serial_printing_cb)
        sens_layout.addWidget(QtWidgets.QLabel("Sensor IDs (comma-separated):"))
        self.sensor_ids_edit = QtWidgets.QLineEdit()
        self.sensor_ids_edit.setPlaceholderText("e.g. 1,2,3,10  (leave empty for board default)")
        self.sensor_ids_edit.setText("1,2,3,4,5,6,7,8,9,10")
        sens_layout.addWidget(self.sensor_ids_edit)
        sens_layout.addWidget(QtWidgets.QLabel("Reference voltage:"))
        self.ref_voltage_combo = QtWidgets.QComboBox()
        self.ref_voltage_combo.addItem("Internal 2.5 V", 0)
        self.ref_voltage_combo.addItem("VDD (e.g. 3.3 V)", 1)
        self.ref_voltage_combo.addItem("Ignore / board default", 2)
        self.ref_voltage_combo.setCurrentIndex(0)
        self.ref_voltage_combo.setToolTip(
            "Reference voltage enum sent in SENSOR_CONFIG:\n"
            " - Internal 2.5 V\n"
            " - VDD (e.g. 3.3 V)\n"
            " - Ignore / board default"
        )
        sens_layout.addWidget(self.ref_voltage_combo)
        sens_layout.addWidget(QtWidgets.QLabel("Actuator controller IP:"))
        self.actuator_ip_edit = QtWidgets.QLineEdit()
        self.actuator_ip_edit.setPlaceholderText("192.168.2.20")
        sens_layout.addWidget(self.actuator_ip_edit)
        self.send_sensor_config_btn = QtWidgets.QPushButton("Send sensor config")
        self.send_sensor_config_btn.setToolTip("Sends to the Target IP and port above.")
        self.send_sensor_config_btn.clicked.connect(self._send_sensor_config)
        sens_layout.addWidget(self.send_sensor_config_btn)
        cmd_layout.addWidget(sens_grp)

        # Abort buttons
        abort_grp = QtWidgets.QGroupBox("Abort packets")
        abort_layout = QtWidgets.QVBoxLayout(abort_grp)
        self.send_abort_btn = QtWidgets.QPushButton("Send Abort")
        self.send_abort_btn.clicked.connect(lambda: self._send_header_only(PacketType.ABORT))
        abort_layout.addWidget(self.send_abort_btn)
        self.send_clear_abort_btn = QtWidgets.QPushButton("Send Clear Abort")
        self.send_clear_abort_btn.clicked.connect(lambda: self._send_header_only(PacketType.CLEAR_ABORT))
        abort_layout.addWidget(self.send_clear_abort_btn)
        self.send_no_conn_abort_btn = QtWidgets.QPushButton("Send No Conn Abort")
        self.send_no_conn_abort_btn.clicked.connect(lambda: self._send_header_only(PacketType.NO_CONNECTION_ABORT))
        abort_layout.addWidget(self.send_no_conn_abort_btn)
        cmd_layout.addWidget(abort_grp)

        cmd_layout.addStretch()

        # Right column: Server & commands + compact leaderboard below
        right_column = QtWidgets.QWidget()
        right_column.setMinimumWidth(260)
        right_column_layout = QtWidgets.QVBoxLayout(right_column)
        right_column_layout.setContentsMargins(0, 0, 0, 0)
        right_column_layout.addWidget(cmd_panel)

        # Ethernet OTA controls
        ota_grp = QtWidgets.QGroupBox("Ethernet OTA")
        ota_layout = QtWidgets.QVBoxLayout(ota_grp)

        ota_proj_row = QtWidgets.QHBoxLayout()
        ota_proj_row.addWidget(QtWidgets.QLabel("PlatformIO project:"))
        self.ota_project_dir_edit = QtWidgets.QLineEdit()
        self.ota_project_dir_edit.setPlaceholderText("Path to PlatformIO project folder")
        ota_proj_row.addWidget(self.ota_project_dir_edit)
        self.ota_project_browse_btn = QtWidgets.QPushButton("Browse")
        self.ota_project_browse_btn.clicked.connect(self._browse_ota_project_dir)
        ota_proj_row.addWidget(self.ota_project_browse_btn)
        ota_layout.addLayout(ota_proj_row)

        ota_env_row = QtWidgets.QHBoxLayout()
        ota_env_row.addWidget(QtWidgets.QLabel("Env name:"))
        self.ota_env_edit = QtWidgets.QLineEdit()
        self.ota_env_edit.setPlaceholderText("e.g. adafruit_feather_esp32s3")
        self.ota_env_edit.setText("adafruit_feather_esp32s3")
        ota_env_row.addWidget(self.ota_env_edit)
        ota_layout.addLayout(ota_env_row)


        ota_port_row = QtWidgets.QHBoxLayout()
        ota_port_row.addWidget(QtWidgets.QLabel("OTA TCP port:"))
        self.ota_port_spin = QtWidgets.QSpinBox()
        self.ota_port_spin.setRange(1, 65535)
        self.ota_port_spin.setValue(3232)
        ota_port_row.addWidget(self.ota_port_spin)
        ota_layout.addLayout(ota_port_row)

        ota_board_id_row = QtWidgets.QHBoxLayout()
        ota_board_id_row.addWidget(QtWidgets.QLabel("Board ID for OTA:"))
        self.ota_board_id_spin = QtWidgets.QSpinBox()
        self.ota_board_id_spin.setRange(0, 254)
        self.ota_board_id_spin.setValue(0)
        self.ota_board_id_spin.setToolTip(
            "Board ID to compile into firmware via BOARD_ID.\n"
            "0 = use default ID from platformio.ini (no override)."
        )
        ota_board_id_row.addWidget(self.ota_board_id_spin)
        ota_layout.addLayout(ota_board_id_row)

        self.ota_upload_btn = QtWidgets.QPushButton("Compile && Upload")
        self.ota_upload_btn.setToolTip("Compile selected PlatformIO project and upload firmware via Ethernet OTA to the Target IP.")
        self.ota_upload_btn.clicked.connect(self._on_ota_compile_and_upload_clicked)
        ota_layout.addWidget(self.ota_upload_btn)

        self.ota_log = QtWidgets.QPlainTextEdit()
        self.ota_log.setReadOnly(True)
        self.ota_log.setFixedHeight(130)
        self.ota_log.setPlaceholderText("OTA output will appear here…")
        self.ota_log.setStyleSheet(
            "QPlainTextEdit {"
            "  background: #1a1a1a; color: #c8c8c8;"
            "  font-family: monospace; font-size: 11px;"
            "  border: 1px solid #333;"
            "}"
        )
        ota_layout.addWidget(self.ota_log)

        right_column_layout.addWidget(ota_grp)

        leaderboard_grp = QtWidgets.QGroupBox("Max force")
        leaderboard_grp.setStyleSheet("QGroupBox { font-size: 10px; } QGroupBox::title { subcontrol-origin: margin; subcontrol-position: top left; padding: 0 4px 2px 4px; }")
        leaderboard_grp.setSizePolicy(QtWidgets.QSizePolicy.Policy.Preferred, QtWidgets.QSizePolicy.Policy.Maximum)
        leaderboard_layout = QtWidgets.QVBoxLayout(leaderboard_grp)
        leaderboard_layout.setContentsMargins(6, 4, 6, 4)
        leaderboard_layout.setSpacing(2)
        leaderboard_layout.setAlignment(QtCore.Qt.AlignmentFlag.AlignTop)
        lb_row = QtWidgets.QHBoxLayout()
        self.leaderboard_name_edit = QtWidgets.QLineEdit()
        self.leaderboard_name_edit.setPlaceholderText("Name")
        self.leaderboard_name_edit.setMaxLength(40)
        self.leaderboard_name_edit.setMaximumWidth(88)
        lb_row.addWidget(self.leaderboard_name_edit)
        self.leaderboard_add_btn = QtWidgets.QPushButton("Add max")
        self.leaderboard_add_btn.setToolTip("Add max force in current time window to leaderboard.")
        self.leaderboard_add_btn.clicked.connect(self._on_add_max_force_to_leaderboard)
        lb_row.addWidget(self.leaderboard_add_btn)
        leaderboard_layout.addLayout(lb_row)
        self.leaderboard_list = QtWidgets.QListWidget()
        self.leaderboard_list.setMaximumHeight(56)
        self.leaderboard_list.setFont(QtGui.QFont(None, 9))
        leaderboard_layout.addWidget(self.leaderboard_list)
        right_column_layout.addWidget(leaderboard_grp)
        right_column_layout.addStretch()

        content.addWidget(right_column)
        layout.addLayout(content)
        self._load_leaderboard()

        # Stats bar
        self.stats_label = QtWidgets.QLabel("Packets: 0  |  Pkts/s: 0  |  Bytes: 0  |  B/s: 0")
        layout.addWidget(self.stats_label)

        self.receiver = None
        self.update_timer = QtCore.QTimer(self)
        self.update_timer.timeout.connect(self._update_plots)
        self._started = False

        # OTA worker
        self._ota_worker: Optional["OTAWorker"] = None

        # Start listening on load (receiver uses same socket as _send_sock so board replies reach us)
        port = self.port_spin.value()
        self.receiver = UDPReceiver(port=port, sock=self._shared_sock)
        self.receiver.sensor_data_received.connect(self._on_sensor_data)
        self.receiver.sensor_data_packet_status.connect(self._on_sensor_data_packet_status)
        self.receiver.board_heartbeat_received.connect(self._on_board_heartbeat)
        self.receiver.self_test_received.connect(self._on_self_test_results)
        self.receiver.status_update.connect(self.status_label.setText)
        self.receiver.start()
        self.stats_start_time = time.time()
        self._started = True
        self.update_timer.start(UPDATE_INTERVAL_MS)

    def _on_ref_voltage_changed(self, value: float):
        self.ref_voltage = value

    def _on_window_seconds_changed(self, value: float):
        self.window_seconds = value

    def _browse_ota_project_dir(self):
        # Start browsing from the DiabloAvionics repo root by default
        default_root = str(Path(__file__).resolve().parents[1])
        directory = QtWidgets.QFileDialog.getExistingDirectory(
            self,
            "Select PlatformIO project folder",
            default_root,
        )
        if directory:
            self.ota_project_dir_edit.setText(directory)

    def _on_ota_compile_and_upload_clicked(self):
        if self._ota_worker is not None and self._ota_worker.isRunning():
            self.ota_log.appendPlainText("[OTA] Already running…")
            return
        project_dir_str = self.ota_project_dir_edit.text().strip()
        if not project_dir_str:
            self.ota_log.appendPlainText("[OTA] Error: set PlatformIO project folder.")
            return
        project_dir = Path(project_dir_str)
        if not project_dir.is_dir():
            self.ota_log.appendPlainText("[OTA] Error: project folder does not exist.")
            return
        env_name = self.ota_env_edit.text().strip()
        ip = self.target_ip_edit.text().strip()
        if not ip:
            self.ota_log.appendPlainText("[OTA] Error: set Target IP first.")
            return
        port = int(self.ota_port_spin.value())
        board_id_val = int(self.ota_board_id_spin.value())
        board_id_opt: Optional[int] = board_id_val if board_id_val > 0 else None

        self.ota_log.clear()
        if board_id_opt is not None:
            self.ota_log.appendPlainText(f"[OTA] Starting — target {ip}:{port}, board ID {board_id_opt}")
        else:
            self.ota_log.appendPlainText(f"[OTA] Starting — target {ip}:{port} (no board ID override)")
        self.ota_upload_btn.setEnabled(False)

        self._ota_worker = OTAWorker(project_dir, env_name, ip, port, board_id=board_id_opt)
        self._ota_worker.progress.connect(self._on_ota_progress)
        self._ota_worker.finished.connect(self._on_ota_finished)
        self._ota_worker.start()

    def _on_ota_progress(self, msg: str):
        self.ota_log.appendPlainText(msg)
        self.ota_log.verticalScrollBar().setValue(self.ota_log.verticalScrollBar().maximum())

    def _on_ota_finished(self, ok: bool, msg: str):
        self.ota_log.appendPlainText(msg)
        self.ota_log.verticalScrollBar().setValue(self.ota_log.verticalScrollBar().maximum())
        self.ota_upload_btn.setEnabled(True)
        self.ota_upload_btn.setEnabled(True)

    def _on_show_temperature_k_changed(self, state):
        from PyQt6.QtCore import Qt
        self.show_temperature_k_type = state == Qt.CheckState.Checked.value
        if self.show_temperature_k_type and self.show_temp_pt1000_cb.isChecked():
            self.show_temp_pt1000_cb.setChecked(False)
        if self.show_temperature_k_type and self.show_force_lc_cb.isChecked():
            self.show_force_lc_cb.setChecked(False)
        if self.show_temperature_k_type and self.show_encoder_angle_cb.isChecked():
            self.show_encoder_angle_cb.setChecked(False)

    def _on_show_temperature_pt1000_changed(self, state):
        from PyQt6.QtCore import Qt
        self.show_temperature_pt1000 = state == Qt.CheckState.Checked.value
        if self.show_temperature_pt1000 and self.show_temp_k_cb.isChecked():
            self.show_temp_k_cb.setChecked(False)
        if self.show_temperature_pt1000 and self.show_force_lc_cb.isChecked():
            self.show_force_lc_cb.setChecked(False)
        if self.show_temperature_pt1000 and self.show_encoder_angle_cb.isChecked():
            self.show_encoder_angle_cb.setChecked(False)

    def _on_show_force_lc_changed(self, state):
        from PyQt6.QtCore import Qt
        if state == Qt.CheckState.Checked.value:
            if self.show_temp_k_cb.isChecked():
                self.show_temp_k_cb.setChecked(False)
            if self.show_temp_pt1000_cb.isChecked():
                self.show_temp_pt1000_cb.setChecked(False)
            if self.show_encoder_angle_cb.isChecked():
                self.show_encoder_angle_cb.setChecked(False)

    def _on_show_encoder_angle_changed(self, state):
        from PyQt6.QtCore import Qt
        if state == Qt.CheckState.Checked.value:
            if self.show_temp_k_cb.isChecked():
                self.show_temp_k_cb.setChecked(False)
            if self.show_temp_pt1000_cb.isChecked():
                self.show_temp_pt1000_cb.setChecked(False)
            if self.show_force_lc_cb.isChecked():
                self.show_force_lc_cb.setChecked(False)

    def _on_add_max_force_to_leaderboard(self):
        """Find max force in current time window and add (name, force) to leaderboard."""
        if self.stats_start_time is None:
            self.status_label.setText("No data yet — start receiving to add to leaderboard.")
            return
        current_time = time.time() - self.stats_start_time
        time_window = self.window_seconds
        exc = self.lc_excitation_spin.value()
        sens = self.lc_sensitivity_spin.value()
        pga = self.lc_pga_gain_spin.value()
        fs = self.lc_full_scale_spin.value()
        ref_v = self.ref_voltage
        max_force: Optional[float] = None
        for sid, dq in self.sensor_data.items():
            if not self.plot_enabled.get(sid, True):
                continue
            for t, code in dq:
                if current_time - t <= time_window:
                    f = code_to_force(code, ref_v, exc, sens, pga, fs)
                    if f is not None and (max_force is None or f > max_force):
                        max_force = f
        if max_force is None:
            self.status_label.setText("No valid force in current window (check Show force & data).")
            return
        name = self.leaderboard_name_edit.text().strip() or "Anonymous"
        self.force_leaderboard.append((name, max_force))
        self.force_leaderboard.sort(key=lambda x: x[1], reverse=True)
        self._refresh_leaderboard_list()
        self._save_leaderboard()
        self.status_label.setText(f"Added: {name} — {max_force:.2f}")

    def _load_leaderboard(self):
        """Load leaderboard from JSON file (persisted between sessions)."""
        try:
            if LEADERBOARD_JSON.exists():
                with open(LEADERBOARD_JSON, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.force_leaderboard = [(e["name"], float(e["force"])) for e in data]
                self.force_leaderboard.sort(key=lambda x: x[1], reverse=True)
                self._refresh_leaderboard_list()
        except Exception:
            pass

    def _save_leaderboard(self):
        """Save leaderboard to JSON file."""
        try:
            data = [{"name": n, "force": f} for n, f in self.force_leaderboard]
            with open(LEADERBOARD_JSON, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception:
            pass

    def _refresh_leaderboard_list(self):
        self.leaderboard_list.clear()
        for i, (name, force) in enumerate(self.force_leaderboard, 1):
            self.leaderboard_list.addItem(f"{i}. {name}: {force:.2f}")

    def _on_channel_toggled(self, channel: int, state):
        from PyQt6.QtCore import Qt
        self.plot_enabled[channel] = state == Qt.CheckState.Checked.value
        if channel in self.sensor_plots:
            self.sensor_plots[channel].setVisible(self.plot_enabled[channel])

    def _on_sensor_data_packet_status(self, source_ip: str, parsed_ok: bool):
        if parsed_ok:
            self.sensor_data_status_label.setText(f"Sensor data: from {source_ip} (ok)")
            self.sensor_data_status_label.setStyleSheet("color: #2ecc71; font-size: 11px;")
        else:
            self.sensor_data_status_label.setText(f"Sensor data: from {source_ip} (malformed)")
            self.sensor_data_status_label.setStyleSheet("color: #e67e22; font-size: 11px;")

    def _on_board_heartbeat(self, timestamp: float, board_id: int, board_state: int, engine_state: int, source_ip: str, firmware_hash: bytes):
        self.heartbeat_timestamps.append(timestamp)
        self.last_heartbeat_time = timestamp
        self.board_id = board_id
        self.board_state = board_state
        self.board_source_ip = source_ip
        self.firmware_hash = firmware_hash
        full_hex = firmware_hash.hex()
        short_hex = full_hex[:16] + "..."
        self.firmware_hash_label.setText(f"Firmware hash: {short_hex}")
        self.firmware_hash_label.setToolTip(f"SHA-256: {full_hex}")
        # Auto-fill Target IP to the IP we are receiving heartbeats from so commands go back to that board.
        # User can still override this manually in the GUI.
        self.target_ip_edit.setText(source_ip)

    def _on_self_test_results(self, header: dict, results: list, source_ip: str):
        """
        Update the self-test UI when a SELF_TEST packet is received.

        header: {'packet_type', 'version', 'timestamp', 'adc_good', 'num_sensors}
        results: [{'sensor_id': uint8, 'result': uint8}, ...]
        """
        self.self_test_label.setText(f"Self-test: from {source_ip}")

        adc_good = bool(header.get("adc_good", 0))
        if adc_good:
            self.self_test_adc_label.setText("ADC: PASS")
            self.self_test_adc_label.setStyleSheet("font-weight: bold; color: #2ecc71;")
        else:
            self.self_test_adc_label.setText("ADC: FAIL")
            self.self_test_adc_label.setStyleSheet("font-weight: bold; color: #e74c3c;")

        self.self_test_results_list.clear()
        for entry in results:
            sensor_id = entry.get("sensor_id", 0)
            passed = bool(entry.get("result", 0))
            text = f"Sensor {sensor_id}: {'PASS' if passed else 'FAIL'}"
            item = QtWidgets.QListWidgetItem(text)
            color = QtGui.QColor("#2ecc71" if passed else "#e74c3c")
            item.setForeground(color)
            self.self_test_results_list.addItem(item)

    def _on_send_heartbeat_changed(self, state):
        if state == QtCore.Qt.CheckState.Checked.value:
            self._server_heartbeat_timer.start(SERVER_HEARTBEAT_INTERVAL_MS)
        else:
            self._server_heartbeat_timer.stop()

    def _send_server_heartbeat_once(self):

        ip = self.target_ip_edit.text().strip()
        if not ip:
            self.send_status_label.setText("Send status: No target IP")
            return
        try:
            port = self.target_port_spin.value()
            pkt = build_server_heartbeat_packet()
            self._send_sock.sendto(pkt, (ip, port))
            self.send_status_label.setText(f"Send status: Sending to {ip}:{port}")
        except Exception as e:
            self.send_status_label.setText(f"Send status: Error — {e}")

    def _send_sensor_config(self):
        ip = self.target_ip_edit.text().strip()
        if not ip:
            return
        try:
            port = self.target_port_spin.value()
            necessary = self.necessary_for_abort_cb.isChecked()
            controller_ip = self.actuator_ip_edit.text().strip() or None
            # 0 = internal 2.5V, 1 = VDD (e.g. 3.3V), 2 = ignore/board default
            ref_index = self.ref_voltage_combo.currentIndex()
            ref_enum = self.ref_voltage_combo.itemData(ref_index)
            if ref_enum is None:
                ref_enum = 0
            enable_serial = 1 if self.enable_serial_printing_cb.isChecked() else 0
            sensor_ids_text = self.sensor_ids_edit.text().strip()
            sensor_ids = parse_sensor_ids_from_text(sensor_ids_text)
            pkt = build_sensor_config_packet(
                sensor_ids,
                necessary,
                controller_ip,
                reference_voltage=ref_enum,
                enable_serial_printing=enable_serial,
            )
            self._send_sock.sendto(pkt, (ip, port))
        except Exception:
            pass

    def _send_header_only(self, packet_type: int):
        ip = self.target_ip_edit.text().strip()
        if not ip:
            return
        try:
            port = self.target_port_spin.value()
            pkt = build_header_only_packet(packet_type)
            self._send_sock.sendto(pkt, (ip, port))
        except Exception:
            pass

    def _on_sensor_data(self, header, chunks: list, source_ip: str):
        if self.stats_start_time is None:
            self.stats_start_time = time.time()
        base_time = self.stats_start_time
        receive_time = time.time() - base_time

        for chunk in chunks:
            for dp in chunk['datapoints']:
                sensor_id = dp['sensor_id']
                code_uint32 = dp['data']

                if sensor_id not in self.sensor_data:
                    self.sensor_data[sensor_id] = deque(maxlen=MAX_POINTS)
                    if sensor_id not in self.plot_enabled:
                        self.plot_enabled[sensor_id] = True
                    if sensor_id in self.channel_checkboxes:
                        self.channel_checkboxes[sensor_id].setChecked(self.plot_enabled[sensor_id])
                    color = SENSOR_COLORS[(sensor_id - 1) % len(SENSOR_COLORS)]
                    pen = pg.mkPen(color=color, width=2)
                    plot = self.plot_widget.plot([], [], pen=pen, name=f"Ch {sensor_id}")
                    plot.setVisible(self.plot_enabled.get(sensor_id, True))
                    self.sensor_plots[sensor_id] = plot

                self.sensor_data[sensor_id].append((receive_time, code_uint32))

    def _update_plots(self):
        if not self._started or not self.receiver:
            return
        stats = self.receiver.get_stats()
        self.network_stats = {
            'packets': str(stats['packets']),
            'pps': f"{stats['packets_per_sec']:.1f}",
            'bytes': f"{stats['bytes']} B",
            'bps': f"{stats['bytes_per_sec']:.0f} B/s",
        }
        self.stats_label.setText(
            f"Packets: {self.network_stats['packets']}  |  "
            f"Pkts/s: {self.network_stats['pps']}  |  "
            f"Bytes: {self.network_stats['bytes']}  |  "
            f"B/s: {self.network_stats['bps']}"
        )

        # Board status panel: heartbeat rate, state, connection
        now = time.time()
        if len(self.heartbeat_timestamps) >= 2:
            span = self.heartbeat_timestamps[-1] - self.heartbeat_timestamps[0]
            rate = (len(self.heartbeat_timestamps) - 1) / span if span > 0 else 0
            self.heartbeat_rate_label.setText(f"Heartbeat rate: {rate:.2f} Hz")
        else:
            self.heartbeat_rate_label.setText("Heartbeat rate: — Hz")

        if self.board_state is not None:
            self.board_state_label.setText(f"Board state: {board_state_name(self.board_state)}")
        else:
            self.board_state_label.setText("Board state: —")

        if self.last_heartbeat_time is not None:
            if now - self.last_heartbeat_time > HEARTBEAT_TIMEOUT_SEC:
                self.connection_label.setText("Connection: Lost")
                self.connection_label.setStyleSheet("font-weight: bold; color: #e74c3c;")
            else:
                self.connection_label.setText("Connection: Connected")
                self.connection_label.setStyleSheet("font-weight: bold; color: #2ecc71;")
        else:
            self.connection_label.setText("Connection: —")
            self.connection_label.setStyleSheet("font-weight: bold;")

        self.board_id_label.setText(f"Board ID: {self.board_id if self.board_id is not None else '—'}")
        self.board_ip_label.setText(f"Source: {self.board_source_ip or '—'}")

        current_time = time.time() - self.stats_start_time
        time_window = self.window_seconds

        use_pt1000 = self.show_temp_pt1000_cb.isChecked()
        use_k_type = self.show_temp_k_cb.isChecked()
        use_force = self.show_force_lc_cb.isChecked()
        use_encoder = self.show_encoder_angle_cb.isChecked()
        _label_style = {'color': '#FFFFFF', 'font-size': '11pt'}
        if use_encoder:
            self.plot_widget.setLabel("left", "Angle (°)", **_label_style)
        elif use_force:
            self.plot_widget.setLabel("left", "Force", **_label_style)
        elif use_pt1000:
            self.plot_widget.setLabel("left", "Temperature (°C)", **_label_style)
        elif use_k_type:
            self.plot_widget.setLabel("left", "Temperature (°C)", **_label_style)
        else:
            # Choose y-axis unit from visible data range (V, mV, or µV)
            max_abs_v = 0.0
            for sid, dq in self.sensor_data.items():
                if not self.plot_enabled.get(sid, True):
                    continue
                for t, code in dq:
                    if current_time - t <= time_window:
                        v = code_to_voltage(code, self.ref_voltage)
                        max_abs_v = max(max_abs_v, abs(v))
            if max_abs_v < 1e-6:
                y_unit, y_scale = "µV", 1e6
            elif max_abs_v < 1e-3:
                y_unit, y_scale = "mV", 1e3
            else:
                y_unit, y_scale = "V", 1.0
            self.plot_widget.setLabel("left", f"Voltage ({y_unit})", **_label_style)
        ax_left = self.plot_widget.getPlotItem().getAxis("left")
        if hasattr(ax_left, 'label') and hasattr(ax_left.label, 'setColor'):
            ax_left.label.setColor('#FFFFFF')

        for sensor_id, data_deque in self.sensor_data.items():
            if sensor_id not in self.sensor_plots:
                continue
            if not self.plot_enabled.get(sensor_id, True):
                self.sensor_plots[sensor_id].setData([], [])
                self.sensor_plots[sensor_id].setVisible(False)
                continue
            self.sensor_plots[sensor_id].setVisible(True)
            times, values = [], []
            for t, code in data_deque:
                if current_time - t <= time_window:
                    if use_encoder:
                        angle = (code & 0x0FFF) * 360.0 / 4096.0
                        times.append(t)
                        values.append(angle)
                    elif use_force:
                        exc = self.lc_excitation_spin.value()
                        sens = self.lc_sensitivity_spin.value()
                        pga = self.lc_pga_gain_spin.value()
                        fs = self.lc_full_scale_spin.value()
                        force = code_to_force(
                            code, self.ref_voltage, exc, sens, pga, fs
                        )
                        if force is not None:
                            times.append(t)
                            values.append(force)
                    elif use_pt1000:
                        v = code_to_voltage(code, self.ref_voltage)
                        temp = pt1000_voltage_to_temperature_c(v, excitation_ua=PT1000_EXCITATION_UA)
                        if temp is not None:
                            times.append(t)
                            values.append(temp)
                    elif use_k_type:
                        v = code_to_voltage(code, self.ref_voltage)
                        temp = k_type_voltage_to_temperature_c(v)
                        if temp is not None:
                            times.append(t)
                            values.append(temp)
                    else:
                        v = code_to_voltage(code, self.ref_voltage)
                        times.append(t)
                        values.append(v * y_scale)
            if times:
                self.sensor_plots[sensor_id].setData(times, values)

        if current_time > time_window:
            self.plot_widget.setXRange(current_time - time_window, current_time, padding=0)
        else:
            self.plot_widget.setXRange(0, time_window, padding=0)

    def closeEvent(self, event):
        self._save_leaderboard()
        self._server_heartbeat_timer.stop()
        if self._ota_worker is not None:
            try:
                self._ota_worker.requestInterruption()
                self._ota_worker.wait(2000)
            except Exception:
                pass
        if self._send_sock:
            try:
                self._send_sock.close()
            except Exception:
                pass
        if self._started and self.receiver:
            self.receiver.stop()
            self.receiver.wait(2000)
        self.update_timer.stop()
        event.accept()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Sense Testing GUI: plot sensor voltage, track board status, send server/abort packets")
    parser.add_argument('-p', '--port', type=int, default=DEFAULT_PORT, help=f"UDP port (default: {DEFAULT_PORT})")
    parser.add_argument('-r', '--ref-voltage', type=float, default=DEFAULT_REF_VOLTAGE,
                        help=f"ADC reference voltage in V (default: {DEFAULT_REF_VOLTAGE})")
    args = parser.parse_args()

    app = QtWidgets.QApplication(sys.argv)
    app.setStyle("Fusion")
    palette = QtGui.QPalette()
    palette.setColor(QtGui.QPalette.ColorRole.Window, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorRole.WindowText, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorRole.Base, QtGui.QColor(25, 25, 25))
    palette.setColor(QtGui.QPalette.ColorRole.Text, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorRole.Button, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorRole.ButtonText, QtCore.Qt.GlobalColor.white)
    app.setPalette(palette)

    window = SenseTestingGUIWindow(port=args.port, ref_voltage=args.ref_voltage)
    window.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()

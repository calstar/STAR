"""
Fake sensor data generator for demo mode.
Builds UDP packets in the same format as the real boards so the GUI receives and
decodes them exactly like real hardware.

Buffer layout matches Diablo::create_sensor_data_packet() in DAQv2-Comms:
  - DiabloPackets.h: PacketHeader, SensorDataPacket, SensorDataChunk, SensorDatapoint
  - DiabloPacketUtils.cpp: write order = header -> body_header -> for each chunk
    (chunk timestamp -> num_sensors × datapoint)
No Qt or socket usage here.
"""

import struct
import time
from typing import Dict, List, Tuple

import numpy as np

# Same as DAQv2-Comms.h
MAX_PACKET_SIZE = 512

# Packet layout: must match DiabloPackets.h packed structs (little-endian)
# PacketHeader: packet_type (uint8_t), version (uint8_t), timestamp (uint32_t)
PACKET_HEADER_FORMAT = "<BBI"
PACKET_HEADER_SIZE = 6
# SensorDataPacket: num_chunks (uint8_t), num_sensors (uint8_t)
SENSOR_DATA_PACKET_FORMAT = "<BB"
SENSOR_DATA_PACKET_SIZE = 2
# SensorDataChunk: timestamp (uint32_t)
SENSOR_DATA_CHUNK_FORMAT = "<I"
SENSOR_DATA_CHUNK_SIZE = 4
# SensorDatapoint: sensor_id (uint8_t), data (uint32_t)
SENSOR_DATAPOINT_FORMAT = "<BI"
SENSOR_DATAPOINT_SIZE = 5

# Calibration CSVs use ADC codes from ~2e8 to ~2e9; clamp range must allow 0–800+ psi
DEMO_CODE_MIN = 0
DEMO_CODE_MAX = (1 << 32) - 1  # uint32 max

# Precomputed demo signals: arrays of normalized [0,1] for psi range mapping
PRECOMPUTED_LENGTH = 2000
PRECOMPUTED_STEP = 0.05  # seconds per sample
_DEMO_NORM_ARRAYS: List[List[float]] = []


def _demo_signal_sine(t: float) -> float:
    """Sine wave, period 4 s, scaled to [0, 1]."""
    return 0.5 + 0.5 * np.sin(2 * np.pi * t / 4)


def _demo_signal_ramp(t: float) -> float:
    """Sawtooth, repeating ramp up, period 4 s."""
    return (t % 4) / 4


def _demo_signal_square(t: float) -> float:
    """Square wave, period 2 s."""
    return 1.0 if (int(t / 2) % 2) == 0 else 0.0


def _demo_signal_noise(t: float) -> float:
    """Smoothed deterministic noise in [0, 1]."""
    x = 0.5 + 0.4 * np.sin(t * 1.3) * np.cos(t * 2.7) + 0.05 * np.sin(t * 5.1)
    return max(0.0, min(1.0, x))


def _demo_signal_step(t: float) -> float:
    """Two levels with slow transition, period 3 s per level."""
    return 1.0 if (int(t / 3) % 2) == 0 else 0.0


def _demo_signal_triangle(t: float) -> float:
    """Triangle wave, period 4 s."""
    x = (t % 4) / 4
    return 2 * x if x < 0.5 else 2 * (1 - x)


def _demo_signal_double_sine(t: float) -> float:
    """Beat pattern from two close frequencies."""
    x = 0.5 * np.sin(2 * np.pi * t / 3) + 0.5 * np.sin(2 * np.pi * t / 3.2)
    return 0.5 + 0.5 * max(-1, min(1, x))


def _demo_signal_decay(t: float) -> float:
    """Repeating exponential decay, period 2 s."""
    u = t % 2
    y = np.exp(-u)
    lo, hi = np.exp(-2), 1.0
    return (y - lo) / (hi - lo) if hi > lo else 0.5


def _demo_signal_pulse(t: float) -> float:
    """Short periodic spikes, period 2 s, duty 0.1 s."""
    return 1.0 if 0 < (t % 2) < 0.1 else 0.0


def _demo_signal_drift(t: float) -> float:
    """Slow linear drift + small deterministic variation, period 20 s."""
    drift = (t / 20) % 1
    noise = 0.1 * np.sin(t * 2.1) * np.cos(t * 1.7)
    return max(0.0, min(1.0, 0.1 + 0.8 * drift + noise))


def _demo_signal_linear_cycle(t: float) -> float:
    """Triangle wave, period 4 s, normalized [0, 1] (linear 0->1->0)."""
    x = (t % 4) / 4
    return 2 * x if x < 0.5 else 2 * (1 - x)


def _demo_signal_quadratic_cycle(t: float) -> float:
    """Parabola 0->1->0, period 4 s, normalized [0, 1]."""
    phase = (t % 4) / 4
    return 4 * phase * (1 - phase)


def _demo_signal_cubic_cycle(t: float) -> float:
    """Smooth cubic 0->1->0, period 4 s, normalized [0, 1]."""
    phase = (t % 4) / 4
    return 16 * phase * phase * (1 - phase) * (1 - phase)


DEMO_SIGNAL_FUNCTIONS = [
    _demo_signal_sine,
    _demo_signal_ramp,
    _demo_signal_square,
    _demo_signal_noise,
    _demo_signal_step,
    _demo_signal_triangle,
    _demo_signal_double_sine,
    _demo_signal_decay,
    _demo_signal_pulse,
    _demo_signal_drift,
    _demo_signal_linear_cycle,
    _demo_signal_quadratic_cycle,
    _demo_signal_cubic_cycle,
]


# PT 4 -> linear, PT 1 -> quadratic, PT 5 -> cubic (indices into _DEMO_NORM_ARRAYS), 0-800 psi
DEMO_PT_SPECIAL_SIGNALS = {
    4: (10, 0.0, 800.0),   # linear_cycle
    1: (11, 0.0, 800.0),   # quadratic_cycle
    5: (12, 0.0, 800.0),   # cubic_cycle
}


def _precompute_demo_arrays() -> None:
    """Fill _DEMO_NORM_ARRAYS with fixed arrays of normalized [0,1] (run once at import)."""
    global _DEMO_NORM_ARRAYS
    if _DEMO_NORM_ARRAYS:
        return
    for sig_fn in DEMO_SIGNAL_FUNCTIONS:
        arr = []
        for k in range(PRECOMPUTED_LENGTH):
            t = k * PRECOMPUTED_STEP
            norm = sig_fn(t)
            norm = max(0.0, min(1.0, norm))
            arr.append(float(norm))
        _DEMO_NORM_ARRAYS.append(arr)


def _psi_to_code(psi: float, a: float, b: float, c: float, d: float) -> int:
    """Inverse of cubic calibration: find ADC code that yields given psi (Newton-Raphson)."""
    # psi = a*code^3 + b*code^2 + c*code + d
    code = float((DEMO_CODE_MIN + DEMO_CODE_MAX) // 2)
    for _ in range(15):
        f = (a * code * code * code) + (b * code * code) + (c * code) + d - psi
        fp = (3 * a * code * code) + (2 * b * code) + c
        if abs(fp) < 1e-20:
            break
        code = code - f / fp
    code = max(DEMO_CODE_MIN, min(DEMO_CODE_MAX, int(round(code))))
    return code & 0xFFFFFFFF


# _precompute_demo_arrays()  <-- Lazy loaded in build_demo_packet


def create_sensor_data_packet(
    chunks: List[Tuple[int, List[Tuple[int, int]]]],
    packet_type: int,
    version: int,
    timestamp_ms: int,
    max_packet_size: int,
) -> bytes:
    """
    Build a sensor data UDP packet. Byte layout is identical to
    Diablo::create_sensor_data_packet() in DAQv2-Comms (DiabloPacketUtils.cpp):
    header (6) -> num_chunks, num_sensors (2) -> for each chunk: timestamp (4)
    then num_sensors × (sensor_id (1), data (4)).
    chunks: list of (chunk_timestamp_ms, [(sensor_id, adc_code_uint32), ...])
    All chunks must have the same number of datapoints (num_sensors).
    """
    if not chunks:
        return b""
    num_chunks = len(chunks)
    num_sensors = len(chunks[0][1])
    if not all(len(c[1]) == num_sensors for c in chunks):
        return b""
    per_chunk_size = SENSOR_DATA_CHUNK_SIZE + num_sensors * SENSOR_DATAPOINT_SIZE
    total_size = (
        PACKET_HEADER_SIZE
        + SENSOR_DATA_PACKET_SIZE
        + num_chunks * per_chunk_size
    )
    if total_size > max_packet_size:
        return b""
    packet = bytearray(total_size)
    offset = 0
    struct.pack_into(
        PACKET_HEADER_FORMAT, packet, offset, packet_type, version, timestamp_ms
    )
    offset += PACKET_HEADER_SIZE
    struct.pack_into(SENSOR_DATA_PACKET_FORMAT, packet, offset, num_chunks, num_sensors)
    offset += SENSOR_DATA_PACKET_SIZE
    for chunk_ts, datapoints in chunks:
        struct.pack_into(SENSOR_DATA_CHUNK_FORMAT, packet, offset, chunk_ts)
        offset += SENSOR_DATA_CHUNK_SIZE
        for sensor_id, adc_code in datapoints:
            struct.pack_into(
                SENSOR_DATAPOINT_FORMAT, packet, offset, sensor_id, adc_code & 0xFFFFFFFF
            )
            offset += SENSOR_DATAPOINT_SIZE
    return bytes(packet)


def build_demo_packet(
    pt_calibration: Dict[int, Tuple[float, float, float, float]],
    demo_start_time: float,
    stats_start_time: float,
    packet_type: int,
    version: int,
    max_packet_size: int,
    num_connectors: int = 10,
    psi_min: float = 0.0,
    psi_max: float = 700.0,
) -> bytes:
    """
    Build one UDP packet with synthetic PT data for demo mode.
    Same structure as real boards: one chunk per connector (1..num_connectors),
    one datapoint per chunk. Normalized signals [0,1] are mapped to [psi_min, psi_max]
    and converted to ADC codes via inverse calibration so displayed psi ranges 0-700 for all.
    """
    if not _DEMO_NORM_ARRAYS:
        _precompute_demo_arrays()

    now = time.time()
    elapsed = now - demo_start_time
    idx = int(elapsed * 20) % PRECOMPUTED_LENGTH
    ts_ms = int((now - stats_start_time) * 1000) & 0xFFFFFFFF
    base_ms = int(now * 1000) & 0xFFFFFFFF
    default_code = (DEMO_CODE_MIN + DEMO_CODE_MAX) // 2
    chunks = []
    for connector_id in range(1, num_connectors + 1):
        chunk_ts_ms = (base_ms - (num_connectors - connector_id)) & 0xFFFFFFFF
        if connector_id in pt_calibration:
            if connector_id in DEMO_PT_SPECIAL_SIGNALS:
                signal_index, pmin, pmax = DEMO_PT_SPECIAL_SIGNALS[connector_id]
                norm = _DEMO_NORM_ARRAYS[signal_index][idx]
                psi = pmin + (pmax - pmin) * norm
            else:
                signal_index = (connector_id - 1) % 10
                norm = _DEMO_NORM_ARRAYS[signal_index][idx]
                psi = psi_min + (psi_max - psi_min) * norm
            a, b, c, d = pt_calibration[connector_id]
            code = _psi_to_code(psi, a, b, c, d)
        else:
            code = default_code
        chunks.append((chunk_ts_ms, [(connector_id, code)]))
    return create_sensor_data_packet(
        chunks, packet_type, version, ts_ms, max_packet_size
    )

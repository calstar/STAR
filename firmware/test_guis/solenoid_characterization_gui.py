#!/usr/bin/env python3
from __future__ import annotations

"""
Solenoid Characterization GUI
Clone of combined_gui for root GUI, packet reading, and config.
Select 1 PT and 1 actuator; graph shows that PT's pressure and vertical dashed lines
mark each actuator OPEN/CLOSED command time.

Requirements: pip install pyqt6 pyqtgraph numpy pandas
"""

import csv
import json
import os
import re
import socket
import struct
import sys
import time
from pathlib import Path
from typing import Optional, Tuple, List, Dict
from collections import deque

# Default PT calibration path when config paths are empty
PT_CALIBRATION_CSV = str(
    Path(__file__).parent.parent / "PT_Board" / "Calibration" / "PT Calibration Attempt 2026-02-04_test2.csv"
)

# Fix Qt "cocoa" platform plugin on macOS when Homebrew Qt plugins path lacks platforms/
if sys.platform == 'darwin':
    _qt_plugins = os.environ.get('QT_QPA_PLATFORM_PLUGIN_PATH')
    if not _qt_plugins or not os.path.isdir(_qt_plugins):
        _candidates = [
            '/opt/homebrew/share/qt/plugins/platforms',
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
import pandas as pd

# Protocol constants from DAQv2-Comms.h
DIABLO_COMMS_VERSION = 0
MAX_PACKET_SIZE = 512


class PacketType:
    BOARD_HEARTBEAT = 1
    SERVER_HEARTBEAT = 2
    SENSOR_DATA = 3
    ACTUATOR_COMMAND = 4
    SENSOR_CONFIG = 5
    ACTUATOR_CONFIG = 6
    ABORT = 7
    ABORT_DONE = 8
    CLEAR_ABORT = 9
    PWM_ACTUATOR_COMMAND = 10
    NO_CONNECTION_ABORT = 11


DEFAULT_SENSOR_IP = '192.168.2.21'
DEFAULT_ACTUATOR_IP = '192.168.2.12'
DEFAULT_DEVICE_PORT = 5005
DEFAULT_RECEIVE_PORT = 5006

PACKET_HEADER_FORMAT = '<BBI'
PACKET_HEADER_SIZE = 6
ACTUATOR_COMMAND_PACKET_FORMAT = '<B'
ACTUATOR_COMMAND_PACKET_SIZE = 1
ACTUATOR_COMMAND_FORMAT = '<BB'
ACTUATOR_COMMAND_SIZE = 2
PWM_ACTUATOR_COMMAND_PACKET_FORMAT = '<B'
PWM_ACTUATOR_COMMAND_PACKET_SIZE = 1
# PWM Command: actuator_id (u8), duration_ms (u32), duty_cycle (float), frequency (float)
PWM_ACTUATOR_COMMAND_FORMAT = '<BIff'
PWM_ACTUATOR_COMMAND_SIZE = 13
SENSOR_DATA_PACKET_FORMAT = '<BB'
SENSOR_DATA_PACKET_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = '<I'
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = '<BI'
SENSOR_DATAPOINT_SIZE = 5

DEFAULT_WINDOW_SECONDS = 10.0
# Buffer must hold at least (max window s) * (sample rate). Window up to 120 s; at 1 kHz that's 120k points.
MAX_POINTS = 150000
UPDATE_INTERVAL_MS = 50
# Board sends one timestamp per chunk; samples within a chunk are spaced at this rate (match stream_one_adc DATA_RATE).
SAMPLE_RATE_HZ = 7200
DEFAULT_ACTUATOR_ROLE_NAMES = ["LOX Main", "Fuel Main", "Fuel Vent", "Fuel Press", "LOX Vent", "LOX Press"]
DEFAULT_SENSOR_ROLE_NAMES = ["LOX Upstream", "LOX Downstream", "Low Press PT", "Fuel Downstream"]

CONFIG_FILE = Path(__file__).parent / "config.json"


class ConfigManager:
    """Manages loading and saving of application configuration (shared config.json)."""

    def __init__(self):
        self.config = {
            "actuator_role_names": list(DEFAULT_ACTUATOR_ROLE_NAMES),
            "actuator_roles": {name: 0 for name in DEFAULT_ACTUATOR_ROLE_NAMES},
            "sensor_roles": {name: 0 for name in DEFAULT_SENSOR_ROLE_NAMES},
            "network": {
                "actuator_ip": DEFAULT_ACTUATOR_IP,
                "actuator_port": DEFAULT_DEVICE_PORT,
                "sensor_ip_filter": DEFAULT_SENSOR_IP,
                "receive_port": DEFAULT_RECEIVE_PORT,
            },
            "display": {
                "adc_bits": 32,
                "ref_voltage": 2.5,
                "window_seconds": DEFAULT_WINDOW_SECONDS,
                "y_axis_min": 0.0,
                "y_axis_max": 700.0,
                "y_axis_autoscale": True,
            },
            "num_connectors": 10,
            "num_actuators": 10,
            "paths": {"pt_calibration_csv": []},
        }
        self.load()

    def load(self):
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, 'r') as f:
                    loaded = json.load(f)
                    self._update_dict(self.config, loaded)
                    if "sensor_roles" in loaded and isinstance(loaded["sensor_roles"], dict):
                        self.config["sensor_roles"] = dict(loaded["sensor_roles"])
                self._backfill_role_names()
            except Exception as e:
                print(f"Error loading config: {e}")
        else:
            self.save()

    def _backfill_role_names(self):
        roles = self.config.setdefault("actuator_roles", {})
        names = self.config.get("actuator_role_names") or list(roles.keys()) or list(DEFAULT_ACTUATOR_ROLE_NAMES)
        self.config["actuator_role_names"] = names
        for name in names:
            if name not in roles:
                roles[name] = 0
        if "num_connectors" not in self.config:
            self.config["num_connectors"] = 10
        if "num_actuators" not in self.config:
            self.config["num_actuators"] = 10
        if "paths" not in self.config:
            self.config["paths"] = {"pt_calibration_csv": []}
        if isinstance(self.config.get("paths", {}).get("pt_calibration_csv"), str):
            old_val = self.config["paths"]["pt_calibration_csv"]
            self.config["paths"]["pt_calibration_csv"] = [old_val] if old_val and str(old_val).strip() else []

    def save(self):
        try:
            with open(CONFIG_FILE, 'w') as f:
                json.dump(self.config, f, indent=4)
        except Exception as e:
            print(f"Error saving config: {e}")

    def _update_dict(self, target, source):
        for k, v in source.items():
            if isinstance(v, dict) and k in target and isinstance(target[k], dict):
                self._update_dict(target[k], v)
            else:
                target[k] = v

    def get_actuator_role_names(self):
        return self.config.get("actuator_role_names") or list(self.config.get("actuator_roles", {}).keys()) or list(DEFAULT_ACTUATOR_ROLE_NAMES)

    def get_sensor_role_names(self):
        return list(self.config.get("sensor_roles", {}).keys())

    def get_num_connectors(self):
        return int(self.config.get("num_connectors", 10))

    def get_num_actuators(self):
        return int(self.config.get("num_actuators", 10))

    def get_pt_calibration_csv_paths(self):
        p = (self.config.get("paths") or {}).get("pt_calibration_csv", "")
        if isinstance(p, list):
            return [path.strip() for path in p if path and path.strip()]
        return [p.strip()] if p and str(p).strip() else []

    def get_actuator_label(self, idx):
        roles = self.config.get("actuator_roles", {})
        for role, aid in roles.items():
            actuator_id = aid[1] if isinstance(aid, list) and len(aid) == 2 else aid
            if actuator_id == idx:
                return role
        return ""

    def get_sensor_label(self, idx):
        roles = self.config.get("sensor_roles", {})
        for role, cid in roles.items():
            if cid == idx:
                return role
        return ""

    def get_actuator_role(self, role_name):
        aid = self.config.get("actuator_roles", {}).get(role_name, 0)
        if isinstance(aid, list) and len(aid) == 2:
            return aid[1]
        return aid

    def get_actuator_type_by_id(self, actuator_id):
        roles = self.config.get("actuator_roles", {})
        for role, aid in roles.items():
            if isinstance(aid, list) and len(aid) == 2 and aid[1] == actuator_id:
                return aid[0]
            elif aid == actuator_id:
                return 'NC'
        return 'NC'


CONFIG = ConfigManager()
NUM_CONNECTORS = CONFIG.get_num_connectors()
NUM_ACTUATORS = CONFIG.get_num_actuators()

pg.setConfigOptions(antialias=False)


# ---------------------- PT calibration ----------------------
def calculate_pressure(adc_code: float, PT_A: float, PT_B: float, PT_C: float, PT_D: float) -> float:
    return (PT_A * (adc_code ** 3)) + (PT_B * (adc_code ** 2)) + (PT_C * adc_code) + PT_D


def load_pt_calibration(csv_paths) -> Tuple[Dict[int, Tuple[float, float, float, float]], Optional[str]]:
    result = {}
    duplicates = {}
    if isinstance(csv_paths, str):
        csv_paths = [csv_paths] if csv_paths.strip() else []
    elif not isinstance(csv_paths, list):
        csv_paths = []
    if not csv_paths:
        csv_paths = [PT_CALIBRATION_CSV]
    csv_pt_map = {}
    for csv_path in csv_paths:
        if not csv_path or not str(csv_path).strip():
            continue
        csv_path = str(csv_path).strip()
        if not os.path.isfile(csv_path):
            continue
        try:
            with open(csv_path, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                rows = list(reader)
                fieldnames = reader.fieldnames or []
            if not rows:
                continue
            pt_nums = set()
            for col in fieldnames:
                m = re.match(r"PT(\d+)\s+Coefficient\s+0", col, re.IGNORECASE)
                if m:
                    pt_nums.add(int(m.group(1)))
            csv_pt_map[csv_path] = pt_nums
            last = rows[-1]
            for pt_num in sorted(pt_nums):
                if pt_num in result:
                    if pt_num not in duplicates:
                        duplicates[pt_num] = []
                        for prev_path, prev_pt_nums in csv_pt_map.items():
                            if prev_path != csv_path and pt_num in prev_pt_nums:
                                duplicates[pt_num].append(os.path.basename(prev_path))
                    duplicates[pt_num].append(os.path.basename(csv_path))
                    continue
                a = float(last.get(f"PT{pt_num} Coefficient 0", 0))
                b = float(last.get(f"PT{pt_num} Coefficient 1", 0))
                c = float(last.get(f"PT{pt_num} Coefficient 2", 0))
                d = float(last.get(f"PT{pt_num} Coefficient 3", 0))
                result[pt_num] = (a, b, c, d)
        except Exception as e:
            return result, f"Error loading {os.path.basename(csv_path)}: {str(e)}"
    if duplicates:
        error_parts = ["Duplicate PT numbers found:"]
        for pt_num, files in sorted(duplicates.items()):
            error_parts.append(f"  PT{pt_num} appears in: {', '.join(files)}")
        return result, "\n".join(error_parts)
    return result, None


# ---------------------- Solenoid timing extraction ----------------------
def extract_solenoid_timing_live(
    t: np.ndarray,
    P: np.ndarray,
    t_open_cmd: float,
    t_close_cmd: float,
    *,
    smooth_window_sec: float = 0.020,
    derivative_threshold_psi_s: float = 50.0,
    settle_threshold_psi_s: float = 20.0,
    pre_window_sec: float = 0.5,
    guard_sec: float = 0.005,
    min_step_psi: float = 5.0,
    sustain_samples: int = 10,
    search_max_sec: float = 5.0,
    open_is_drop: bool = True,
) -> Dict:
    """
    Extract solenoid valve timing from pressure data using derivative-based edge detection.
    
    Detects 4 events:
      - t_open_start: When valve starts opening (pressure begins changing after OPEN cmd)
      - t_open_end: When valve is fully open (pressure stabilizes at low point)
      - t_close_start: When valve starts closing (pressure begins recovering)
      - t_close_end: When valve is fully closed (pressure returns to baseline)
    
    This algorithm handles overlapping command/response timing where the physical valve
    response lags behind electrical commands by hundreds of milliseconds.
    
    Args:
        t: Time array in seconds
        P: Pressure array in psi
        t_open_cmd: Time of OPEN command
        t_close_cmd: Time of CLOSE command
        smooth_window_sec: Window for smoothing pressure (default: 20ms)
        derivative_threshold_psi_s: Rate of change to detect transition start (default: 50 psi/s)
        settle_threshold_psi_s: Rate of change threshold for "settled" state (default: 20 psi/s)
        pre_window_sec: Time before command to calculate baseline (default: 0.5s)
        guard_sec: Minimum time after command before looking for response (default: 5ms)
        min_step_psi: Minimum pressure change to consider valid (default: 5 psi)
        sustain_samples: Number of consecutive samples to confirm a state (default: 10)
        search_max_sec: Maximum time after command to search for events (default: 5s)
        open_is_drop: If True, opening causes pressure drop; if False, opening causes pressure rise
    
    Returns:
        Dictionary with timing results including t_open_start, t_open_end, t_close_start, t_close_end
    """
    t = np.asarray(t, dtype=float)
    P = np.asarray(P, dtype=float)
    if t.ndim != 1 or P.ndim != 1 or len(t) != len(P):
        raise ValueError("t and P must be 1D arrays of the same length")
    if len(t) < 20:
        raise ValueError("Need at least 20 samples")
    if not np.all(np.diff(t) > 0):
        raise ValueError("t must be strictly increasing")
    if t_open_cmd >= t_close_cmd:
        raise ValueError("t_open_cmd must be < t_close_cmd")
    if t[0] > t_open_cmd or t[-1] < t_close_cmd:
        raise ValueError("t must cover both commands")

    dt_med = float(np.median(np.diff(t)))
    fs = 1.0 / dt_med

    # Smooth pressure signal
    n = int(round(smooth_window_sec * fs))
    n = max(3, n)
    if n % 2 == 0:
        n += 1
    n = min(n, len(P) - 2)
    if n >= 3:
        k = np.ones(n) / n
        P_s = np.convolve(P, k, mode="same")
    else:
        P_s = P.copy()

    # Compute derivative with additional smoothing for stability
    dP_dt_raw = np.gradient(P_s, t)
    n_deriv = max(3, int(round(0.010 * fs)))  # 10ms smoothing on derivative
    if n_deriv % 2 == 0:
        n_deriv += 1
    n_deriv = min(n_deriv, len(dP_dt_raw) - 2)
    if n_deriv >= 3:
        k_deriv = np.ones(n_deriv) / n_deriv
        dP_dt = np.convolve(dP_dt_raw, k_deriv, mode="same")
    else:
        dP_dt = dP_dt_raw

    def _median_in_window(t0: float, t1: float) -> float:
        idx = np.nonzero((t >= t0) & (t <= t1))[0]
        if len(idx) < 5:
            # Fall back to closest samples if window is too small
            i_center = int(np.searchsorted(t, (t0 + t1) / 2))
            i_start = max(0, i_center - 10)
            i_end = min(len(P_s), i_center + 10)
            return float(np.median(P_s[i_start:i_end]))
        return float(np.median(P_s[idx]))

    def _first_sustained_idx(cond: np.ndarray, start_idx: int, end_idx: Optional[int] = None) -> Optional[int]:
        """Find first index where condition is sustained for sustain_samples consecutive samples."""
        s = max(1, int(sustain_samples))
        if end_idx is None:
            end_idx = len(cond)
        for i in range(start_idx, min(end_idx, len(cond)) - s + 1):
            if np.all(cond[i : i + s]):
                return i
        return None

    # Get baseline pressure before OPEN command
    P_baseline = _median_in_window(max(t[0], t_open_cmd - pre_window_sec), t_open_cmd - 0.001)
    
    # Define search region
    i_open_cmd = int(np.searchsorted(t, t_open_cmd + guard_sec))
    i_search_end = int(np.searchsorted(t, t_open_cmd + search_max_sec))
    i_search_end = min(i_search_end, len(t) - 1)
    
    # For OPEN detection: look for derivative in expected direction
    # If open_is_drop=True, opening causes negative derivative (pressure falls)
    if open_is_drop:
        # Opening: look for sustained negative derivative
        cond_open_start = dP_dt < -derivative_threshold_psi_s
        cond_open_settled = np.abs(dP_dt) < settle_threshold_psi_s
    else:
        # Opening: look for sustained positive derivative  
        cond_open_start = dP_dt > derivative_threshold_psi_s
        cond_open_settled = np.abs(dP_dt) < settle_threshold_psi_s

    # Find when opening starts (first sustained derivative exceeding threshold)
    # Validate that it results in a real pressure change (not just noise)
    i_open_start = None
    t_open_start = None
    t_open_end = None
    P_open_post = None
    
    search_from = i_open_cmd
    while search_from < i_search_end:
        candidate = _first_sustained_idx(cond_open_start, search_from, i_search_end)
        if candidate is None:
            break
        
        # Check if this leads to a real pressure change
        # Look ahead 100ms and check if pressure has actually changed (not just spiked)
        i_look_ahead = min(candidate + int(0.1 * fs), i_search_end - 1)
        P_at_candidate = float(P_s[candidate])
        P_ahead = float(P_s[i_look_ahead])
        
        if open_is_drop:
            pressure_change = P_at_candidate - P_ahead
        else:
            pressure_change = P_ahead - P_at_candidate
        
        if pressure_change >= min_step_psi:
            # Valid opening detected
            i_open_start = candidate
            t_open_start = float(t[i_open_start])
            
            # Find when opening ends: User requested "when peak pressure drop rate starts"
            # We interpret this as the time of maximum derivative magnitude (peak flow acceleration)
            # Search for peak derivative between t_open_start and end of search window
            search_peak_end_idx = min(len(dP_dt), i_search_end)
            if search_peak_end_idx > i_open_start:
                peak_search_region = slice(i_open_start, search_peak_end_idx)
                if open_is_drop:
                    # Look for MINIMUM derivative (most negative)
                    i_peak = i_open_start + np.argmin(dP_dt[peak_search_region])
                else:
                    # Look for MAXIMUM derivative (most positive)
                    i_peak = i_open_start + np.argmax(dP_dt[peak_search_region])
                
                t_open_end = float(t[i_peak])
                P_open_post = float(P_s[i_peak])
            else:
                t_open_end = t_open_start # Should not happen given logic above
                P_open_post = float(P_s[i_open_start])
            
            # Since we found t_open_start, we break (only one open event expected)
            break
        else:
            # False positive - skip ahead and keep searching
            search_from = candidate + sustain_samples
    
    # For CLOSE detection: look for reverse derivative direction
    # The minimum pressure point marks the transition from opening to closing
    # We search from after t_open_end (if found) or after i_open_start
    if i_open_start is not None:
        search_start_for_close = i_open_start + sustain_samples
    else:
        search_start_for_close = i_open_cmd
    
    # Find minimum pressure point in the search region (this is "fully open")
    search_region = slice(search_start_for_close, i_search_end)
    if search_region.stop > search_region.start:
        i_min_local = search_start_for_close + int(np.argmin(P_s[search_region]))
        P_min = float(P_s[i_min_local])
        t_min = float(t[i_min_local])
    else:
        i_min_local = None
        P_min = None
        t_min = None

    # Fallback: if t_open_end (settled) was not found but we have a min point, use that as open end
    if t_open_end is None and t_min is not None:
        t_open_end = t_min
        P_open_post = P_min
    
    # For CLOSE: look for derivative in opposite direction to open
    if open_is_drop:
        # Closing: look for sustained positive derivative (pressure rises)
        cond_close_start = dP_dt > derivative_threshold_psi_s
    else:
        # Closing: look for sustained negative derivative (pressure falls)
        cond_close_start = dP_dt < -derivative_threshold_psi_s
    cond_close_settled = np.abs(dP_dt) < settle_threshold_psi_s
    
    # Search for close start after the minimum pressure point
    t_close_start = None
    t_close_end = None
    P_close_pre = P_min
    P_close_post = None
    
    if i_min_local is not None:
        i_close_start = _first_sustained_idx(cond_close_start, i_min_local, i_search_end)
        if i_close_start is not None:
            t_close_start = float(t[i_close_start])
            
            # Find when closing ends (derivative settles)
            i_close_end = _first_sustained_idx(cond_close_settled, i_close_start + sustain_samples, i_search_end)
            if i_close_end is not None:
                t_close_end = float(t[i_close_end])
                P_close_post = float(np.median(P_s[i_close_end:min(i_close_end + 50, len(P_s))]))
    
    def _maybe_delay(t_cmd: float, t_evt: Optional[float]) -> Optional[float]:
        return None if t_evt is None else float(t_evt - t_cmd)

    def _maybe_dt(t0: Optional[float], t1: Optional[float]) -> Optional[float]:
        return None if (t0 is None or t1 is None) else float(t1 - t0)

    return {
        "t_open_cmd": t_open_cmd,
        "t_close_cmd": t_close_cmd,
        "open_delay": _maybe_delay(t_open_cmd, t_open_start),
        "open_time": _maybe_dt(t_open_start, t_open_end),
        "close_delay": _maybe_delay(t_close_cmd, t_close_start),
        "close_time": _maybe_dt(t_close_start, t_close_end),
        "t_open_start": t_open_start,
        "t_open_end": t_open_end,
        "t_close_start": t_close_start,
        "t_close_end": t_close_end,
        "P_open_pre": P_baseline,
        "P_open_post": P_open_post,
        "P_close_pre": P_close_pre,
        "P_close_post": P_close_post,
    }


def extract_solenoid_timing_from_commands(
    df: pd.DataFrame,
    *,
    time_col: str = "time_sec",
    pressure_col: str = "pressure_psi",
    actuation_col: str = "ACTUATION",
    open_token: str = "OPEN",
    close_token: str = "CLOSED",
    smooth_window_sec: float = 0.020,
    derivative_threshold_psi_s: float = 50.0,
    settle_threshold_psi_s: float = 20.0,
    pre_window_sec: float = 0.5,
    guard_sec: float = 0.005,
    min_step_psi: float = 5.0,
    sustain_samples: int = 10,
    search_max_sec: float = 5.0,
    open_is_drop: bool = True,
) -> Dict:
    """
    Pressure-based timing from a DataFrame with ACTUATION column.
    Parses df to (t, P, t_open_cmd, t_close_cmd) then calls extract_solenoid_timing_live.
    Use this for CSV/offline; use extract_solenoid_timing_live for live GUI.
    """
    if time_col not in df or pressure_col not in df or actuation_col not in df:
        raise ValueError(f"df must contain columns: {time_col}, {pressure_col}, {actuation_col}")
    t = df[time_col].to_numpy(dtype=float)
    P_raw = df[pressure_col].to_numpy(dtype=float)
    finite = np.isfinite(P_raw)
    if finite.sum() < 10:
        raise ValueError("Not enough finite pressure samples")
    P = np.interp(t, t[finite], P_raw[finite])
    act = df[actuation_col].astype(str)
    open_rows = df.index[act == open_token].to_list()
    close_rows = df.index[act == close_token].to_list()
    if len(open_rows) != 1 or len(close_rows) != 1:
        raise ValueError(f"Expected exactly 1 '{open_token}' and 1 '{close_token}' row in {actuation_col}")
    t_open_cmd = float(t[open_rows[0]])
    t_close_cmd = float(t[close_rows[0]])
    if t_open_cmd >= t_close_cmd:
        raise ValueError("OPEN command must occur before CLOSED command")
    return extract_solenoid_timing_live(
        t, P, t_open_cmd, t_close_cmd,
        smooth_window_sec=smooth_window_sec,
        derivative_threshold_psi_s=derivative_threshold_psi_s,
        settle_threshold_psi_s=settle_threshold_psi_s,
        pre_window_sec=pre_window_sec,
        guard_sec=guard_sec,
        min_step_psi=min_step_psi,
        sustain_samples=sustain_samples,
        search_max_sec=search_max_sec,
        open_is_drop=open_is_drop,
    )


# ---------------------- Protocol ----------------------
def parse_packet_header(data: bytes) -> Optional[Tuple[int, int, int]]:
    if len(data) < PACKET_HEADER_SIZE:
        return None
    try:
        packet_type, version, timestamp = struct.unpack(PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE])
        return (packet_type, version, timestamp)
    except struct.error:
        return None


def parse_sensor_data_packet(data: bytes) -> Optional[Tuple[dict, List[dict]]]:
    if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE:
        return None
    header = parse_packet_header(data)
    if header is None or header[0] != PacketType.SENSOR_DATA:
        return None
    packet_type, version, timestamp = header
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
    for chunk_idx in range(num_chunks):
        try:
            chunk_timestamp, = struct.unpack(
                SENSOR_DATA_CHUNK_FORMAT,
                data[offset:offset + SENSOR_DATA_CHUNK_SIZE]
            )
        except struct.error:
            return None
        offset += SENSOR_DATA_CHUNK_SIZE
        datapoints = []
        for sensor_idx in range(num_sensors):
            try:
                sensor_id, sensor_data = struct.unpack(
                    SENSOR_DATAPOINT_FORMAT,
                    data[offset:offset + SENSOR_DATAPOINT_SIZE]
                )
                datapoints.append({'sensor_id': sensor_id, 'data': sensor_data})
                offset += SENSOR_DATAPOINT_SIZE
            except struct.error:
                return None
        chunks.append({'timestamp': chunk_timestamp, 'datapoints': datapoints})
    header_dict = {'packet_type': packet_type, 'version': version, 'timestamp': timestamp}
    return (header_dict, chunks)


def create_actuator_command_packet(commands: List[Tuple[int, int]]) -> bytes:
    if len(commands) == 0 or len(commands) > 255:
        return b''
    header_size = PACKET_HEADER_SIZE
    body_size = ACTUATOR_COMMAND_PACKET_SIZE
    commands_size = len(commands) * ACTUATOR_COMMAND_SIZE
    total_size = header_size + body_size + commands_size
    if total_size > MAX_PACKET_SIZE:
        return b''
    packet = bytearray(total_size)
    offset = 0
    struct.pack_into(PACKET_HEADER_FORMAT, packet, offset, PacketType.ACTUATOR_COMMAND, DIABLO_COMMS_VERSION, int(time.time() * 1000) & 0xFFFFFFFF)
    offset += PACKET_HEADER_SIZE
    struct.pack_into(ACTUATOR_COMMAND_PACKET_FORMAT, packet, offset, len(commands))
    offset += ACTUATOR_COMMAND_PACKET_SIZE
    for actuator_id, actuator_state in commands:
        struct.pack_into(ACTUATOR_COMMAND_FORMAT, packet, offset, actuator_id, actuator_state)
        offset += ACTUATOR_COMMAND_SIZE
    return bytes(packet)


def create_pwm_actuator_command_packet(commands: List[Tuple[int, int, float, float]]) -> bytes:
    """
    Creates a PWM Actuator Command packet.
    Packet layout: PacketHeader + PWMActuatorCommandPacket + N PWMActuatorCommand.
    
    commands: List of tuples (actuator_id, duration_ms, duty_cycle, frequency)
              Note: duration is in ms (uint32), duty_cycle is float (0.0-1.0), frequency is float (Hz)
    """
    if len(commands) == 0 or len(commands) > 255:
        return b''
        
    header_size = PACKET_HEADER_SIZE
    body_size = PWM_ACTUATOR_COMMAND_PACKET_SIZE
    commands_size = len(commands) * PWM_ACTUATOR_COMMAND_SIZE
    total_size = header_size + body_size + commands_size
    
    if total_size > MAX_PACKET_SIZE:
        return b''
        
    packet = bytearray(total_size)
    offset = 0
    
    # Header
    struct.pack_into(PACKET_HEADER_FORMAT, packet, offset, PacketType.PWM_ACTUATOR_COMMAND, DIABLO_COMMS_VERSION, int(time.time() * 1000) & 0xFFFFFFFF)
    offset += PACKET_HEADER_SIZE
    
    # Body (num_commands)
    struct.pack_into(PWM_ACTUATOR_COMMAND_PACKET_FORMAT, packet, offset, len(commands))
    offset += PWM_ACTUATOR_COMMAND_PACKET_SIZE
    
    # Commands
    for actuator_id, duration_ms, duty_cycle, frequency in commands:
        struct.pack_into(PWM_ACTUATOR_COMMAND_FORMAT, packet, offset, actuator_id, duration_ms, duty_cycle, frequency)
        offset += PWM_ACTUATOR_COMMAND_SIZE
        
    return bytes(packet)


# ---------------------- UDP Receiver ----------------------
class UDPReceiver(QtCore.QThread):
    sensor_data_received = QtCore.pyqtSignal(dict, list, str)
    status_update = QtCore.pyqtSignal(str)

    def __init__(self, port: int = DEFAULT_RECEIVE_PORT, bind_address: str = '0.0.0.0'):
        super().__init__()
        self.port = port
        self.bind_address = bind_address
        self._stop = False
        self.sock = None

    def stop(self):
        self._stop = True
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass

    def run(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.settimeout(0.1)
        try:
            self.sock.bind((self.bind_address, self.port))
            self.status_update.emit(f"Listening on {self.bind_address}:{self.port}")
        except OSError as e:
            self.status_update.emit(f"Error binding: {e}")
            return
        while not self._stop:
            try:
                data, addr = self.sock.recvfrom(MAX_PACKET_SIZE)
                header = parse_packet_header(data)
                if header is None:
                    continue
                packet_type, version, timestamp = header
                if packet_type == PacketType.SENSOR_DATA:
                    result = parse_sensor_data_packet(data)
                    if result:
                        header_dict, chunks = result
                        self.sensor_data_received.emit(header_dict, chunks, addr[0])
            except socket.timeout:
                continue
            except Exception as e:
                if not self._stop:
                    self.status_update.emit(f"Error: {e}")
                continue
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
        self.status_update.emit("Stopped")


# ---------------------- Full Plot Window ----------------------
class FullPlotWindow(QtWidgets.QMainWindow):
    """
    Full plot window with timing analysis for all open/close pairs.
    Displays per-pair metrics (including ΔP) and averages in a table.
    """

    def __init__(self, times: np.ndarray, pressures: np.ndarray, actuator_events: List[Tuple[float, str]], sensor_label: str):
        super().__init__()
        self.setWindowTitle(f"Full Plot & Timing Analysis - {sensor_label}")
        self.resize(1200, 800)

        self.times = np.asarray(times, dtype=float)
        self.pressures = np.asarray(pressures, dtype=float)
        self.actuator_events = list(actuator_events)
        self.sensor_label = sensor_label
        self.timing_results: List[Dict] = []

        self.widget = QtWidgets.QWidget()
        self.setCentralWidget(self.widget)
        layout = QtWidgets.QVBoxLayout(self.widget)
        layout.setContentsMargins(8, 8, 8, 8)

        # --- Toolbar ---
        toolbar = QtWidgets.QHBoxLayout()
        self.btn_reset = QtWidgets.QPushButton("Reset View")
        self.btn_reset.clicked.connect(self.on_reset_view)
        toolbar.addWidget(self.btn_reset)

        self.btn_mode = QtWidgets.QPushButton("Drag Mode: Pan")
        self.btn_mode.setCheckable(True)
        self.btn_mode.clicked.connect(self.on_toggle_mode)
        toolbar.addWidget(self.btn_mode)

        self.btn_save_csv = QtWidgets.QPushButton("Save CSV")
        self.btn_save_csv.clicked.connect(self.on_save_csv)
        toolbar.addWidget(self.btn_save_csv)
        
        toolbar.addStretch()
        layout.addLayout(toolbar)

        # --- Plot (top 65%) ---
        self.plot_widget = pg.PlotWidget(title=f"Pressure: {sensor_label}")
        self.plot_widget.setBackground('k')
        self.plot_widget.setLabel('left', 'Pressure (psi)')
        self.plot_widget.setLabel('bottom', 'Time (seconds)')
        self.plot_widget.showGrid(x=True, y=True, alpha=0.5)
        layout.addWidget(self.plot_widget, 65)

        # Plot pressure curve
        self.plot_widget.plot(self.times, self.pressures, pen=pg.mkPen((80, 150, 255), width=2), name="Pressure")

        # --- Results table (bottom 35%) ---
        self.table = QtWidgets.QTableWidget()
        self.table.setColumnCount(12)
        self.table.setHorizontalHeaderLabels([
            "Pair #", 
            "Open Cmd (s)", "Open Start (s)", "Open End (s)",
            "Close Cmd (s)", "Close Start (s)", "Close End (s)",
            "Open Delay dT (s)", "Open Full dT (s)", 
            "Close Delay dT (s)", "Close Full dT (s)",
            "Total dP (psi)"
        ])
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setEditTriggers(QtWidgets.QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        # Set explicit colors for readable alternating rows
        self.table.setStyleSheet("""
            QTableWidget {
                background-color: #1e1e1e;
                alternate-background-color: #2d2d2d;
                color: #ffffff;
                gridline-color: #444444;
            }
            QTableWidget::item {
                padding: 4px;
            }
            QHeaderView::section {
                background-color: #3c3c3c;
                color: #ffffff;
                padding: 4px;
                border: 1px solid #444444;
            }
        """)
        layout.addWidget(self.table, 35)

        # Crosshair for plot
        self.v_line = pg.InfiniteLine(angle=90, movable=False, pen=pg.mkPen('y', width=1, style=QtCore.Qt.PenStyle.DotLine))
        self.h_line = pg.InfiniteLine(angle=0, movable=False, pen=pg.mkPen('y', width=1, style=QtCore.Qt.PenStyle.DotLine))
        self.plot_widget.addItem(self.v_line, ignoreBounds=True)
        self.plot_widget.addItem(self.h_line, ignoreBounds=True)
        self.hover_label = pg.TextItem(text="", anchor=(0, 1), color='y')
        self.plot_widget.addItem(self.hover_label, ignoreBounds=True)
        # Reduce rateLimit to 20 to reduce cursor lag
        self.proxy = pg.SignalProxy(self.plot_widget.scene().sigMouseMoved, rateLimit=20, slot=self._mouse_moved)

        # Run analysis and populate UI
        self._run_analysis()
        self._draw_event_lines()
        self._populate_table()

    def on_reset_view(self):
        self.plot_widget.plotItem.autoRange()

    def on_toggle_mode(self):
        # If checked -> Rect Mode (Zoom), else Pan Mode
        if self.btn_mode.isChecked():
            self.btn_mode.setText("Drag Mode: Zoom Box")
            self.plot_widget.plotItem.getViewBox().setMouseMode(pg.ViewBox.RectMode)
        else:
            self.btn_mode.setText("Drag Mode: Pan")
            self.plot_widget.plotItem.getViewBox().setMouseMode(pg.ViewBox.PanMode)

    def _pair_events(self) -> List[Tuple[float, float]]:
        """Pair each OPEN with the immediately following CLOSE."""
        sorted_events = sorted(self.actuator_events, key=lambda x: x[0])
        pairs = []
        i = 0
        while i < len(sorted_events):
            t_open, kind = sorted_events[i]
            if kind == "open":
                # Find next close
                for j in range(i + 1, len(sorted_events)):
                    if sorted_events[j][1] == "closed":
                        pairs.append((t_open, sorted_events[j][0]))
                        i = j  # Skip to after this close
                        break
            i += 1
        return pairs

    def _run_analysis(self):
        """Run timing analysis on all open/close pairs."""
        pairs = self._pair_events()
        for t_open, t_close in pairs:
            try:
                result = extract_solenoid_timing_live(self.times, self.pressures, t_open, t_close)
                # Compute deltaP
                P_open_pre = result.get("P_open_pre")
                P_open_post = result.get("P_open_post")
                P_close_pre = result.get("P_close_pre")
                P_close_post = result.get("P_close_post")
                result["delta_P_open"] = (P_open_pre - P_open_post) if (P_open_pre is not None and P_open_post is not None) else None
                result["delta_P_close"] = (P_close_post - P_close_pre) if (P_close_post is not None and P_close_pre is not None) else None
                result["total_dP"] = (P_open_pre - P_close_post) if (P_open_pre is not None and P_close_post is not None) else None
                self.timing_results.append(result)
            except ValueError:
                # Skip pairs that fail analysis (e.g., not enough data)
                pass

    def _draw_event_lines(self):
        """Draw vertical lines for command events and detected timing events."""
        # Command lines (OPEN = green dashed, CLOSED = red dashed)
        for t, kind in self.actuator_events:
            color = (80, 255, 80) if kind == "open" else (255, 80, 80)
            pen = pg.mkPen(color=color, width=1.5, style=QtCore.Qt.PenStyle.DashLine)
            line = pg.InfiniteLine(pos=t, angle=90, pen=pen, movable=False)
            self.plot_widget.addItem(line)

        # Detected timing lines for each pair
        # Open Start/End = Cyan (dash/solid), Close Start/End = Magenta (dash/solid)
        for result in self.timing_results:
            lines_def = [
                (result.get("t_open_start"), (0, 255, 255), QtCore.Qt.PenStyle.DashLine),
                (result.get("t_open_end"), (0, 255, 255), QtCore.Qt.PenStyle.SolidLine),
                (result.get("t_close_start"), (255, 0, 255), QtCore.Qt.PenStyle.DashLine),
                (result.get("t_close_end"), (255, 0, 255), QtCore.Qt.PenStyle.SolidLine),
            ]
            for t_val, color, style in lines_def:
                if t_val is not None:
                    pen = pg.mkPen(color=color, width=1.5, style=style)
                    line = pg.InfiniteLine(pos=t_val, angle=90, pen=pen, movable=False)
                    self.plot_widget.addItem(line)

    def _populate_table(self):
        """Populate table with per-pair results and averages."""
        def _fmt(val, decimals=4):
            return f"{val:.{decimals}f}" if val is not None else "N/A"

        num_pairs = len(self.timing_results)
        self.table.setRowCount(num_pairs + 1)  # +1 for averages row

        # Per-pair rows
        for i, result in enumerate(self.timing_results):
            self.table.setItem(i, 0, QtWidgets.QTableWidgetItem(str(i + 1)))
            # Timestamps
            self.table.setItem(i, 1, QtWidgets.QTableWidgetItem(_fmt(result.get("t_open_cmd"))))
            self.table.setItem(i, 2, QtWidgets.QTableWidgetItem(_fmt(result.get("t_open_start"))))
            self.table.setItem(i, 3, QtWidgets.QTableWidgetItem(_fmt(result.get("t_open_end"))))
            self.table.setItem(i, 4, QtWidgets.QTableWidgetItem(_fmt(result.get("t_close_cmd"))))
            self.table.setItem(i, 5, QtWidgets.QTableWidgetItem(_fmt(result.get("t_close_start"))))
            self.table.setItem(i, 6, QtWidgets.QTableWidgetItem(_fmt(result.get("t_close_end"))))
            # Delays & dP
            self.table.setItem(i, 7, QtWidgets.QTableWidgetItem(_fmt(result.get("open_delay"))))
            self.table.setItem(i, 8, QtWidgets.QTableWidgetItem(_fmt(result.get("open_time"))))
            self.table.setItem(i, 9, QtWidgets.QTableWidgetItem(_fmt(result.get("close_delay"))))
            self.table.setItem(i, 10, QtWidgets.QTableWidgetItem(_fmt(result.get("close_time"))))
            self.table.setItem(i, 11, QtWidgets.QTableWidgetItem(_fmt(result.get("total_dP"), 2)))

        # Averages row
        def _avg(key):
            vals = [r.get(key) for r in self.timing_results if r.get(key) is not None]
            return sum(vals) / len(vals) if vals else None

        avg_row = num_pairs
        avg_label = QtWidgets.QTableWidgetItem("AVG")
        avg_label.setFont(QtGui.QFont("", -1, QtGui.QFont.Weight.Bold))
        self.table.setItem(avg_row, 0, avg_label)
        # Skip averaging absolute timestamps (cols 1-6)
        for c in range(1, 7):
            self.table.setItem(avg_row, c, QtWidgets.QTableWidgetItem(""))
            
        self.table.setItem(avg_row, 7, QtWidgets.QTableWidgetItem(_fmt(_avg("open_delay"))))
        self.table.setItem(avg_row, 8, QtWidgets.QTableWidgetItem(_fmt(_avg("open_time"))))
        self.table.setItem(avg_row, 9, QtWidgets.QTableWidgetItem(_fmt(_avg("close_delay"))))
        self.table.setItem(avg_row, 10, QtWidgets.QTableWidgetItem(_fmt(_avg("close_time"))))
        self.table.setItem(avg_row, 11, QtWidgets.QTableWidgetItem(_fmt(_avg("total_dP"), 2)))

        # Bold the averages row and set distinct background color for readability
        avg_bg = QtGui.QColor(40, 60, 80)  # Dark blue-gray
        avg_fg = QtGui.QColor(255, 255, 255)  # White text
        for col in range(12):
            item = self.table.item(avg_row, col)
            if item:
                font = item.font()
                font.setBold(True)
                item.setFont(font)
                item.setBackground(avg_bg)
                item.setForeground(avg_fg)

        self.table.resizeColumnsToContents()

    def on_save_csv(self):
        """Save pressure data, actuator events, and timing results to CSV."""
        default_name = f"solenoid_char_{self.sensor_label.replace(' ', '_')}_{time.strftime('%Y%m%d_%H%M%S')}.csv"
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Save characterization CSV",
            default_name,
            "CSV (*.csv);;All files (*)",
        )
        if not path:
            return
        try:
            # Build timing event map from analysis results
            timing_map = {}  # t -> "EVENT_NAME"
            for result in self.timing_results:
                for key in ["t_open_start", "t_open_end", "t_close_start", "t_close_end"]:
                    val = result.get(key)
                    if val is not None:
                        # Find closest timestamp in data
                        idx = (np.abs(self.times - val)).argmin()
                        closest_t = self.times[idx]
                        if abs(closest_t - val) < 0.05:  # 50ms tolerance
                            timing_map[closest_t] = key.upper()

            # Build actuator event map
            event_at_t = {t: ("OPEN" if k == "open" else "CLOSED") for t, k in self.actuator_events}

            # Build rows
            rows = []
            for i, t in enumerate(self.times):
                psi = self.pressures[i]
                act = event_at_t.get(t, "")
                timing = timing_map.get(t, "")
                rows.append((t, f"{psi:.4f}", act, timing))

            # Add command events if their times don't match samples exactly
            existing_ts = set(self.times)
            for t, kind in self.actuator_events:
                if not any(abs(t - et) < 1e-9 for et in existing_ts):
                    rows.append((t, "", "OPEN" if kind == "open" else "CLOSED", ""))

            rows.sort(key=lambda r: r[0])

            with open(path, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["time_sec", "pressure_psi", "ACTUATION", "TIMING_EVENT"])
                for t, psi, act, timing in rows:
                    w.writerow([f"{t:.6f}", psi, act, timing])
            QtWidgets.QMessageBox.information(self, "Save CSV", f"Saved to {path}")
        except OSError as e:
            QtWidgets.QMessageBox.critical(self, "Save CSV", f"Error saving file: {e}")

    def _mouse_moved(self, evt):
        pos = evt[0]
        if self.plot_widget.sceneBoundingRect().contains(pos):
            mouse_point = self.plot_widget.plotItem.vb.mapSceneToView(pos)
            self.v_line.setPos(mouse_point.x())
            self.h_line.setPos(mouse_point.y())
            self.hover_label.setText(f"t={mouse_point.x():.4f}, P={mouse_point.y():.2f}")
            self.hover_label.setPos(mouse_point.x(), mouse_point.y())


# ---------------------- Main Window ----------------------
class SolenoidCharacterizationWindow(QtWidgets.QMainWindow):
    """Single window: PT selector, actuator selector, one pressure graph, OPEN/CLOSED buttons, vertical event lines."""

    def __init__(self, receiver: UDPReceiver, device_ip: str, device_port: int, bind_address: str = '0.0.0.0'):
        super().__init__()
        self.setWindowTitle("Solenoid Characterization")
        self.receiver = receiver
        self.device_ip = device_ip
        self.device_port = device_port
        self.bind_address = bind_address

        self.stats_start_time = time.time()
        self.sensor_data: Dict[int, deque] = {}
        self.sensor_adc_codes: Dict[int, deque] = {}
        self.sensor_psi_data: Dict[int, deque] = {}
        self.filter_source_ip = CONFIG.config["network"]["sensor_ip_filter"]
        self.adc_bits = CONFIG.config["display"]["adc_bits"]
        self.reference_voltage = CONFIG.config["display"]["ref_voltage"]
        # Sliding window: 10–120 s (slider updates this)
        config_window = CONFIG.config["display"].get("window_seconds", DEFAULT_WINDOW_SECONDS)
        self.window_seconds = max(10.0, min(120.0, float(config_window)))
        self.y_axis_auto_scale = CONFIG.config["display"].get("y_axis_autoscale", True)
        self.y_axis_min = float(CONFIG.config["display"].get("y_axis_min", 0.0))
        self.y_axis_max = float(CONFIG.config["display"].get("y_axis_max", 700.0))

        base = Path(__file__).parent
        paths = CONFIG.get_pt_calibration_csv_paths()
        resolved = [str(base / p) for p in paths] if paths else []
        self.pt_calibration, self.pt_calibration_error = load_pt_calibration(resolved if resolved else [])
        if self.pt_calibration_error:
            print(f"PT Calibration Error: {self.pt_calibration_error}")

        self.actuator_events: List[Tuple[float, str]] = []  # (t_sec, "open"|"closed")
        self.event_lines: List[pg.InfiniteLine] = []
        
        # Board Sync state
        self.board_t0_ms: Optional[int] = None
        # (board_accum_ms, wall_time_sec) for the latest received packet
        self.last_sync_params: Optional[Tuple[float, float]] = None

        self.command_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        self.init_ui()

        self.receiver.sensor_data_received.connect(self.on_sensor_data)
        self.receiver.status_update.connect(self.on_status_update)

        self.update_timer = QtCore.QTimer(self)
        self.update_timer.timeout.connect(self.update_plot)
        self.update_timer.start(UPDATE_INTERVAL_MS)

        self.paused = False
        self.full_plot_window = None  # Keep reference to prevent GC

    def init_ui(self):
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        main_h = QtWidgets.QHBoxLayout(central)
        main_h.setContentsMargins(4, 4, 4, 4)
        main_h.setSpacing(8)

        # Left side: 70% — existing controls + plot + buttons
        left_widget = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(left_widget)
        layout.setContentsMargins(0, 0, 0, 0)

        top = QtWidgets.QHBoxLayout()
        top.addWidget(QtWidgets.QLabel("PT:"))
        self.pt_combo = QtWidgets.QComboBox()
        self._fill_pt_combo()
        self.pt_combo.currentIndexChanged.connect(self._on_pt_changed)
        top.addWidget(self.pt_combo)

        top.addWidget(QtWidgets.QLabel("Actuator:"))
        self.actuator_combo = QtWidgets.QComboBox()
        for name in CONFIG.get_actuator_role_names():
            aid = CONFIG.get_actuator_role(name)
            if aid and 1 <= aid <= NUM_ACTUATORS:
                label = CONFIG.get_actuator_label(aid) or name
                self.actuator_combo.addItem(f"{label} (ID {aid})", aid)
        if self.actuator_combo.count() == 0:
            for aid in range(1, NUM_ACTUATORS + 1):
                self.actuator_combo.addItem(f"Actuator {aid}", aid)
        
        # Default to Actuator 7 if present
        idx_7 = self.actuator_combo.findData(7)
        if idx_7 >= 0:
            self.actuator_combo.setCurrentIndex(idx_7)
            
        self.actuator_combo.currentIndexChanged.connect(self._on_actuator_changed)
        top.addWidget(self.actuator_combo)

        top.addWidget(QtWidgets.QLabel("Receive IP:"))
        self.receive_ip_edit = QtWidgets.QLineEdit(self.filter_source_ip)
        self.receive_ip_edit.setFixedWidth(120)
        self.receive_ip_edit.setToolTip("IP address to accept sensor data from")
        self.receive_ip_edit.editingFinished.connect(self._on_receive_ip_changed)
        top.addWidget(self.receive_ip_edit)

        top.addWidget(QtWidgets.QLabel("Send IP:"))
        self.send_ip_edit = QtWidgets.QLineEdit(self.device_ip)
        self.send_ip_edit.setFixedWidth(120)
        self.send_ip_edit.setToolTip("IP address to send actuator commands to")
        self.send_ip_edit.editingFinished.connect(self._on_send_ip_changed)
        top.addWidget(self.send_ip_edit)

        self.status_label = QtWidgets.QLabel("Starting...")
        self.status_label.setStyleSheet("font-weight: bold; padding: 5px;")
        top.addWidget(self.status_label)
        top.addWidget(QtWidgets.QLabel("Selected PT rate:"))
        self.pt_sample_rate_label = QtWidgets.QLabel("-- Hz")
        self.pt_sample_rate_label.setStyleSheet("font-family: monospace; min-width: 90px;")
        top.addWidget(self.pt_sample_rate_label)
        top.addStretch()
        layout.addLayout(top)

        # Window size slider (10–120 s)
        window_row = QtWidgets.QHBoxLayout()
        window_row.addWidget(QtWidgets.QLabel("Window:"))
        self.window_slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.window_slider.setMinimum(10)
        self.window_slider.setMaximum(120)
        self.window_slider.setValue(int(self.window_seconds))
        self.window_slider.setTickPosition(QtWidgets.QSlider.TickPosition.TicksBelow)
        self.window_slider.setTickInterval(10)
        self.window_slider.valueChanged.connect(self._on_window_slider_changed)
        window_row.addWidget(self.window_slider, 1)
        self.window_label = QtWidgets.QLabel(f"{int(self.window_seconds)} s")
        self.window_label.setMinimumWidth(40)
        window_row.addWidget(self.window_label)
        layout.addLayout(window_row)

        self.plot_widget = pg.GraphicsLayoutWidget()
        self.plot_widget.setBackground('k')
        layout.addWidget(self.plot_widget, 1)

        self.plot_item = self.plot_widget.addPlot(title="Pressure (selected PT)")
        self.plot_item.setTitle("Pressure (selected PT)", color='w', size='14pt')
        self.plot_item.setLabel('left', 'Pressure (psi)', color='w')
        self.plot_item.setLabel('bottom', 'Time (seconds)', color='w')
        self.plot_item.showGrid(x=True, y=True, alpha=0.5)
        self.plot_item.getViewBox().setBackgroundColor('k')
        font = QtGui.QFont()
        font.setPointSize(12)
        for axis_name in ('left', 'bottom'):
            ax = self.plot_item.getAxis(axis_name)
            ax.setStyle(tickFont=font)
            ax.setPen(pg.mkPen('w', width=0.5))
            ax.setTextPen('w')
        try:
            self.plot_item.getAxis('left').label.setFont(font)
            self.plot_item.getAxis('bottom').label.setFont(font)
        except AttributeError:
            pass

        self.pt_curve = self.plot_item.plot([], [], pen=pg.mkPen((80, 150, 255), width=2), name="PT (psi)")

        # Live PT readout (top-right of plot, in data coordinates)
        self.pt_readout = pg.TextItem(text="", anchor=(1, 1), color=(200, 220, 255))
        self.pt_readout.setFont(QtGui.QFont("Monospace", 14, QtGui.QFont.Weight.Bold))
        self.plot_item.addItem(self.pt_readout)

        btn_row = QtWidgets.QHBoxLayout()
        self.save_csv_btn = QtWidgets.QPushButton("Save CSV")
        self.save_csv_btn.setMinimumHeight(40)
        self.save_csv_btn.clicked.connect(self.save_characterization_csv)
        btn_row.addWidget(self.save_csv_btn)
        self.open_btn = QtWidgets.QPushButton("OPEN")
        self.open_btn.setMinimumHeight(40)
        self.open_btn.clicked.connect(self.on_open_clicked)
        self.closed_btn = QtWidgets.QPushButton("CLOSED")
        self.closed_btn.setMinimumHeight(40)
        self.closed_btn.clicked.connect(self.on_closed_clicked)
        btn_row.addWidget(self.open_btn)
        btn_row.addWidget(self.closed_btn)
        
        self.full_plot_btn = QtWidgets.QPushButton("Full Plot")
        self.full_plot_btn.setMinimumHeight(40)
        self.full_plot_btn.clicked.connect(self.on_full_plot_clicked)
        btn_row.addWidget(self.full_plot_btn)

        self.pause_btn = QtWidgets.QPushButton("Pause")
        self.pause_btn.setMinimumHeight(40)
        self.pause_btn.setCheckable(True)
        self.pause_btn.clicked.connect(self.on_pause_clicked)
        btn_row.addWidget(self.pause_btn)

        btn_row.addStretch()

        # PWM actuation
        pwm_label = QtWidgets.QLabel("PWM:")
        pwm_label.setStyleSheet("font-weight: bold;")
        btn_row.addWidget(pwm_label)
        btn_row.addWidget(QtWidgets.QLabel("Duty %"))
        self.pwm_duty_spin = QtWidgets.QDoubleSpinBox()
        self.pwm_duty_spin.setRange(0, 100)
        self.pwm_duty_spin.setValue(50)
        self.pwm_duty_spin.setDecimals(1)
        self.pwm_duty_spin.setSuffix(" %")
        self.pwm_duty_spin.setMinimumHeight(32)
        btn_row.addWidget(self.pwm_duty_spin)
        btn_row.addWidget(QtWidgets.QLabel("Freq (Hz)"))
        self.pwm_freq_spin = QtWidgets.QDoubleSpinBox()
        self.pwm_freq_spin.setRange(0.1, 1000000.0)
        self.pwm_freq_spin.setValue(10)
        self.pwm_freq_spin.setDecimals(1)
        self.pwm_freq_spin.setMinimumHeight(32)
        btn_row.addWidget(self.pwm_freq_spin)
        btn_row.addWidget(QtWidgets.QLabel("Duration (s)"))
        self.pwm_duration_spin = QtWidgets.QDoubleSpinBox()
        self.pwm_duration_spin.setRange(0.1, 3600)
        self.pwm_duration_spin.setValue(2.0)
        self.pwm_duration_spin.setDecimals(2)
        self.pwm_duration_spin.setMinimumHeight(32)
        btn_row.addWidget(self.pwm_duration_spin)
        self.pwm_go_btn = QtWidgets.QPushButton("Go")
        self.pwm_go_btn.setMinimumHeight(40)
        self.pwm_go_btn.clicked.connect(self.on_pwm_go_clicked)
        btn_row.addWidget(self.pwm_go_btn)

        layout.addLayout(btn_row)

        main_h.addWidget(left_widget)

    def _fill_pt_combo(self):
        self.pt_combo.clear()
        for pt_id in sorted(self.pt_calibration.keys()):
            label = CONFIG.get_sensor_label(pt_id) or ""
            if label:
                self.pt_combo.addItem(f"{label} (PT {pt_id})", pt_id)
            else:
                self.pt_combo.addItem(f"PT {pt_id}", pt_id)
        if self.pt_combo.count() == 0:
            for pt_id in range(1, NUM_CONNECTORS + 1):
                self.pt_combo.addItem(f"PT {pt_id}", pt_id)

    def _on_pt_changed(self, index: int):
        self.update_plot()

    def _on_actuator_changed(self, index: int):
        pass

    def _on_receive_ip_changed(self):
        new_ip = self.receive_ip_edit.text().strip()
        if new_ip and new_ip != self.filter_source_ip:
            self.filter_source_ip = new_ip
            self.status_label.setText(f"Receive IP → {new_ip}")

    def _on_send_ip_changed(self):
        new_ip = self.send_ip_edit.text().strip()
        if new_ip and new_ip != self.device_ip:
            self.device_ip = new_ip
            self.status_label.setText(f"Send IP → {new_ip}")

    def _on_window_slider_changed(self, value: int):
        self.window_seconds = float(value)
        self.window_label.setText(f"{value} s")

    def save_characterization_csv(self):
        """Save the selected PT pressure and solenoid actuations as one 4-column CSV: time_sec, pressure_psi, ACTUATION, TIMING_EVENT."""
        pt_id = self.get_selected_pt_id()
        if pt_id is None:
            QtWidgets.QMessageBox.warning(self, "Save CSV", "No PT selected.")
            return
        default_name = f"solenoid_char_pt{pt_id}_{time.strftime('%Y%m%d_%H%M%S')}.csv"
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Save characterization CSV",
            default_name,
            "CSV (*.csv);;All files (*)",
        )
        if not path:
            return
        try:
            pressure_data = list(self.sensor_psi_data[pt_id]) if pt_id in self.sensor_psi_data else []
            if not pressure_data:
                QtWidgets.QMessageBox.warning(self, "Save CSV", "No pressure data to save.")
                return

            # Analyze timing events for all pairs
            t_all = np.array([x[0] for x in pressure_data])
            P_all = np.array([x[1] for x in pressure_data])
            timing_map = {}  # t -> "EVENT_NAME"

            sorted_events = sorted(self.actuator_events, key=lambda x: x[0])
            # Find pairs of OPEN -> CLOSED
            # Find pairs of OPEN -> CLOSED
            processed_indices = set()
            for i in range(len(sorted_events)):
                if i in processed_indices:
                    continue
                
                t_open, kind = sorted_events[i]
                if kind == "open":
                    # Find next closed
                    t_close = None
                    close_idx = -1
                    for j in range(i + 1, len(sorted_events)):
                        if sorted_events[j][1] == "closed":
                            t_close = sorted_events[j][0]
                            close_idx = j
                            break
                    
                    if t_close:
                        # Mark close as processed so we don't use it again (though finding OPEN skips it anyway)
                        processed_indices.add(close_idx)
                        
                        try:
                            # Run detection on full data window
                            res = extract_solenoid_timing_live(t_all, P_all, t_open, t_close)
                            # Map results to closest samples
                            for key in ["t_open_start", "t_open_end", "t_close_start", "t_close_end"]:
                                val = res.get(key)
                                if val is not None:
                                    # Find closest timestamp in data
                                    idx = (np.abs(t_all - val)).argmin()
                                    closest_t = t_all[idx]
                                    # Use a small tolerance to ensure we map to the right sample
                                    if abs(closest_t - val) < 0.05: # 50ms tolerance
                                        timing_map[closest_t] = key.upper()
                        except ValueError:
                            pass

            # Build merged rows: (time_sec, pressure_psi, ACTUATION, TIMING_EVENT)
            rows = []
            event_at_t = {t: ("OPEN" if k == "open" else "CLOSED") for t, k in self.actuator_events}
            
            for t, psi in pressure_data:
                act = event_at_t.get(t, "")
                timing = timing_map.get(t, "")
                rows.append((t, f"{psi:.4f}", act, timing))
            
            # Ensure command events are included if exact timestamps didn't align with samples
            # (Though map above handles existing pressure samples, commands are from different source)
            # Insert logic similar to original to ensure commands are present
            # But here we focus on adding content to existing pressure rows mostly.
            # If command time is distinct, we insert a new row.
            
            # Copy existing rows to check against
            existing_ts = set(r[0] for r in rows)
            
            for t, kind in self.actuator_events:
                 if not any(abs(t - et) < 1e-9 for et in existing_ts):
                    rows.append((t, "", "OPEN" if kind == "open" else "CLOSED", ""))
            
            rows.sort(key=lambda r: r[0])
            
            with open(path, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["time_sec", "pressure_psi", "ACTUATION", "TIMING_EVENT"])
                for t, psi, act, timing in rows:
                    w.writerow([f"{t:.6f}", psi, act, timing])
            QtWidgets.QMessageBox.information(self, "Save CSV", f"Saved to {path}")
        except OSError as e:
            QtWidgets.QMessageBox.critical(self, "Save CSV", f"Error saving file: {e}")

    def get_selected_pt_id(self) -> Optional[int]:
        if self.pt_combo.count() == 0:
            return None
        return self.pt_combo.currentData()

    def get_selected_actuator_id(self) -> Optional[int]:
        if self.actuator_combo.count() == 0:
            return None
        return self.actuator_combo.currentData()

    def code_to_voltage(self, code_uint32: int) -> float:
        code_int32 = code_uint32 if code_uint32 < 2**31 else code_uint32 - 2**32
        max_code = 2 ** (self.adc_bits - 1)
        return (code_int32 * self.reference_voltage) / max_code

    def get_current_board_time(self) -> float:
        """Estimate current board time (in seconds relative to board_t0) using last sync."""
        if self.board_t0_ms is None or self.last_sync_params is None:
            # Fallback if no data yet: just use wall clock relative to start
            return time.time() - self.stats_start_time
        
        last_board_ms, last_wall_sec = self.last_sync_params
        now_wall = time.time()
        elapsed_sec = now_wall - last_wall_sec
        # Estimate: board time has advanced by same amount as wall time since last packet
        current_board_ms = last_board_ms + (elapsed_sec * 1000.0)
        return (current_board_ms - self.board_t0_ms) / 1000.0

    def on_status_update(self, message: str):
        self.status_label.setText(message)

    def on_sensor_data(self, header: dict, chunks: List[dict], source_ip: str):
        if source_ip != self.filter_source_ip:
            return
        
        dt_sec = 1.0 / SAMPLE_RATE_HZ
        arrival_wall_time = time.time()

        for chunk in chunks:
            chunk_ts_ms = chunk["timestamp"]
            if self.board_t0_ms is None:
                self.board_t0_ms = chunk_ts_ms
            
            # Base time for this chunk in plot seconds (relative to first packet)
            # Timestamp corresponds to START of chunk (based on firmware logic)
            chunk_base_sec = (chunk_ts_ms - self.board_t0_ms) / 1000.0
            
            # Identify the latest sample time in this chunk for sync update
            last_sample_ms = chunk_ts_ms + (len(chunk["datapoints"]) - 1) * dt_sec * 1000.0

            for i, dp in enumerate(chunk["datapoints"]):
                # Sample time based entirely on board crystal (timestamp + index)
                sample_time = chunk_base_sec + i * dt_sec
                
                sensor_id = dp["sensor_id"]
                if sensor_id not in self.sensor_data:
                    self.sensor_data[sensor_id] = deque(maxlen=MAX_POINTS)
                    self.sensor_adc_codes[sensor_id] = deque(maxlen=MAX_POINTS)
                    if sensor_id in self.pt_calibration:
                        self.sensor_psi_data[sensor_id] = deque(maxlen=MAX_POINTS)
                
                # Enforce monotonicity in case of timestamp jitter/resets (though rare with millis)
                deq = self.sensor_data[sensor_id]
                if len(deq) > 0 and sample_time <= deq[-1][0]:
                     sample_time = deq[-1][0] + dt_sec

                code_uint32 = dp["data"]
                voltage = self.code_to_voltage(code_uint32)
                self.sensor_data[sensor_id].append((sample_time, voltage))
                self.sensor_adc_codes[sensor_id].append((sample_time, code_uint32))
                if sensor_id in self.pt_calibration:
                    a, b, c, d = self.pt_calibration[sensor_id]
                    psi = calculate_pressure(code_uint32, a, b, c, d)
                    self.sensor_psi_data[sensor_id].append((sample_time, psi))
            
            # Update sync params with the effective board time of the last processed sample
            # and the current wall time.
            self.last_sync_params = (last_sample_ms, arrival_wall_time)

    def _send_actuator_command(self, actuator_id: int, hardware_command: int):
        try:
            packet = create_actuator_command_packet([(actuator_id, hardware_command)])
            if packet:
                self.command_sock.sendto(packet, (self.device_ip, self.device_port))
        except OSError as e:
            print(f"Error sending command: {e}")

    def _add_event_line(self, t_sec: float, kind: str):
        self.actuator_events.append((t_sec, kind))
        if kind == "open":
            pen = pg.mkPen(color=(80, 255, 80), width=1.5, style=QtCore.Qt.PenStyle.DashLine)
        else:
            pen = pg.mkPen(color=(255, 80, 80), width=1.5, style=QtCore.Qt.PenStyle.DashLine)
        line = pg.InfiniteLine(pos=t_sec, angle=90, pen=pen, movable=False)
        self.plot_item.addItem(line)
        self.event_lines.append(line)

    def on_open_clicked(self):
        aid = self.get_selected_actuator_id()
        if not aid:
            return
        # Use estimated board time for event
        t_sec = self.get_current_board_time()
        actuator_type = CONFIG.get_actuator_type_by_id(aid)
        if actuator_type == 'NO':
            hardware_command = 0
        else:
            hardware_command = 1
        self._send_actuator_command(aid, hardware_command)
        self._add_event_line(t_sec, "open")

    def on_closed_clicked(self):
        aid = self.get_selected_actuator_id()
        if not aid:
            return
        # Use estimated board time for event
        t_sec = self.get_current_board_time()
        actuator_type = CONFIG.get_actuator_type_by_id(aid)
        if actuator_type == 'NO':
            hardware_command = 1
        else:
            hardware_command = 0
        self._send_actuator_command(aid, hardware_command)
        self._add_event_line(t_sec, "closed")

    def on_full_plot_clicked(self):
        # Auto-pause when opening analysis
        if not self.paused:
            self.pause_btn.click()

        pt_id = self.get_selected_pt_id()
        if pt_id is None or pt_id not in self.sensor_psi_data:
            QtWidgets.QMessageBox.warning(self, "Full Plot", "No data to plot.")
            return
            
        psi_deque = self.sensor_psi_data[pt_id]
        if not psi_deque:
            QtWidgets.QMessageBox.warning(self, "Full Plot", "No data to plot.")
            return
            
        times = np.array([t for t, _ in psi_deque])
        pressures = np.array([p for _, p in psi_deque])
        
        # Filter actuator events to those within the data range (or all if we want context, 
        # but the prompt implied "our test", maybe just current buffer is fine)
        # We'll pass all current events.
        
        label = CONFIG.get_sensor_label(pt_id) or f"PT {pt_id}"
        
        self.full_plot_window = FullPlotWindow(
            times, 
            pressures, 
            list(self.actuator_events), 
            label
        )
        self.full_plot_window.show()

    def on_pwm_go_clicked(self):
        aid = self.get_selected_actuator_id()
        if not aid:
            QtWidgets.QMessageBox.warning(self, "PWM", "Select an actuator first.")
            return
            
        duty = self.pwm_duty_spin.value() / 100.0
        freq = self.pwm_freq_spin.value()
        duration_s = self.pwm_duration_spin.value()
        
        if freq <= 0 or duration_s <= 0:
            QtWidgets.QMessageBox.warning(self, "PWM", "Frequency and duration must be positive.")
            return

        # Create and send PWM packet
        duration_ms = int(duration_s * 1000)
        # commands: List of tuples (actuator_id, duration_ms, duty_cycle, frequency)
        commands = [(aid, duration_ms, duty, freq)]
        
        try:
            packet = create_pwm_actuator_command_packet(commands)
            if packet:
                self.command_sock.sendto(packet, (self.device_ip, self.device_port))
                self.status_label.setText(f"Sent PWM: ID={aid} {duration_s}s @ {freq}Hz {duty*100:.1f}%")
                
                # Add event lines for visualization
                # "Open" line at start
                t_start = self.get_current_board_time()
                self._add_event_line(t_start, "open")
                
                # "Closed" line at end (estimated)
                t_end = t_start + duration_s
                self._add_event_line(t_end, "closed")
                
        except OSError as e:
            self.status_label.setText(f"Error sending PWM: {e}")
            print(f"Error sending PWM command: {e}")

    def on_pause_clicked(self):
        self.paused = self.pause_btn.isChecked()
        self.pause_btn.setText("Resume" if self.paused else "Pause")

    def update_plot(self):
        if self.paused:
            return

        current_time = time.time() - self.stats_start_time
        time_window = self.window_seconds
        window_start = current_time - time_window

        # Trim event lines and events that have left the sliding window (keeps view and memory bounded)
        while self.actuator_events and self.event_lines and self.actuator_events[0][0] < window_start:
            self.actuator_events.pop(0)
            line = self.event_lines.pop(0)
            self.plot_item.removeItem(line)

        pt_id = self.get_selected_pt_id()
        if pt_id is None or pt_id not in self.sensor_psi_data:
            chan = (CONFIG.get_sensor_label(pt_id) or f"PT {pt_id}") if pt_id is not None else ""
            self.pt_sample_rate_label.setText(f"{chan}: -- Hz".strip(": ") if chan else "-- Hz")
            self.pt_curve.setData([], [])
            self.pt_readout.setText("")
            self.plot_item.setXRange(window_start, current_time, padding=0.02)

            return
        psi_deque = self.sensor_psi_data[pt_id]
        if len(psi_deque) == 0:
            pt_label_empty = CONFIG.get_sensor_label(pt_id) or f"PT {pt_id}"
            self.pt_sample_rate_label.setText(f"{pt_label_empty}: -- Hz")
            self.pt_curve.setData([], [])
            self.pt_readout.setText("")
            self.plot_item.setXRange(window_start, current_time, padding=0.02)

            return
        # PT sample rate for selected channel: count samples with receive-time in last 1 s
        # (Each (t, psi) is one PT sample; t is relative receive time. So count = samples/sec.)
        one_sec_ago = current_time - 1.0
        pt_sample_count = sum(1 for t, _ in psi_deque if t >= one_sec_ago)
        pt_label = CONFIG.get_sensor_label(pt_id) or f"PT {pt_id}"
        self.pt_sample_rate_label.setText(f"{pt_label}: {pt_sample_count} Hz")
        times = []
        psi_values = []
        for t, psi in psi_deque:
            if t >= window_start:
                times.append(t)
                psi_values.append(psi)
        if times:
            times_array = np.array(times)
            psi_array = np.array(psi_values)
            self.pt_curve.setData(times_array, psi_array)
            # Latest PT value readout (top-right)
            latest_psi = float(psi_values[-1])
            self.pt_readout.setText(f"{latest_psi:.1f} psi")
            self.pt_readout.setPos(current_time, float(np.max(psi_array)))
            self.plot_item.setXRange(window_start, current_time, padding=0.02)
            if self.y_axis_auto_scale and len(psi_array) > 0:
                y_min = float(np.min(psi_array))
                y_max = float(np.max(psi_array))
                margin = (y_max - y_min) * 0.05 + 1.0
                self.plot_item.setYRange(y_min - margin, y_max + margin, padding=0)
            else:
                self.plot_item.setYRange(self.y_axis_min, self.y_axis_max, padding=0)
        else:
            self.pt_curve.setData([], [])
            self.pt_readout.setText("")
            self.plot_item.setXRange(window_start, current_time, padding=0.02)


    def closeEvent(self, event):
        if self.command_sock:
            try:
                self.command_sock.close()
            except Exception:
                pass
        event.accept()


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Solenoid Characterization GUI')
    parser.add_argument('-i', '--ip', type=str, default=CONFIG.config["network"]["actuator_ip"], help='Actuator board IP')
    parser.add_argument('-p', '--port', type=int, default=CONFIG.config["network"]["receive_port"], help='UDP receive port')
    parser.add_argument('-d', '--device-port', type=int, default=CONFIG.config["network"]["actuator_port"], help='Actuator command port')
    parser.add_argument('-a', '--address', type=str, default='0.0.0.0', help='Bind address for receiver')
    args = parser.parse_args()

    app = QtWidgets.QApplication(sys.argv)
    app.setStyle("Fusion")
    palette = QtGui.QPalette()
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Window, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.WindowText, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Base, QtGui.QColor(25, 25, 25))
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Text, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Button, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.ButtonText, QtCore.Qt.GlobalColor.white)
    app.setPalette(palette)

    receiver = UDPReceiver(port=args.port, bind_address=args.address)
    receiver.start()

    window = SolenoidCharacterizationWindow(
        receiver,
        device_ip=args.ip,
        device_port=args.device_port,
        bind_address=args.address,
    )
    window.showMaximized()

    def cleanup():
        receiver.stop()
        receiver.wait(2000)

    app.aboutToQuit.connect(cleanup)
    sys.exit(app.exec())


if __name__ == '__main__':
    main()

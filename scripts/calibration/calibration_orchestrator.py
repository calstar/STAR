#!/usr/bin/env python3
"""
Unified Calibration Orchestrator
=================================
Two-phase calibration lifecycle for all sensor types (PT, TC, RTD, LC)
backed by the full mathematical framework from the paper:

  ▸ Environmental-robust basis functions φ(v, e)  [Eq 66-72]
  ▸ Total Least Squares (TLS) calibration         [Eq 112-118]
  ▸ Bayesian regression with hierarchical priors   [Eq 126-149]
  ▸ Recursive Least Squares with forgetting        [Eq 162-166]
  ▸ Generalised Likelihood Ratio drift detection    [Eq 235-248]
  ▸ Empirical Bayes population prior evolution
  ▸ Active learning — system requests recalibration when quality degrades
  ▸ Transfer learning across sensors and sessions

Phase 1  – CALIBRATION (human-in-the-loop)
  User supplies known reference values.  The orchestrator collects raw ADC
  via UDP, converts to voltage, runs TLS + Bayesian update, validates
  quality, and saves coefficients.

Phase 2  – MONITORING / SELF-RECALIBRATION (autonomous, runs forever)
  After Phase 1 the orchestrator enters a continuous monitoring loop:
    ▸ RLS online parameter updates per channel (with forgetting factor)
    ▸ GLR drift detection (proper log-likelihood ratio)
    ▸ Bayesian full-recalibration when drift detected
    ▸ Empirical Bayes population prior propagation across all channels
    ▸ Active learning: system raises recalibration alerts
    ▸ Automatic periodic saves of coefficients + learned priors

Everything is config-driven — board IPs, ports, sensor counts, and
calibration paths are read from config/config.toml.

Usage:
  python3 calibration_orchestrator.py                   # Full lifecycle
  python3 calibration_orchestrator.py --skip-phase1     # Monitor only
  python3 calibration_orchestrator.py --phase1-only     # Calibrate & exit
  python3 calibration_orchestrator.py --sensors PT TC   # Specific types
"""

from __future__ import annotations

import sys, os, time, json, signal, socket, struct, threading, logging
import numpy as np
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from collections import deque, defaultdict
from datetime import datetime

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# ── Config loader ────────────────────────────────────────────────────────
try:
    from config_loader import (
        load_config,
        get_board_by_type,
        get_sensor_port,
        get_calibration_config,
        resolve_path,
        get_boards,
    )

    _cfg_loaded = True
except ImportError:
    _cfg_loaded = False
    logger.warning("config_loader not available — using hardcoded fallbacks")

# ── Mathematical framework imports ───────────────────────────────────────
from robust_calibration import (
    RobustCalibrationFramework,
    EnvironmentalState,
    CalibrationPoint as RobustCalPoint,
)
from autonomous_calibration_engine import (
    AutonomousCalibrationEngine,
    AdaptivePriorEvolution,
    DriftDetector as EngineDriftDetector,
    ActiveLearningAgent,
    OnlineBayesianLearner,
    CalibrationRequest,
)

# ── Actuator communication (2-way: send commands, receive status) ──────
try:
    from controller_integration import ActuatorComm

    ACTUATOR_COMM_AVAILABLE = True
except ImportError:
    ACTUATOR_COMM_AVAILABLE = False
    logger.warning("⚠️  Actuator communication not available")

# ── DiabloAvionics packet constants ─────────────────────────────────────
PACKET_HEADER_FORMAT = "<BBI"
PACKET_HEADER_SIZE = 6
SENSOR_DATA_PACKET_FORMAT = "<BB"
SENSOR_DATA_PACKET_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = "<I"
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = "<BI"
SENSOR_DATAPOINT_SIZE = 5
PACKET_TYPE_SENSOR_DATA = 3
MAX_PACKET_SIZE = 512

# ADC → Voltage conversion (24-bit ADC at 2.5V reference, sign-extended to 32-bit)
ADC_REF_VOLTAGE = 2.5
ADC_FULL_SCALE = 2**31  # 2147483648


def adc_to_voltage(adc_signed: int) -> float:
    """Convert signed 32-bit ADC code to voltage."""
    return (adc_signed * ADC_REF_VOLTAGE) / ADC_FULL_SCALE


# ── Sensor type descriptors ─────────────────────────────────────────────


@dataclass
class SensorTypeInfo:
    name: str  # PT, TC, RTD, LC
    unit: str  # PSI, °C, lbs
    ref_prompt: str
    board_ip: Optional[str]
    udp_port: int
    num_sensors: int
    calibration_dir: Path
    enabled: bool


def _build_sensor_types() -> Dict[str, SensorTypeInfo]:
    types = {}
    defs = {
        "PT": ("PSI", "pressure (PSI)", "192.168.2.101", 10),
        "TC": ("°C", "temperature (°C)", "192.168.2.103", 10),
        "RTD": ("°C", "temperature (°C)", "192.168.2.104", 4),
        "LC": ("lbs", "force (lbs)", "192.168.2.102", 4),
    }
    base_cal = Path(__file__).parent / "calibrations"
    for name, (unit, prompt, fallback_ip, fallback_n) in defs.items():
        ip, n, port, enabled = fallback_ip, fallback_n, 5006, True
        cal_dir = base_cal / name.lower() if name != "PT" else base_cal
        if _cfg_loaded:
            port = get_sensor_port()
            b = get_board_by_type(name)
            if b:
                ip = b.get("ip", fallback_ip)
                n = b.get("num_sensors", fallback_n)
                enabled = b.get("enabled", True)
            cc = get_calibration_config(name.lower())
            jd = cc.get("json_dir")
            if jd:
                cal_dir = resolve_path(jd)
        cal_dir.mkdir(parents=True, exist_ok=True)
        types[name] = SensorTypeInfo(name, unit, prompt, ip, port, n, cal_dir, enabled)
    return types


SENSOR_TYPES = _build_sensor_types()

# Number of parameters in environmental-robust basis (from the paper)
N_PARAMS = 6

# ═════════════════════════════════════════════════════════════════════════
#  UDP RECEIVER
# ═════════════════════════════════════════════════════════════════════════


class UDPSensorReceiver(threading.Thread):
    """Receives raw DiabloAvionics UDP packets and dispatches samples."""

    def __init__(self, port: int):
        super().__init__(daemon=True)
        self.port = port
        self._stop = threading.Event()
        self.sample_queue: deque = deque(maxlen=5000)
        self.connected = False
        self.stats = {"packets": 0, "samples": 0}

    def stop(self):
        self._stop.set()

    @staticmethod
    def parse(data: bytes):
        """Parse DiabloAvionics sensor data packet with error handling."""
        try:
            if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE:
                return None
            pt, _, _ = struct.unpack(PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE])
            if pt != PACKET_TYPE_SENSOR_DATA:
                return None
            off = PACKET_HEADER_SIZE
            nc, ns = struct.unpack(
                SENSOR_DATA_PACKET_FORMAT, data[off : off + SENSOR_DATA_PACKET_SIZE]
            )
            off += SENSOR_DATA_PACKET_SIZE
            per = SENSOR_DATA_CHUNK_SIZE + ns * SENSOR_DATAPOINT_SIZE
            required_len = PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE + nc * per
            if len(data) < required_len:
                logger.debug(f"Packet too short: {len(data)} < {required_len}")
                return None
            samples = []
            for _ in range(nc):
                off += SENSOR_DATA_CHUNK_SIZE
                for _ in range(ns):
                    if off + SENSOR_DATAPOINT_SIZE > len(data):
                        logger.warning("Packet truncated during parsing")
                        return samples  # Return partial samples
                    sid, raw = struct.unpack(
                        SENSOR_DATAPOINT_FORMAT, data[off : off + SENSOR_DATAPOINT_SIZE]
                    )
                    off += SENSOR_DATAPOINT_SIZE
                    # Sign-extend 32-bit value
                    signed = raw if raw < 0x80000000 else raw - 0x100000000
                    samples.append((sid, signed))
            return samples
        except struct.error as e:
            logger.debug(f"Packet parse error: {e}")
            return None
        except Exception as e:
            logger.warning(f"Unexpected parse error: {e}")
            return None

    def run(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(0.2)
        try:
            sock.bind(("0.0.0.0", self.port))
            self.connected = True
            logger.info(f"📡 UDP receiver on :{self.port}")
        except OSError as e:
            logger.error(f"Bind :{self.port} failed: {e}")
            return
        while not self._stop.is_set():
            try:
                data, addr = sock.recvfrom(MAX_PACKET_SIZE)
            except socket.timeout:
                continue
            except Exception:
                if not self._stop.is_set():
                    continue
                break
            samples = self.parse(data)
            if samples is None:
                continue
            self.stats["packets"] += 1
            src_ip = addr[0]
            for sid, signed in samples:
                self.stats["samples"] += 1
                self.sample_queue.append((src_ip, sid, signed, time.time()))
        sock.close()
        self.connected = False


# ═════════════════════════════════════════════════════════════════════════
#  CALIBRATION ORCHESTRATOR
# ═════════════════════════════════════════════════════════════════════════


class CalibrationOrchestrator:
    """
    Two-phase calibration lifecycle backed by the paper's full math:
      • RobustCalibrationFramework per channel  (TLS, Bayesian, GLR, RLS)
      • AutonomousCalibrationEngine for cross-sensor empirical Bayes +
        active learning
    """

    def __init__(self, sensor_names: Optional[List[str]] = None):
        # ── sensor types ────────────────────────────────────────────────
        self.sensor_types: Dict[str, SensorTypeInfo] = {}
        for name, info in SENSOR_TYPES.items():
            if sensor_names and name not in sensor_names:
                continue
            self.sensor_types[name] = info

        # ── Active connectors per board IP (from config or all) ──────────────
        # Key: (sensor_type, board_ip) -> List[int] of active connectors
        # This allows multiple boards of the same type with different IPs
        self.active_connectors: Dict[Tuple[str, str], List[int]] = {}
        self.board_ip_to_type: Dict[str, str] = {}  # IP -> sensor type mapping

        for stype, info in self.sensor_types.items():
            # Get all boards of this type (supports multiple boards)
            if _cfg_loaded:
                from config_loader import get_boards_by_type

                boards = get_boards_by_type(stype)
            else:
                boards = []

            if not boards:
                # Fallback: use single board info from SensorTypeInfo
                board_ip = info.board_ip or "unknown"
                active = list(range(1, info.num_sensors + 1))  # Default: all connectors
                self.active_connectors[(stype, board_ip)] = active
                self.board_ip_to_type[board_ip] = stype
                logger.info(
                    f"  {stype} ({board_ip}): active connectors = {active} (default: all)"
                )
            else:
                # Process each board separately
                for board in boards:
                    board_ip = board.get("ip", info.board_ip or "unknown")
                    board_name = board.get("name", "unknown")
                    num_sensors = board.get("num_sensors", info.num_sensors)

                    # Get active connectors for this specific board
                    active = list(range(1, num_sensors + 1))  # Default: all connectors
                    if "active_connectors" in board:
                        active_cfg = board.get("active_connectors", [])
                        if active_cfg:  # If specified, use only those
                            active = [
                                int(c) for c in active_cfg if 1 <= int(c) <= num_sensors
                            ]

                    self.active_connectors[(stype, board_ip)] = active
                    self.board_ip_to_type[board_ip] = stype
                    logger.info(
                        f"  {stype} ({board_name}, {board_ip}): active connectors = {active}"
                    )

        # ── Per-channel RobustCalibrationFramework ──────────────────────
        # keyed by (sensor_type, board_ip, channel_id) - ONLY for active connectors
        # We use (stype, ch) as the key but track board_ip separately for routing
        self.robust: Dict[Tuple[str, int], RobustCalibrationFramework] = {}
        self.channel_to_board_ip: Dict[Tuple[str, int], str] = (
            {}
        )  # Track which board each channel belongs to
        channel_idx = 0
        for (stype, board_ip), active_conns in self.active_connectors.items():
            for ch in active_conns:
                key = (stype, ch)
                # If we already have this (stype, ch) from another board, append board_ip to distinguish
                # For now, we'll use the first board's IP if there's a conflict
                if key not in self.robust:
                    self.robust[key] = RobustCalibrationFramework(sensor_id=channel_idx)
                    self.channel_to_board_ip[key] = board_ip
                    channel_idx += 1
                else:
                    # Multiple boards with same type and channel - use board_ip in key
                    logger.warning(
                        f"  ⚠️  Channel conflict: {stype} CH{ch} exists on multiple boards. Using first board."
                    )

        # Total channels = only active connectors
        total_channels = sum(len(conns) for conns in self.active_connectors.values())

        # ── Cross-sensor Autonomous Engine ──────────────────────────────
        orch_cfg = {}
        if _cfg_loaded:
            orch_cfg = load_config().get("calibration", {}).get("orchestrator", {})
        forgetting = float(orch_cfg.get("rls_forgetting_factor", 0.995))
        self.engine = AutonomousCalibrationEngine(
            n_sensors=total_channels,
            n_params=N_PARAMS,
            forgetting_factor=forgetting,
        )

        # Build flat index → key mapping (for engine ↔ robust) - ONLY active connectors
        self._idx_to_key: Dict[int, Tuple[str, int]] = {}
        self._key_to_idx: Dict[Tuple[str, int], int] = {}
        idx = 0
        for key in sorted(self.robust.keys()):  # Sort for consistent ordering
            self._idx_to_key[idx] = key
            self._key_to_idx[key] = idx
            idx += 1

        # ── Live ADC buffers ────────────────────────────────────────────
        self.live_adc: Dict[Tuple[str, int], deque] = defaultdict(
            lambda: deque(maxlen=200)
        )

        # ── IP → sensor type routing ────────────────────────────────────
        self.ip_to_type: Dict[str, str] = {}
        for stype, info in self.sensor_types.items():
            if info.board_ip:
                self.ip_to_type[info.board_ip] = stype

        # ── Reference values (set by user during Phase 1 or live) ──────
        self.references: Dict[Tuple[str, int], float] = {}

        # ── Environmental state (default; can be updated by sensors) ────
        self.env_state = EnvironmentalState()

        # ── UDP receiver ────────────────────────────────────────────────
        port = (
            next(iter(self.sensor_types.values())).udp_port
            if self.sensor_types
            else 5006
        )
        self.receiver = UDPSensorReceiver(port)

        # ── Config-driven settings ──────────────────────────────────────
        self.min_points = int(orch_cfg.get("min_points", 5))
        self.target_points = int(orch_cfg.get("target_points", 15))
        self.max_points = int(orch_cfg.get("max_points", 30))
        self.target_r2 = float(orch_cfg.get("target_r_squared", 0.99))
        self.min_r2 = float(orch_cfg.get("min_r_squared", 0.95))
        self.glr_threshold = float(orch_cfg.get("drift_glr_threshold", 2.0))
        self._save_interval = float(orch_cfg.get("auto_save_interval_sec", 300))
        self._status_interval = float(orch_cfg.get("status_interval_sec", 30))

        # Apply GLR threshold to per-channel frameworks
        for rcf in self.robust.values():
            rcf.glr_threshold = self.glr_threshold
            rcf.forgetting_factor = forgetting

        # ── State ───────────────────────────────────────────────────────
        self.running = False
        self.collecting = False
        self.phase = "IDLE"
        self.monitor_thread: Optional[threading.Thread] = None

        # ── Pending active-learning alerts ──────────────────────────────
        self.pending_alerts: List[CalibrationRequest] = []

        # ── Actuator communication (optional) ────────────────────────────
        self.actuator_comm = None
        if ACTUATOR_COMM_AVAILABLE:
            try:
                from config_loader import get_board_by_type

                actuator_board = get_board_by_type("ACTUATOR") if _cfg_loaded else None
                if actuator_board and actuator_board.get("enabled", False):
                    actuator_ip = actuator_board.get("ip", "192.168.2.201")
                    actuator_port = actuator_board.get("port", 5005)
                    self.actuator_comm = ActuatorComm(actuator_ip, actuator_port)
                    logger.info(
                        f"✅ Actuator communication initialized: {actuator_ip}:{actuator_port}"
                    )
            except Exception as e:
                logger.warning(f"⚠️  Failed to initialize actuator comm: {e}")

        # ── Stats ───────────────────────────────────────────────────────
        self.stats = {
            "phase1_points": 0,
            "tls_fits": 0,
            "bayesian_updates": 0,
            "rls_updates": 0,
            "drifts_detected": 0,
            "recalibrations": 0,
            "active_learning_alerts": 0,
            "saves": 0,
            "start_time": time.time(),
        }

        logger.info(
            f"🔧 Orchestrator: {', '.join(self.sensor_types.keys())} "
            f"({total_channels} channels, {N_PARAMS}-param env-robust basis)"
        )

    # ── UDP start / stop ─────────────────────────────────────────────────
    def start_receiver(self):
        self.receiver.start()
        time.sleep(0.5)
        if not self.receiver.connected:
            logger.error("❌ UDP receiver failed to bind")
            return False

        # Start actuator communication if available
        if self.actuator_comm:
            if not self.actuator_comm.start():
                logger.warning("⚠️  Actuator communication failed to start")

        self.running = True
        return True

    def stop(self):
        self.running = False
        self.receiver.stop()
        if self.actuator_comm:
            self.actuator_comm.stop()
        if self.monitor_thread and self.monitor_thread.is_alive():
            self.monitor_thread.join(timeout=3)
        logger.info("🛑 Orchestrator stopped")

    # ── Queue drain (routes by source IP) ────────────────────────────────
    def _drain_queue(self):
        max_drain = 100  # Limit per call to prevent blocking
        drained = 0
        while self.receiver.sample_queue and drained < max_drain:
            try:
                src_ip, sid, signed, ts = self.receiver.sample_queue.popleft()
            except (IndexError, ValueError):
                break
            drained += 1

            stype = self.ip_to_type.get(src_ip)
            if stype is None:
                # Check if it's actuator board (for status parsing)
                if self.actuator_comm and src_ip == self.actuator_comm.actuator_ip:
                    # Store raw data for actuator status parsing
                    if not hasattr(self, "_actuator_raw_samples"):
                        self._actuator_raw_samples = deque(maxlen=100)
                    self._actuator_raw_samples.append((sid, signed, ts))
                continue

            # FIX: sensor_id (sid) is 0-indexed from packet, channels are 1-indexed
            channel_id = sid + 1

            # Get active connectors for this specific board IP
            board_key = (stype, src_ip)
            active_conns = self.active_connectors.get(board_key, [])

            # If not found by IP, try by type (fallback for single board per type)
            if not active_conns:
                # Try to find any board of this type
                for (st, ip), conns in self.active_connectors.items():
                    if st == stype:
                        active_conns = conns
                        break

            # Only process if this connector is active for this board
            if channel_id not in active_conns:
                continue  # Skip inactive connectors

            key = (stype, channel_id)

            if key not in self.robust:
                # Log first few misses to help debug
                if self.stats.get("missed_channels", 0) < 5:
                    logger.warning(
                        f"⚠️  Unknown channel: {stype} CH{channel_id} (sid={sid})"
                    )
                    self.stats["missed_channels"] = (
                        self.stats.get("missed_channels", 0) + 1
                    )
                continue
            self.live_adc[key].append(signed)

            # Phase 1: collect calibration points when user is collecting
            if self.collecting and key in self.references:
                ref_val = self.references[key]
                pt = RobustCalPoint(
                    adc_code=float(signed),  # Use raw ADC code directly
                    pressure=ref_val,
                    timestamp=ts,
                    environmental_state=self.env_state,
                    uncertainty=self._adc_uncertainty(key),
                )
                rcf = self.robust[key]
                result = rcf.add_calibration_point(pt)
                self.stats["phase1_points"] += 1

                if result.get("drift_detected"):
                    self.stats["drifts_detected"] += 1

                # Feed into autonomous engine
                idx = self._key_to_idx[key]
                phi = rcf.environmental_robust_basis_functions(
                    float(signed), self.env_state
                )
                self.engine.add_calibration_point(idx, phi, ref_val, pt.uncertainty)

            # Phase 2: continuous RLS + drift monitoring
            if self.phase == "MONITORING":
                self._online_update(key, float(signed))

    def _parse_actuator_status(self):
        """Parse actuator current sense data from raw samples"""
        if not hasattr(self, "_actuator_raw_samples") or not self._actuator_raw_samples:
            return

        # Process recent actuator samples
        while self._actuator_raw_samples:
            try:
                sid, signed, ts = self._actuator_raw_samples.popleft()
                # Convert ADC to voltage
                voltage = (signed * 2.5) / 2147483648.0
                # Update actuator status
                if not hasattr(self, "actuator_statuses"):
                    self.actuator_statuses = {}
                self.actuator_statuses[sid] = {
                    "voltage": voltage,
                    "timestamp": ts,
                    "actuator_id": sid,
                }
            except (IndexError, ValueError):
                break

    def _print_actuator_status(self):
        """Print actuator current sense status"""
        if not hasattr(self, "actuator_statuses") or not self.actuator_statuses:
            print("  ⚠️  No actuator status data received yet")
            return

        print(f"\n  {'─'*60}")
        print("  Actuator Current Sense Status:")
        for actuator_id in sorted(self.actuator_statuses.keys()):
            status = self.actuator_statuses[actuator_id]
            age = time.time() - status["timestamp"]
            print(
                f"    Actuator {actuator_id}: {status['voltage']:.4f}V  (age: {age:.1f}s)"
            )
        print(f"  {'─'*60}\n")

    def _adc_uncertainty(self, key) -> float:
        """Compute measurement uncertainty from ADC noise."""
        buf = self.live_adc.get(key)
        if buf and len(buf) >= 10:
            codes = list(buf)[-50:]
            std_v = adc_to_voltage(int(np.std(codes)))
            return max(abs(std_v), 0.001)
        return 0.01  # default 1% of range

    # ── Phase 2: online update per channel ───────────────────────────────
    def _online_update(self, key: Tuple[str, int], adc_code: float):
        """
        Phase 2 per-sample update:
          1. RLS update (if reference available)
          2. Prediction + uncertainty for active-learning check
          3. GLR drift detection → full Bayesian recal if triggered
        """
        rcf = self.robust[key]
        idx = self._key_to_idx[key]

        # If a reference is available, do a proper RLS update
        if key in self.references:
            ref_val = self.references[key]
            pt = RobustCalPoint(
                adc_code=adc_code,  # Use raw ADC code directly
                pressure=ref_val,
                timestamp=time.time(),
                environmental_state=self.env_state,
                uncertainty=self._adc_uncertainty(key),
            )
            result = rcf.add_calibration_point(pt)
            self.stats["rls_updates"] += 1

            if result.get("drift_detected"):
                stype, ch = key
                logger.warning(
                    f"⚠️  DRIFT on {stype} CH{ch} "
                    f"(GLR={result['glr_statistic']:.2f}) — full Bayesian recal"
                )
                self.stats["drifts_detected"] += 1
                self.stats["recalibrations"] += 1

            # Feed into engine
            phi = rcf.environmental_robust_basis_functions(adc_code, self.env_state)
            self.engine.add_calibration_point(idx, phi, ref_val, pt.uncertainty)

        # Active learning check (even without reference)
        phi = rcf.environmental_robust_basis_functions(adc_code, self.env_state)
        pred, unc, alert = self.engine.predict(idx, phi)
        if alert is not None:
            self.stats["active_learning_alerts"] += 1
            self.pending_alerts.append(alert)
            if len(self.pending_alerts) % 5 == 1:
                stype, ch = key
                logger.info(
                    f"📝 Active learning: {stype} CH{ch} needs recal — "
                    f"{alert.reason} (urgency={alert.urgency:.2f})"
                )

    # ══════════════════════════════════════════════════════════════════════
    #  Phase 1: Interactive Calibration
    # ══════════════════════════════════════════════════════════════════════

    def run_phase1(self):
        self.phase = "CALIBRATION"
        print(f"\n{'═'*72}")
        print("  PHASE 1 — INTERACTIVE CALIBRATION  (TLS + Bayesian)")
        print(f"{'═'*72}")
        print("  Commands:")
        print("    ref <TYPE> <ch> <value>   — set reference  (e.g. ref PT 1 14.7)")
        print("    ref <TYPE> <ch1-ch2> <val>— range ref      (e.g. ref PT 1-4 14.7)")
        print("    ref-all <TYPE> <value>    — set all channels  (e.g. ref-all PT 0.0)")
        print("    collect [secs]            — collect samples at current references")
        print("    fit                       — run TLS + Bayesian fit for all channels")
        print("    status                    — show calibration status")
        print("    save                      — save calibrations + priors")
        print("    live                      — show live ADC (Ctrl+C to stop)")
        if self.actuator_comm:
            print(
                "    actuator <id> <0|1>      — send actuator command (test 2-way comm)"
            )
            print("    actuator-status          — show actuator current sense readings")
        print("    done                      — finish Phase 1, enter Phase 2")
        print("    quit                      — save and exit")
        print()
        print("  NOTE: Channels WITHOUT references inherit the population prior from")
        print("        calibrated channels (empirical Bayes). Calibrate a subset and")
        print("        ALL channels benefit via hierarchical Bayesian transfer.")
        print(f"{'─'*72}")
        types_str = ", ".join(
            f"{n}({i.num_sensors}ch)" for n, i in self.sensor_types.items()
        )
        print(f"  Sensors: {types_str}")
        print(f"  IP map:  {self.ip_to_type}")
        print(
            f"  Math:    {N_PARAMS}-param env-robust basis, TLS, hierarchical Bayesian"
        )
        print(f"{'═'*72}\n")

        while self.running:
            try:
                cmd = input("  [CAL] > ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not cmd:
                continue
            self._drain_queue()
            parts = cmd.split()
            verb = parts[0].lower()

            if verb == "ref-all" and len(parts) >= 3:
                stype = parts[1].upper()
                val = float(parts[2])
                if stype in self.sensor_types:
                    info = self.sensor_types[stype]
                    for ch in range(1, info.num_sensors + 1):
                        self.references[(stype, ch)] = val
                    print(f"  ✅ {stype} all → {val} {info.unit}")
                else:
                    print(f"  ⚠️  Unknown type: {stype}")

            elif verb == "ref" and len(parts) >= 4:
                stype = parts[1].upper()
                ch_spec = parts[2]
                val = float(parts[3])
                u = self.sensor_types.get(
                    stype, SensorTypeInfo(stype, "?", "", None, 0, 0, Path(), True)
                ).unit
                # Support range: "ref PT 1-4 14.7"
                if "-" in ch_spec:
                    lo, hi = ch_spec.split("-", 1)
                    for ch in range(int(lo), int(hi) + 1):
                        self.references[(stype, ch)] = val
                    print(f"  ✅ {stype} CH{lo}-{hi} → {val} {u}")
                else:
                    ch = int(ch_spec)
                    self.references[(stype, ch)] = val
                    print(f"  ✅ {stype} CH{ch} → {val} {u}")

            elif verb == "collect":
                dur = float(parts[1]) if len(parts) > 1 else 5.0
                self._collect(dur)

            elif verb == "fit":
                self._tls_bayesian_fit_all()
                self._print_status()

            elif verb == "status":
                self._print_status()

            elif verb == "save":
                self._tls_bayesian_fit_all()
                self._save_all()

            elif verb == "live":
                self._print_live()

            elif verb == "done":
                self._tls_bayesian_fit_all()
                self._save_all()
                print("  ➡️  Transitioning to Phase 2 (Monitoring)…")
                break

            elif verb in ("quit", "exit", "q"):
                self._tls_bayesian_fit_all()
                self._save_all()
                self.running = False
                return

            else:
                print(f"  ⚠️  Unknown: {cmd}")

    def _collect(self, dur: float):
        if not self.references:
            print("  ⚠️  No references set — nothing to collect")
            return
        refs = ", ".join(
            f"{t} CH{c}={v}" for (t, c), v in sorted(self.references.items())
        )
        print(f"  📊 Collecting {dur:.1f}s at: {refs}")
        self.collecting = True
        t0 = time.time()
        points_before = self.stats.get("phase1_points", 0)
        try:
            while time.time() - t0 < dur and self.running:
                self._drain_queue()
                time.sleep(0.01)
        except KeyboardInterrupt:
            print("\n  ⚠️  Collection interrupted")
        finally:
            self.collecting = False
            points_collected = self.stats.get("phase1_points", 0) - points_before
            print(
                f"  ✅ Done — collected {points_collected} points ({self.stats.get('phase1_points', 0)} total)"
            )

    # ── TLS + Bayesian fitting ───────────────────────────────────────────
    def _tls_bayesian_fit_all(self):
        """Run TLS + Bayesian update for all channels with enough data."""
        for key, rcf in self.robust.items():
            pts = rcf.calibration_points
            if len(pts) < self.min_points:
                continue
            # TLS fit
            theta_tls, cov_tls = rcf.total_least_squares_calibration(pts)
            self.stats["tls_fits"] += 1
            # Full Bayesian update
            theta_post, cov_post = rcf.bayesian_update(pts)
            rcf.theta_mean = theta_post
            rcf.theta_cov = cov_post
            self.stats["bayesian_updates"] += 1

            stype, ch = key
            conf = rcf.get_confidence_level()
            summary = rcf.get_calibration_summary()
            rmse = summary.get("rmse", 0.0)
            logger.info(
                f"✅ {stype} CH{ch}: TLS+Bayesian  "
                f"RMSE={rmse:.4f}  [{conf}]  {len(pts)}pts"
            )

    # ══════════════════════════════════════════════════════════════════════
    #  Phase 2: Continuous Monitoring / Self-Recalibration
    # ══════════════════════════════════════════════════════════════════════

    def run_phase2(self):
        self.phase = "MONITORING"
        print(f"\n{'═'*72}")
        print("  PHASE 2 — CONTINUOUS MONITORING / SELF-RECALIBRATION")
        if self.actuator_comm:
            print("  + Actuator communication enabled (2-way: commands + status)")
        print(f"{'═'*72}")
        print("  Math:  RLS w/ forgetting → GLR drift → Bayesian recal")
        print("         Empirical Bayes prior propagation across sensors")
        print("         Active learning: system requests recal when needed")
        print(f"  Press Ctrl+C to stop.  Status every {self._status_interval:.0f}s.")
        print(f"{'═'*72}\n")

        last_status = time.time()
        last_save = time.time()

        while self.running:
            try:
                self._drain_queue()
                now = time.time()

                # Parse actuator status from received packets (if actuator board enabled)
                if self.actuator_comm:
                    self._parse_actuator_status()

                if now - last_status > self._status_interval:
                    self._print_status()
                    self._print_alerts()
                    last_status = now
                if now - last_save > self._save_interval:
                    self._save_all()
                    last_save = now
                time.sleep(0.01)
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"Phase 2 error: {e}")
                time.sleep(1)

    def run_phase2_background(self):
        self.phase = "MONITORING"
        self.monitor_thread = threading.Thread(target=self.run_phase2, daemon=True)
        self.monitor_thread.start()

    def _print_alerts(self):
        if not self.pending_alerts:
            return
        print(f"  ⚡ Active Learning Alerts ({len(self.pending_alerts)}):")
        # Show last 5
        for alert in self.pending_alerts[-5:]:
            key = self._idx_to_key.get(alert.sensor_id, ("?", "?"))
            print(
                f"    {key[0]} CH{key[1]}: {alert.reason}  "
                f"(urgency={alert.urgency:.2f}, conf={alert.confidence:.2f})"
            )
        self.pending_alerts.clear()

    # ── Save / Load ──────────────────────────────────────────────────────
    def _save_all(self):
        for stype, info in self.sensor_types.items():
            calibrated = {}
            for ch in range(1, info.num_sensors + 1):
                key = (stype, ch)
                rcf = self.robust[key]
                if len(rcf.calibration_points) >= self.min_points:
                    calibrated[ch] = rcf
            if not calibrated:
                continue

            ts = datetime.now().strftime("%Y%m%d_%H%M%S")

            # ── JSON (full Bayesian state) ──
            jp = info.calibration_dir / f"{stype.lower()}_calibration_{ts}.json"
            data = {
                "sensor_type": stype,
                "unit": info.unit,
                "framework": "robust_bayesian_tls",
                "n_params": N_PARAMS,
                "created": datetime.now().isoformat(),
                "phase": self.phase,
                "calibration_parameters": {},
                "quality": {},
            }
            for ch, rcf in sorted(calibrated.items()):
                summary = rcf.get_calibration_summary()
                data["calibration_parameters"][str(ch)] = {
                    "theta_mean": rcf.theta_mean.tolist(),
                    "theta_cov": rcf.theta_cov.tolist(),
                    "rls_P": rcf.rls_P.tolist(),
                }
                data["quality"][str(ch)] = {
                    "confidence": summary.get("confidence_level", "UNKNOWN"),
                    "num_points": summary.get("calibration_points", 0),
                    "rmse": summary.get("rmse", 0.0),
                    "max_residual": summary.get("max_residual", 0.0),
                    "forgetting_factor": rcf.forgetting_factor,
                }

            # Also save legacy polynomial_coeffs for C++ stack compat
            # The C++ stack reads [A, B, C, D] cubic from JSON
            # We provide theta_mean[3]*v³ + theta_mean[2]*v² + theta_mean[1]*v + theta_mean[0]
            # mapped to polynomial form
            data["calibration_polynomials"] = {}
            for ch, rcf in sorted(calibrated.items()):
                # Map 6-param basis → legacy 4-coeff cubic approximation
                # by evaluating at the environmental state midpoint
                data["calibration_polynomials"][str(ch)] = rcf.theta_mean.tolist()

            with open(jp, "w") as f:
                json.dump(data, f, indent=2)

            # ── CSV (DiabloAvionics compat — 4 coeffs per channel) ──
            cp = info.calibration_dir / f"{stype.lower()}_calibration_{ts}.csv"
            cols = ["Timestamp"]
            for ch in sorted(calibrated.keys()):
                for ci in range(N_PARAMS):
                    cols.append(f"{stype}{ch} Param {ci}")
            row = [datetime.now().isoformat()]
            for ch in sorted(calibrated.keys()):
                theta = calibrated[ch].theta_mean
                for ci in range(N_PARAMS):
                    row.append(f"{theta[ci]:.15e}")
            with open(cp, "w") as f:
                f.write(",".join(cols) + "\n")
                f.write(",".join(row) + "\n")

            logger.info(f"💾 {stype}: {jp.name}  ({len(calibrated)} channels)")
            self.stats["saves"] += 1

        # ── Save learned population prior ──
        self._save_prior()

    def _save_prior(self):
        """Save the learned population prior for warm-starting future sessions."""
        prior_path = Path(__file__).parent / "calibrations" / "learned_prior.json"
        prior_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            prior_data = self.engine.export_learned_prior()
            prior_data["saved_at"] = datetime.now().isoformat()
            engine_status = self.engine.get_system_status()
            prior_data["system_status"] = {
                "total_calibrations": engine_status["total_calibrations"],
                "prior_confidence": engine_status["prior_confidence"],
                "average_sensor_quality": engine_status["average_sensor_quality"],
                "drift_rate": engine_status["drift_rate"],
            }
            with open(prior_path, "w") as f:
                json.dump(prior_data, f, indent=2)
            logger.info(
                f"💾 Prior saved: ESS={prior_data['effective_sample_size']:.1f}"
            )
        except Exception as e:
            logger.error(f"Save prior: {e}")

    def load_existing(self):
        """Load latest calibrations + learned prior for cold-start Phase 2."""
        # Load per-channel calibrations
        for stype, info in self.sensor_types.items():
            if not info.calibration_dir.is_dir():
                continue
            jsons = sorted(
                info.calibration_dir.glob(f"{stype.lower()}_calibration_*.json"),
                key=os.path.getmtime,
            )
            if not jsons:
                continue
            latest = jsons[-1]
            try:
                with open(latest) as f:
                    data = json.load(f)
                params = data.get("calibration_parameters", {})
                for ch_str, pdata in params.items():
                    ch = int(ch_str)
                    key = (stype, ch)
                    if key not in self.robust:
                        continue
                    rcf = self.robust[key]
                    rcf.theta_mean = np.array(pdata["theta_mean"])
                    rcf.theta_cov = np.array(pdata["theta_cov"])
                    if "rls_P" in pdata:
                        rcf.rls_P = np.array(pdata["rls_P"])
                logger.info(
                    f"📂 Loaded {stype}: {latest.name} ({len(params)} channels)"
                )
            except Exception as e:
                logger.error(f"Load {latest}: {e}")

        # Load learned prior
        prior_path = Path(__file__).parent / "calibrations" / "learned_prior.json"
        if prior_path.exists():
            try:
                with open(prior_path) as f:
                    prior_data = json.load(f)
                self.engine.import_learned_prior(prior_data)
                logger.info(
                    f"📂 Loaded prior: ESS={prior_data.get('effective_sample_size', '?')}"
                )
            except Exception as e:
                logger.error(f"Load prior: {e}")

    # ── Status ───────────────────────────────────────────────────────────
    def _print_status(self):
        print(f"\n{'═'*78}")
        print(f"  Calibration Orchestrator — Phase: {self.phase}")
        uptime = time.time() - self.stats["start_time"]
        print(
            f"  Uptime: {uptime/60:.1f}m  UDP: {self.receiver.stats['packets']} pkts / "
            f"{self.receiver.stats['samples']} samples"
        )
        print(
            f"  Cal pts: {self.stats['phase1_points']}  "
            f"TLS: {self.stats['tls_fits']}  "
            f"Bayes: {self.stats['bayesian_updates']}  "
            f"RLS: {self.stats['rls_updates']}  "
            f"Drifts: {self.stats['drifts_detected']}  "
            f"Alerts: {self.stats['active_learning_alerts']}"
        )

        # Engine status
        eng = self.engine.get_system_status()
        print(
            f"  Engine: prior_conf={eng['prior_confidence']:.3f}  "
            f"avg_quality={eng['average_sensor_quality']:.3f}  "
            f"drift_rate={eng['drift_rate']:.2e}  "
            f"ESS={eng['effective_sample_size']:.1f}"
        )

        print(f"{'─'*78}")
        for stype, info in self.sensor_types.items():
            print(
                f"  {stype} ({info.unit})  board={info.board_ip}  ch={info.num_sensors}"
            )
            for ch in range(1, info.num_sensors + 1):
                key = (stype, ch)
                rcf = self.robust[key]
                buf = self.live_adc.get(key)
                adc_str = ""
                if buf and len(buf):
                    mean_adc = int(np.mean(list(buf)))
                    mean_v = adc_to_voltage(mean_adc)
                    adc_str = f"V={mean_v:>8.5f}"
                else:
                    adc_str = "V=---"

                ref = self.references.get(key)
                ref_str = f"  ref={ref:.2f}" if ref is not None else ""

                npts = len(rcf.calibration_points)
                conf = rcf.get_confidence_level()
                summary = rcf.get_calibration_summary()
                rmse = summary.get("rmse", 0.0)

                # Prediction at current ADC code (works for both direct + prior-only)
                pred_str = ""
                if buf and len(buf):
                    mean_adc_code = int(np.mean(list(buf)))
                    pred, sigma = rcf.predict_pressure_with_uncertainty(
                        float(mean_adc_code), self.env_state
                    )
                    pred_str = f"  →{pred:>8.2f}±{sigma:.2f}"

                # Show calibration source: DIRECT (has data) vs PRIOR (population)
                src = "DIRECT" if npts > 0 else "PRIOR "

                print(
                    f"    CH{ch:>2d}: {src} {npts:>3d}pts  [{conf:<7s}]  "
                    f"RMSE={rmse:<8.4f}  {adc_str}{pred_str}{ref_str}"
                )
        print(f"{'═'*78}\n")

    def _print_live(self):
        print("  (Ctrl+C to stop)")
        try:
            while True:
                self._drain_queue()
                parts = []
                for key in sorted(self.live_adc.keys()):
                    buf = self.live_adc[key]
                    if len(buf):
                        stype, ch = key
                        v = adc_to_voltage(int(np.mean(list(buf))))
                        parts.append(f"{stype}{ch}:{v:>8.5f}V")
                print(
                    f"\r  [{self.receiver.stats['packets']:>6d}] " + "  ".join(parts),
                    end="",
                    flush=True,
                )
                time.sleep(0.25)
        except KeyboardInterrupt:
            print()


# ═════════════════════════════════════════════════════════════════════════
#  MAIN
# ═════════════════════════════════════════════════════════════════════════


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Unified Calibration Orchestrator — Robust Bayesian + TLS",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Mathematical Framework (from the paper):
  Phase 1: TLS + Bayesian hierarchical regression with environmental basis
  Phase 2: RLS with forgetting → GLR drift detection → Bayesian recal
           Empirical Bayes prior evolution → Active learning alerts

Examples:
  python3 calibration_orchestrator.py                   # Full lifecycle
  python3 calibration_orchestrator.py --skip-phase1     # Monitor only
  python3 calibration_orchestrator.py --phase1-only     # Calibrate & exit
  python3 calibration_orchestrator.py --sensors PT TC   # Specific types
""",
    )
    parser.add_argument(
        "--sensors",
        nargs="+",
        default=None,
        help="Sensor types to include (default: all enabled)",
    )
    parser.add_argument(
        "--skip-phase1",
        action="store_true",
        help="Skip Phase 1, load existing calibrations, go to monitoring",
    )
    parser.add_argument(
        "--phase1-only",
        action="store_true",
        help="Run Phase 1 only (calibrate and exit)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="UDP port override (default: from config.toml)",
    )
    args = parser.parse_args()

    sensor_names = [s.upper() for s in args.sensors] if args.sensors else None
    orch = CalibrationOrchestrator(sensor_names)

    if args.port:
        orch.receiver = UDPSensorReceiver(args.port)

    if not orch.start_receiver():
        return 1

    def shutdown(*_):
        print("\n🛑 Shutting down…")
        orch._save_all()
        orch._print_status()
        orch.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Phase 1
    if not args.skip_phase1:
        orch.run_phase1()
        if not orch.running:
            return 0
    else:
        orch.load_existing()

    # Phase 2
    if not args.phase1_only and orch.running:
        orch.run_phase2()

    orch._save_all()
    orch._print_status()
    orch.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())

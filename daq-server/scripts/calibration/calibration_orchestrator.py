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
        build_orchestrator_key_to_packet_ch,
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

try:
    from calibration_robustness import (
        RobustnessManager,
        SystemConfig as RobustnessConfig,
        OperationMode,
    )

    ROBUSTNESS_AVAILABLE = True
except ImportError:
    ROBUSTNESS_AVAILABLE = False

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
N_PARAMS = 9  # Paper: 9-parameter environmental-robust basis (φ₀–φ₈)

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
                exclude_hp = (
                    load_config().get("calibration", {}).get("exclude_hp_pt", True)
                    if _cfg_loaded
                    else True
                )
                for board in boards:
                    # Skip HP PT boards (4-20 mA) — they use linear conversion, not robust calibration
                    if stype == "PT" and exclude_hp and board.get("hp_pt_connectors"):
                        logger.info(
                            f"  {stype} ({board.get('name', '?')}, {board.get('ip', '?')}): skipped (HP PT board)"
                        )
                        continue
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

                    # Store board ID for this IP to build unique keys
                    if not hasattr(self, "ip_to_board_id"):
                        self.ip_to_board_id = {}
                    self.ip_to_board_id[board_ip] = board.get("board_id", 1)

                    logger.info(
                        f"  {stype} ({board_name}, {board_ip}, ID {self.ip_to_board_id[board_ip]}): active connectors = {active}"
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
            board_id = getattr(self, "ip_to_board_id", {}).get(board_ip, 1)
            for ch in active_conns:
                # Use board-aware unique ID: boardId * 100 + channelId
                unique_ch = board_id * 100 + ch
                key = (stype, unique_ch)
                if key not in self.robust:
                    self.robust[key] = RobustCalibrationFramework(sensor_id=unique_ch)
                    self.channel_to_board_ip[key] = board_ip
                else:
                    logger.warning(
                        f"  ⚠️  Channel conflict: {stype} key {key} exists on multiple boards. Using first."
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
        # Paper: consensus only in test/calibration mode; disabled in flight
        self.consensus_enabled = bool(orch_cfg.get("consensus_enabled", True))
        phase2 = load_config().get("phase2", {}) if _cfg_loaded else {}
        env_cal = (
            load_config().get("calibration", {}).get("environmental", {})
            if _cfg_loaded
            else {}
        )
        self.consensus_threshold = float(phase2.get("consensus_threshold_psi", 1.0))
        self.min_consensus_sensors = int(env_cal.get("min_consensus_sensors", 2))
        self.self_cal_alpha_threshold = float(
            orch_cfg.get("self_cal_alpha_threshold", 0.6)
        )
        self.agreement_threshold = float(orch_cfg.get("agreement_threshold", 0.6))

        # Latest predictions per channel for consensus (paper Section 6)
        self.latest_predictions: Dict[Tuple[str, int], Tuple[float, float, float]] = {}

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
        self.pending_alerts_max = 50  # cap to prevent unbounded growth

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

        # ── Robustness manager (backup, validation, health) ────────────────
        self.robustness_manager = None
        if ROBUSTNESS_AVAILABLE:
            try:
                rb_cfg = RobustnessConfig()
                rb_cfg.model_order = N_PARAMS - 1  # 9 params → order 8
                rb_cfg.num_sensors = total_channels
                self.robustness_manager = RobustnessManager(rb_cfg)
                logger.info(
                    "🛡️  Robustness manager enabled (backup, validation, health)"
                )
            except Exception as e:
                logger.warning(f"⚠️  Robustness manager init failed: {e}")

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
            board_id = getattr(self, "ip_to_board_id", {}).get(src_ip, 1)
            unique_ch = board_id * 100 + channel_id
            key = (stype, unique_ch)

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
            # User reference is ground truth — validate then add
            if self.collecting and key in self.references:
                ref_val = self.references[key]
                unc = self._adc_uncertainty(key)
                # Robustness validation (optional)
                if self.robustness_manager:
                    v_res = self.robustness_manager.validator.validate_pressure(
                        ref_val, key[1]
                    )
                    if not v_res:
                        self.robustness_manager.health_monitor.log_validation_error(
                            v_res
                        )
                        continue
                pt = RobustCalPoint(
                    adc_code=float(signed),  # Use raw ADC code directly
                    pressure=ref_val,
                    timestamp=ts,
                    environmental_state=self.env_state,
                    uncertainty=unc,
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
          4. Store for consensus (live_adc, latest_predictions)
        """
        self.live_adc[key].append(adc_code)
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

        # RCF prediction for consensus and active learning
        pred, sigma = rcf.predict_pressure_with_uncertainty(adc_code, self.env_state)
        self.latest_predictions[key] = (pred, sigma, time.time())

        phi = rcf.environmental_robust_basis_functions(adc_code, self.env_state)
        _, _, alert = self.engine.predict(idx, phi, adc_code=adc_code)
        if alert is not None:
            self.stats["active_learning_alerts"] += 1
            self.pending_alerts.append(alert)
            if len(self.pending_alerts) > self.pending_alerts_max:
                self.pending_alerts = self.pending_alerts[-self.pending_alerts_max :]
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
        print(f"  Data:  relay WebSocket (online updates via _online_update)")
        print(f"  Press Ctrl+C to stop.  Status every {self._status_interval:.0f}s.")
        print(f"{'═'*72}\n")

        last_status = time.time()
        last_save = time.time()

        while self.running:
            try:
                # In sidecar mode the relay_subscriber_task calls _online_update() directly;
                # _drain_queue() is only valid when the UDP receiver is started (CLI mode).
                # Skip it here to avoid touching an unstarted receiver.
                now = time.time()

                if now - last_status > self._status_interval:
                    self._print_status()
                    self._print_alerts()
                    last_status = now
                if now - last_save > self._save_interval:
                    self._save_all()
                    last_save = now
                self._run_consensus_and_self_cal()
                time.sleep(0.5)
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

    # ── Clear calibration (start from scratch) ────────────────────────────
    def clear_calibration(self):
        """Clear all references and per-channel calibration data. User can start fresh."""
        self.references.clear()
        for key, rcf in self.robust.items():
            rcf.calibration_points.clear()
            rcf.theta_mean = rcf.population_prior_mean.copy()
            rcf.theta_cov = rcf.individual_prior_cov.copy()
            rcf.rls_P = np.eye(rcf.n_params) * 100.0
            rcf.bias_model.b = np.zeros(3)
            rcf.bias_model.P_b = np.eye(3) * 0.01
            rcf.inflation_factor = 1.0
        logger.info("🗑️ Calibration cleared — references and points reset")

    def _run_consensus_and_self_cal(self):
        """Paper Section 6: consensus + agreement + self-cal when α≥0.6, agreement>0.6."""
        if not self.consensus_enabled or self.phase != "MONITORING":
            return

        # Collect PT predictions (same stype for consensus)
        pt_keys = [k for k in self.latest_predictions if k[0] == "PT"]
        if len(pt_keys) < self.min_consensus_sensors:
            return

        now = time.time()
        active = []
        for key in pt_keys:
            pred, sigma, ts = self.latest_predictions[key]
            if now - ts > 2.0:  # stale
                continue
            alpha, _ = self.robust[key].get_autonomy_score()
            if alpha < 0.2:
                continue
            w = alpha / (sigma**2 + 1e-6)
            active.append((key, pred, sigma, w))

        if len(active) < self.min_consensus_sensors:
            for key in pt_keys:
                if key in self.robust:
                    self.robust[key].inflation_factor = 1.0
            return

        # Consensus pressure
        w_sum = sum(w for _, _, _, w in active)
        p_consensus = sum(p * w for _, p, _, w in active) / w_sum
        sigma_consensus = 1.0 / np.sqrt(w_sum)

        # Agreement score (paper Eq.)
        agreement = 1.0
        for i, (_, pi, si, _) in enumerate(active):
            for j, (_, pj, sj, _) in enumerate(active):
                if i >= j:
                    continue
                d2 = (pi - pj) ** 2 / (si**2 + sj**2 + 1e-12)
                agreement *= np.exp(-d2 / (2 * len(active) * (len(active) - 1)))

        if agreement < self.agreement_threshold:
            # Disagreement: inflate uncertainty (paper Section 7)
            inflate = 2.0 - agreement
            for key in pt_keys:
                if key in self.robust:
                    self.robust[key].inflation_factor = inflate
            return

        # Agreement: deflate uncertainty
        deflate = 0.5 + 0.5 * agreement
        for key in pt_keys:
            if key in self.robust:
                self.robust[key].inflation_factor = deflate

        # Self-calibration for PTs with α≥0.6
        for key, pred, sigma, w in active:
            rcf = self.robust[key]
            alpha, _ = rcf.get_autonomy_score()
            if alpha < self.self_cal_alpha_threshold:
                continue
            buf = self.live_adc.get(key)
            if not buf or len(buf) < 3:
                continue
            mean_adc = float(np.mean(list(buf)))
            unc = sigma_consensus * (1 + (1 - alpha) / max(alpha, 0.01))
            pt = RobustCalPoint(
                adc_code=mean_adc,
                pressure=p_consensus,
                timestamp=now,
                environmental_state=self.env_state,
                uncertainty=unc,
            )
            rcf.add_calibration_point(pt)
            self.stats["phase1_points"] = self.stats.get("phase1_points", 0) + 1
            idx = self._key_to_idx.get(key)
            if idx is not None:
                phi = rcf.environmental_robust_basis_functions(mean_adc, self.env_state)
                self.engine.add_calibration_point(idx, phi, p_consensus, unc)
            logger.debug(
                f"Self-cal: {key} α={alpha:.2f} agreement={agreement:.2f} p={p_consensus:.1f}"
            )

    # ── Zero-point propagation (paper Section 9) ───────────────────────────
    def propagate_zero_point(self, calibrated_key: Tuple[str, int], stype: str):
        """When human provides zero for one PT, add (v_k, 0, 0.01) for all other PTs of same type."""
        for key, rcf in self.robust.items():
            if key[0] != stype or key == calibrated_key:
                continue
            buf = self.live_adc.get(key)
            if buf and len(buf) >= 3:
                mean_adc = float(np.mean(list(buf)))
                pt = RobustCalPoint(
                    adc_code=mean_adc,
                    pressure=0.0,
                    timestamp=time.time(),
                    environmental_state=self.env_state,
                    uncertainty=0.01,
                )
                rcf.add_calibration_point(pt)
                logger.info(
                    f"  Zero propagated: {key[0]} CH{key[1]} ← (adc={mean_adc:.0f}, 0 PSI)"
                )

    # ── Save / Load ──────────────────────────────────────────────────────
    def _save_all(self):
        """Save calibration constants to JSON (and CSV) in config calibration path."""
        # Robustness backup before save
        if (
            self.robustness_manager
            and self.robustness_manager.backup_manager.should_backup()
        ):
            pop_prior = self.engine.export_learned_prior()
            pt_states = {}
            for key, rcf in self.robust.items():
                ch = key[1]
                pt_states[ch] = {
                    "theta_mean": rcf.theta_mean.tolist(),
                    "theta_cov": rcf.theta_cov.tolist(),
                    "n_points": len(rcf.calibration_points),
                }
            self.robustness_manager.backup_manager.backup_calibration_state(
                population_prior={
                    "population_mean": pop_prior.get("prior_mean", []),
                    "population_covariance": pop_prior.get("prior_covariance", []),
                    "effective_sample_size": pop_prior.get("effective_sample_size", 0),
                },
                pt_states=pt_states,
                metadata={"phase": self.phase, "stats": self.stats},
            )

        for stype, info in self.sensor_types.items():
            calibrated = {}
            for key, rcf in self.robust.items():
                if key[0] != stype:
                    continue
                ch = key[1]
                # Include channels that have enough calibration points OR have been
                # RLS-updated autonomously so the learned theta persists across restarts.
                has_points = len(rcf.calibration_points) >= self.min_points
                has_rls = getattr(rcf, "rls_updates", 0) > 0
                if has_points or has_rls:
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

            # Legacy polynomial_coeffs [A,B,C,D] for psi = A*adc³ + B*adc² + C*adc + D
            # 9-param: p = θ₀ + θ₁*v + θ₂*v² + θ₃*v³ with v=adc/1e9 → A=θ₃/1e27, B=θ₂/1e18, C=θ₁/1e9, D=θ₀
            # Key by packet_ch so sense_conversions fallback can load
            key_to_packet = build_orchestrator_key_to_packet_ch()
            data["calibration_polynomials"] = {}
            for ch, rcf in sorted(calibrated.items()):
                t = rcf.theta_mean
                leg = [
                    t[3] / 1e27 if len(t) > 3 else 0,
                    t[2] / 1e18 if len(t) > 2 else 0,
                    t[1] / 1e9 if len(t) > 1 else 0,
                    t[0] if len(t) > 0 else 0,
                ]
                packet_ch = key_to_packet.get((stype, ch), ch)
                data["calibration_polynomials"][str(packet_ch)] = leg

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

    def _load_prior_from_polynomial_calibration(self):
        """
        Load polynomial calibration (calibration_poly_coeffs + adc_norm_min/scale)
        from calibration/ or calibration_backups/ and use as initial theta for RCFs.
        Fixes 150 PSI reading as 56.8 — the default prior theta[1]=200 has wrong slope.
        """
        if _cfg_loaded and not load_config().get("calibration", {}).get(
            "prior_from_polynomial", True
        ):
            return
        from config_loader import get_repo_root

        repo = get_repo_root()
        search_dirs = [
            repo / "calibration",
            repo / "calibration_backups",
            repo / "scripts" / "calibration" / "calibrations",
        ]
        polys = {}
        adc_min = {}
        adc_scale = {}
        for cal_dir in search_dirs:
            if not cal_dir.is_dir():
                continue
            for fp in sorted(
                cal_dir.glob("*.json"), key=os.path.getmtime, reverse=True
            ):
                if "learned_prior" in fp.name:
                    continue
                try:
                    with open(fp) as f:
                        data = json.load(f)
                    p = data.get("calibration_poly_coeffs") or data.get(
                        "calibration_polynomials"
                    )
                    m = data.get("calibration_adc_norm_min") or {}
                    s = data.get("calibration_adc_norm_scale") or {}
                    if p and (m or s):
                        for k, v in p.items():
                            if isinstance(v, (list, tuple)) and len(v) >= 2:
                                polys[k] = list(v)
                                if k in m:
                                    adc_min[k] = float(m[k])
                                if k in s:
                                    adc_scale[k] = float(s[k])
                        break
                except Exception:
                    continue
            if polys:
                break

        if not polys:
            return

        # Map calibration key (101, 102, 1101) -> unique_ch (2101, 2102, 2201)
        def cal_key_to_unique_ch(k: str) -> Optional[int]:
            n = int(k)
            if 100 <= n <= 199:
                return 2100 + (n - 100)
            if 1100 <= n <= 1199:
                return 2200 + (n - 1100)
            return None

        for ch_str, coeffs in polys.items():
            uch = cal_key_to_unique_ch(ch_str)
            if uch is None:
                continue
            key = ("PT", uch)
            if key not in self.robust:
                continue
            mn = adc_min.get(ch_str)
            sc = adc_scale.get(ch_str)
            if mn is None or sc is None or sc <= 0:
                continue
            self.robust[key].set_theta_from_polynomial(coeffs, mn, sc)
        if polys:
            logger.info(f"📐 Loaded polynomial priors for {len(polys)} PT channels")

    def load_existing(self):
        """Load latest calibrations + learned prior for cold-start Phase 2."""
        self._load_prior_from_polynomial_calibration()

        key_to_packet = build_orchestrator_key_to_packet_ch()
        packet_to_key = {}
        for (stype, uch), pch in key_to_packet.items():
            packet_to_key[(stype, pch)] = (stype, uch)

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
                polys = data.get("calibration_polynomials", {})

                for ch_str, pdata in params.items():
                    ch = int(ch_str)
                    key = (stype, ch)
                    if key not in self.robust:
                        continue
                    rcf = self.robust[key]
                    theta = np.array(pdata["theta_mean"])
                    cov = np.array(pdata["theta_cov"])
                    if len(theta) == 6:
                        theta = np.concatenate([theta, [0.0, 0.0, 0.0]])
                        cov = np.pad(cov, ((0, 3), (0, 3)), constant_values=0.1)
                    rcf.theta_mean = theta
                    rcf.theta_cov = cov
                    if "rls_P" in pdata:
                        rls_P = np.array(pdata["rls_P"])
                        if rls_P.shape[0] == 6:
                            rls_P = np.pad(
                                rls_P, ((0, 3), (0, 3)), constant_values=100.0
                            )
                        rcf.rls_P = rls_P

                # Fallback: legacy polynomial-only → theta_mean
                if not params and polys and stype == "PT":
                    for pch_str, coeffs in polys.items():
                        if len(coeffs) < 4:
                            continue
                        key = packet_to_key.get((stype, int(pch_str)))
                        if key is None:
                            continue
                        if key not in self.robust:
                            continue
                        A, B, C, D = coeffs[0], coeffs[1], coeffs[2], coeffs[3]
                        theta = np.array(
                            [
                                D,
                                C * 1e9,
                                B * 1e18,
                                A * 1e27,
                                0.0,
                                0.0,
                                0.0,
                                0.0,
                                0.0,
                            ]
                        )
                        self.robust[key].theta_mean = theta
                        self.robust[key].theta_cov = np.eye(9) * 0.1

                n = len(params) or (len(polys) if stype == "PT" else 0)
                if n:
                    logger.info(f"📂 Loaded {stype}: {latest.name} ({n} channels)")
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

        # Load auto-saved RLS state from adjustments.json (framework_v2 format).
        # This overrides the timestamped file load above with the most recent
        # autonomous calibration state (written every ~2 min by calibration_server).
        adj_path = Path(__file__).parent / "calibrations" / "adjustments.json"
        if adj_path.exists():
            try:
                with open(adj_path) as f:
                    adj_data = json.load(f)
                fw2 = adj_data.get("framework_v2", {})
                loaded_adj = 0
                for unique_ch_str, pdata in fw2.items():
                    theta = pdata.get("theta_mean")
                    cov = pdata.get("theta_cov")
                    if not theta or not cov:
                        continue
                    key = ("PT", int(unique_ch_str))
                    if key not in self.robust:
                        continue
                    t = np.array(theta)
                    c = np.array(cov)
                    if len(t) == 6:
                        t = np.concatenate([t, [0.0, 0.0, 0.0]])
                        c = np.pad(c, ((0, 3), (0, 3)), constant_values=0.1)
                    if t.shape[0] == 9:
                        self.robust[key].theta_mean = t
                        if c.shape == (9, 9):
                            self.robust[key].theta_cov = c
                        loaded_adj += 1
                if loaded_adj:
                    logger.info(
                        f"📂 Loaded adjustments.json: {loaded_adj} PT channels "
                        f"(saved {adj_data.get('auto_saved_at', '?')})"
                    )
            except Exception as e:
                logger.error(f"Load adjustments.json: {e}")

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

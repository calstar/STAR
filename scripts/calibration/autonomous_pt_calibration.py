#!/usr/bin/env python3
"""
Autonomous PT Calibration System
Automatically calibrates PT sensors by listening to raw UDP packets from the
DiabloAvionics boards and collecting calibration points at known reference pressures.

All board IPs, ports, sensor counts, and calibration paths are read from
config/config.toml via config_loader so you only change the config file.

Features:
- Reads raw board UDP packets (DiabloAvionics protocol) — no external dependencies
- Automatic calibration point collection with quality scoring
- Reference pressure input (from gauges, regulators, etc.)
- Automatic cubic polynomial fitting (psi = A·adc³ + B·adc² + C·adc + D)
- R² quality validation with confidence levels
- Automatic saving of calibration coefficients (JSON + CSV)
- Confidence-based autonomous operation
- Live ADC monitoring
"""

import sys
import os
import time
import json
import socket
import struct
import signal
import threading
import numpy as np
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from collections import deque, defaultdict
from datetime import datetime
import logging

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# ── Config-driven defaults ───────────────────────────────────────────────
try:
    from config_loader import (
        load_config,
        get_board_by_type,
        get_sensor_port,
        get_calibration_config,
        resolve_path,
    )

    _cfg_loaded = True
except ImportError:
    _cfg_loaded = False


def _default_port():
    if _cfg_loaded:
        return get_sensor_port()
    return 5006


def _default_board_ip():
    if _cfg_loaded:
        b = get_board_by_type("PT")
        if b:
            return b.get("ip")
    return "192.168.2.101"


def _default_num_sensors():
    if _cfg_loaded:
        b = get_board_by_type("PT")
        if b:
            return b.get("num_sensors", 10)
    return 10


def _default_calibration_dir():
    if _cfg_loaded:
        cc = get_calibration_config("pt")
        jd = cc.get("json_dir")
        if jd:
            return resolve_path(jd)
    return Path(__file__).parent / "calibrations"


# ── DiabloAvionics packet constants (match combined_gui.py exactly) ─────
PACKET_HEADER_FORMAT = "<BBI"  # packet_type(u8), version(u8), timestamp(u32) = 6 bytes
PACKET_HEADER_SIZE = 6
SENSOR_DATA_PACKET_FORMAT = "<BB"  # num_chunks(u8), num_sensors(u8) = 2 bytes
SENSOR_DATA_PACKET_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = "<I"  # chunk_timestamp(u32) = 4 bytes
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = "<BI"  # sensor_id(u8), data(u32) = 5 bytes
SENSOR_DATAPOINT_SIZE = 5
PACKET_TYPE_SENSOR_DATA = 3  # PacketType.SENSOR_DATA
MAX_PACKET_SIZE = 512

# Calibration storage (config-driven)
CALIBRATION_DIR = _default_calibration_dir()
CALIBRATION_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class CalibrationPoint:
    """Calibration data point with ADC codes"""

    sensor_id: int
    adc_code: int  # Raw ADC code (32-bit signed)
    reference_pressure: float  # Reference pressure in PSI
    timestamp: float
    voltage: float = 0.0  # For display/reference
    quality_score: float = 1.0  # Quality of this point (0-1)


@dataclass
class SensorCalibrationState:
    """State for a single sensor's calibration"""

    sensor_id: int
    calibration_points: List[CalibrationPoint]
    polynomial_coeffs: Optional[Tuple[float, float, float, float]] = (
        None  # [A, B, C, D]
    )
    r_squared: float = 0.0
    confidence_level: str = "LOW"  # LOW, MEDIUM, HIGH, MAXIMUM
    last_updated: float = 0.0
    is_calibrated: bool = False


class AutonomousPTCalibrator:
    """
    Autonomous PT calibration system that automatically calibrates sensors
    by listening to raw DiabloAvionics UDP packets and collecting calibration
    points at known reference pressures.

    Data path: Board → UDP → this script (direct, no middleware needed)
    """

    def __init__(self, udp_port: int = None, board_ip: Optional[str] = None):
        if udp_port is None:
            udp_port = _default_port()
        if board_ip is None:
            board_ip = _default_board_ip()
        self.udp_port = udp_port
        self.board_ip = board_ip  # filter source IP (None = accept all)
        self.udp_connected = False

        # Sensor calibration states
        self.sensor_states: Dict[int, SensorCalibrationState] = {}

        # Reference pressure sources (can be set manually or from external gauges)
        self.reference_pressures: Dict[int, float] = {}  # sensor_id -> ref_psi

        # Live ADC buffers (for stability scoring)
        self.live_adc: Dict[int, deque] = defaultdict(lambda: deque(maxlen=200))

        # Calibration settings
        self.min_calibration_points = 5  # Minimum points for calibration
        self.target_calibration_points = 10  # Target points for good calibration
        self.max_calibration_points = 20  # Maximum points to keep

        # Quality thresholds
        self.min_r_squared = 0.95  # Minimum R² for acceptable calibration
        self.target_r_squared = 0.99  # Target R² for good calibration

        # Data collection
        self.running = False
        self.collecting = False  # True = actively recording points at current ref
        self.data_thread: Optional[threading.Thread] = None

        # Statistics
        self.stats = {
            "messages_received": 0,
            "packets_received": 0,
            "calibration_points_collected": 0,
            "calibrations_completed": 0,
            "start_time": time.time(),
        }

        logger.info("🤖 Autonomous PT Calibrator initialized")
        logger.info(f"   UDP port: {self.udp_port}")
        logger.info(f"   Board IP filter: {self.board_ip or 'any'}")

    # ── UDP packet parsing ──────────────────────────────────────────────
    @staticmethod
    def _parse_sensor_packet(data: bytes) -> Optional[List[Tuple[int, int, int]]]:
        """Parse a DiabloAvionics sensor data packet.
        Returns list of (sensor_id, adc_signed, adc_raw) or None."""
        if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE:
            return None
        pkt_type, _ver, _ts = struct.unpack(
            PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE]
        )
        if pkt_type != PACKET_TYPE_SENSOR_DATA:
            return None

        off = PACKET_HEADER_SIZE
        num_chunks, num_sensors = struct.unpack(
            SENSOR_DATA_PACKET_FORMAT, data[off : off + SENSOR_DATA_PACKET_SIZE]
        )
        off += SENSOR_DATA_PACKET_SIZE

        per_chunk = SENSOR_DATA_CHUNK_SIZE + num_sensors * SENSOR_DATAPOINT_SIZE
        expected = PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE + num_chunks * per_chunk
        if len(data) < expected:
            return None

        samples = []
        for _ in range(num_chunks):
            _chunk_ts = struct.unpack(
                SENSOR_DATA_CHUNK_FORMAT, data[off : off + SENSOR_DATA_CHUNK_SIZE]
            )
            off += SENSOR_DATA_CHUNK_SIZE
            for _ in range(num_sensors):
                sid, raw = struct.unpack(
                    SENSOR_DATAPOINT_FORMAT, data[off : off + SENSOR_DATAPOINT_SIZE]
                )
                off += SENSOR_DATAPOINT_SIZE
                adc_signed = raw if raw < 0x80000000 else raw - 0x100000000
                samples.append((sid, adc_signed, raw))
        return samples

    # ── Reference pressure management ───────────────────────────────────
    def set_reference_pressure(self, sensor_id: int, pressure_psi: float):
        """Set reference pressure for a sensor (from gauge, regulator, etc.)"""
        self.reference_pressures[sensor_id] = pressure_psi
        logger.info(
            f"📊 Set reference pressure for sensor {sensor_id}: {pressure_psi:.2f} PSI"
        )

    def set_reference_pressures(self, pressures: Dict[int, float]):
        """Set reference pressures for multiple sensors"""
        self.reference_pressures.update(pressures)
        logger.info(f"📊 Set reference pressures for {len(pressures)} sensors")

    def set_reference_all(self, pressure_psi: float, num_channels: int = None):
        """Set all channels to the same reference pressure (e.g. zero cal)"""
        if num_channels is None:
            num_channels = _default_num_sensors()
        for ch in range(1, num_channels + 1):
            self.reference_pressures[ch] = pressure_psi
        logger.info(f"📊 Set ALL channels (1-{num_channels}) → {pressure_psi:.2f} PSI")

    # ── Start / stop ────────────────────────────────────────────────────
    def start(self):
        """Start autonomous calibration (UDP listener thread)"""
        self.running = True
        self.data_thread = threading.Thread(
            target=self._data_collection_loop, daemon=True
        )
        self.data_thread.start()
        logger.info("🚀 Autonomous calibration started")
        return True

    def stop(self):
        """Stop autonomous calibration"""
        self.running = False
        if self.data_thread:
            self.data_thread.join(timeout=2.0)
        logger.info("🛑 Autonomous calibration stopped")

    def collect_samples(self, duration_sec: float = 5.0):
        """Collect calibration points for `duration_sec` at current references."""
        if not self.reference_pressures:
            logger.warning("⚠️  No reference pressures set — nothing to collect")
            return
        refs = ", ".join(
            f"CH{c}={v:.1f}" for c, v in sorted(self.reference_pressures.items())
        )
        logger.info(f"📊 Collecting for {duration_sec:.1f}s at: {refs}")
        self.collecting = True
        time.sleep(duration_sec)
        self.collecting = False
        logger.info(
            f"✅ Collection done — {self.stats['calibration_points_collected']} total points"
        )

    # ── UDP listener loop ───────────────────────────────────────────────
    def _data_collection_loop(self):
        """Main data collection loop — reads raw UDP packets from boards"""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(0.2)
        try:
            sock.bind(("0.0.0.0", self.udp_port))
            self.udp_connected = True
            logger.info(f"📡 Listening on UDP :{self.udp_port}")
        except OSError as e:
            logger.error(f"❌ Failed to bind UDP :{self.udp_port}: {e}")
            return

        last_auto_fit = time.time()
        last_auto_save = time.time()

        while self.running:
            try:
                data, addr = sock.recvfrom(MAX_PACKET_SIZE)
            except socket.timeout:
                continue
            except Exception as e:
                if self.running:
                    logger.error(f"recv error: {e}")
                continue

            source_ip = addr[0]
            if self.board_ip and source_ip != self.board_ip:
                continue

            samples = self._parse_sensor_packet(data)
            if samples is None:
                continue

            self.stats["packets_received"] += 1

            for sensor_id, adc_signed, adc_raw in samples:
                self.stats["messages_received"] += 1
                self.live_adc[sensor_id].append(adc_signed)

                # Only record calibration points when collecting is active
                if not self.collecting:
                    continue
                if sensor_id not in self.reference_pressures:
                    continue

                # Compute quality score from ADC stability
                buf = self.live_adc[sensor_id]
                quality = 1.0
                if len(buf) >= 10:
                    std = float(np.std(list(buf)[-50:]))
                    # Lower std = higher quality (normalize to ~0-1 range)
                    quality = max(0.1, 1.0 - min(std / 100000.0, 0.9))

                voltage = (adc_signed * 2.5) / 2147483648.0

                point = CalibrationPoint(
                    sensor_id=sensor_id,
                    adc_code=adc_signed,
                    reference_pressure=self.reference_pressures[sensor_id],
                    timestamp=time.time(),
                    voltage=voltage,
                    quality_score=quality,
                )
                self._add_calibration_point(point)

            # Periodic auto-fit (every 5s)
            now = time.time()
            if now - last_auto_fit > 5.0:
                self._auto_fit_calibrations()
                last_auto_fit = now

            # Periodic auto-save (every 60s)
            if now - last_auto_save > 60.0:
                self.save_calibrations()
                last_auto_save = now

        sock.close()
        self.udp_connected = False

    def _process_pt_sample(self, sensor_id: int, adc_signed: int, adc_raw: int):
        """Process a single PT ADC sample."""
        self.live_adc[sensor_id].append(adc_signed)

        if not self.collecting or sensor_id not in self.reference_pressures:
            return

        voltage = (adc_signed * 2.5) / 2147483648.0
        point = CalibrationPoint(
            sensor_id=sensor_id,
            adc_code=adc_signed,
            reference_pressure=self.reference_pressures[sensor_id],
            timestamp=time.time(),
            voltage=voltage,
            quality_score=1.0,
        )
        self._add_calibration_point(point)

    def _add_calibration_point(self, point: CalibrationPoint):
        """Add a calibration point for a sensor"""
        sensor_id = point.sensor_id

        # Initialize sensor state if needed
        if sensor_id not in self.sensor_states:
            self.sensor_states[sensor_id] = SensorCalibrationState(
                sensor_id=sensor_id, calibration_points=[]
            )

        state = self.sensor_states[sensor_id]

        # Add point
        state.calibration_points.append(point)
        self.stats["calibration_points_collected"] += 1

        # Limit number of points
        if len(state.calibration_points) > self.max_calibration_points:
            state.calibration_points = state.calibration_points[
                -self.max_calibration_points :
            ]

        logger.debug(
            f"📝 Added calibration point for sensor {sensor_id}: "
            f"ADC={point.adc_code}, Pressure={point.reference_pressure:.2f} PSI"
        )

    def _auto_fit_calibrations(self):
        """Automatically fit calibration polynomials when enough points are collected"""
        for sensor_id, state in self.sensor_states.items():
            if len(state.calibration_points) >= self.min_calibration_points:
                if not state.is_calibrated or len(state.calibration_points) % 2 == 0:
                    # Fit calibration
                    success = self._fit_calibration(sensor_id)
                    if success and not state.is_calibrated:
                        state.is_calibrated = True
                        self.stats["calibrations_completed"] += 1
                        logger.info(
                            f"✅ Auto-calibrated sensor {sensor_id}: "
                            f"R²={state.r_squared:.4f}, {len(state.calibration_points)} points"
                        )

    def _fit_calibration(self, sensor_id: int) -> bool:
        """Fit calibration polynomial for a sensor"""
        if sensor_id not in self.sensor_states:
            return False

        state = self.sensor_states[sensor_id]

        if len(state.calibration_points) < self.min_calibration_points:
            return False

        try:
            # Extract ADC codes and pressures
            adc_codes = np.array([p.adc_code for p in state.calibration_points])
            pressures = np.array(
                [p.reference_pressure for p in state.calibration_points]
            )

            # Fit cubic polynomial: psi = A*adc³ + B*adc² + C*adc + D
            poly_coeffs = np.polyfit(adc_codes, pressures, 3)

            # Calculate R²
            y_pred = np.polyval(poly_coeffs, adc_codes)
            ss_res = np.sum((pressures - y_pred) ** 2)
            ss_tot = np.sum((pressures - np.mean(pressures)) ** 2)
            r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

            # Update state
            state.polynomial_coeffs = tuple(poly_coeffs)
            state.r_squared = r_squared
            state.last_updated = time.time()

            # Update confidence level
            if (
                r_squared >= self.target_r_squared
                and len(state.calibration_points) >= self.target_calibration_points
            ):
                state.confidence_level = "MAXIMUM"
            elif (
                r_squared >= self.min_r_squared
                and len(state.calibration_points) >= self.min_calibration_points
            ):
                state.confidence_level = "HIGH"
            elif len(state.calibration_points) >= self.min_calibration_points:
                state.confidence_level = "MEDIUM"
            else:
                state.confidence_level = "LOW"

            return True

        except Exception as e:
            logger.error(f"Error fitting calibration for sensor {sensor_id}: {e}")
            return False

    def save_calibrations(self):
        """Save all calibrations to JSON + CSV files (C++ stack reads both)"""
        calibrated = {
            sid: s for sid, s in self.sensor_states.items() if s.polynomial_coeffs
        }
        if not calibrated:
            return None

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # ── JSON (primary format the C++ SensorCalibrationManager loads) ──
        try:
            json_path = CALIBRATION_DIR / f"pt_calibration_{timestamp}.json"
            data = {
                "sensor_type": "PT",
                "unit": "PSI",
                "polynomial_order": 3,
                "created": datetime.now().isoformat(),
                "calibration_polynomials": {},
                "quality": {},
            }
            for sensor_id, state in sorted(calibrated.items()):
                data["calibration_polynomials"][str(sensor_id)] = list(
                    state.polynomial_coeffs
                )
                data["quality"][str(sensor_id)] = {
                    "r_squared": state.r_squared,
                    "confidence_level": state.confidence_level,
                    "num_points": len(state.calibration_points),
                    "last_updated": state.last_updated,
                }
            with open(json_path, "w") as f:
                json.dump(data, f, indent=2)
            logger.info(f"💾 JSON: {json_path}")
        except Exception as e:
            logger.error(f"Error saving JSON: {e}")
            json_path = None

        # ── CSV (DiabloAvionics compat format) ──
        try:
            csv_path = CALIBRATION_DIR / f"pt_calibration_{timestamp}.csv"
            cols = ["Timestamp"]
            for ch in sorted(calibrated.keys()):
                for ci in range(4):
                    cols.append(f"PT{ch} Coefficient {ci}")

            row = [datetime.now().isoformat()]
            for ch in sorted(calibrated.keys()):
                coeffs = calibrated[ch].polynomial_coeffs or (0, 0, 0, 0)
                for ci in range(4):
                    row.append(f"{coeffs[ci]:.15e}" if ci < len(coeffs) else "0.0")

            with open(csv_path, "w") as f:
                f.write(",".join(cols) + "\n")
                f.write(",".join(row) + "\n")
            logger.info(f"💾 CSV: {csv_path}")
        except Exception as e:
            logger.error(f"Error saving CSV: {e}")

        return json_path

    def get_status(self) -> dict:
        """Get calibration status"""
        status = {
            "udp_connected": self.udp_connected,
            "running": self.running,
            "collecting": self.collecting,
            "sensors": {},
            "stats": self.stats.copy(),
        }

        for sensor_id, state in self.sensor_states.items():
            status["sensors"][sensor_id] = {
                "num_points": len(state.calibration_points),
                "is_calibrated": state.is_calibrated,
                "r_squared": state.r_squared,
                "confidence_level": state.confidence_level,
                "has_reference": sensor_id in self.reference_pressures,
            }

        return status

    def print_status(self):
        """Print calibration status"""
        status = self.get_status()
        print("\n" + "=" * 70)
        print("🤖 Autonomous PT Calibration Status")
        print("=" * 70)
        print(
            f"UDP: {'✅ Listening :{}'.format(self.udp_port) if status['udp_connected'] else '❌ Not connected'}"
        )
        print(f"Running: {'✅ Yes' if status['running'] else '❌ No'}")
        print(f"Collecting: {'📊 YES' if status['collecting'] else '⏸  No'}")
        print(f"\nStatistics:")
        print(f"  Packets received:     {status['stats']['packets_received']}")
        print(f"  Samples received:     {status['stats']['messages_received']}")
        print(
            f"  Calibration points:   {status['stats']['calibration_points_collected']}"
        )
        print(f"  Calibrations done:    {status['stats']['calibrations_completed']}")

        # Live ADC values
        if self.live_adc:
            print(f"\nLive ADC:")
            for ch in sorted(self.live_adc.keys()):
                buf = self.live_adc[ch]
                if len(buf) > 0:
                    mean = int(np.mean(list(buf)))
                    std = int(np.std(list(buf)))
                    print(f"  CH{ch:>2d}: ADC={mean:>11d}  σ={std:>8d}")

        print(f"\nCalibration Channels:")
        for sensor_id in sorted(
            set(list(self.sensor_states.keys()) + list(self.live_adc.keys()))
        ):
            state = self.sensor_states.get(sensor_id)
            ref = self.reference_pressures.get(sensor_id)
            ref_str = f"  ref={ref:.1f} PSI" if ref is not None else ""

            if state:
                cal_str = (
                    f"R²={state.r_squared:.4f} [{state.confidence_level}]"
                    if state.is_calibrated
                    else "⏳ collecting"
                )
                print(
                    f"  CH{sensor_id:>2d}: {len(state.calibration_points):>3d} pts  "
                    f"{'✅' if state.is_calibrated else '  '} {cal_str}{ref_str}"
                )
            else:
                print(f"  CH{sensor_id:>2d}:   0 pts     no data yet{ref_str}")
        print("=" * 70 + "\n")


def main():
    """Main entry point — interactive or scripted PT calibration via UDP"""
    import argparse

    parser = argparse.ArgumentParser(
        description="Autonomous PT Calibration System (UDP)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Interactive mode — prompts for reference pressures
  python3 autonomous_pt_calibration.py --interactive

  # Zero-cal all channels
  python3 autonomous_pt_calibration.py --ref-all 0.0 --collect-time 10

  # Specific channels
  python3 autonomous_pt_calibration.py --sensor 1 --pressure 14.7 --sensor 2 --pressure 100.0
        """,
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="UDP port to listen on (default: from config.toml)",
    )
    parser.add_argument(
        "--board-ip",
        default=None,
        help="Filter by board source IP (default: from config.toml)",
    )
    parser.add_argument(
        "--reference-pressures",
        type=str,
        help="JSON file with reference pressures {channel_id: psi}",
    )
    parser.add_argument(
        "--sensor", type=int, action="append", help="Sensor channel ID to calibrate"
    )
    parser.add_argument(
        "--pressure",
        type=float,
        action="append",
        help="Reference pressure (PSI) — paired with --sensor",
    )
    parser.add_argument(
        "--ref-all",
        type=float,
        default=None,
        help="Set all channels (1-10) to this reference pressure",
    )
    parser.add_argument(
        "--collect-time",
        type=float,
        default=5.0,
        help="Seconds to collect per reference point (default: 5)",
    )
    parser.add_argument(
        "--status-interval",
        type=float,
        default=10.0,
        help="Status print interval in seconds (default: 10)",
    )
    parser.add_argument(
        "--interactive",
        "-i",
        action="store_true",
        help="Interactive mode — prompt for commands",
    )

    args = parser.parse_args()

    # Create calibrator
    calibrator = AutonomousPTCalibrator(udp_port=args.port, board_ip=args.board_ip)

    # Load reference pressures from file
    if args.reference_pressures:
        with open(args.reference_pressures, "r") as f:
            ref_pressures = json.load(f)
            # Convert keys to int
            calibrator.set_reference_pressures(
                {int(k): float(v) for k, v in ref_pressures.items()}
            )

    # Set from --ref-all
    if args.ref_all is not None:
        calibrator.set_reference_all(args.ref_all)

    # Set from --sensor / --pressure pairs
    if args.sensor and args.pressure:
        if len(args.sensor) != len(args.pressure):
            print("❌ Error: Number of --sensor must match number of --pressure")
            return 1
        for sensor_id, pressure in zip(args.sensor, args.pressure):
            calibrator.set_reference_pressure(sensor_id, pressure)

    # Start UDP listener
    calibrator.start()
    time.sleep(1.0)

    def shutdown(sig=None, frame=None):
        print("\n🛑 Stopping...")
        calibrator.stop()
        calibrator.save_calibrations()
        calibrator.print_status()
        print("✅ Calibrations saved")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    if args.interactive:
        # ── Interactive calibration loop ────────────────────────────────
        print(f"\n{'═' * 70}")
        print("  INTERACTIVE PT CALIBRATION (UDP)")
        print(f"  Listening on UDP :{args.port}")
        print(f"{'═' * 70}")
        print("  Commands:")
        print("    ref <ch> <psi>     — set reference for one channel")
        print("    ref-all <psi>      — set reference for all channels (1-10)")
        print("    collect [secs]     — collect calibration points")
        print("    fit                — fit polynomials now")
        print("    save               — save calibrations to JSON + CSV")
        print("    status             — show full status")
        print("    live               — show live ADC values (Ctrl+C to stop)")
        print("    quit               — save and exit")
        print()

        while True:
            try:
                cmd = input("  [PT] > ").strip()
            except EOFError:
                break
            if not cmd:
                continue
            parts = cmd.split()
            verb = parts[0].lower()

            if verb == "ref-all" and len(parts) >= 2:
                calibrator.set_reference_all(float(parts[1]))
            elif verb == "ref" and len(parts) >= 3:
                calibrator.set_reference_pressure(int(parts[1]), float(parts[2]))
            elif verb == "collect":
                dur = float(parts[1]) if len(parts) > 1 else args.collect_time
                calibrator.collect_samples(dur)
            elif verb == "fit":
                calibrator._auto_fit_calibrations()
                calibrator.print_status()
            elif verb == "save":
                calibrator._auto_fit_calibrations()
                calibrator.save_calibrations()
            elif verb == "status":
                calibrator.print_status()
            elif verb == "live":
                print("  (Ctrl+C to stop live view)")
                try:
                    while True:
                        parts_live = []
                        for ch in sorted(calibrator.live_adc.keys()):
                            buf = calibrator.live_adc[ch]
                            if len(buf) > 0:
                                parts_live.append(
                                    f"CH{ch}:{int(np.mean(list(buf))):>10d}"
                                )
                        print(
                            f"\r  [{calibrator.stats['packets_received']:>6d} pkts] "
                            + "  ".join(parts_live),
                            end="",
                            flush=True,
                        )
                        time.sleep(0.25)
                except KeyboardInterrupt:
                    print()
            elif verb in ("quit", "exit", "q"):
                shutdown()
            else:
                print(f"  ⚠️  Unknown command: {cmd}")

    else:
        # ── Non-interactive mode ────────────────────────────────────────
        if not calibrator.reference_pressures:
            print("⚠️  No references set — showing live ADC (Ctrl+C to stop)")
            try:
                while True:
                    calibrator.print_status()
                    time.sleep(args.status_interval)
            except KeyboardInterrupt:
                shutdown()
        else:
            # Collect at current references and save
            calibrator.collect_samples(args.collect_time)
            calibrator._auto_fit_calibrations()
            calibrator.save_calibrations()
            calibrator.print_status()
            calibrator.stop()

    return 0


if __name__ == "__main__":
    sys.exit(main())

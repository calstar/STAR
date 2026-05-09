#!/usr/bin/env python3
"""
Autonomous RTD Calibration System
Reads raw resistance counts from RTD boards via UDP, collects calibration points
at known reference temperatures, fits polynomials, and saves coefficients.

All board IPs, ports, and sensor counts come from config/config.toml.

Polynomial model: temp_°C = A·counts³ + B·counts² + C·counts + D

Usage:
  python3 autonomous_rtd_calibration.py --interactive
  python3 autonomous_rtd_calibration.py --ref-all 25.0 --collect-time 10
"""

import sys, os, time, json, socket, struct, signal, threading, logging
import numpy as np
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass
from collections import deque, defaultdict
from datetime import datetime

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
    return get_sensor_port() if _cfg_loaded else 5006


def _default_board_ip():
    if _cfg_loaded:
        b = get_board_by_type("RTD")
        if b:
            return b.get("ip")
    return "192.168.2.104"


def _default_num_sensors():
    if _cfg_loaded:
        b = get_board_by_type("RTD")
        if b:
            return b.get("num_sensors", 4)
    return 4


def _default_calibration_dir():
    if _cfg_loaded:
        cc = get_calibration_config("rtd")
        jd = cc.get("json_dir")
        if jd:
            return resolve_path(jd)
    return Path(__file__).parent / "calibrations" / "rtd"


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

CALIBRATION_DIR = _default_calibration_dir()
CALIBRATION_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class CalibrationPoint:
    sensor_id: int
    resistance_counts: int
    reference_temp_c: float
    timestamp: float
    quality_score: float = 1.0


@dataclass
class SensorCalibrationState:
    sensor_id: int
    calibration_points: List[CalibrationPoint]
    polynomial_coeffs: Optional[tuple] = None
    r_squared: float = 0.0
    confidence_level: str = "LOW"
    last_updated: float = 0.0
    is_calibrated: bool = False


class AutonomousRTDCalibrator:
    """Autonomous RTD calibration via direct UDP board packets."""

    def __init__(self, udp_port=None, board_ip=None):
        if udp_port is None:
            udp_port = _default_port()
        if board_ip is None:
            board_ip = _default_board_ip()
        self.udp_port = udp_port
        self.board_ip = board_ip
        self.udp_connected = False
        self.sensor_states: Dict[int, SensorCalibrationState] = {}
        self.reference_temps: Dict[int, float] = {}
        self.live_adc: Dict[int, deque] = defaultdict(lambda: deque(maxlen=200))
        self.min_calibration_points = 5
        self.target_calibration_points = 10
        self.max_calibration_points = 20
        self.min_r_squared = 0.95
        self.target_r_squared = 0.99
        self.running = False
        self.collecting = False
        self.data_thread = None
        self.stats = {
            "packets_received": 0,
            "messages_received": 0,
            "calibration_points_collected": 0,
            "calibrations_completed": 0,
            "start_time": time.time(),
        }
        logger.info("🌡️  Autonomous RTD Calibrator initialized")

    @staticmethod
    def _parse_sensor_packet(data):
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
        if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE + nc * per:
            return None
        samples = []
        for _ in range(nc):
            off += SENSOR_DATA_CHUNK_SIZE
            for _ in range(ns):
                sid, raw = struct.unpack(
                    SENSOR_DATAPOINT_FORMAT, data[off : off + SENSOR_DATAPOINT_SIZE]
                )
                off += SENSOR_DATAPOINT_SIZE
                signed = raw if raw < 0x80000000 else raw - 0x100000000
                samples.append((sid, signed, raw))
        return samples

    def set_reference_temp(self, ch, temp_c):
        self.reference_temps[ch] = temp_c
        logger.info(f"🌡️  RTD CH{ch} → {temp_c:.1f} °C")

    def set_reference_all(self, temp_c, n=None):
        if n is None:
            n = _default_num_sensors()
        for ch in range(1, n + 1):
            self.reference_temps[ch] = temp_c
        logger.info(f"🌡️  RTD all (1-{n}) → {temp_c:.1f} °C")

    def start(self):
        self.running = True
        self.data_thread = threading.Thread(target=self._listen, daemon=True)
        self.data_thread.start()
        return True

    def stop(self):
        self.running = False
        if self.data_thread:
            self.data_thread.join(timeout=2)

    def collect_samples(self, dur=5.0):
        if not self.reference_temps:
            logger.warning("No reference temps set")
            return
        logger.info(f"📊 Collecting RTD data for {dur:.1f}s")
        self.collecting = True
        time.sleep(dur)
        self.collecting = False
        logger.info(f"✅ {self.stats['calibration_points_collected']} total points")

    def _listen(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(0.2)
        try:
            sock.bind(("0.0.0.0", self.udp_port))
            self.udp_connected = True
            logger.info(f"📡 RTD listening UDP :{self.udp_port}")
        except OSError as e:
            logger.error(f"Bind failed: {e}")
            return
        while self.running:
            try:
                data, addr = sock.recvfrom(MAX_PACKET_SIZE)
            except socket.timeout:
                continue
            except Exception as e:
                if self.running:
                    logger.error(f"recv: {e}")
                continue
            if self.board_ip and addr[0] != self.board_ip:
                continue
            samples = self._parse_sensor_packet(data)
            if not samples:
                continue
            self.stats["packets_received"] += 1
            for sid, signed, raw in samples:
                self.stats["messages_received"] += 1
                self.live_adc[sid].append(signed)
                if self.collecting and sid in self.reference_temps:
                    pt = CalibrationPoint(
                        sid, signed, self.reference_temps[sid], time.time()
                    )
                    self._add_point(pt)
        sock.close()
        self.udp_connected = False

    def _add_point(self, pt):
        if pt.sensor_id not in self.sensor_states:
            self.sensor_states[pt.sensor_id] = SensorCalibrationState(pt.sensor_id, [])
        s = self.sensor_states[pt.sensor_id]
        s.calibration_points.append(pt)
        self.stats["calibration_points_collected"] += 1
        if len(s.calibration_points) > self.max_calibration_points:
            s.calibration_points = s.calibration_points[-self.max_calibration_points :]

    def auto_fit(self):
        for sid, s in self.sensor_states.items():
            if len(s.calibration_points) < self.min_calibration_points:
                continue
            counts = np.array(
                [p.resistance_counts for p in s.calibration_points], dtype=np.float64
            )
            ref = np.array(
                [p.reference_temp_c for p in s.calibration_points], dtype=np.float64
            )
            if np.std(ref) < 1e-9:
                s.polynomial_coeffs = (0.0, 0.0, 0.0, float(np.mean(ref)))
                s.r_squared = 0.0
                s.is_calibrated = True
                continue
            try:
                c = np.polyfit(counts, ref, min(3, len(s.calibration_points) - 1))
                while len(c) < 4:
                    c = np.insert(c, 0, 0.0)
                s.polynomial_coeffs = tuple(c)
                pred = np.polyval(c, counts)
                ss_r = np.sum((ref - pred) ** 2)
                ss_t = np.sum((ref - np.mean(ref)) ** 2)
                s.r_squared = 1 - ss_r / ss_t if ss_t > 0 else 0
                s.last_updated = time.time()
                if (
                    s.r_squared >= self.target_r_squared
                    and len(s.calibration_points) >= self.target_calibration_points
                ):
                    s.confidence_level = "MAXIMUM"
                elif s.r_squared >= self.min_r_squared:
                    s.confidence_level = "HIGH"
                else:
                    s.confidence_level = "MEDIUM"
                if not s.is_calibrated:
                    s.is_calibrated = True
                    self.stats["calibrations_completed"] += 1
            except Exception as e:
                logger.error(f"Fit failed CH{sid}: {e}")

    def save_calibrations(self):
        cal = {sid: s for sid, s in self.sensor_states.items() if s.polynomial_coeffs}
        if not cal:
            return None
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        jp = CALIBRATION_DIR / f"rtd_calibration_{ts}.json"
        data = {
            "sensor_type": "RTD",
            "unit": "°C",
            "polynomial_order": 3,
            "created": datetime.now().isoformat(),
            "calibration_polynomials": {},
            "quality": {},
        }
        for sid, s in sorted(cal.items()):
            data["calibration_polynomials"][str(sid)] = list(s.polynomial_coeffs)
            data["quality"][str(sid)] = {
                "r_squared": s.r_squared,
                "confidence_level": s.confidence_level,
                "num_points": len(s.calibration_points),
            }
        with open(jp, "w") as f:
            json.dump(data, f, indent=2)
        logger.info(f"💾 {jp}")
        return jp

    def print_status(self):
        print(f"\n{'═'*70}")
        print("🌡️  Autonomous RTD Calibration Status")
        print(f"{'═'*70}")
        print(f"UDP: {'✅ :'+str(self.udp_port) if self.udp_connected else '❌'}")
        print(
            f"Pkts: {self.stats['packets_received']}  Samples: {self.stats['messages_received']}  Points: {self.stats['calibration_points_collected']}"
        )
        for ch in sorted(
            set(list(self.sensor_states.keys()) + list(self.live_adc.keys()))
        ):
            s = self.sensor_states.get(ch)
            buf = self.live_adc.get(ch)
            adc_str = (
                f"R_cnt={int(np.mean(list(buf))):>10d}"
                if buf and len(buf)
                else "R_cnt=---"
            )
            ref = self.reference_temps.get(ch)
            ref_str = f"  ref={ref:.1f}°C" if ref is not None else ""
            if s:
                cal = (
                    f"R²={s.r_squared:.4f} [{s.confidence_level}]"
                    if s.is_calibrated
                    else "⏳"
                )
                print(
                    f"  CH{ch:>2d}: {len(s.calibration_points):>3d} pts  {cal}  {adc_str}{ref_str}"
                )
            else:
                print(f"  CH{ch:>2d}:   0 pts  ---  {adc_str}{ref_str}")
        print(f"{'═'*70}\n")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Autonomous RTD Calibration (UDP)")
    parser.add_argument(
        "--port", type=int, default=None, help="UDP port (default: from config.toml)"
    )
    parser.add_argument(
        "--board-ip", default=None, help="Board IP filter (default: from config.toml)"
    )
    parser.add_argument("--sensor", type=int, action="append")
    parser.add_argument("--temp", type=float, action="append")
    parser.add_argument("--ref-all", type=float, default=None)
    parser.add_argument("--collect-time", type=float, default=5.0)
    parser.add_argument("--interactive", "-i", action="store_true")
    args = parser.parse_args()

    cal = AutonomousRTDCalibrator(args.port, args.board_ip)
    if args.ref_all is not None:
        cal.set_reference_all(args.ref_all)
    if args.sensor and args.temp:
        for s, t in zip(args.sensor, args.temp):
            cal.set_reference_temp(s, t)
    cal.start()
    time.sleep(1)

    def shutdown(*_):
        cal.stop()
        cal.auto_fit()
        cal.save_calibrations()
        cal.print_status()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)

    if args.interactive:
        print(
            "Commands: ref <ch> <°C> | ref-all <°C> | collect [s] | fit | save | status | quit"
        )
        while True:
            try:
                cmd = input("  [RTD] > ").strip()
            except EOFError:
                break
            if not cmd:
                continue
            p = cmd.split()
            v = p[0].lower()
            if v == "ref-all" and len(p) >= 2:
                cal.set_reference_all(float(p[1]))
            elif v == "ref" and len(p) >= 3:
                cal.set_reference_temp(int(p[1]), float(p[2]))
            elif v == "collect":
                cal.collect_samples(float(p[1]) if len(p) > 1 else args.collect_time)
            elif v == "fit":
                cal.auto_fit()
                cal.print_status()
            elif v == "save":
                cal.auto_fit()
                cal.save_calibrations()
            elif v == "status":
                cal.print_status()
            elif v in ("quit", "exit", "q"):
                shutdown()
            else:
                print(f"  ⚠️  Unknown: {cmd}")
    else:
        if cal.reference_temps:
            cal.collect_samples(args.collect_time)
            cal.auto_fit()
            cal.save_calibrations()
            cal.print_status()
            cal.stop()
        else:
            print("No refs set — showing live (Ctrl+C to stop)")
            while True:
                cal.print_status()
                time.sleep(10)


if __name__ == "__main__":
    sys.exit(main())

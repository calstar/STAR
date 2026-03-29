#!/usr/bin/env python3
import socket
import struct
import time
import threading
import random
import tomli
import os
import argparse
import json
import math

# DiabloAvionics Packet Types (DAQv2-Comms DiabloEnums.h)
PACKET_TYPE_HEARTBEAT = 1
PACKET_TYPE_SENSOR_DATA = 3
PACKET_TYPE_ACTUATOR_COMMAND = 4
PACKET_TYPE_SENSOR_CONFIG = 5
PACKET_TYPE_SELF_TEST = 12

# Board States (DAQv2-Comms DiabloEnums.h)
BOARD_STATE_SETUP = 1
BOARD_STATE_ACTIVE = 2
BOARD_STATE_SELF_TEST = 10

# Board Types
BOARD_TYPE_PT = 1
BOARD_TYPE_LC = 2
BOARD_TYPE_RTD = 3
BOARD_TYPE_TC = 4
BOARD_TYPE_ACTUATOR = 5


class SimulatedBoard:
    def __init__(
        self,
        name,
        board_config,
        target_ip,
        target_port,
        low_noise=False,
        board_index=0,
        sim_pt_targets=None,
        skip_startup=False,
    ):
        self.name = name
        self.board_index = board_index
        self.config = board_config
        self.target_ip = target_ip
        self.target_port = target_port
        self.low_noise = low_noise
        self.sim_pt_targets = sim_pt_targets or {}

        self.ip = board_config.get("ip", "127.0.0.1")
        self.board_id = board_config.get("board_id", 0)
        self.board_type_str = board_config.get("type", "PT")
        self.num_sensors = board_config.get("num_sensors", 10)
        self.channel_offset = board_config.get("channel_offset", 0)
        self.listen_port = board_config.get("listen_port", 5005)

        # Map string type to enum
        type_map = {
            "PT": BOARD_TYPE_PT,
            "LC": BOARD_TYPE_LC,
            "RTD": BOARD_TYPE_RTD,
            "TC": BOARD_TYPE_TC,
            "ACTUATOR": BOARD_TYPE_ACTUATOR,
            # Diablo::BoardType has no ENCODER yet — wire UNKNOWN(0); config drives routing.
            "ENCODER": 0,
        }
        self.board_type = type_map.get(self.board_type_str, BOARD_TYPE_PT)

        # HP PT specific settings
        self.hp_pt_connectors = set(board_config.get("hp_pt_connectors", []))
        self.excitation_id = board_config.get("excitation_connector_id", -1)
        self.hp_pt_full_scale_psi = board_config.get("hp_pt_full_scale_psi", 5000.0)
        self.hp_pt_sense_resistor_ohms = board_config.get(
            "hp_pt_sense_resistor_ohms", 120
        )

        # State machine (matches SensorHotfireCore.h lifecycle)
        self.board_state = BOARD_STATE_ACTIVE if skip_startup else BOARD_STATE_SETUP
        self.setup_start_time = None
        self.setup_timeout = 10.0  # fallback to ACTIVE if no SENSOR_CONFIG
        self.can_receive = False  # whether socket is bound to listen_port

        self.running = False
        self.sock = None
        self.thread = None
        self.packets_sent = 0

    def start(self):
        self.running = True
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

        bind_ip = self.ip
        bind_port = self.listen_port if self.board_state == BOARD_STATE_SETUP else 0

        try:
            self.sock.bind((bind_ip, bind_port))
            self.can_receive = bind_port != 0
            print(
                f"[{self.name}] Bound to {bind_ip}:{bind_port}", flush=True
            )
        except Exception:
            # When config IPs (e.g. 192.168.2.21) are not on this host, use distinct
            # loopback IPs so daq_bridge can route each board's data correctly.
            # 127.0.0.2 = first board, 127.0.0.3 = second, etc.
            fallback_ip = f"127.0.0.{2 + self.board_index}"
            try:
                self.sock.bind((fallback_ip, bind_port))
                self.ip = fallback_ip
                self.can_receive = bind_port != 0
                print(
                    f"[{self.name}] Bound to {fallback_ip}:{bind_port} (config IP {self.config.get('ip')} unavailable)",
                    flush=True,
                )
            except Exception:
                # Last resort: ephemeral port, can't receive SENSOR_CONFIG
                try:
                    self.sock.bind((fallback_ip, 0))
                    self.ip = fallback_ip
                except Exception:
                    pass
                if self.board_state == BOARD_STATE_SETUP:
                    print(
                        f"[{self.name}] Warning: Could not bind to port {bind_port}, skipping startup lifecycle",
                        flush=True,
                    )
                    self.board_state = BOARD_STATE_ACTIVE

        # Non-blocking for interleaved send/receive
        self.sock.settimeout(0)

        self.thread = threading.Thread(target=self._run)
        self.thread.daemon = True
        self.thread.start()

    def _run(self):
        last_heartbeat = 0
        last_sensor_data = 0
        self.setup_start_time = time.time()

        heartbeat_interval = 1.0  # 1 Hz
        sensor_interval = 0.02 if self.board_type_str == "ENCODER" else 0.1  # 50 Hz for ENCODER, 10 Hz for others

        while self.running:
            now = time.time()
            ts_ms = int(now * 1000) & 0xFFFFFFFF

            # --- SETUP: check for SENSOR_CONFIG ---
            if self.board_state == BOARD_STATE_SETUP:
                if self.can_receive:
                    self._check_for_sensor_config()
                # Timeout fallback
                if self.board_state == BOARD_STATE_SETUP and (now - self.setup_start_time) > self.setup_timeout:
                    print(
                        f"[{self.name}] SETUP timeout ({self.setup_timeout}s), going ACTIVE",
                        flush=True,
                    )
                    self.board_state = BOARD_STATE_ACTIVE

            # --- Send Heartbeat (all states, matching firmware) ---
            if now - last_heartbeat >= heartbeat_interval:
                self._send_heartbeat(ts_ms)
                last_heartbeat = now

            # --- Send Sensor Data (ACTIVE only, matching firmware) ---
            if self.board_state == BOARD_STATE_ACTIVE:
                if now - last_sensor_data >= sensor_interval:
                    self._send_sensor_data(ts_ms)
                    last_sensor_data = now

            time.sleep(0.01)

    def _check_for_sensor_config(self):
        """Non-blocking check for SENSOR_CONFIG packet from config_broadcast_service."""
        try:
            data, addr = self.sock.recvfrom(4096)
            if data and len(data) >= 1 and data[0] == PACKET_TYPE_SENSOR_CONFIG:
                print(
                    f"[{self.name}] SENSOR_CONFIG received from {addr}, running self-test",
                    flush=True,
                )
                # Firmware: run self-test once, send results, immediately go ACTIVE
                # (SensorHotfireCore.h: SelfTest state is transient — same loop iteration)
                self._send_self_test()
                self.board_state = BOARD_STATE_ACTIVE
                print(
                    f"[{self.name}] SELF_TEST sent, transitioning to ACTIVE",
                    flush=True,
                )
        except (BlockingIOError, socket.timeout, OSError):
            pass

    def _send_self_test(self):
        """Send SELF_TEST packet with pass results for all active connectors.

        Matches firmware SelfTestPacket: header(6B) + adc_good(1B) + num_sensors(1B)
        + N x (sensor_id(1B) + result(1B)).
        """
        active_connectors = self.config.get("active_connectors", [])
        if not active_connectors:
            active_connectors = list(range(1, self.num_sensors + 1))

        ts_ms = int(time.time() * 1000) & 0xFFFFFFFF
        header = struct.pack("<BBI", PACKET_TYPE_SELF_TEST, 0, ts_ms)

        adc_good = 1  # ADC TDAC self-test passed
        n = min(len(active_connectors), 255)
        body = struct.pack("BB", adc_good, n)
        for sensor_id in active_connectors[:n]:
            body += struct.pack("BB", sensor_id & 0xFF, 1)  # 1 = pass

        try:
            self.sock.sendto(header + body, (self.target_ip, self.target_port))
        except Exception:
            pass

    def _send_heartbeat(self, ts_ms):
        # DAQv2-Comms: PacketHeader (6B) + BoardHeartbeatPacket = 32B firmware_hash + board_id +
        # EngineState + BoardState (no board_type on wire — FSW maps type from config by source IP).
        header = struct.pack("<BBI", PACKET_TYPE_HEARTBEAT, 0, ts_ms)
        firmware_hash = bytes(32)
        engine_safe = 0
        body = firmware_hash + struct.pack(
            "<BBB", self.board_id & 0xFF, engine_safe, self.board_state
        )
        try:
            self.sock.sendto(header + body, (self.target_ip, self.target_port))
        except Exception:
            pass

    def _send_sensor_data(self, ts_ms):
        header = struct.pack("<BB I", PACKET_TYPE_SENSOR_DATA, 0, ts_ms)

        active_connectors = self.config.get("active_connectors", [])
        if not active_connectors:
            active_connectors = list(range(1, self.num_sensors + 1))

        num_chunks = 1
        body_header = struct.pack("<BB", num_chunks, len(active_connectors))

        chunk_ts = ts_ms
        chunk_data = struct.pack("<I", chunk_ts)

        for sensor_id in active_connectors:
            val = self._generate_data(sensor_id)
            chunk_data += struct.pack("<B I", sensor_id, val)

        try:
            self.sock.sendto(
                header + body_header + chunk_data, (self.target_ip, self.target_port)
            )
            self.packets_sent += 1
        except Exception:
            pass

    def _generate_data(self, sensor_id):
        t = time.time()
        ADC_MAX = 2147483648  # 2^31 as per backend logic

        if sensor_id == self.excitation_id:
            # Excitation feed: ~1.8V on 2.5V ref (must be > 0 for backend to accept HP PT)
            return int(ADC_MAX * 1.8 / 2.5)

        if self.board_type == BOARD_TYPE_PT:
            # Global channel for pt_board_2 (connector 1 → ch11, etc.)
            global_ch = sensor_id + self.channel_offset
            target_psi = self.sim_pt_targets.get(global_ch) or self.sim_pt_targets.get(
                sensor_id
            )

            if sensor_id in self.hp_pt_connectors:
                # HP PT (4-20 mA): psi = (i-4)/16 * full_scale. adc ∝ i.
                # i_ma = 4 + 16*psi/full_scale; v = i*R/1000; adc = v/2.5 * ADC_MAX
                psi = target_psi or 4000.0
                psi = min(psi, self.hp_pt_full_scale_psi)
                i_ma = 4.0 + 16.0 * (psi / self.hp_pt_full_scale_psi)
                v_sense = i_ma * self.hp_pt_sense_resistor_ohms / 1000.0
                adc_base = int(v_sense / 2.5 * ADC_MAX)
                noise = 0 if self.low_noise else random.randint(-50000, 50000)
                return max(0, min(adc_base + noise, ADC_MAX - 1))
            else:
                # Low-pressure PT: calibration psi ≈ C*adc + D (C≈6e-7, D≈-165)
                # adc ≈ (target_psi + 165) / 6e-7 for typical polynomial
                psi = target_psi or 500.0
                adc_per_psi = 2_200_000  # ~(1/6e-7) for typical calibration
                adc_base = int(500_000 + (psi + 165) * adc_per_psi)
                if self.low_noise:
                    return max(0, min(adc_base, ADC_MAX - 1))
                wave = (math.sin(t * 0.1 + sensor_id * 0.5) + 1) / 2.0
                variation = int(20_000_000 * wave)  # ±10M for slight movement
                noise = random.randint(-10000, 10000)
                return max(0, min(adc_base + variation + noise, ADC_MAX - 1))

        elif self.board_type == BOARD_TYPE_LC:
            if self.low_noise:
                return 10_000_000 + sensor_id * 1_000_000
            wave = (math.sin(t * 0.2 + self.board_id) + 1) / 2.0
            val = int(wave * 50000000 + random.randint(-500, 500))
            return max(0, min(val, ADC_MAX - 1))

        elif self.board_type == BOARD_TYPE_TC:
            if self.low_noise:
                return 4_000_000 + sensor_id * 500_000
            wave = (math.sin(t * 0.1 + self.board_id * 0.5) + 1) / 2.0
            val = int(2000000 + wave * 8000000 + random.randint(-500, 500))
            return max(0, min(val, ADC_MAX - 1))

        elif self.board_type == BOARD_TYPE_RTD:
            # Pt1000 at ~25°C: R≈1097Ω, I_exc=1000µA → V=1.097V
            # ADC = (V/Vref) * 2^31 ≈ 942M.  Small offset per sensor_id.
            if self.low_noise:
                return 942_000_000 + sensor_id * 5_000_000
            wave = (math.sin(t * 0.05 + sensor_id) + 1) / 2.0
            val = int(900_000_000 + wave * 100_000_000 + random.randint(-100, 100))
            return max(0, min(val, ADC_MAX - 1))

        elif self.board_type == BOARD_TYPE_ACTUATOR:
            # 12-bit ADC (0-4095), 3.3V ref, V-to-I transfer = 1:1
            # Slow sine wave for visual testing (~0-2.0A)
            wave = (math.sin(t * 0.2 + sensor_id * 0.7) + 1) / 2.0
            base = int(wave * 2500)  # 0-2500 counts ≈ 0-2.0A
            noise = 0 if self.low_noise else random.randint(-5, 5)
            return max(0, min(base + noise, 4095))

        elif self.board_type_str == "ENCODER":
            # Deterministic encoder-ish counts for Elodin raw path (signed-friendly magnitude)
            base = 1_000_000 + sensor_id * 10_000
            return base + int(500 * math.sin(t + sensor_id))

        return random.randint(1000, 5000)


def main():
    parser = argparse.ArgumentParser(description="DiabloAvionics Board Simulator")
    parser.add_argument(
        "--config", default="config/config.toml", help="Path to config.toml"
    )
    parser.add_argument(
        "--target", default="127.0.0.1", help="Target IP (DAQ Bridge / Backend)"
    )
    parser.add_argument("--port", type=int, default=5006, help="Target Port")
    parser.add_argument(
        "--only-type",
        metavar="TYPE",
        help="Only simulate boards of this type (e.g. PT, TC, LC, RTD, ACTUATOR)",
    )
    parser.add_argument(
        "--low-noise",
        action="store_true",
        help="Reduce PT noise for spike validation (smoother signal)",
    )
    parser.add_argument(
        "--stats-file",
        metavar="PATH",
        help="Write JSON stats (packets sent per board) to this file on shutdown",
    )
    parser.add_argument(
        "--duration",
        type=float,
        metavar="SECONDS",
        help="Run for this many seconds then exit (default: run until Ctrl+C)",
    )
    parser.add_argument(
        "--skip-startup",
        action="store_true",
        help="Skip SETUP/SELF_TEST lifecycle, go directly to ACTIVE",
    )
    args = parser.parse_args()

    if not os.path.exists(args.config):
        print(f"Error: Config file not found at {args.config}")
        return

    try:
        with open(args.config, "rb") as f:
            config = tomli.load(f)
    except Exception as e:
        print(f"Error loading config: {e}")
        return

    boards = config.get("boards", {})
    sim_pt_targets = {
        int(k): float(v) for k, v in config.get("sim_pt_targets", {}).items()
    }
    simulated_boards = []

    print(f"🚀 Starting Simulator - Target: {args.target}:{args.port}")
    if sim_pt_targets:
        print(
            f"   Sim PT targets: {len(sim_pt_targets)} channels (e.g. ch1/ch5=500, ch6=4k)"
        )
    if not args.skip_startup:
        print("   Startup lifecycle: SETUP → SELF_TEST → ACTIVE (matching firmware)")

    active_count = 0
    for name, board_cfg in boards.items():
        if not board_cfg.get("enabled", True):
            continue
        # Handled only by board_startup_sim.py (SETUP → SELF_TEST E2E)
        if name == "integration_startup":
            continue
        # Filter by --only-type if specified
        if (
            args.only_type
            and board_cfg.get("type", "PT").upper() != args.only_type.upper()
        ):
            continue

        board = SimulatedBoard(
            name,
            board_cfg,
            args.target,
            args.port,
            low_noise=args.low_noise,
            board_index=active_count,
            sim_pt_targets=sim_pt_targets,
            skip_startup=args.skip_startup,
        )
        board.start()
        simulated_boards.append(board)
        active_count += 1
        state_label = "ACTIVE" if args.skip_startup else "SETUP"
        print(
            f"  [{state_label:6}] {name:15} | Type: {board.board_type_str:4} | ID: {board.board_id:2} | Source: {board.ip}:{board.listen_port}"
        )

    if active_count == 0:
        print("No enabled boards found in config!", flush=True)
    else:
        print(f"{active_count} boards started.", flush=True)

    print("Simulator is running. Press Ctrl+C to stop.", flush=True)

    def write_stats():
        if not args.stats_file:
            return
        stats = {
            "total_sensor_packets": sum(b.packets_sent for b in simulated_boards),
            "boards": {},
        }
        for b in simulated_boards:
            active = b.config.get(
                "active_connectors", list(range(1, b.num_sensors + 1))
            )
            stats["boards"][b.name] = {
                "type": b.board_type_str,
                "board_id": b.board_id,
                "packets_sent": b.packets_sent,
                "channels_per_packet": len(active),
                "total_sensor_updates": b.packets_sent * len(active),
            }
        stats["total_sensor_updates"] = sum(
            v["total_sensor_updates"] for v in stats["boards"].values()
        )
        with open(args.stats_file, "w") as f:
            json.dump(stats, f, indent=2)
        print(f"Stats written to {args.stats_file}", flush=True)

    # Register SIGTERM handler so integration test cleanup triggers stats write
    import signal

    def _sigterm_handler(signum, frame):
        for b in simulated_boards:
            b.running = False
        time.sleep(0.1)  # let threads finish current send
        write_stats()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _sigterm_handler)

    try:
        if args.duration:
            time.sleep(args.duration)
            print(f"\nDuration ({args.duration}s) reached. Stopping...")
            for b in simulated_boards:
                b.running = False
            write_stats()
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping simulator...")
        for b in simulated_boards:
            b.running = False
        write_stats()


if __name__ == "__main__":
    main()

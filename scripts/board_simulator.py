#!/usr/bin/env python3
import socket
import struct
import time
import threading
import random
import tomli
import os
import argparse
import math

# DiabloAvionics Packet Types
PACKET_TYPE_HEARTBEAT = 1
PACKET_TYPE_SENSOR_DATA = 3
PACKET_TYPE_ACTUATOR_COMMAND = 4

# Board Types
BOARD_TYPE_PT = 1
BOARD_TYPE_LC = 2
BOARD_TYPE_RTD = 3
BOARD_TYPE_TC = 4
BOARD_TYPE_ACTUATOR = 5


class SimulatedBoard:
    def __init__(
        self, name, board_config, target_ip, target_port, low_noise=False, board_index=0
    ):
        self.name = name
        self.board_index = board_index
        self.config = board_config
        self.target_ip = target_ip
        self.target_port = target_port
        self.low_noise = low_noise

        self.ip = board_config.get("ip", "127.0.0.1")
        self.board_id = board_config.get("board_id", 0)
        self.board_type_str = board_config.get("type", "PT")
        self.num_sensors = board_config.get("num_sensors", 10)

        # Map string type to enum
        type_map = {
            "PT": BOARD_TYPE_PT,
            "LC": BOARD_TYPE_LC,
            "RTD": BOARD_TYPE_RTD,
            "TC": BOARD_TYPE_TC,
            "ACTUATOR": BOARD_TYPE_ACTUATOR,
        }
        self.board_type = type_map.get(self.board_type_str, BOARD_TYPE_PT)

        # HP PT specific settings
        self.hp_pt_connectors = set(board_config.get("hp_pt_connectors", []))
        self.excitation_id = board_config.get("excitation_connector_id", -1)

        self.running = False
        self.sock = None
        self.thread = None

    def start(self):
        self.running = True
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

        try:
            # Bind to the flight IP defined in config.toml
            # Requires these IPs to be added as aliases to the interface (e.g. lo)
            self.sock.bind((self.ip, 0))
            print(f"[{self.name}] Bound to {self.ip}", flush=True)
        except Exception:
            # When config IPs (e.g. 192.168.2.21) are not on this host, use distinct
            # loopback IPs so daq_bridge can route each board's data correctly.
            # 127.0.0.2 = first board, 127.0.0.3 = second, etc.
            fallback_ip = f"127.0.0.{2 + self.board_index}"
            try:
                self.sock.bind((fallback_ip, 0))
                self.ip = fallback_ip
                print(
                    f"[{self.name}] Bound to {fallback_ip} (config IP {self.config.get('ip')} unavailable)",
                    flush=True,
                )
            except Exception:
                print(
                    f"[{self.name}] Warning: Could not bind to "
                    f"{self.ip} or {fallback_ip}. Sending from default interface.",
                    flush=True,
                )

        self.thread = threading.Thread(target=self._run)
        self.thread.daemon = True
        self.thread.start()

    def _run(self):
        last_heartbeat = 0
        last_sensor_data = 0

        heartbeat_interval = 1.0  # 1 Hz
        sensor_interval = 0.1  # 10 Hz

        while self.running:
            now = time.time()
            ts_ms = int(now * 1000) & 0xFFFFFFFF

            # Send Heartbeat
            if now - last_heartbeat >= heartbeat_interval:
                self._send_heartbeat(ts_ms)
                last_heartbeat = now

            # Send Sensor Data
            if now - last_sensor_data >= sensor_interval:
                self._send_sensor_data(ts_ms)
                last_sensor_data = now

            time.sleep(0.01)

    def _send_heartbeat(self, ts_ms):
        header = struct.pack("<BB I", PACKET_TYPE_HEARTBEAT, 0, ts_ms)
        body = struct.pack("<BBBB", self.board_type, self.board_id, 0, 2)
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
        except Exception:
            pass

    def _generate_data(self, sensor_id):
        t = time.time()
        ADC_MAX = 2147483648  # 2^31 as per backend logic

        if sensor_id == self.excitation_id:
            # Excitation feed: ~1.8V on 2.5V ref (must be > 0 for backend to accept HP PT)
            return int(ADC_MAX * 1.8 / 2.5)

        if self.board_type == BOARD_TYPE_PT:
            if sensor_id in self.hp_pt_connectors:
                # Same amplitude as regular PT (80M ADC span) so bars/plots look consistent
                wave = (
                    math.sin(t * 0.3 + self.board_id * 0.5 + sensor_id * 0.7) + 1
                ) / 2.0
                noise = 0 if self.low_noise else random.randint(-5000, 5000)
                return int(500000000 + wave * 80000000 + noise)
            else:
                # Regular PT: gentle sine wave around realistic ambient pressure.
                # Calibration polynomial zero crossing is ~271M ADC (0 PSI).
                # Base ~320M → ~20 PSI, ±80M variation → ~0-68 PSI sweep.
                # This replaces the old 500M-1.3B sweep which mapped to 139-707 PSI
                # via the cubic polynomial and looked like massive spikes on the plot.
                wave = (
                    math.sin(t * 0.3 + self.board_id * 0.5 + sensor_id * 0.7) + 1
                ) / 2.0
                noise = 0 if self.low_noise else random.randint(-5000, 5000)
                return int(320000000 + wave * 80000000 + noise)

        elif self.board_type == BOARD_TYPE_LC:
            # Scale for ~0-500 N (force_n)
            wave = (math.sin(t * 0.2 + self.board_id) + 1) / 2.0
            val = int(wave * 50000000 + random.randint(-500, 500))
            return max(0, min(val, ADC_MAX - 1))

        elif self.board_type == BOARD_TYPE_TC:
            # Scale for ~20-100 C (temperature_c)
            wave = (math.sin(t * 0.1 + self.board_id * 0.5) + 1) / 2.0
            val = int(2000000 + wave * 8000000 + random.randint(-500, 500))
            return max(0, min(val, ADC_MAX - 1))

        elif self.board_type == BOARD_TYPE_RTD:
            # Scale for ~20-50 C (temperature_c)
            wave = (math.sin(t * 0.05 + sensor_id) + 1) / 2.0
            val = int(2000000 + wave * 3000000 + random.randint(-100, 100))
            return max(0, min(val, ADC_MAX - 1))

        elif self.board_type == BOARD_TYPE_ACTUATOR:
            return int(1200000 + random.randint(-2000, 2000))

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
    simulated_boards = []

    print(f"🚀 Starting Simulator - Target: {args.target}:{args.port}")

    active_count = 0
    for name, board_cfg in boards.items():
        if not board_cfg.get("enabled", True):
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
        )
        board.start()
        simulated_boards.append(board)
        active_count += 1
        print(
            f"✅ Simulated {name:15} | Type: {board.board_type_str:4} | ID: {board.board_id:2} | Source: {board.ip}"
        )

    if active_count == 0:
        print("⚠️ No enabled boards found in config!", flush=True)
    else:
        print(f"✨ {active_count} boards active and simulating data.", flush=True)

    print("📡 Simulator is running. Press Ctrl+C to stop.", flush=True)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping simulator...")
        for b in simulated_boards:
            b.running = False


if __name__ == "__main__":
    main()

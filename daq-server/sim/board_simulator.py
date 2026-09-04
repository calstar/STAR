#!/usr/bin/env python3
import socket
import struct
import time
import threading
import random
import os
import sys
import argparse
import json
import math

try:
    import tomli
except ModuleNotFoundError:
    try:
        import tomllib as tomli  # stdlib since Python 3.11, same API
    except ModuleNotFoundError:
        raise SystemExit(
            "board_simulator: no TOML parser available. "
            "Install one with `pip install tomli` (or use Python >= 3.11)."
        )

# DiabloAvionics Packet Types (DAQv2-Comms DiabloEnums.h)
PACKET_TYPE_HEARTBEAT = 1
PACKET_TYPE_SENSOR_DATA = 3
PACKET_TYPE_ACTUATOR_COMMAND = 4
PACKET_TYPE_SENSOR_CONFIG = 5
PACKET_TYPE_ACTUATOR_CONFIG = 6
PACKET_TYPE_SELF_TEST = 12
PACKET_TYPE_LOGS = 15

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


class TimingPathology:
    """Deliberate timing defects for exercising the bridge's clock sync.

    All default off → simulator behaves exactly as before. See --net-jitter-ms,
    --clock-drift-ppm, --clock-offset-ms, --reboot-after, --start-near-wrap,
    --chunks-per-packet.
    """

    def __init__(
        self,
        chunks_per_packet=1,
        net_jitter_ms=0.0,
        clock_drift_ppm=0.0,
        clock_offset_ms=0.0,
        reboot_after_s=None,
        start_near_wrap=False,
    ):
        self.chunks_per_packet = max(1, int(chunks_per_packet))
        self.net_jitter_ms = float(net_jitter_ms)
        self.clock_drift_ppm = float(clock_drift_ppm)
        self.clock_offset_ms = float(clock_offset_ms)
        self.reboot_after_s = reboot_after_s
        self.start_near_wrap = bool(start_near_wrap)


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
        timing=None,
        sensor_hz=None,
        allow_ip_fallback=False,
    ):
        self.name = name
        self.board_index = board_index
        self.config = board_config
        # Only permit rebinding a non-bindable config IP to loopback when explicitly allowed
        # (sim_config.toml already uses loopback IPs so it never needs this; a hardware config
        # must NOT silently fall back — that emits synthetic data tagged with real board IDs).
        self.allow_ip_fallback = bool(allow_ip_fallback)
        self.target_ip = target_ip
        self.target_port = target_port
        self.low_noise = low_noise
        self.sim_pt_targets = sim_pt_targets or {}
        # None → per-type production defaults (see _run). A value overrides every
        # board type uniformly, for CI where the point is "did anything obviously
        # break", not sustaining hardware rates.
        self.sensor_hz = sensor_hz

        # ── Board clock model (faithful to firmware millis(): uptime-relative) ──
        self.timing = timing or TimingPathology()
        # Alternate drift sign across boards so both directions are exercised.
        self.drift_ppm = self.timing.clock_drift_ppm * (
            1 if board_index % 2 == 0 else -1
        )
        self._boot_epoch = time.time()
        # start-near-wrap: begin ~30 s before the uint32 boundary. Compensate
        # for clock_offset_ms so the wrap still lands ~30 s in when both
        # pathologies are enabled together.
        self._clock_base_ms = (
            int(2**32 - 30_000 - self.timing.clock_offset_ms)
            if self.timing.start_near_wrap
            else 0
        )
        self._rebooted_at = None
        # Deterministic per-board RNG for network jitter (reproducible runs).
        self._jitter_rng = random.Random(0xD1AB70 + board_index * 7919)
        self._pending_chunks = []  # [(chunk_ts_ms, packed_samples_bytes), ...]

        self.ip = board_config.get("ip", "127.0.0.1")
        self.board_id = board_config.get("board_id", 0)
        self.board_type_str = board_config.get("type", "PT")
        self.num_sensors = board_config.get("num_sensors", 10)
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

        # Sensor interface, declared per board. The ADC reference is set once per board, so every
        # connector on a 4-20 mA board is a loop channel — there is no per-connector list.
        # Falls back to the legacy hp_pt_* key presence for a config written before pt_type.
        pt_type = board_config.get("pt_type")
        if pt_type is not None:
            self.is_current_loop = pt_type == "4-20 mA absolute"
        else:
            self.is_current_loop = bool(board_config.get("hp_pt_connectors")) or (
                "hp_pt_full_scale_psi" in board_config
            )
        self.hp_pt_full_scale_psi = board_config.get("hp_pt_full_scale_psi", 5000.0)
        self.hp_pt_sense_resistor_ohms = board_config.get(
            "hp_pt_sense_resistor_ohms", 120
        )

        # State machine (matches SensorHotfireCore.h lifecycle)
        self.skip_startup = skip_startup
        self.board_state = BOARD_STATE_ACTIVE if skip_startup else BOARD_STATE_SETUP
        self.can_receive = False  # whether socket is bound to listen_port
        # With --skip-startup we never bind listen_port (no SENSOR_CONFIG) so the normal
        # SETUP→SELF_TEST→ACTIVE path never runs — self-test UDP is never sent unless we
        # emit it once here (GUI + Playwright expect SELF_TEST.BOARD_* in sensorData).
        self._skip_startup_self_test_sent = False
        # Self-test is a one-shot at activation, but on a session start it races the
        # pipeline coming up (daq_bridge binding :5006, backend re-subscribing to the
        # new Elodin DB). A single packet is often lost → no self-test shown. Re-send
        # the same result a few times over the first seconds so at least one lands
        # once the pipeline is ready. (Same idea as board_startup_sim's send burst.)
        self._selftest_resend_until = 0.0  # wall-clock deadline; 0 = not arming
        self._selftest_last_resend = 0.0

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
            # The config IP (e.g. 192.168.2.21) is not on this host. Falling back to loopback here
            # is how synthetic data ends up tagged with a REAL board's identity — the root cause of
            # sim data sneaking into a live run. Only do it when explicitly allowed (sim_config.toml
            # uses loopback IPs and doesn't need this; the integration test opts in). Otherwise abort.
            if not self.allow_ip_fallback:
                sys.exit(
                    f"[{self.name}] FATAL: config IP {self.config.get('ip')} is not bindable on this "
                    f"host. Refusing loopback fallback — it would emit synthetic data tagged as board "
                    f"{self.config.get('board_id')}. Run the simulator against config/sim_config.toml "
                    f"(loopback IPs), or pass --allow-ip-fallback (integration test only)."
                )
            # When config IPs (e.g. 192.168.2.21) are not on this host, bind a distinct loopback IP
            # per board so daq_bridge can route each board's data. Mirror the config IP's host octet
            # (192.168.2.51 -> 127.0.0.51): the bridge resolves loopback packets by that octet, which
            # is identity-based and immune to [boards] iteration order (the C++ toml++ loader sorts
            # alphabetically, this file iterates source order — an index-based scheme mislabels
            # boards). Falls back to the old index scheme only if the config IP has no usable octet.
            try:
                host_octet = int(str(self.config.get("ip", "")).rsplit(".", 1)[-1])
            except (ValueError, TypeError):
                host_octet = 0
            fallback_ip = (
                f"127.0.0.{host_octet}" if host_octet >= 2 else f"127.0.0.{2 + self.board_index}"
            )
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

    def _board_ms(self, now):
        """Board clock (uint32 millis), with optional drift/offset/wrap pathologies."""
        uptime_s = (now - self._boot_epoch) * (1.0 + self.drift_ppm * 1e-6)
        return (
            int(uptime_s * 1000.0 + self._clock_base_ms + self.timing.clock_offset_ms)
            & 0xFFFFFFFF
        )

    def _jitter_delay(self):
        """One-sided network delay in seconds (0 when jitter disabled)."""
        if self.timing.net_jitter_ms <= 0:
            return 0.0
        return self._jitter_rng.uniform(0.0, self.timing.net_jitter_ms) / 1000.0

    def _run(self):
        run_started = time.time()
        last_heartbeat = 0
        last_sensor_data = 0
        last_log = 0
        log_seq = 0

        heartbeat_interval = 1.0  # 1 Hz
        log_interval = 1.0  # 1 Hz — simple diagnostic logs, always on (see _send_logs)
        if self.sensor_hz:
            # Uniform override (--sensor-hz): every board type, encoder included.
            # Encoder is normally 5x the others AND exempt from GUI envelope
            # downsampling, so it dominates pipeline load — flattening it is the
            # single biggest reduction available.
            sensor_interval = 1.0 / self.sensor_hz
            actuator_current_interval = sensor_interval
        else:
            sensor_interval = 0.02 if self.board_type_str == "ENCODER" else 0.1  # 50 Hz for ENCODER, 10 Hz default
            actuator_current_interval = 0.1  # Explicitly keep actuator current-sense packets at 10 Hz

        while self.running:
            now = time.time()

            # --- Pathology: one-time reboot (millis resets to ~0) ---
            if (
                self.timing.reboot_after_s is not None
                and self._rebooted_at is None
                and now - run_started >= self.timing.reboot_after_s
            ):
                self._boot_epoch = now
                self._clock_base_ms = 0  # a rebooted board counts from zero
                self._rebooted_at = now
                self._pending_chunks = []
                print(f"[{self.name}] simulated REBOOT — board millis reset", flush=True)

            ts_ms = self._board_ms(now)

            # --- SETUP: wait for SENSOR_CONFIG (no timeout — matches real firmware) ---
            if self.board_state == BOARD_STATE_SETUP:
                if self.can_receive:
                    self._check_for_sensor_config()

            # --- skip-startup: no CONFIG, so emit one SELF_TEST pass burst (DAQ→Elodin→thin→WS) ---
            if (
                self.skip_startup
                and self.board_state == BOARD_STATE_ACTIVE
                and not self._skip_startup_self_test_sent
                and now - run_started >= 2.0
            ):
                self._send_self_test()
                self._skip_startup_self_test_sent = True
                self._selftest_resend_until = now + 6.0  # re-send window (pipeline-startup race)
                print(
                    f"[{self.name}] skip-startup: one-shot SELF_TEST sent (pass all active connectors)",
                    flush=True,
                )

            # --- Self-test re-send window: the result is one-shot, but a session start
            # races the pipeline coming up, so resend it ~1 Hz for a few seconds after
            # activation. Same values (idempotent in the backend cache); ensures delivery. ---
            if (
                self._selftest_resend_until > 0.0
                and now < self._selftest_resend_until
                and now - self._selftest_last_resend >= 1.0
            ):
                self._send_self_test()
                self._selftest_last_resend = now

            # --- Send Heartbeat (all states, matching firmware) ---
            if now - last_heartbeat >= heartbeat_interval:
                self._send_heartbeat(ts_ms)
                last_heartbeat = now

            # --- Send diagnostic LOGS (type 15), 1 Hz, always on (does NOT honor the
            # config mode byte — the sim just streams so the pipeline can be tested). ---
            if now - last_log >= log_interval:
                self._send_logs(ts_ms, log_seq)
                log_seq += 1
                last_log = now

            # --- Send Sensor Data (ACTIVE only, matching firmware) ---
            if self.board_state == BOARD_STATE_ACTIVE:
                effective_sensor_interval = (
                    actuator_current_interval
                    if self.board_type == BOARD_TYPE_ACTUATOR
                    else sensor_interval
                )
                if now - last_sensor_data >= effective_sensor_interval:
                    self._send_sensor_data(ts_ms)
                    last_sensor_data = now

            time.sleep(0.01)

    def _check_for_sensor_config(self):
        """Non-blocking check for SENSOR_CONFIG or ACTUATOR_CONFIG from config_broadcast_service."""
        try:
            data, addr = self.sock.recvfrom(4096)
            if data and len(data) >= 1 and data[0] in (PACKET_TYPE_SENSOR_CONFIG, PACKET_TYPE_ACTUATOR_CONFIG):
                pkt_name = "ACTUATOR_CONFIG" if data[0] == PACKET_TYPE_ACTUATOR_CONFIG else "SENSOR_CONFIG"
                print(
                    f"[{self.name}] {pkt_name} received from {addr}, running self-test",
                    flush=True,
                )
                # Firmware: run self-test once, send results, immediately go ACTIVE
                # (SensorHotfireCore.h: SelfTest state is transient — same loop iteration)
                self._send_self_test()
                self._selftest_resend_until = time.time() + 6.0  # re-send window (pipeline-startup race)
                self.board_state = BOARD_STATE_ACTIVE
                print(
                    f"[{self.name}] SELF_TEST sent, transitioning to ACTIVE",
                    flush=True,
                )
        except (BlockingIOError, socket.timeout, OSError):
            pass

    def _send_self_test(self):
        """Send SELF_TEST packet with pass results for all active connectors.

        Wire format (matches firmware SensorHotfireCore.h):
          header(6B) + adc_good(1B) + num_sensors(1B) + N x (sensor_id(1B) + result(1B))

        Firmware extracts sensor_0 (TDAC) from the results list and puts it in
        the adc_good field. The DAQ bridge publishes adc_good as a sensor_id=0
        Elodin row, then publishes each per-channel result separately.
        """
        active_connectors = self.config.get("active_connectors", [])
        if not active_connectors:
            active_connectors = list(range(1, self.num_sensors + 1))

        ts_ms = self._board_ms(time.time())
        header = struct.pack("<BBI", PACKET_TYPE_SELF_TEST, 0, ts_ms)

        adc_good = 1
        n = min(len(active_connectors), 255)
        body = struct.pack("BB", adc_good, n)
        for sensor_id in active_connectors[:n]:
            body += struct.pack("BB", sensor_id & 0xFF, 1)

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

    def _send_logs(self, ts_ms, seq):
        """Send a type-15 LOGS packet: a simple, board-identifying diagnostic line.
        Wire format matches daq::create_log_packet / parse_log_packet:
          PacketHeader(6B: type,version,ts) + flags(1B) + text_len(2B LE) + text.
        The sim always streams these (it does NOT gate on the config mode byte) so
        the board→bridge→backend→frontend log path can be exercised end to end."""
        text = f"[SIM] board {self.board_id} {self.board_type_str} alive #{seq}".encode("utf-8")
        flags = 0
        text_len = len(text) & 0xFFFF
        # <BBIBH = type(u8) version(u8) ts(u32 LE) flags(u8) text_len(u16 LE)
        header = struct.pack("<BBIBH", PACKET_TYPE_LOGS, 0, ts_ms, flags, text_len)
        try:
            self.sock.sendto(header + text[:text_len], (self.target_ip, self.target_port))
        except Exception:
            pass

    def _send_sensor_data(self, ts_ms):
        """Collect one chunk (one scan of all channels, stamped with the board
        clock); send a packet once chunks_per_packet chunks are accumulated —
        matching real firmware batching (SENSOR_MAX_CHUNKS_BEFORE_SEND)."""
        active_connectors = self.config.get("active_connectors", [])
        if not active_connectors:
            active_connectors = list(range(1, self.num_sensors + 1))

        chunk_data = struct.pack("<I", ts_ms)
        for sensor_id in active_connectors:
            val = self._generate_data(sensor_id)
            chunk_data += struct.pack("<B I", sensor_id, val)
        self._pending_chunks.append(chunk_data)

        if len(self._pending_chunks) < self.timing.chunks_per_packet:
            return

        header = struct.pack("<BB I", PACKET_TYPE_SENSOR_DATA, 0, ts_ms)
        body_header = struct.pack(
            "<BB", len(self._pending_chunks), len(active_connectors)
        )
        payload = header + body_header + b"".join(self._pending_chunks)
        self._pending_chunks = []

        # Pathology: one-sided network delay before the send.
        delay = self._jitter_delay()
        if delay > 0:
            time.sleep(delay)

        try:
            self.sock.sendto(payload, (self.target_ip, self.target_port))
            self.packets_sent += 1
        except Exception:
            pass

    def _generate_data(self, sensor_id):
        t = time.time()
        ADC_MAX = 2147483648  # 2^31 as per backend logic

        if self.board_type == BOARD_TYPE_PT:
            # Local connector id (1–10) — matches Elodin packet channel / daq_bridge
            target_psi = self.sim_pt_targets.get(sensor_id)

            if self.is_current_loop:
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
    parser.add_argument(
        "--allow-ip-fallback",
        action="store_true",
        help="Permit binding loopback when a config IP isn't on this host (sim_config.toml / "
             "integration test only — NEVER with a hardware config; it would emit synthetic data "
             "tagged with real board IDs).",
    )
    parser.add_argument(
        "--sensor-hz",
        type=float,
        default=None,
        metavar="HZ",
        help="Uniform sensor scan rate for ALL board types, overriding the per-type "
             "defaults (10 Hz, 50 Hz encoder). For CI, where the goal is verifying "
             "nothing obviously broke rather than sustaining hardware rates. Keep "
             "above the GUI envelope budget (points_per_second) or downsampling "
             "becomes a pass-through and stops being tested.",
    )
    # ── Timing pathologies (exercise the DAQ bridge's clock sync; default off) ──
    parser.add_argument(
        "--chunks-per-packet",
        type=int,
        default=1,
        metavar="N",
        help="Batch N chunks (scans) per sensor packet, each with its own board-clock timestamp",
    )
    parser.add_argument(
        "--net-jitter-ms",
        type=float,
        default=0.0,
        metavar="MS",
        help="Random one-sided network delay in [0, MS] ms per sensor packet (seeded per board)",
    )
    parser.add_argument(
        "--clock-drift-ppm",
        type=float,
        default=0.0,
        metavar="PPM",
        help="Board crystal drift; sign alternates per board so both directions run",
    )
    parser.add_argument(
        "--clock-offset-ms",
        type=float,
        default=0.0,
        metavar="MS",
        help="Absolute board-clock offset (bogus clock)",
    )
    parser.add_argument(
        "--reboot-after",
        type=float,
        default=None,
        metavar="SECONDS",
        help="Reset every board's millis to ~0 once, after this many seconds",
    )
    parser.add_argument(
        "--start-near-wrap",
        action="store_true",
        help="Start board millis ~30 s before the uint32 wrap so a wrap occurs mid-run",
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
            sensor_hz=args.sensor_hz,
            allow_ip_fallback=args.allow_ip_fallback,
            timing=TimingPathology(
                chunks_per_packet=args.chunks_per_packet,
                net_jitter_ms=args.net_jitter_ms,
                clock_drift_ppm=args.clock_drift_ppm,
                clock_offset_ms=args.clock_offset_ms,
                reboot_after_s=args.reboot_after,
                start_near_wrap=args.start_near_wrap,
            ),
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
                "chunks_per_packet": b.timing.chunks_per_packet,
                "total_sensor_updates": b.packets_sent
                * len(active)
                * b.timing.chunks_per_packet,
                # Timing-pathology ground truth (for timestamp-quality tests)
                "clock_drift_ppm": b.drift_ppm,
                "clock_offset_ms": b.timing.clock_offset_ms,
                "net_jitter_ms": b.timing.net_jitter_ms,
                "start_near_wrap": b.timing.start_near_wrap,
                "rebooted_at": b._rebooted_at,
            }
        stats["total_sensor_updates"] = sum(
            v["total_sensor_updates"] for v in stats["boards"].values()
        )
        # Atomic write (tmp + rename): the integration test reads this file
        # every run while the simulator is still updating it.
        tmp_path = args.stats_file + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(stats, f, indent=2)
        os.replace(tmp_path, args.stats_file)

    # Register SIGTERM handler so integration test cleanup triggers stats write
    import signal

    def _sigterm_handler(signum, frame):
        for b in simulated_boards:
            b.running = False
        time.sleep(0.1)  # let threads finish current send
        write_stats()
        print(f"Stats written to {args.stats_file}", flush=True)
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
                # Refresh ground-truth stats every second so the integration
                # test's sample-conservation check can read live sent counts.
                write_stats()
    except KeyboardInterrupt:
        print("\nStopping simulator...")
        for b in simulated_boards:
            b.running = False
        write_stats()


if __name__ == "__main__":
    main()

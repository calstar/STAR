#!/usr/bin/env python3
import asyncio
import json
import logging
import math
import socket
import struct
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any, Optional
import websockets
from urllib.parse import urlparse
from pathlib import Path

import sys

sys.path.append(str(Path(__file__).resolve().parent.parent.parent))

from scripts.calibration.calibration_orchestrator import (
    CalibrationOrchestrator,
)  # noqa: E402
from scripts.calibration.robust_calibration import (
    CalibrationPoint,
    EnvironmentalState,
)  # noqa: E402
from scripts.calibration.sense_conversions import (  # noqa: E402
    raw_to_physical,
    hp_pt_adc_to_psi,
)
from scripts.calibration.config_loader import (  # noqa: E402
    load_config,
    build_channel_to_orchestrator_key,
    get_hp_pt_packet_channels,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("CalibrationServer")

# Single source of truth for config: config/config.toml via shared loader.
config = load_config()


class ElodinWriter:
    """Minimal TCP client that writes TABLE packets directly to Elodin DB."""

    def __init__(self, host: str = "127.0.0.1", port: int = 2240):
        self.host = host
        self.port = port
        self.sock: Optional[socket.socket] = None
        self.connected = False

    def connect(self) -> bool:
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.settimeout(3.0)
            self.sock.connect((self.host, self.port))
            self.connected = True
            logger.info(f"[ElodinWriter] Connected to {self.host}:{self.port}")
            return True
        except Exception as e:
            logger.warning(f"[ElodinWriter] Connect failed: {e}")
            self.sock = None
            self.connected = False
            return False

    def write_calibrated_pt(
        self, channel_id: int, pressure_psi: float, raw_adc: int = 0
    ) -> bool:
        """
        Write a calibrated PT TABLE packet to Elodin DB.
        Packet ID: [0x20, 0x10 + channel_id]. Payload: ts_ns(8)+ch(1)+pad(3)+psi(f32)+raw(u32)+flags(1)
        """
        return self._write_calibrated(0x20, channel_id, pressure_psi, raw_adc)

    def _write_calibrated(
        self, high: int, channel_id: int, value: float, raw_counts: int
    ) -> bool:
        """Generic calibrated write: 21-byte payload, packet_id [high, 0x10+channel_id]."""
        if not self.connected or not self.sock:
            return False
        try:
            ts_ns = time.time_ns()
            payload = struct.pack("<Q", ts_ns)
            payload += struct.pack("<B", channel_id)
            payload += bytes(3)
            payload += struct.pack("<f", value)
            payload += struct.pack("<I", raw_counts & 0xFFFFFFFF)  # handle signed (LC)
            payload += struct.pack("<B", 0)
            header = struct.pack("<I", len(payload) + 4)
            header += struct.pack("<B", 1)  # TABLE
            header += struct.pack("<BB", high, 0x10 + channel_id)
            header += struct.pack("<B", 0)
            self.sock.sendall(header + payload)
            return True
        except Exception as e:
            logger.debug(f"[ElodinWriter] Write failed: {e}")
            self.sock = None
            self.connected = False
            return False

    def write_calibrated_tc(
        self, channel_id: int, temperature_c: float, raw_adc: int
    ) -> bool:
        """Write calibrated TC to Elodin. Packet ID: [0x21, 0x10+channel_id]."""
        return self._write_calibrated(0x21, channel_id, temperature_c, raw_adc)

    def write_calibrated_rtd(
        self, channel_id: int, temperature_c: float, raw_counts: int
    ) -> bool:
        """Write calibrated RTD to Elodin. Packet ID: [0x22, 0x10+channel_id]."""
        return self._write_calibrated(0x22, channel_id, temperature_c, raw_counts)

    def write_calibrated_lc(self, channel_id: int, force: float, raw_adc: int) -> bool:
        """Write calibrated LC to Elodin. Packet ID: [0x23, 0x10+channel_id]."""
        return self._write_calibrated(0x23, channel_id, force, raw_adc)


def _parse_raw_adc(payload: bytes) -> Optional[int]:
    """Extract raw ADC uint32 from a raw PT/TC/RTD payload (21-byte format)."""
    if len(payload) >= 21:
        return struct.unpack_from("<I", payload, 12)[0]
    if len(payload) >= 12:
        return struct.unpack_from("<I", payload, 8)[0]
    return None


def _parse_raw_signed(payload: bytes) -> Optional[int]:
    """Extract raw ADC int32 (for LC signed ADC)."""
    if len(payload) >= 21:
        return struct.unpack_from("<i", payload, 12)[0]
    return None


# Per-channel write throttle (configurable, default 100 Hz)
_last_elodin_write: dict = {}
_first_calibrated_write_logged: set = set()
_hp_pt_channels_cache: dict = {}  # cached for speed


def _throttle_key(stype: str, ch: int) -> str:
    return f"{stype}:{ch}"


_raw_conversion_config_cache: dict = {}


def _get_raw_conversion_config():
    """Get config for raw sense_conversions fallback (cached)."""
    if not _raw_conversion_config_cache:
        cal = config.get("calibration", {})
        rtd_cfg = cal.get("rtd", {})
        tc_cfg = cal.get("tc", {})
        lc_cfg = cal.get("lc", {})
        _raw_conversion_config_cache.update(
            {
                "rtd_r0": rtd_cfg.get("r0_ohm", 1000.0),
                "rtd_adc_ref_v": rtd_cfg.get("adc_ref_voltage", 2.5),
                "rtd_excitation_ua": rtd_cfg.get("excitation_ua", 1000.0),
                "tc_adc_ref_v": tc_cfg.get("adc_ref_voltage", 2.5),
                "lc_sensitivity_mv_per_v": lc_cfg.get("sensitivity_mv_per_v", 2.0),
                "lc_pga_gain": lc_cfg.get("pga_gain", 128.0),
                "lc_full_scale_value": lc_cfg.get("full_scale_value", 100.0),
            }
        )
    return _raw_conversion_config_cache


def _process_raw_and_write_calibrated(
    stype: str,
    channel_id: int,
    raw_val: int,
    writer: Any,
    channel_to_key: dict,
) -> None:
    """Compute calibrated value (RCF or raw conversion) and write to Elodin DB.
    Reuses prediction from _online_update when fresh to avoid double compute.
    """
    interval = (
        config.get("calibration", {}).get("sidecar", {}).get("write_interval_sec", 0.01)
    )
    now = time.monotonic()
    throttle_key = _throttle_key(stype, channel_id)
    if now - _last_elodin_write.get(throttle_key, 0) < interval:
        return

    pred = None
    key = channel_to_key.get((stype, channel_id))

    # Path 1: Reuse fresh prediction from _online_update (avoids duplicate predict)
    if key and key in state.orchestrator.latest_predictions:
        p, _, ts = state.orchestrator.latest_predictions[key]
        if now - ts < 0.5 and math.isfinite(p):
            pred = p

    # Path 2: Compute via RCF if no fresh prediction
    if pred is None and key and key in state.orchestrator.robust:
        try:
            rcf = state.orchestrator.robust[key]
            pred, _unc = rcf.predict_pressure_with_uncertainty(
                float(raw_val), state.env_state
            )
        except Exception:
            pass

    # Path 3: HP PT (4-20 mA) — linear conversion when robust stack excludes HP
    if pred is None and stype == "PT":
        if not _hp_pt_channels_cache:
            _hp_pt_channels_cache.update(get_hp_pt_packet_channels())
        hp_cfg = _hp_pt_channels_cache.get(channel_id)
        if hp_cfg:
            pred = hp_pt_adc_to_psi(
                raw_val,
                hp_cfg["full_scale_psi"],
                hp_cfg["sense_resistor_ohms"],
                hp_cfg["adc_ref_voltage"],
            )

    # Path 4: Fallback to raw physical conversion (sense_conversions) for TC/RTD/LC/PT
    if pred is None or not math.isfinite(pred):
        cfg = _get_raw_conversion_config()
        pred = raw_to_physical(
            stype,
            raw_val,
            channel_id=channel_id,
            rtd_r0=cfg["rtd_r0"],
            rtd_adc_ref_v=cfg["rtd_adc_ref_v"],
            rtd_excitation_ua=cfg["rtd_excitation_ua"],
            tc_adc_ref_v=cfg["tc_adc_ref_v"],
            lc_sensitivity_mv_per_v=cfg["lc_sensitivity_mv_per_v"],
            lc_pga_gain=cfg["lc_pga_gain"],
            lc_full_scale_value=cfg["lc_full_scale_value"],
        )

    if pred is None or not math.isfinite(pred):
        return

    _last_elodin_write[throttle_key] = now
    if not writer.connected:
        writer.connect()

    if stype == "PT":
        writer.write_calibrated_pt(channel_id, float(pred), raw_val)
    elif stype == "TC":
        writer.write_calibrated_tc(channel_id, float(pred), raw_val)
    elif stype == "RTD":
        writer.write_calibrated_rtd(channel_id, float(pred), raw_val)
    elif stype == "LC":
        writer.write_calibrated_lc(channel_id, float(pred), raw_val)
    k = (stype, channel_id)
    if k not in _first_calibrated_write_logged:
        _first_calibrated_write_logged.add(k)
        logger.info(
            f"[Cal] First calibrated write: {stype} ch{channel_id} → {pred:.2f}"
        )


async def relay_subscriber_task():
    """
    Subscribe to the Elodin Relay WebSocket to get raw ADC data.
    Feeds the calibration engine and writes calibrated values back to Elodin DB.
    The relay is the sole subscriber to Elodin DB and fans out TABLE packets here.
    """
    sidecar_cfg = config.get("calibration", {}).get("sidecar", {})
    relay_host = sidecar_cfg.get("relay_host", "127.0.0.1")
    relay_port = sidecar_cfg.get("relay_port", 9090)
    relay_url = f"ws://{relay_host}:{relay_port}"

    elodin_cfg = config.get("database", {})
    elodin_host = elodin_cfg.get("host", "127.0.0.1")
    elodin_port = elodin_cfg.get("port", 2240)
    writer = ElodinWriter(elodin_host, elodin_port)
    channel_to_key = build_channel_to_orchestrator_key()
    logger.info(
        f"[Relay] Relay subscriber starting → {relay_url} (channel map: {len(channel_to_key)} entries)"
    )

    while True:
        try:
            async with websockets.connect(relay_url, ping_interval=20) as ws:
                logger.info(f"[Relay] Connected to relay at {relay_url}")
                async for message in ws:
                    if not isinstance(message, bytes) or len(message) < 8:
                        continue
                    ty = message[4]
                    high = message[5]
                    low = message[6]
                    payload = message[8:]

                    if ty != 1:  # TABLE = 1
                        continue

                    channel_id = low
                    stype = None
                    raw_val = None

                    # Raw PT: [0x20, 0x01..0x0E]
                    if high == 0x20 and 0x01 <= low <= 0x0E:
                        raw_val = _parse_raw_adc(payload)
                        stype = "PT"
                    # Raw TC: [0x21, 0x01..0x14]
                    elif high == 0x21 and 0x01 <= low <= 0x14:
                        raw_val = _parse_raw_adc(payload)
                        stype = "TC"
                    # Raw RTD: [0x22, 0x01..0x14]
                    elif high == 0x22 and 0x01 <= low <= 0x14:
                        raw_val = _parse_raw_adc(payload)
                        stype = "RTD"
                    # Raw LC: [0x23, 0x01..0x14]
                    elif high == 0x23 and 0x01 <= low <= 0x14:
                        raw_val = _parse_raw_signed(payload)
                        stype = "LC"

                    if stype is None or raw_val is None:
                        continue

                    key = channel_to_key.get((stype, channel_id))
                    if key and key in state.orchestrator.robust:
                        state.orchestrator._online_update(key, float(raw_val))

                    # Compute calibrated and write to Elodin DB
                    _process_raw_and_write_calibrated(
                        stype, channel_id, raw_val, writer, channel_to_key
                    )

        except Exception as e:
            logger.warning(f"[Relay] Disconnected ({e}), retrying in 5s...")
            await asyncio.sleep(5)


class ServerState:
    def __init__(self):
        self.orchestrator = CalibrationOrchestrator()
        self.orchestrator.load_existing()
        self.orchestrator.run_phase2_background()

        # Load env state from config
        env_cfg = config.get("calibration", {}).get("environmental", {})
        self.env_state = EnvironmentalState(
            temperature=env_cfg.get("temperature", 25.0),
            humidity=env_cfg.get("humidity", 50.0),
            vibration=env_cfg.get("vibration", 0.0),
            aging_factor=env_cfg.get("aging_factor", 1.0),
            mounting_torque=env_cfg.get("mounting_torque", 1.0),
        )
        self.orchestrator.env_state = self.env_state

        self.ws_clients = set()


state = ServerState()


class CalibrationHTTPRequestHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200, "ok")
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/status":
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()

            channels = []
            for key, rcf in state.orchestrator.robust.items():
                if key[0] not in ("PT", "TC", "RTD", "LC"):
                    continue
                channel_id = key[1]
                idx = state.orchestrator._key_to_idx.get(key)

                # Get autonomous learning status (new engine API may not expose per-sensor history)
                drift = False
                try:
                    # Prefer engine-per-sensor drift status if available
                    if (
                        hasattr(state.orchestrator.engine, "get_sensor_status")
                        and idx is not None
                    ):
                        sensor_status = state.orchestrator.engine.get_sensor_status(idx)
                        if sensor_status is not None:
                            drift = bool(sensor_status.get("drift_detected", False))
                    # Fallback: use last GLR value on the robust framework
                except Exception:
                    drift = False

                summary = rcf.get_calibration_summary()

                glr = 0.0
                if hasattr(rcf, "_last_glr"):
                    glr = rcf._last_glr

                channels.append(
                    {
                        "sensorType": key[0],
                        "sensorId": channel_id,
                        "updateCount": len(rcf.calibration_points),
                        "rlsUpdateCount": len(rcf.calibration_points),
                        "lastUpdate": 0,
                        "driftDetected": drift,
                        "meanResidual": summary.get("rmse", 0.0),
                        "glrStat": glr,
                        "confidence": summary.get("confidence_level", "UNCALIBRATED"),
                        "coeffs": {
                            "A": (
                                summary.get("parameters", [0, 0, 0, 0, 0, 0])[3]
                                if len(summary.get("parameters", [])) > 3
                                else 0
                            ),
                            "B": (
                                summary.get("parameters", [0, 0, 0, 0, 0, 0])[2]
                                if len(summary.get("parameters", [])) > 2
                                else 0
                            ),
                            "C": (
                                summary.get("parameters", [0, 0, 0, 0, 0, 0])[1]
                                if len(summary.get("parameters", [])) > 1
                                else 0
                            ),
                            "D": (
                                summary.get("parameters", [0, 0, 0, 0, 0, 0])[0]
                                if len(summary.get("parameters", [])) > 0
                                else 0
                            ),
                        },
                        "phase2Active": True,
                        "covarianceTrace": sum(summary.get("uncertainty", [0])),
                        "bayesianConfidence": (
                            1.0 if summary.get("confidence_level") == "MAXIMUM" else 0.5
                        ),
                        "populationPriorActive": True,
                        "sidecarConnected": True,
                    }
                )

            payload = {"channels": channels, "phase2Enabled": True, "timestamp": 0}
            self.wfile.write(json.dumps(payload).encode("utf-8"))

        elif path.startswith("/api/coefficients/"):
            try:
                ch = int(path.split("/")[-1])
                key = ("PT", ch)
                if key in state.orchestrator.robust:
                    rcf = state.orchestrator.robust[key]
                    summary = rcf.get_calibration_summary()
                    self.send_response(200)
                    self._send_cors_headers()
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(summary).encode("utf-8"))
                else:
                    self.send_response(404)
                    self._send_cors_headers()
                    self.end_headers()
            except ValueError:
                self.send_response(400)
                self.end_headers()

        elif path == "/api/environmental":
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "temperature": state.env_state.temperature,
                        "humidity": state.env_state.humidity,
                        "vibration": state.env_state.vibration,
                        "aging_factor": state.env_state.aging_factor,
                        "mounting_torque": state.env_state.mounting_torque,
                    }
                ).encode("utf-8")
            )

        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)

        try:
            req = json.loads(data.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_response(400)
            self._send_cors_headers()
            self.end_headers()
            return

        if path == "/api/calibrate":
            ch = req.get("channel")
            adc = req.get("adc_code")
            ref_value = req.get("reference_value") or req.get("reference_psi")
            sensor_type = req.get("sensor_type", "PT")  # PT/TC/RTD/LC

            channel_to_key = build_channel_to_orchestrator_key()
            key = channel_to_key.get((sensor_type, ch), (sensor_type, ch))
            if key in state.orchestrator.robust:
                # Add calibration point (triggers TLS/Bayesian update in RCF)
                pt = CalibrationPoint(
                    adc_code=adc,
                    pressure=ref_value,
                    timestamp=0,
                    environmental_state=state.env_state,
                    uncertainty=(
                        1e-3 if abs(ref_value) < 10 else 0.01
                    ),  # Paper: human=10⁻⁶ σ²
                )
                res = state.orchestrator.robust[key].add_calibration_point(pt)
                # Paper: zero-point propagation — when |p|<10 PSI, add (v_k,0,0.01) for all k≠j
                if abs(ref_value) < 10:
                    state.orchestrator.propagate_zero_point(key, sensor_type)
                state.orchestrator._save_all()
                self.send_response(200)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({"success": True, "result": res}).encode("utf-8")
                )
                asyncio.run_coroutine_threadsafe(
                    broadcast_ws(
                        json.dumps(
                            {
                                "type": "coefficient_update",
                                "sensor_type": sensor_type,
                                "channel": ch,
                            }
                        )
                    ),
                    ws_loop,
                )
            else:
                self.send_response(404)
                self._send_cors_headers()
                self.end_headers()

        elif path == "/api/zero_all":
            channels = req.get("channels", [])
            state.orchestrator.clear_calibration()
            channel_to_key = build_channel_to_orchestrator_key()
            # Paper: zero-point propagation — add (v_k, 0, e_k, 0.01) for each PT
            for ch_data in channels:
                packet_ch = ch_data.get("id")
                adc = ch_data.get("adc_code")
                key = channel_to_key.get(("PT", packet_ch), ("PT", packet_ch))
                if key in state.orchestrator.robust:
                    pt = CalibrationPoint(
                        adc_code=adc,
                        pressure=0.0,
                        timestamp=0,
                        environmental_state=state.env_state,
                        uncertainty=0.01,  # Paper: propagation uncertainty
                    )
                    state.orchestrator.robust[key].add_calibration_point(pt)
            state.orchestrator._save_all()
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}).encode("utf-8"))

            asyncio.run_coroutine_threadsafe(
                broadcast_ws(
                    json.dumps({"type": "coefficient_update", "channel": "all"})
                ),
                ws_loop,
            )

        elif path == "/api/environmental":
            state.env_state.temperature = req.get(
                "temperature", state.env_state.temperature
            )
            state.env_state.humidity = req.get("humidity", state.env_state.humidity)
            state.env_state.vibration = req.get("vibration", state.env_state.vibration)
            state.env_state.aging_factor = req.get(
                "aging_factor", state.env_state.aging_factor
            )
            state.env_state.mounting_torque = req.get(
                "mounting_torque", state.env_state.mounting_torque
            )
            state.orchestrator.env_state = state.env_state

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}).encode("utf-8"))

        elif path == "/api/adc_sample":
            samples = req.get("samples", [])
            channel_to_key = build_channel_to_orchestrator_key()
            for sample in samples:
                packet_ch = sample.get("channel")
                adc = sample.get("adc")
                if packet_ch is None or adc is None:
                    continue
                # Map packet channel ID to orchestrator key (stype, unique_ch)
                key = None
                for stype in ("PT", "TC", "RTD", "LC"):
                    k = channel_to_key.get((stype, packet_ch))
                    if k and k in state.orchestrator.robust:
                        key = k
                        break
                if key:
                    state.orchestrator._online_update(key, float(adc))

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}).encode("utf-8"))

        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()


def run_http_server(host, port):
    server = HTTPServer((host, port), CalibrationHTTPRequestHandler)
    logger.info(f"Starting HTTP server on {host}:{port}")
    server.serve_forever()


async def ws_handler(websocket):
    state.ws_clients.add(websocket)
    try:
        await websocket.wait_closed()
    finally:
        state.ws_clients.remove(websocket)


async def broadcast_ws(message):
    if state.ws_clients:
        await asyncio.gather(*[client.send(message) for client in state.ws_clients])


def run_ws_server(host, port):
    global ws_loop
    ws_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(ws_loop)

    async def _run_ws():
        async with websockets.serve(ws_handler, host, port):
            logger.info(f"Starting WebSocket server on {host}:{port}")
            asyncio.ensure_future(relay_subscriber_task())
            await asyncio.Future()  # run forever

    ws_loop.run_until_complete(_run_ws())


if __name__ == "__main__":
    sidecar_cfg = config.get("calibration", {}).get("sidecar", {})
    host = sidecar_cfg.get("host", "127.0.0.1")
    port = sidecar_cfg.get("port", 8100)

    http_thread = threading.Thread(
        target=run_http_server, args=(host, port), daemon=True
    )
    ws_thread = threading.Thread(
        target=run_ws_server, args=(host, port + 1), daemon=True
    )

    http_thread.start()
    ws_thread.start()

    try:
        while True:
            # Check for active learning alerts to broadcast.
            # Atomically snapshot-and-clear to avoid losing alerts appended
            # by the orchestrator thread between the loop and clear().
            if state.orchestrator.pending_alerts:
                alerts, state.orchestrator.pending_alerts = (
                    state.orchestrator.pending_alerts,
                    [],
                )
                for alert in alerts:
                    asyncio.run_coroutine_threadsafe(
                        broadcast_ws(
                            json.dumps(
                                {
                                    "type": "active_learning_alert",
                                    "sensor_id": alert.sensor_id,
                                    "reason": alert.reason,
                                    "urgency": alert.urgency,
                                    "confidence": alert.confidence,
                                }
                            )
                        ),
                        ws_loop,
                    )

            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        state.orchestrator.running = False

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

from scripts.calibration.calibration_orchestrator import (  # noqa: E402
    CalibrationOrchestrator,
)
from scripts.calibration.robust_calibration import (  # noqa: E402
    CalibrationPoint,
    EnvironmentalState,
)
from scripts.calibration.sense_conversions import (  # noqa: E402
    raw_to_physical,
    hp_pt_adc_to_psi,
)
from scripts.calibration.config_loader import (  # noqa: E402
    load_config,
    build_channel_to_orchestrator_key,
    get_hp_pt_packet_channels,
    get_excitation_packet_channels,
    decode_board_namespaced_low,
    packet_ch_for_board_connector,
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
        self,
        connector_id: int,
        pressure_psi: float,
        raw_adc: int,
        *,
        raw_packet_low: int,
    ) -> bool:
        """
        Write calibrated PT to Elodin. Packet low byte = raw_packet_low + 0x10 (board-namespaced),
        matching FSW calibration_service / daq_bridge (NOT legacy 0x10 + global_ch).
        """
        return self._write_calibrated(
            0x20, raw_packet_low, connector_id, pressure_psi, raw_adc
        )

    def _write_calibrated(
        self,
        high: int,
        raw_packet_low: int,
        connector_id: int,
        value: float,
        raw_counts: int,
    ) -> bool:
        """21-byte TABLE row; cal packet id [high, raw_low + 0x10] (same rule as C++ cal_main)."""
        if not self.connected or not self.sock:
            return False
        try:
            cal_low = (raw_packet_low + 0x10) & 0xFF
            ts_ns = time.time_ns()
            payload = struct.pack("<Q", ts_ns)
            payload += struct.pack("<B", connector_id & 0xFF)
            payload += bytes(3)
            payload += struct.pack("<f", value)
            payload += struct.pack("<I", raw_counts & 0xFFFFFFFF)
            payload += struct.pack("<B", 0)
            header = struct.pack("<I", len(payload) + 4)
            header += struct.pack("<B", 1)  # TABLE
            header += struct.pack("<BB", high, cal_low)
            header += struct.pack("<B", 0)
            self.sock.sendall(header + payload)
            return True
        except Exception as e:
            logger.debug(f"[ElodinWriter] Write failed: {e}")
            self.sock = None
            self.connected = False
            return False

    def write_calibrated_tc(
        self,
        connector_id: int,
        temperature_c: float,
        raw_adc: int,
        *,
        raw_packet_low: int,
    ) -> bool:
        return self._write_calibrated(
            0x21, raw_packet_low, connector_id, temperature_c, raw_adc
        )

    def write_calibrated_rtd(
        self,
        connector_id: int,
        temperature_c: float,
        raw_counts: int,
        *,
        raw_packet_low: int,
    ) -> bool:
        return self._write_calibrated(
            0x22, raw_packet_low, connector_id, temperature_c, raw_counts
        )

    def write_calibrated_lc(
        self, connector_id: int, force: float, raw_adc: int, *, raw_packet_low: int
    ) -> bool:
        return self._write_calibrated(
            0x23, raw_packet_low, connector_id, force, raw_adc
        )


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


def _parse_int32_at_12(payload: bytes) -> Optional[int]:
    """Signed ADC at offset 12 (PT/LP, TC, RTD raw on wire)."""
    if len(payload) >= 21:
        return struct.unpack_from("<i", payload, 12)[0]
    return None


# Per-channel write throttle (configurable, default 100 Hz)
_last_elodin_write: dict = {}
_first_calibrated_write_logged: set = set()
_hp_pt_channels_cache: dict = {}       # {packet_ch: hp_pt_cfg}  — populated lazily
_excitation_channels_cache: dict = {}  # {packet_ch: exc_cfg}    — populated lazily

# ── EMA (exponential moving average) noise filter ────────────────────────────
# Applied to LP PT channels before writing calibrated value to Elodin.
# alpha=1.0 disables filtering; lower values smooth more at the cost of lag.
_EMA_ALPHA_DEFAULT = 0.4  # ~4 Hz effective bandwidth at 20 Hz sample rate
_ema_state: dict = {}  # packet_ch → last EMA value


def _apply_ema(key: int, value: float, alpha: float = _EMA_ALPHA_DEFAULT) -> float:
    prev = _ema_state.get(key)
    if prev is None or not math.isfinite(prev):
        _ema_state[key] = value
        return value
    ema = alpha * value + (1.0 - alpha) * prev
    _ema_state[key] = ema
    return ema


def _reset_ema_for_packet_channels(packet_channels: list) -> None:
    """Clear EMA state for a list of packet_ch values so corrected values take effect immediately."""
    for pch in packet_channels:
        _ema_state.pop(pch, None)


def _apply_direct_offset_correction(
    key: tuple,
    adc_code: float,
    target_psi: float,
) -> bool:
    """
    Directly correct theta_mean[0] (the D intercept) so the RCF outputs target_psi
    at the given adc_code without disturbing the slope coefficients.
    Returns True if the correction was applied.
    """
    rcf = state.orchestrator.robust.get(key)
    if rcf is None:
        return False
    try:
        current_pred, _ = rcf.predict_pressure_with_uncertainty(
            float(adc_code), state.env_state
        )
        if not math.isfinite(current_pred):
            return False
        delta = current_pred - target_psi
        rcf.theta_mean[0] -= delta
        # Tighten covariance on the offset term to reflect this high-confidence fix.
        rcf.theta_cov[0, 0] = max(rcf.theta_cov[0, 0] * 0.1, 1e-4)
        return True
    except Exception:
        return False


def _parse_pt_raw_for_packet_ch(payload: bytes, packet_ch: int) -> Optional[int]:
    """HP PT / excitation: unsigned ADC; LP PT: signed ADS1262 counts (matches FSW)."""
    if len(payload) < 21:
        return None
    if not _hp_pt_channels_cache:
        _hp_pt_channels_cache.update(get_hp_pt_packet_channels())
    if not _excitation_channels_cache:
        _excitation_channels_cache.update(get_excitation_packet_channels())
    if packet_ch in _hp_pt_channels_cache or packet_ch in _excitation_channels_cache:
        return struct.unpack_from("<I", payload, 12)[0]
    return struct.unpack_from("<i", payload, 12)[0]


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
    packet_ch: int,
    raw_val: int,
    writer: Any,
    channel_to_key: dict,
    *,
    connector_id: int,
    raw_packet_low: int,
) -> None:
    """Compute calibrated value (RCF or raw conversion) and optionally write to Elodin DB."""
    sidecar_cfg = config.get("calibration", {}).get("sidecar", {})
    if not sidecar_cfg.get("write_to_elodin", True):
        return

    interval = float(sidecar_cfg.get("write_interval_sec", 0.01))
    now = time.monotonic()
    throttle_key = _throttle_key(stype, packet_ch)
    if now - _last_elodin_write.get(throttle_key, 0) < interval:
        return

    # Ensure caches are populated (done once per process lifetime)
    if not _hp_pt_channels_cache:
        _hp_pt_channels_cache.update(get_hp_pt_packet_channels())
    if not _excitation_channels_cache:
        _excitation_channels_cache.update(get_excitation_packet_channels())

    pred = None
    is_hp_pt = stype == "PT" and packet_ch in _hp_pt_channels_cache
    is_excitation = stype == "PT" and packet_ch in _excitation_channels_cache
    key = channel_to_key.get((stype, packet_ch))

    # Path 0E: Excitation voltage — ADC → actual loop supply volts (bypass all pressure paths).
    if is_excitation:
        exc_cfg = _excitation_channels_cache[packet_ch]
        adc_ref = exc_cfg["adc_ref_voltage"]
        attenuation = exc_cfg["divider_attenuation"]
        if attenuation > 0:
            v_adc = (float(raw_val) / 2_147_483_648.0) * adc_ref
            pred = v_adc / attenuation

    # Path 0H: HP PT (4-20 mA) — bypass RCF entirely; the orchestrator's polynomial
    # is calibrated for LP PT voltage-mode inputs and produces garbage for HP PT.
    # board_simulator.py generates valid 4-20 mA ADC codes for HP PT connectors, so
    # hp_pt_adc_to_psi is correct in both sim and real-hardware modes.
    elif is_hp_pt:
        hp_cfg = _hp_pt_channels_cache[packet_ch]
        pred = hp_pt_adc_to_psi(
            raw_val,
            hp_cfg["full_scale_psi"],
            hp_cfg["sense_resistor_ohms"],
            hp_cfg["adc_ref_voltage"],
        )

    else:
        # Path 1: Reuse fresh prediction from _online_update (avoids duplicate predict)
        if key and key in state.orchestrator.latest_predictions:
            p, _, ts = state.orchestrator.latest_predictions[key]
            if now - ts < 0.5 and math.isfinite(p):
                pred = p

        # Path 2: Compute via RCF (LP PT polynomial / Bayesian model)
        if pred is None and key and key in state.orchestrator.robust:
            try:
                rcf = state.orchestrator.robust[key]
                pred, _unc = rcf.predict_pressure_with_uncertainty(
                    float(raw_val), state.env_state
                )
            except Exception:
                pass

        # Path 4: Fallback to raw physical conversion for TC/RTD/LC/LP PT
        if pred is None or not math.isfinite(pred):
            cfg = _get_raw_conversion_config()
            pred = raw_to_physical(
                stype,
                raw_val,
                channel_id=packet_ch,
                rtd_r0=cfg["rtd_r0"],
                rtd_adc_ref_v=cfg["rtd_adc_ref_v"],
                rtd_excitation_ua=cfg["rtd_excitation_ua"],
                tc_adc_ref_v=cfg["tc_adc_ref_v"],
                lc_sensitivity_mv_per_v=cfg["lc_sensitivity_mv_per_v"],
                lc_pga_gain=cfg["lc_pga_gain"],
                lc_full_scale_value=cfg["lc_full_scale_value"],
            )

        # EMA noise filter — only for LP PT (noisy ratiometric ADC)
        if pred is not None and math.isfinite(pred) and stype == "PT":
            sidecar_cfg2 = config.get("calibration", {}).get("sidecar", {})
            alpha = float(sidecar_cfg2.get("ema_alpha", _EMA_ALPHA_DEFAULT))
            pred = _apply_ema(packet_ch, pred, alpha)

    if pred is None or not math.isfinite(pred):
        return

    _last_elodin_write[throttle_key] = now
    if not writer.connected:
        writer.connect()

    if stype == "PT":
        writer.write_calibrated_pt(
            connector_id, float(pred), raw_val, raw_packet_low=raw_packet_low
        )
    elif stype == "TC":
        writer.write_calibrated_tc(
            connector_id, float(pred), raw_val, raw_packet_low=raw_packet_low
        )
    elif stype == "RTD":
        writer.write_calibrated_rtd(
            connector_id, float(pred), raw_val, raw_packet_low=raw_packet_low
        )
    elif stype == "LC":
        writer.write_calibrated_lc(
            connector_id, float(pred), raw_val, raw_packet_low=raw_packet_low
        )
    k = (stype, packet_ch)
    if k not in _first_calibrated_write_logged:
        _first_calibrated_write_logged.add(k)
        logger.info(
            f"[Cal] First calibrated write: {stype} packet_ch={packet_ch} → {pred:.2f}"
        )


_ADJUSTMENTS_PATH = Path(__file__).resolve().parent / "calibrations" / "adjustments.json"


def _auto_save_adjustments() -> None:
    """
    Persist all RLS-learned theta_mean / theta_cov back to adjustments.json so
    that the next server restart loads the latest autonomous calibration state.
    Channels are keyed by unique_id = board_id * 100 + connector (framework_v2 format).
    Only channels that have an active RCF entry are written; any existing channels
    without an RCF entry are preserved.
    """
    rcf_map = state.orchestrator.robust  # {(stype, unique_ch): RCF}
    if not rcf_map:
        return

    # Load existing data so we don't clobber unrelated keys
    existing: dict = {}
    if _ADJUSTMENTS_PATH.exists():
        try:
            with open(_ADJUSTMENTS_PATH) as f:
                existing = json.load(f)
        except Exception:
            pass

    fw2 = existing.get("framework_v2", {})
    for (stype, unique_ch), rcf in rcf_map.items():
        if stype != "PT":
            continue  # only PT uses this format currently
        key_str = str(unique_ch)
        fw2[key_str] = {
            "theta_mean": rcf.theta_mean.tolist(),
            "theta_cov": rcf.theta_cov.tolist(),
            "rls_updates": getattr(rcf, "rls_updates", 0),
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }

    existing["framework_v2"] = fw2
    existing["auto_saved_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    _ADJUSTMENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _ADJUSTMENTS_PATH.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(existing, f, indent=2)
    tmp.replace(_ADJUSTMENTS_PATH)
    logger.info(f"[AutoSave] adjustments.json updated ({len(fw2)} PT channels)")


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
    _we = sidecar_cfg.get("write_to_elodin", True)
    logger.info(
        f"[Relay] Relay subscriber starting → {relay_url} (channel map: {len(channel_to_key)} entries, "
        f"write_to_elodin={_we})"
    )

    adj_save_interval = float(
        config.get("calibration", {}).get("sidecar", {}).get(
            "adjustments_save_interval_sec", 120.0
        )
    )
    _last_adj_save = time.monotonic()

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

                    stype = None
                    raw_val = None
                    connector_id: Optional[int] = None
                    packet_ch: Optional[int] = None

                    dec = decode_board_namespaced_low(low)
                    if dec is None:
                        continue
                    board_slot, connector_id, is_raw = dec
                    if not is_raw:
                        continue

                    if high == 0x20:
                        stype = "PT"
                        packet_ch = packet_ch_for_board_connector(
                            "PT", board_slot, connector_id
                        )
                        if packet_ch is not None:
                            raw_val = _parse_pt_raw_for_packet_ch(payload, packet_ch)
                    elif high == 0x21:
                        stype = "TC"
                        packet_ch = packet_ch_for_board_connector(
                            "TC", board_slot, connector_id
                        )
                        if packet_ch is not None:
                            raw_val = _parse_int32_at_12(payload)
                    elif high == 0x22:
                        stype = "RTD"
                        packet_ch = packet_ch_for_board_connector(
                            "RTD", board_slot, connector_id
                        )
                        if packet_ch is not None:
                            raw_val = _parse_int32_at_12(payload)
                    elif high == 0x23:
                        stype = "LC"
                        packet_ch = packet_ch_for_board_connector(
                            "LC", board_slot, connector_id
                        )
                        if packet_ch is not None:
                            raw_val = _parse_raw_signed(payload)

                    if (
                        stype is None
                        or raw_val is None
                        or packet_ch is None
                        or connector_id is None
                    ):
                        continue

                    key = channel_to_key.get((stype, packet_ch))
                    # HP PT and excitation channels use direct conversions, not the RCF
                    # polynomial. Feeding their raw codes into _online_update would corrupt
                    # the Bayesian model (the polynomial is calibrated for LP PT voltage-mode).
                    # Also skip HP PT online update in sim mode (FSW handles those channels).
                    _is_hp = stype == "PT" and packet_ch in _hp_pt_channels_cache
                    _is_exc = stype == "PT" and packet_ch in _excitation_channels_cache
                    if key and key in state.orchestrator.robust and not _is_hp and not _is_exc:
                        state.orchestrator._online_update(key, float(raw_val))

                    _process_raw_and_write_calibrated(
                        stype,
                        packet_ch,
                        raw_val,
                        writer,
                        channel_to_key,
                        connector_id=connector_id,
                        raw_packet_low=low,
                    )

                    # Periodic auto-save of RLS-learned calibration to adjustments.json
                    _now = time.monotonic()
                    if _now - _last_adj_save >= adj_save_interval:
                        _last_adj_save = _now
                        try:
                            _auto_save_adjustments()
                        except Exception as _se:
                            logger.warning(f"[Relay] adjustments auto-save failed: {_se}")

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
                # For near-zero reference points apply a direct offset correction immediately
                # (Bayesian update with one point converges slowly against the prior).
                if abs(ref_value) < 50:
                    _apply_direct_offset_correction(key, float(adc), float(ref_value))
                    _reset_ema_for_packet_channels([ch])
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
            channel_to_key = build_channel_to_orchestrator_key()
            corrected_packet_chs = []
            # Direct offset correction: shift theta_mean[0] so each sensor reads target_psi
            # at its current ADC reading. This preserves the learned slope and is instantaneous.
            # (Previously called clear_calibration() first which discarded all learned state.)
            for ch_data in channels:
                packet_ch = ch_data.get("id")
                adc = ch_data.get("adc_code")
                target = float(ch_data.get("target_psi", 0.0))
                if packet_ch is None or adc is None:
                    continue
                # Skip HP PT and excitation channels — those have hardware-level conversions
                if not _excitation_channels_cache:
                    _excitation_channels_cache.update(get_excitation_packet_channels())
                if not _hp_pt_channels_cache:
                    _hp_pt_channels_cache.update(get_hp_pt_packet_channels())
                if packet_ch in _hp_pt_channels_cache or packet_ch in _excitation_channels_cache:
                    continue
                key = channel_to_key.get(("PT", packet_ch), ("PT", packet_ch))
                if _apply_direct_offset_correction(key, float(adc), target):
                    corrected_packet_chs.append(packet_ch)
            # Reset EMA so corrected value reaches the GUI immediately
            _reset_ema_for_packet_channels(corrected_packet_chs)
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

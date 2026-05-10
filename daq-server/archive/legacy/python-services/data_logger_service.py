#!/usr/bin/env python3
"""
Standalone binary data logger for sensor runs.

Connects to backend WebSocket, receives SENSOR_UPDATE/STATE_UPDATE/ACTUATOR_UPDATE,
and writes .sensorlog files. Starts on ARMED, stops on IDLE or EMERGENCY_ABORT.

File format matches diablo_server/backend DataLogger:
  HEADER: SLOG magic, version, startTime, channel table
  RECORDS: 14 bytes each (timestamp_ms offset, channel_idx, value)

Usage:
    python scripts/services/data_logger_service.py [--ws-url URL] [--output-dir DIR]
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
from pathlib import Path

MAGIC = b"SLOG"
VERSION = 1
RECORD_SIZE = 14  # 4 + 2 + 8

# SystemState enum from shared-types (IDLE=0, ARMED=4, EMERGENCY_ABORT=6)
STATE_IDLE = 0
STATE_ARMED = 4
STATE_EMERGENCY_ABORT = 6


def main() -> int:
    parser = argparse.ArgumentParser(description="Standalone data logger")
    parser.add_argument(
        "--ws-url", default="ws://127.0.0.1:8081", help="Backend WebSocket URL"
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Output dir for .sensorlog (default: data/runs)",
    )
    args = parser.parse_args()

    try:
        import websocket
    except ImportError:
        print("pip install websocket-client", file=sys.stderr)
        return 1

    output_dir = args.output_dir or os.path.join(os.getcwd(), "data", "runs")
    os.makedirs(output_dir, exist_ok=True)

    fd = None
    start_time_ms = 0
    channel_map = {}
    channels = []
    record_count = 0

    def start_log():
        nonlocal fd, start_time_ms, channel_map, channels, record_count
        if fd is not None:
            return
        ts = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime())
        filepath = os.path.join(output_dir, f"run_{ts}.sensorlog")
        fd = open(filepath, "wb")
        start_time_ms = int(time.time() * 1000)
        channel_map.clear()
        channels.clear()
        record_count = 0
        # Placeholder header (0 channels)
        fd.write(MAGIC)
        fd.write(struct.pack("<H", VERSION))
        fd.write(struct.pack("<d", float(start_time_ms)))
        fd.write(struct.pack("<H", 0))
        fd.flush()
        print(f"[DataLogger] Started → {filepath}")

    def record(entity: str, value: float):
        nonlocal fd, record_count
        if fd is None:
            return
        if not isinstance(value, (int, float)) or (
            isinstance(value, float) and not (value == value)
        ):
            return  # NaN / non-finite
        idx = channel_map.get(entity)
        if idx is None:
            idx = len(channels)
            channel_map[entity] = idx
            channels.append(entity)
        offset_ms = int(time.time() * 1000) - start_time_ms
        offset_ms = max(0, min(offset_ms, 0xFFFFFFFF))
        rec = struct.pack("<IHd", offset_ms & 0xFFFFFFFF, idx & 0xFFFF, float(value))
        fd.write(rec)
        record_count += 1

    def stop_log():
        nonlocal fd, channels, record_count, start_time_ms
        if fd is None:
            return
        duration_ms = int(time.time() * 1000) - start_time_ms
        filepath = fd.name
        fd.close()
        fd = None
        # Rewrite with full header
        with open(filepath, "rb") as f:
            old = f.read()
        old_header_size = 4 + 2 + 8 + 2  # magic + version + startTime + channelCnt(0)
        record_bytes = len(old) - old_header_size
        full_records = record_bytes // RECORD_SIZE
        records = old[old_header_size : old_header_size + full_records * RECORD_SIZE]
        header = bytearray()
        header.extend(MAGIC)
        header.extend(struct.pack("<H", VERSION))
        header.extend(struct.pack("<d", float(start_time_ms)))
        header.extend(struct.pack("<H", len(channels)))
        for name in channels:
            nb = name.encode("utf-8")
            header.extend(struct.pack("<H", len(nb)))
            header.extend(nb)
        with open(filepath, "wb") as f:
            f.write(header)
            f.write(records)
        print(
            f"[DataLogger] Stopped → {record_count} records, {len(channels)} channels, {duration_ms/1000:.1f}s"
        )

    def on_message(ws, message):
        try:
            msg = json.loads(message)
            t = msg.get("type")
            payload = msg.get("payload") or {}
            if t == "state_update":
                state = payload.get("currentState")
                if state == STATE_ARMED:
                    start_log()
                elif state in (STATE_IDLE, STATE_EMERGENCY_ABORT):
                    stop_log()
                if fd is not None and state is not None:
                    record("PSM.state", float(state))
            elif t == "sensor_update":
                entity = payload.get("entity")
                component = payload.get("component")
                val = payload.get("value")
                if val is None:
                    return
                key = (
                    f"{entity}.{component}"
                    if (entity and component)
                    else payload.get("key") or entity
                )
                if key is not None:
                    record(key, float(val))
            elif t == "actuator_update":
                name = payload.get("name")
                state = payload.get("state")
                if name is not None and state is not None and fd is not None:
                    record(
                        f"ACT.{str(name).replace(' ', '_')}.actuator_state",
                        float(state),
                    )
        except Exception as e:
            print(f"[DataLogger] Parse error: {e}", file=sys.stderr)

    def on_error(ws, err):
        print(f"[DataLogger] WS error: {err}", file=sys.stderr)

    def on_close(ws, close_status, close_msg):
        if fd is not None:
            stop_log()

    ws = websocket.WebSocketApp(
        args.ws_url,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )
    print(f"[DataLogger] Connecting to {args.ws_url}...")
    ws.run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())

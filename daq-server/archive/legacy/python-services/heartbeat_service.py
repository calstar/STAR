#!/usr/bin/env python3
"""
Standalone SERVER_HEARTBEAT service.

Polls the GUI backend for engine_state and broadcasts SERVER_HEARTBEAT (type 2)
to boards. Decouples heartbeat from the backend so the backend is purely GUI.

Packet format (7 bytes): type(1)=2, version(1)=0, timestamp_ms(4 LE), engine_state(1)

Usage:
    python scripts/services/heartbeat_service.py [--config PATH] [--backend-url URL]

Config: config/config.toml [server_heartbeat] and [heartbeat_service]
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from pathlib import Path

# Locate repo root (scripts/services/ -> scripts/ -> repo root)
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent.parent
CONFIG_PATH = _REPO_ROOT / "config" / "config.toml"
if not CONFIG_PATH.is_file():
    CONFIG_PATH = Path("config/config.toml")  # cwd-relative fallback

SERVER_HEARTBEAT_TYPE = 2
DIABLO_VERSION = 0


def load_toml(path: Path) -> dict:
    try:
        import tomllib

        with open(path, "rb") as f:
            return tomllib.load(f)
    except ImportError:
        pass
    try:
        import tomli

        with open(path, "rb") as f:
            return tomli.load(f)
    except ImportError:
        pass
    try:
        import toml

        return toml.load(str(path))
    except ImportError:
        pass
    raise RuntimeError("Need tomllib (py3.11+), tomli, or toml: pip install tomli")


def load_config(config_path: Path) -> dict:
    if not config_path.is_file():
        return {}
    return load_toml(config_path)


def fetch_engine_state(backend_url: str, timeout: float = 2.0) -> int:
    """GET /api/engine_state from GUI backend. Returns 0 (IDLE) on failure."""
    try:
        import urllib.request

        req = urllib.request.Request(f"{backend_url.rstrip('/')}/api/engine_state")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode())
            return int(data.get("engineState", 0))
    except Exception:
        return 0


def build_heartbeat_packet(engine_state: int) -> bytes:
    ts_ms = int(time.time() * 1000) & 0xFFFFFFFF
    return bytes(
        [
            SERVER_HEARTBEAT_TYPE,
            DIABLO_VERSION,
            (ts_ms >> 0) & 0xFF,
            (ts_ms >> 8) & 0xFF,
            (ts_ms >> 16) & 0xFF,
            (ts_ms >> 24) & 0xFF,
            engine_state & 0xFF,
        ]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="SERVER_HEARTBEAT service")
    parser.add_argument(
        "--config", type=Path, default=CONFIG_PATH, help="config.toml path"
    )
    parser.add_argument(
        "--backend-url",
        default="http://127.0.0.1:8082",
        help="GUI backend URL for engine_state",
    )
    parser.add_argument(
        "--interval-ms", type=int, default=None, help="Override heartbeat interval"
    )
    parser.add_argument("--broadcast-ip", default=None, help="Override broadcast IP")
    parser.add_argument(
        "--broadcast-port", type=int, default=None, help="Override broadcast port"
    )
    args = parser.parse_args()

    cfg = load_config(args.config)
    hb = cfg.get("server_heartbeat", {})
    svc = cfg.get("heartbeat_service", {})

    interval_ms = (
        args.interval_ms or svc.get("interval_ms") or hb.get("interval_ms", 1000)
    )
    broadcast_ip = (
        args.broadcast_ip
        or svc.get("broadcast_ip")
        or hb.get("broadcast_ip", "255.255.255.255")
    )
    broadcast_port = (
        args.broadcast_port
        or svc.get("broadcast_port")
        or hb.get("broadcast_port", 5005)
    )
    backend_url = svc.get("backend_url", args.backend_url)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)

    print(
        f"[HeartbeatService] Started — interval={interval_ms}ms broadcast={broadcast_ip}:{broadcast_port}"
    )
    print(f"[HeartbeatService] Engine state from {backend_url}/api/engine_state")

    last_log = 0.0
    count = 0
    while True:
        try:
            engine_state = fetch_engine_state(backend_url)
            pkt = build_heartbeat_packet(engine_state)
            sock.sendto(pkt, (broadcast_ip, broadcast_port))
            count += 1
            now = time.time()
            if now - last_log >= 10.0:
                print(
                    f"[HeartbeatService] Sent {count} heartbeats (engine_state={engine_state})"
                )
                last_log = now
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"[HeartbeatService] Error: {e}", file=sys.stderr)
        time.sleep(interval_ms / 1000.0)

    sock.close()
    print("[HeartbeatService] Stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())

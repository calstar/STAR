#!/usr/bin/env python3
"""
Standalone config packet broadcaster.

Builds ACTUATOR_CONFIG and SENSOR_CONFIG from config.toml and calibration JSON,
sends them via UDP to boards. No backend dependency.

Usage:
    python scripts/services/config_broadcast_service.py [--config PATH] [--interval-ms MS]

Config: config/config.toml [config_broadcast_service]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent.parent
CONFIG_PATH = _REPO_ROOT / "config" / "config.toml"
if not CONFIG_PATH.is_file():
    CONFIG_PATH = Path("config/config.toml")

TARGET_PORT = 5005


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Config packet broadcaster (standalone)"
    )
    parser.add_argument(
        "--config", type=Path, default=CONFIG_PATH, help="config.toml path"
    )
    parser.add_argument(
        "--interval-ms", type=int, default=None, help="Broadcast interval ms"
    )
    args = parser.parse_args()

    # Import after potential cwd changes
    from config_packet_builder import build_all_config_packets

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

    cfg = load_toml(args.config) if args.config.is_file() else {}
    svc = cfg.get("config_broadcast_service", {})
    interval_ms = args.interval_ms or svc.get("interval_ms", 1000)

    sock = __import__("socket").socket(
        __import__("socket").AF_INET, __import__("socket").SOCK_DGRAM
    )

    print(
        f"[ConfigBroadcast] Started — interval={interval_ms}ms (standalone, no backend)"
    )
    last_log = 0.0
    total_sent = 0
    while True:
        try:
            packets = build_all_config_packets()
            for pkt_type, board_id, raw, ip in packets:
                try:
                    sock.sendto(raw, (ip, TARGET_PORT))
                    total_sent += 1
                except Exception as e:
                    print(f"[ConfigBroadcast] Send error to {ip}: {e}", file=sys.stderr)
            now = time.time()
            if now - last_log >= 10.0 and total_sent > 0:
                print(f"[ConfigBroadcast] Sent {total_sent} packets total")
                last_log = now
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"[ConfigBroadcast] Error: {e}", file=sys.stderr)
        time.sleep(interval_ms / 1000.0)

    sock.close()
    print("[ConfigBroadcast] Stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())

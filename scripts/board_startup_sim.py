#!/usr/bin/env python3
"""
Integration-only simulated board: SETUP heartbeats → wait for SENSOR_CONFIG (type 5) → send SELF_TEST.

Matches Diablo PacketHeader (6B) + SelfTestPacket + N×SelfTestResult (DAQv2-Comms).
"""

from __future__ import annotations

import argparse
import socket
import struct
import sys
import time

PACKET_BOARD_HEARTBEAT = 1
PACKET_SENSOR_CONFIG = 5
PACKET_SELF_TEST = 12
BOARD_TYPE_PT = 1  # minimal type for heartbeat body
BOARD_STATE_SETUP = 1
ENGINE_SAFE = 0
DIABLO_VERSION = 0


def build_board_heartbeat(_board_type: int, board_id: int, ts_ms: int) -> bytes:
    """DAQv2 BoardHeartbeatPacket: 32B hash + board_id + engine_state + board_state."""
    header = struct.pack(
        "<BBI", PACKET_BOARD_HEARTBEAT, DIABLO_VERSION, ts_ms & 0xFFFFFFFF
    )
    firmware_hash = bytes(32)
    body = firmware_hash + struct.pack(
        "<BBB", board_id & 0xFF, ENGINE_SAFE, BOARD_STATE_SETUP
    )
    return header + body


def build_self_test_packet(sensor_results: list[tuple[int, int]]) -> bytes:
    """sensor_results: list of (sensor_id, result) result 1=pass 0=fail."""
    ts_ms = int(time.time() * 1000) & 0xFFFFFFFF
    header = struct.pack("<BBI", PACKET_SELF_TEST, DIABLO_VERSION, ts_ms)
    n = min(len(sensor_results), 255)
    adc_good = 1  # SelfTestPacket.adc_good — required on wire before num_sensors
    body = struct.pack("BB", adc_good, n)
    for i in range(n):
        sid, res = sensor_results[i]
        body += struct.pack("BB", sid & 0xFF, 1 if res else 0)
    return header + body


def main() -> int:
    p = argparse.ArgumentParser(
        description="Board startup E2E helper for integration tests"
    )
    p.add_argument("--board-ip", default="127.0.0.60")
    p.add_argument("--listen-port", type=int, required=True)
    p.add_argument("--daq-host", default="127.0.0.1")
    p.add_argument("--daq-port", type=int, required=True)
    p.add_argument("--board-id", type=int, default=60)
    p.add_argument(
        "--board-type",
        type=int,
        default=BOARD_TYPE_PT,
        help="Heartbeat board_type byte",
    )
    p.add_argument("--timeout-s", type=float, default=90.0)
    args = p.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((args.board_ip, args.listen_port))
    except OSError as e:
        print(
            f"[board_startup_sim] bind {args.board_ip}:{args.listen_port} failed: {e}",
            flush=True,
        )
        return 1

    sock.settimeout(0.5)
    target = (args.daq_host, args.daq_port)
    deadline = time.time() + args.timeout_s
    last_hb = 0.0

    print(
        f"[board_startup_sim] board_id={args.board_id} listen={args.board_ip}:{args.listen_port} "
        f"→ DAQ {target[0]}:{target[1]}",
        flush=True,
    )

    while time.time() < deadline:
        now = time.time()
        if now - last_hb >= 1.0:
            ts_ms = int(now * 1000) & 0xFFFFFFFF
            pkt = build_board_heartbeat(args.board_type, args.board_id, ts_ms)
            sock.sendto(pkt, target)
            last_hb = now
        try:
            data, _addr = sock.recvfrom(4096)
            if data and len(data) >= 1 and data[0] == PACKET_SENSOR_CONFIG:
                print(
                    "[board_startup_sim] SENSOR_CONFIG received, sending SELF_TEST",
                    flush=True,
                )
                # Single pass result for connector 2 — keeps WS path unambiguous (integration asserts sensor_2=1).
                st = build_self_test_packet([(2, 1)])
                sock.sendto(st, target)
                sock.close()
                return 0
        except socket.timeout:
            continue

    print("[board_startup_sim] timeout waiting for SENSOR_CONFIG", flush=True)
    sock.close()
    return 2


if __name__ == "__main__":
    sys.exit(main())

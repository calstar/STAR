"""
Headless demo board — a fake LC board for testing a GUI with no hardware.

It behaves like the real firmware's UDP side:
  * sends BOARD_HEARTBEAT once per second (Setup until configured, then Active),
  * listens for SERVER_HEARTBEAT / SENSOR_CONFIG / ABORT / CLEAR_ABORT,
  * on SENSOR_CONFIG: replies with a SELF_TEST, then streams SENSOR_DATA at
    ~20 Hz with a slow sine per connector.

Run it alongside the GUI (both on localhost):

    # terminal 1
    python -m boardgui.demo_board
    # terminal 2
    python LC-GUI/lc_gui.py --board-ip 127.0.0.1

Pure stdlib + boardgui.protocol — no Qt.
"""

from __future__ import annotations

import argparse
import math
import socket
import struct
import time
from typing import List

from . import protocol


def _sine_code(t: float, connector_id: int) -> int:
    """A gentle signed-int32 wave, distinct per connector, as a u32 ADC code."""
    amp = 2.0e8
    signed = int(amp * math.sin(t * 0.7 + connector_id))
    return struct.unpack("<I", struct.pack("<i", signed))[0]


def build_sensor_data(connectors: List[int], board_ms: int, chunks: int = 4) -> bytes:
    body = bytearray(struct.pack(protocol.SENSOR_DATA_HEADER_FORMAT, chunks, len(connectors)))
    now = time.time()
    for c in range(chunks):
        body += struct.pack(protocol.SENSOR_DATA_CHUNK_FORMAT, (board_ms + c) & 0xFFFFFFFF)
        for cid in connectors:
            body += struct.pack(protocol.SENSOR_DATAPOINT_FORMAT, cid, _sine_code(now + c * 0.01, cid))
    return protocol._make_header(protocol.PacketType.SENSOR_DATA, board_ms) + bytes(body)


def build_self_test(connectors: List[int], board_ms: int) -> bytes:
    body = bytearray(struct.pack("<BB", 1, len(connectors)))  # adc_good=1
    for cid in connectors:
        body += struct.pack("<BB", cid, 1)                    # each connector passes
    return protocol._make_header(protocol.PacketType.SELF_TEST, board_ms) + bytes(body)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Fake LC board that feeds a board GUI.")
    p.add_argument("--server-ip", default="127.0.0.1", help="where to send data (the GUI host)")
    p.add_argument("--server-port", type=int, default=5006)
    p.add_argument("--listen-port", type=int, default=5005, help="where the GUI sends control")
    p.add_argument("--board-id", type=int, default=41)
    p.add_argument("--connectors", default="1,2,3")
    args = p.parse_args(argv)

    connectors = [int(x) for x in args.connectors.replace(",", " ").split()]
    fw_hash = bytes(range(32))

    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    rx.bind(("0.0.0.0", args.listen_port))
    rx.settimeout(0.02)
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    dest = (args.server_ip, args.server_port)
    start = time.time()
    board_state = protocol.BoardState.SETUP
    engine_state = protocol.EngineState.SAFE
    last_hb = 0.0
    last_data = 0.0
    print(f"[demo_board] id={args.board_id} -> {dest}, listening on :{args.listen_port}, "
          f"connectors={connectors}")

    while True:
        now = time.time()
        board_ms = int((now - start) * 1000) & 0xFFFFFFFF

        # receive control packets
        try:
            data, addr = rx.recvfrom(protocol.MAX_PACKET_SIZE)
            hdr = protocol.parse_header(data)
            if hdr:
                name = protocol.packet_type_name(hdr.packet_type)
                if hdr.packet_type == protocol.PacketType.SENSOR_CONFIG:
                    sc = protocol.parse_sensor_config(data)
                    if sc:
                        connectors[:] = sc.sensor_ids or connectors
                        print(f"[demo_board] SENSOR_CONFIG connectors={connectors} "
                              f"ref={sc.reference_voltage} -> self-test + Active")
                        tx.sendto(build_self_test(connectors, board_ms), dest)
                        board_state = protocol.BoardState.ACTIVE
                elif hdr.packet_type == protocol.PacketType.SERVER_HEARTBEAT and len(data) > 6:
                    engine_state = data[6]
                elif hdr.packet_type == protocol.PacketType.ABORT:
                    board_state = protocol.BoardState.STANDALONE_ABORT
                    print("[demo_board] ABORT -> Standalone Abort")
                elif hdr.packet_type == protocol.PacketType.CLEAR_ABORT:
                    board_state = protocol.BoardState.ACTIVE
                    print("[demo_board] CLEAR_ABORT -> Active")
                else:
                    print(f"[demo_board] rx {name}")
        except socket.timeout:
            pass

        # 1 Hz heartbeat
        if now - last_hb >= 1.0:
            last_hb = now
            hb = protocol._make_header(protocol.PacketType.BOARD_HEARTBEAT, board_ms) + \
                struct.pack(protocol.BOARD_HEARTBEAT_BODY_FORMAT, fw_hash, args.board_id,
                            engine_state, board_state)
            tx.sendto(hb, dest)

        # ~20 Hz sensor data when active
        if board_state in (protocol.BoardState.ACTIVE, protocol.BoardState.STANDALONE_ABORT):
            if now - last_data >= 0.05:
                last_data = now
                tx.sendto(build_sensor_data(connectors, board_ms), dest)

        time.sleep(0.005)


if __name__ == "__main__":
    raise SystemExit(main())

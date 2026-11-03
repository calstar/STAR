#!/usr/bin/env python3
"""Watch a Valve Encoder Board's RS-485 output from a laptop.

Hardware: any USB-to-RS-485 adapter. Wire its A to the board's RS485_A
(J2 pin 1), B to RS485_B (J2 pin 2), and its GND to the board's GND. If you
see only bad frames, swap A and B (vendors label them inconsistently).

    pip install pyserial
    python3 rs485_monitor.py --port /dev/ttyUSB0          # stream mode
    python3 rs485_monitor.py --port COM5 --poll 1         # polled mode, ID 1
    python3 rs485_monitor.py --list                       # find the port
    python3 rs485_monitor.py --file capture.bin           # decode a capture

Decodes the same frame format as include/valve_protocol.h (DRAFT v1).
"""

import argparse
import struct
import sys
import time

SYNC0, SYNC1 = 0xAA, 0x55
MAX_PAYLOAD = 32
TYPE_VALVE_STATUS = 0x01
TYPE_POLL = 0x10

STATES = {0: "UNKNOWN", 1: "CLOSED", 2: "OPEN", 3: "MOVING", 4: "FAULT"}
FLAGS = [
    (0x01, "magnet"),
    (0x02, "MAGNET-WEAK"),
    (0x04, "MAGNET-STRONG"),
    (0x08, "I2C-ERROR"),
    (0x10, "NOT-CALIBRATED"),
]


def crc16(data: bytes, crc: int = 0xFFFF) -> int:
    """CRC-16/CCITT-FALSE, same as valve_proto::crc16."""
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


def encode_frame(msg_type: int, valve_id: int, payload: bytes = b"") -> bytes:
    body = bytes([msg_type, valve_id, len(payload)]) + payload
    return bytes([SYNC0, SYNC1]) + body + struct.pack("<H", crc16(body))


class Parser:
    """Byte-at-a-time parser; mirrors valve_proto::Parser."""

    def __init__(self):
        self.buf = bytearray()
        self.good = 0
        self.bad = 0

    def feed(self, data: bytes):
        self.buf += data
        frames = []
        while True:
            start = self.buf.find(bytes([SYNC0, SYNC1]))
            if start < 0:
                # keep a trailing 0xAA in case its 0x55 is in the next chunk
                self.buf = self.buf[-1:] if self.buf[-1:] == b"\xaa" else bytearray()
                return frames
            del self.buf[:start]
            if len(self.buf) < 5:
                return frames
            length = self.buf[4]
            if length > MAX_PAYLOAD:
                self.bad += 1
                del self.buf[:2]
                continue
            total = 5 + length + 2
            if len(self.buf) < total:
                return frames
            body = bytes(self.buf[2 : 5 + length])
            (crc_rx,) = struct.unpack_from("<H", self.buf, 5 + length)
            if crc16(body) != crc_rx:
                self.bad += 1
                del self.buf[:2]
                continue
            del self.buf[:total]
            self.good += 1
            frames.append((body[0], body[1], body[3:]))


def describe(msg_type: int, valve_id: int, payload: bytes) -> str:
    if msg_type == TYPE_VALVE_STATUS and len(payload) == 9:
        seq, state, flags, raw, uptime = struct.unpack("<BBBHI", payload)
        names = [name for bit, name in FLAGS if flags & bit]
        return (
            f"valve {valve_id:3d}  seq {seq:3d}  {STATES.get(state, state):8s}"
            f"  raw {raw:4d} ({raw * 360 / 4096:6.1f} deg)"
            f"  t={uptime / 1000:9.3f}s  [{' '.join(names)}]"
        )
    if msg_type == TYPE_POLL:
        return f"POLL -> valve {valve_id}"
    return f"type 0x{msg_type:02X} id {valve_id} payload {payload.hex()}"


def run_file(path: str) -> int:
    parser = Parser()
    with open(path, "rb") as f:
        for frame in parser.feed(f.read()):
            print(describe(*frame))
    print(f"good={parser.good} bad={parser.bad}", file=sys.stderr)
    return 0 if parser.bad == 0 else 1


def run_port(args) -> int:
    try:
        import serial  # pyserial
    except ImportError:
        print("pip install pyserial", file=sys.stderr)
        return 2
    ser = serial.Serial(args.port, args.baud, timeout=0.05)
    parser = Parser()
    last_poll = 0.0
    last_stats = time.time()
    print(f"listening on {args.port} @ {args.baud} baud (Ctrl+C to stop)")
    try:
        while True:
            now = time.time()
            if args.poll is not None and now - last_poll >= args.interval:
                # Many USB adapters switch direction automatically.
                ser.write(encode_frame(TYPE_POLL, args.poll))
                ser.flush()
                last_poll = now
            for frame in parser.feed(ser.read(256)):
                if frame[0] == TYPE_POLL and args.poll is not None:
                    continue  # our own poll echoed back by the adapter
                print(describe(*frame))
            if now - last_stats >= 5:
                print(f"-- good frames {parser.good}, bad {parser.bad}")
                last_stats = now
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", help="serial port, e.g. /dev/ttyUSB0 or COM5")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--poll", type=int, help="send POLLs to this valve ID")
    ap.add_argument("--interval", type=float, default=0.1, help="poll period s")
    ap.add_argument("--file", help="decode a binary capture instead")
    ap.add_argument("--list", action="store_true", help="list serial ports")
    args = ap.parse_args()

    if args.list:
        from serial.tools import list_ports

        for p in list_ports.comports():
            print(p.device, "-", p.description)
        return 0
    if args.file:
        return run_file(args.file)
    if not args.port:
        ap.error("--port (or --file / --list) is required")
    return run_port(args)


if __name__ == "__main__":
    sys.exit(main())

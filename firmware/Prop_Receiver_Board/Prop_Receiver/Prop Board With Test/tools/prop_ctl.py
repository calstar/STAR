#!/usr/bin/env python3
"""
prop_ctl.py: command-line client for the STAR Prop Receiver (UDP, port 5005). Standard library only.

  prop_ctl.py <ip> ping
  prop_ctl.py <ip> status
  prop_ctl.py <ip> enable <mask>          e.g. 0x01 = channel 1, 0x1F = all five
  prop_ctl.py <ip> set <ch 1-5> <mA>
  prop_ctl.py <ip> setall <mA1> <mA2> <mA3> <mA4> <mA5>
  prop_ctl.py <ip> estop
  prop_ctl.py <ip> cal <ch 1-5> <gain> <offset_mA>
  prop_ctl.py <ip> timeout <ms>           0 = failsafe off

Channels are numbered 1-5 like the board nets (20mA_1..20mA_5); on the wire they are 0-4.
Options via environment: PROP_PORT (default 5005), PROP_ADDR (default 1).
"""
import os, socket, struct, sys

NUM_CH = 5
STATUS = {0: "OK", 1: "BAD_CMD", 2: "BAD_LEN", 3: "BAD_ARG", 4: "HW"}
CMD = dict(ping=0x01, set=0x02, setall=0x03, enable=0x04, status=0x05, estop=0x06, cal=0x07, timeout=0x08)


def crc16(data):
    c = 0xFFFF
    for b in data:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    return c


def frame(addr, cmd, payload=b""):
    body = bytes([addr, cmd, len(payload)]) + payload
    return b"\xA5" + body + struct.pack("<H", crc16(body))


def transact(host, port, addr, cmd, payload=b"", timeout=1.0, retries=2):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        for _ in range(retries + 1):
            s.sendto(frame(addr, cmd, payload), (host, port))
            try:
                r, _ = s.recvfrom(512)
            except socket.timeout:
                continue
            if len(r) < 7 or r[0] != 0xA5 or r[3] != len(r) - 6:
                raise SystemExit("malformed reply: " + r.hex())
            if crc16(r[1:-2]) != struct.unpack("<H", r[-2:])[0]:
                raise SystemExit("bad CRC in reply")
            if r[2] != (cmd | 0x80):
                raise SystemExit("unexpected reply command 0x%02X" % r[2])
            return r[4], r[5:5 + r[3] - 1]
        raise SystemExit("no reply from %s:%d (addr 0x%02X)" % (host, port, addr))
    finally:
        s.close()


def channel(arg):
    ch = int(arg, 0)
    if not 1 <= ch <= NUM_CH:
        raise SystemExit("channel must be 1-%d" % NUM_CH)
    return ch - 1


def main(argv):
    if len(argv) < 3 or argv[2] not in CMD:
        print(__doc__.strip())
        return 2
    host, name, args = argv[1], argv[2], argv[3:]
    port = int(os.environ.get("PROP_PORT", "5005"))
    addr = int(os.environ.get("PROP_ADDR", "1"), 0)

    need = dict(ping=0, status=0, estop=0, enable=1, set=2, setall=NUM_CH, cal=3, timeout=1)[name]
    if len(args) != need:
        raise SystemExit("'%s' takes %d argument(s)" % (name, need))

    if name == "enable":
        payload = bytes([int(args[0], 0) & 0xFF])
    elif name == "set":
        payload = struct.pack("<Bf", channel(args[0]), float(args[1]))
    elif name == "setall":
        payload = struct.pack("<5f", *map(float, args))
    elif name == "cal":
        payload = struct.pack("<Bff", channel(args[0]), float(args[1]), float(args[2]))
    elif name == "timeout":
        payload = struct.pack("<H", int(args[0], 0))
    else:
        payload = b""

    st, pl = transact(host, port, addr, CMD[name], payload)
    print("status: %s" % STATUS.get(st, "0x%02X" % st))
    if st != 0:
        return 1

    if name == "ping" and len(pl) >= 6:
        ver, node, up = struct.unpack("<BBI", pl[:6])
        print("firmware v%d, node 0x%02X, uptime %d s" % (ver, node, up))
    elif name == "status" and len(pl) >= 51:
        v = struct.unpack("<B5f5H5f", pl[:51])
        mask, tgt, mv, ma = v[0], v[1:6], v[6:11], v[11:16]
        print("enable mask: 0x%02X" % mask)
        print("  ch  enabled  target mA  feedback mV  feedback mA")
        for i in range(NUM_CH):
            fb_mv = "n/a" if mv[i] == 0xFFFF else str(mv[i])
            fb_ma = "n/a" if mv[i] == 0xFFFF else "%.2f" % ma[i]
            print("  %d   %-7s  %9.3f  %11s  %11s" % (i + 1, "yes" if mask >> i & 1 else "no", tgt[i], fb_mv, fb_ma))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

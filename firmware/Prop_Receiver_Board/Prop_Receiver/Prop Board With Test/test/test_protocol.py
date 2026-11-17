#!/usr/bin/env python3
"""
End-to-end protocol tests over UDP. Standard library only (unittest).

  python3 test_protocol.py            # starts the C simulator (build/sim_udp) on localhost
  BOARD_IP=192.168.1.50 python3 test_protocol.py   # same tests against a REAL board
  BOARD_IP=... BOARD_PORT=5005 ...    # optional port

Tests marked "hardware" only run when BOARD_IP is set. Do tests with a dummy load, not an actuator.
The frame encoder here is written independently of the C code on purpose (cross-implementation check).
"""
import os, socket, struct, subprocess, sys, time, unittest

NUM_CH = 5
HERE = os.path.dirname(os.path.abspath(__file__))
BOARD_IP = os.environ.get("BOARD_IP")
HW = BOARD_IP is not None
ST = {0: "OK", 1: "BAD_CMD", 2: "BAD_LEN", 3: "BAD_ARG", 4: "HW"}
CMD = dict(ping=1, set=2, setall=3, enable=4, status=5, estop=6, cal=7, timeout=8)

def _pins_value(name):
    """Reads a float constant from ../main/pins.h so the tests follow the configured output range."""
    import re
    with open(os.path.join(HERE, "..", "main", "pins.h")) as f:
        m = re.search(r"#define\s+%s\s+([0-9.]+)f?" % name, f.read())
    return float(m.group(1))

MA_MAX = _pins_value("LOOP_MA_MAX")      # highest accepted set-point

def crc16(d):
    c = 0xFFFF
    for b in d:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    return c

def frame(cmd, payload=b"", addr=1):
    body = bytes([addr, cmd, len(payload)]) + payload
    return b"\xA5" + body + struct.pack("<H", crc16(body))

class Node:
    def __init__(self, host, port):
        self.addr = (host, port)
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.s.settimeout(1.0)
    def send_raw(self, data): self.s.sendto(data, self.addr)
    def recv(self, timeout=1.0):
        self.s.settimeout(timeout)
        try:
            r, _ = self.s.recvfrom(512)
        except socket.timeout:
            return None
        assert r[0] == 0xA5, "bad SOF in reply"
        assert crc16(r[1:-2]) == struct.unpack("<H", r[-2:])[0], "bad CRC in reply"
        assert r[3] == len(r) - 6, "bad length field in reply"
        return dict(addr=r[1], cmd=r[2], status=r[4], payload=r[5:5 + r[3] - 1])
    def call(self, name, payload=b"", addr=1, timeout=1.0):
        self.send_raw(frame(CMD[name], payload, addr))
        return self.recv(timeout)
    def drain(self):
        self.s.settimeout(0.05)
        try:
            while True: self.s.recvfrom(512)
        except socket.timeout:
            pass
    # conveniences
    def set(self, ch, ma): return self.call("set", struct.pack("<Bf", ch, ma))
    def enable(self, mask): return self.call("enable", bytes([mask]))
    def status(self):
        r = self.call("status")
        assert r and r["status"] == 0, r
        v = struct.unpack("<B5f5H5f", r["payload"])
        return dict(mask=v[0], target=list(v[1:6]), fb_mv=list(v[6:11]), fb_ma=list(v[11:16]))

_sim = None
_target = None
def setUpModule():
    global _sim, _target
    if HW:
        _target = (BOARD_IP, int(os.environ.get("BOARD_PORT", "5005")))
        return
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    binp = os.path.join(os.environ.get("PROP_BUILD", os.path.join(HERE, "build")), "sim_udp")
    if not os.path.exists(binp):
        raise RuntimeError("Simulator not built: run `make` in test/ first (%s)" % binp)
    _sim = subprocess.Popen([binp, str(port)], stdout=subprocess.PIPE, text=True)
    line = _sim.stdout.readline()
    assert line.startswith("READY"), line
    _target = ("127.0.0.1", port)

def tearDownModule():
    if _sim:
        _sim.terminate(); _sim.wait(timeout=5)

class Base(unittest.TestCase):
    def setUp(self):
        self.n = Node(*_target)
        self.n.call("timeout", struct.pack("<H", 2000))     # known failsafe window
        self.n.call("estop")
        self.n.drain()
    def tearDown(self):
        self.n.call("estop")
        self.n.s.close()

class ProtocolTests(Base):
    def test_ping(self):
        r = self.n.call("ping")
        self.assertEqual(r["status"], 0)
        self.assertEqual(r["cmd"], 0x81)
        ver, addr, up = struct.unpack("<BBI", r["payload"])
        self.assertEqual(addr, 1); self.assertGreaterEqual(ver, 1)

    def test_outputs_start_disabled_after_estop(self):
        st = self.n.status()
        self.assertEqual(st["mask"], 0)
        self.assertEqual(st["target"], [0.0] * NUM_CH)

    def test_set_and_enable_roundtrip(self):
        self.assertEqual(self.n.set(2, MA_MAX)["status"], 0)               # upper boundary is accepted
        self.assertEqual(self.n.enable(0b00100)["status"], 0)
        st = self.n.status()
        self.assertEqual(st["mask"], 0b00100)
        self.assertAlmostEqual(st["target"][2], MA_MAX, places=4)
        self.assertEqual(st["target"][0], 0.0)

    def test_set_all(self):
        vals = [1.0, 2.0, 3.0, 4.0, 5.0]
        self.assertEqual(self.n.call("setall", struct.pack("<5f", *vals))["status"], 0)
        for a, b in zip(self.n.status()["target"], vals): self.assertAlmostEqual(a, b, places=4)

    def test_set_all_is_atomic(self):
        self.n.call("setall", struct.pack("<5f", 1, 2, 3, 4, 5))
        r = self.n.call("setall", struct.pack("<5f", 9, 9, 9, 99, 9))
        self.assertEqual(ST[r["status"]], "BAD_ARG")
        self.assertEqual(self.n.status()["target"], [1.0, 2.0, 3.0, 4.0, 5.0])

    def test_argument_validation(self):
        for ch, ma in [(5, 1.0), (255, 1.0), (0, -1.0), (0, MA_MAX + 0.5), (0, float("nan")), (0, float("inf"))]:
            r = self.n.set(ch, ma)
            self.assertEqual(ST[r["status"]], "BAD_ARG", (ch, ma))
        self.assertEqual(ST[self.n.call("set", b"\x00\x00")["status"]], "BAD_LEN")
        self.assertEqual(ST[self.n.call("enable", b"")["status"]], "BAD_LEN")
        self.assertEqual(ST[self.n.call("setall", b"\x00" * 16)["status"]], "BAD_LEN")
        self.assertEqual(ST[self.n.call("timeout", b"\x01")["status"]], "BAD_LEN")
        r = self.n.call("ping"); self.assertEqual(r["status"], 0)   # still alive

    def test_unknown_command(self):
        self.n.send_raw(frame(0x55))
        self.assertEqual(ST[self.n.recv()["status"]], "BAD_CMD")

    def test_enable_mask_is_clamped_to_five_channels(self):
        self.n.enable(0xFF)
        self.assertEqual(self.n.status()["mask"], 0x1F)

    def test_estop(self):
        self.n.call("setall", struct.pack("<5f", 5, 6, 7, 8, 9)); self.n.enable(0x1F)
        self.assertEqual(self.n.call("estop")["status"], 0)
        st = self.n.status()
        self.assertEqual(st["mask"], 0); self.assertEqual(st["target"], [0.0] * NUM_CH)

    def test_calibration_validation(self):
        good = struct.pack("<Bff", 1, 1.02, 0.1)
        self.assertEqual(self.n.call("cal", good)["status"], 0)
        self.n.call("cal", struct.pack("<Bff", 1, 1.0, 0.0))          # restore
        for bad in [struct.pack("<Bff", 1, 0.2, 0.0), struct.pack("<Bff", 1, 3.0, 0.0),
                    struct.pack("<Bff", 1, 1.0, 9.0), struct.pack("<Bff", 7, 1.0, 0.0),
                    struct.pack("<Bff", 1, float("nan"), 0.0)]:
            self.assertEqual(ST[self.n.call("cal", bad)["status"]], "BAD_ARG")
        self.assertEqual(ST[self.n.call("cal", b"\x00")["status"]], "BAD_LEN")

class RobustnessTests(Base):
    def test_bad_crc_is_silently_dropped(self):
        f = bytearray(frame(CMD["enable"], b"\x01")); f[-1] ^= 0xFF
        self.n.send_raw(bytes(f))
        self.assertIsNone(self.n.recv(0.3))
        self.assertEqual(self.n.status()["mask"], 0)                   # and did not execute

    def test_wrong_address_is_ignored(self):
        self.n.send_raw(frame(CMD["enable"], b"\x01", addr=0x42))
        self.assertIsNone(self.n.recv(0.3))
        self.assertEqual(self.n.status()["mask"], 0)

    def test_broadcast_executes_without_reply(self):
        self.n.send_raw(frame(CMD["enable"], b"\x03", addr=0xFF))
        self.assertIsNone(self.n.recv(0.3))
        self.assertEqual(self.n.status()["mask"], 3)

    def test_garbage_datagrams_do_not_break_the_node(self):
        for blob in [b"", b"\xA5", b"\xA5\x01", os.urandom(300), b"\xA5\x01\x02\xFF" + b"\x00" * 40,
                     frame(CMD["ping"])[:-1], frame(CMD["ping"]) + b"\x00"]:
            self.n.send_raw(blob)
        self.n.drain()
        self.assertEqual(self.n.call("ping")["status"], 0)

    def test_rapid_fire(self):
        for i in range(200): self.n.send_raw(frame(CMD["ping"]))
        got = 0
        while self.n.recv(0.3): got += 1
        self.assertGreater(got, 100)                                    # UDP may drop some, but it must keep up
        self.assertEqual(self.n.call("ping")["status"], 0)

class FailsafeTests(Base):
    def test_failsafe_trips_after_silence(self):
        self.n.call("timeout", struct.pack("<H", 300))
        self.n.set(0, 8.0); self.n.enable(1)
        time.sleep(0.7)
        st = self.n.status()          # note: this status call itself is a valid command
        self.assertEqual(st["mask"], 0)
        self.assertEqual(st["target"][0], 0.0)

    def test_keepalive_prevents_failsafe(self):
        self.n.call("timeout", struct.pack("<H", 400))
        self.n.set(0, 8.0); self.n.enable(1)
        for _ in range(8):
            time.sleep(0.15); self.assertEqual(self.n.call("ping")["status"], 0)
        self.assertEqual(self.n.status()["mask"], 1)

    def test_timeout_zero_disables_failsafe(self):
        self.n.call("timeout", struct.pack("<H", 0))
        self.n.set(0, 8.0); self.n.enable(1)
        time.sleep(0.5)
        self.assertEqual(self.n.status()["mask"], 1)

    def test_garbage_does_not_feed_watchdog(self):
        self.n.call("timeout", struct.pack("<H", 400))
        self.n.set(0, 8.0); self.n.enable(1)
        end = time.time() + 0.8
        while time.time() < end:
            self.n.send_raw(os.urandom(20)); time.sleep(0.05)
        self.n.drain()
        self.assertEqual(self.n.status()["mask"], 0)

class FeedbackChainTests(Base):
    """Checks DAC math -> loop current -> feedback scaling agree. On real hardware this is the
    first real accuracy test (needs the loop connected to its sense resistor)."""
    def test_feedback_tracks_target(self):
        for target in (0.2 * MA_MAX, 0.5 * MA_MAX, 0.8 * MA_MAX, MA_MAX):
            self.n.set(0, target); self.n.enable(1)
            time.sleep(0.25 if HW else 0.1)
            fb = self.n.status()["fb_ma"][0]
            tol = max(0.6, target * 0.08)
            self.assertAlmostEqual(fb, target, delta=tol, msg="target %.1f mA, feedback says %.2f mA" % (target, fb))

    def test_feedback_near_zero_when_disabled(self):
        self.assertEqual(self.n.set(0, 0.75 * MA_MAX)["status"], 0); self.n.enable(0)
        time.sleep(0.25 if HW else 0.1)
        self.assertLess(self.n.status()["fb_ma"][0], 0.6)

    def test_channels_are_independent(self):
        targets = [f * MA_MAX for f in (0.1, 0.3, 0.5, 0.7, 0.9)]
        self.assertEqual(self.n.call("setall", struct.pack("<5f", *targets))["status"], 0); self.n.enable(0b00101)
        time.sleep(0.25 if HW else 0.1)
        fb = self.n.status()["fb_ma"]
        for ch, t in enumerate(targets):
            want = t if (0b00101 >> ch) & 1 else 0.0
            self.assertAlmostEqual(fb[ch], want, delta=max(0.6, want * 0.08), msg="ch%d" % (ch + 1))

@unittest.skipUnless(HW, "hardware only: set BOARD_IP")
class HardwareOnlyTests(Base):
    def test_ethernet_latency(self):
        t = []
        for _ in range(50):
            t0 = time.time(); self.assertEqual(self.n.call("ping")["status"], 0); t.append(time.time() - t0)
        t.sort(); print("\n   ping latency median %.1f ms, worst %.1f ms" % (t[25] * 1000, t[-1] * 1000))
        self.assertLess(t[25], 0.05)

    def test_adc_reads_plausible_idle_values(self):
        st = self.n.status()
        for ch, mv in enumerate(st["fb_mv"]):
            self.assertNotEqual(mv, 0xFFFF, "ch%d ADC unavailable" % (ch + 1))
            self.assertLess(mv, 300, "ch%d reads %d mV with outputs disabled" % (ch + 1, mv))

class CliTests(Base):
    """The prop_ctl.py command-line tool, run as a subprocess against the same target."""
    def run_cli(self, *args):
        env = dict(os.environ, PROP_PORT=str(_target[1]))
        return subprocess.run([sys.executable, os.path.join(HERE, "..", "tools", "prop_ctl.py"), _target[0], *args],
                              capture_output=True, text=True, env=env, timeout=10)
    def test_cli_ping_and_status(self):
        r = self.run_cli("ping"); self.assertEqual(r.returncode, 0, r.stderr); self.assertIn("status: OK", r.stdout)
        self.run_cli("set", "1", "7.5"); self.run_cli("enable", "0x01")
        r = self.run_cli("status"); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("enable mask: 0x01", r.stdout); self.assertIn("7.5", r.stdout)

if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""calibration_service, end to end and hermetic: freeze what it publishes and the files it writes.

    service_run.py --cal build/bin/calibration_service --fixtures <dir>   > stack.txt

The service runs in a private temp directory (every store path it uses is relative to its cwd:
scripts/calibration/calibrations/{cubic_calibration,lc_tare}.json, abort_thresholds.txt), with
the fixture config (board IPs 127.0.0.x, never the stand's) and a stand-in Elodin on an
OS-assigned 127.0.0.1 port, the same relay test/t7_integration.py uses. The stand-in rather than
a real elodin-db because the golden is the exact, ordered byte stream the service writes: the
stand-in hands raw packets and commands to the service on one socket, in the order written here,
and records everything the service writes back, so nothing depends on the database's scheduling.

Raw packets carry fixed timestamps, which the calibrated messages echo, so the stream needs no
normalisation. In the files, timestamps written from the wall clock (within an hour of now) are
masked, and the robust preview curve's psi values (fitCurve[].psi) are masked: the robust model
adds a bias that RobustCalibrationFramework propagates by wall-clock dt between predictions, so
those numbers are not a function of the inputs (reported as a defect, not hidden in a tolerance).

Never run on the stand. Binds one 127.0.0.1 port: run it under with_stack_lock.sh.
"""

from __future__ import annotations

import argparse
import difflib
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

CAL_DIR = "scripts/calibration/calibrations"
MS = 1_000_000
TIMEOUT_S = 30.0


def frame(hi: int, lo: int, body: bytes, ty: int = 1) -> bytes:
    """ElodinClient framing: u32 len (body + 4) | ty | id hi | id lo | req | body."""
    return struct.pack("<IBBBB", 4 + len(body), ty, hi, lo, 0) + body


class FakeElodin:
    """One client at a time (the service). Records every frame it writes, in order."""

    def __init__(self) -> None:
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen()
        self.port = self.srv.getsockname()[1]
        self.cond = threading.Condition()
        self.frames: list[tuple[int, int, int, int, bytes]] = []
        self.client: socket.socket | None = None
        self.connections = 0
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            with self.cond:
                self.client = c
                self.connections += 1
                self.cond.notify_all()
            threading.Thread(target=self._read, args=(c,), daemon=True).start()

    def _read(self, c: socket.socket) -> None:
        buf = b""
        while True:
            try:
                d = c.recv(65536)
            except OSError:
                break
            if not d:
                break
            buf += d
            while len(buf) >= 8:
                (ln,) = struct.unpack_from("<I", buf)
                if len(buf) < 4 + ln:
                    break
                pkt, buf = buf[: 4 + ln], buf[4 + ln :]
                with self.cond:
                    self.frames.append((pkt[4], pkt[5], pkt[6], pkt[7], pkt[8:]))
                    self.cond.notify_all()

    def wait_connections(self, n: int) -> None:
        with self.cond:
            if not self.cond.wait_for(lambda: self.connections >= n, TIMEOUT_S):
                raise RuntimeError("calibration_service did not connect")

    def send(self, data: bytes) -> None:
        assert self.client is not None
        self.client.sendall(data)

    def wait_for(self, pred, what: str) -> int:
        with self.cond:
            for _ in range(int(TIMEOUT_S / 0.05)):
                for i, f in enumerate(self.frames):
                    if pred(f):
                        return i
                self.cond.wait(0.05)
        raise RuntimeError(f"timed out waiting for {what}")

    def close(self) -> None:
        self.srv.close()
        if self.client:
            self.client.close()


class Run:
    def __init__(self, cal: str, fixtures: Path, work: Path) -> None:
        self.cal = cal
        self.fix = fixtures
        self.work = work
        self.db = FakeElodin()
        self.ts = 1_700_000_000_000 * MS  # synthetic sample clock, ns
        self.cursor = 0  # frames already printed
        self.marker = 4_000_000
        self.proc: subprocess.Popen | None = None
        self.out: list[str] = []
        self.seen: dict[str, list[str]] = {}  # last snapshot of each file, for diffs

    # ── service lifecycle ───────────────────────────────────────────────────────────────────
    def start(self) -> None:
        env = {k: v for k, v in os.environ.items() if not k.startswith("CAL_")}
        log = open(self.work / "cal.log", "a")
        self.proc = subprocess.Popen(
            [
                self.cal,
                "--config",
                "config/config.toml",
                "--elodin-port",
                str(self.db.port),
                "--adjustments",
                "adj.json",
            ],
            cwd=self.work,
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
        )
        self.db.wait_connections(self.db.connections + 1)

    def stop(self) -> None:
        assert self.proc is not None
        self.proc.send_signal(signal.SIGTERM)
        try:
            rc = self.proc.wait(timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            raise RuntimeError("calibration_service did not stop on SIGTERM")
        self.p(f"service exit code {rc}")
        self.proc = None

    # ── input ───────────────────────────────────────────────────────────────────────────────
    def tick(self, ms: int = 20) -> int:
        self.ts += ms * MS
        return self.ts

    def raw(
        self, hi: int, lo: int, adc: int, ch: int | None = None, signed: bool = True
    ) -> bytes:
        body = struct.pack(
            "<QB3x" + ("i" if signed else "I") + "IB",
            self.tick(),
            (lo & 0x1F) if ch is None else ch,
            adc,
            0,
            0,
        )
        return frame(hi, lo, body)

    def t7(self, lo: int, volts: float) -> bytes:
        return frame(
            0x26, lo, struct.pack("<QB3xfIB", self.tick(), lo & 0x1F, volts, 0, 0)
        )

    def cmd(self, cmd: int, uid: int, ref: float, stamp: int | None = None) -> bytes:
        ts = self.tick() if stamp is None else stamp
        return frame(0x46, 0x00, struct.pack("<QBBHf", ts, cmd, 0, uid, ref))

    def sync(self) -> None:
        """Round-trip a sentinel through the service: everything sent before it is processed and
        every file it wrote is on disk once the sentinel's calibrated echo is back."""
        self.marker += 1
        m = self.marker
        self.db.send(self.raw(0x30, 0x23, m, signed=False))
        self.db.wait_for(
            lambda f: f[1] == 0x31
            and f[2] == 0x33
            and len(f[4]) == 21
            and struct.unpack_from("<I", f[4], 16)[0] == m,
            f"sentinel {m}",
        )

    # ── output ──────────────────────────────────────────────────────────────────────────────
    def p(self, s: str) -> None:
        self.out.append(s)

    def drain(self, label: str) -> None:
        """Print every frame the service wrote since the last drain (sentinels left out)."""
        with self.db.cond:
            frames = self.db.frames[self.cursor :]
            self.cursor = len(self.db.frames)
        self.p(f"-- published: {label}")
        for ty, hi, lo, req, body in frames:
            if (
                len(body) == 21
                and (hi, lo) == (0x31, 0x33)
                and struct.unpack_from("<I", body, 16)[0] > 4_000_000
            ):
                continue
            calibrated = len(body) == 21 and (
                hi in (0x31, 0x34) or (0x20 <= hi <= 0x26 and (lo & 0x1F) >= 0x10)
            )
            if calibrated:
                ts, ch, value, raw, status = struct.unpack("<QB3xfIB", body)
                bits = struct.unpack("<I", struct.pack("<f", value))[0]
                self.p(
                    f"  [{hi:02x},{lo:02x}] ts=+{(ts - 1_700_000_000_000 * MS) // MS}ms "
                    f"ch={ch} value={value!r:} bits={bits:08x} raw={raw} status={status}"
                )
            else:
                self.p(
                    f"  frame ty={ty} id=[{hi:02x},{lo:02x}] req={req} len={len(body)}"
                )
                for i in range(0, len(body), 32):
                    self.p("    " + body[i : i + 32].hex())

    def files(self, label: str) -> None:
        cal = self.work / CAL_DIR
        self.p(f"-- files: {label}")
        names = sorted(
            str(p.relative_to(self.work))
            for p in self.work.rglob("*")
            if p.is_file() and p.name != "cal.log"
        )
        self.p("  ls: " + " ".join(names))
        for rel in ("cubic_calibration.json", "lc_tare.json", "abort_thresholds.txt"):
            self.dump(f"{CAL_DIR}/{rel}", (cal / rel))
        self.dump("adj.json", self.work / "adj.json")

    def dump(self, label: str, path: Path) -> None:
        """A file's first snapshot in full, every later one as a diff against the previous."""
        lines = (
            normalize(path.read_text()).splitlines() if path.exists() else ["<absent>"]
        )
        prev = self.seen.get(label)
        self.seen[label] = lines
        if prev is None:
            self.p(f"  --- {label} ---")
            self.out.extend(lines)
            self.p(f"  --- end {label} ---")
        elif prev == lines:
            self.p(f"  --- {label}: unchanged")
        else:
            self.p(f"  --- {label}: diff")
            for d in list(difflib.unified_diff(prev, lines, lineterm="", n=2))[2:]:
                self.p("  " + d)


def normalize(text: str) -> str:
    now = time.time()

    def ts(m: re.Match) -> str:
        v = float(m.group(2))
        recent = abs(v - now) < 3600 or abs(v - now * 1000) < 3.6e6
        return m.group(1) + ('"<NOW>"' if recent else m.group(2))

    text = re.sub(
        r'("(?:generated_unix|updatedAt|t|set_at_ms)": )(-?[0-9][0-9.eE+-]*)', ts, text
    )
    text = re.sub(r"(generated_unix )([0-9]+)", ts, text)
    # fitCurve psi: robust predictions carry a wall-clock-propagated bias (see module docstring).
    out: list[str] = []
    depth = 0  # bracket depth inside a "fitCurve" array; 0 = outside
    for line in text.splitlines():
        if depth == 0 and '"fitCurve": [' in line:
            depth = (
                1
                if not line.rstrip().endswith("]") and not line.rstrip().endswith("],")
                else 0
            )
        elif depth > 0:
            depth += line.count("[") - line.count("]")
            line = re.sub(r'("psi": )[^,]*(,?)$', r'\1"<ROBUST>"\2', line)
        out.append(line)
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


# ── the scenario ────────────────────────────────────────────────────────────────────────────

PT_RATIO = [
    0,
    1,
    -1,
    214748365,
    300000000,
    429496730,
    600000000,
    858993460,
    1073741824,
    1717986918,
    2040109466,
    2147483647,
    -2147483648,
    -214748365,
]


# 4-20 mA shunt codes: 0, 3 mA, 3.99, 4.0, 4.05, 4.09 (latches), 4.0 (holds), 3.93 (drops),
# 12 mA, 20 mA, 21 mA, the open-loop 0xFFFF0FB5, 0x80000000, 0xFFFFFFFF.
def ma_code(ma: float) -> int:
    return int(round(ma * 120.0 / 1000.0 / 2.5 * 2147483648.0))


PT_LOOP = [
    0,
    ma_code(3.0),
    ma_code(3.99),
    ma_code(4.0),
    ma_code(4.05),
    ma_code(4.09),
    ma_code(4.0),
    ma_code(3.93),
    ma_code(12.0),
    ma_code(20.0),
    ma_code(21.0),
    0xFFFF0FB5,
    0x80000000,
    0xFFFFFFFF,
    2147483647,
]
TC = [
    0,
    1,
    -1,
    3518437,
    35184372,
    88583218,
    59750000,
    -5600000,
    2147483647,
    -2147483648,
]
RTD = [
    0,
    1,
    85899346,
    94489281,
    107374182,
    128849018,
    171798692,
    2145336164,
    -85899346,
    2147483647,
]
LC = [
    0,
    1,
    -1,
    100000,
    1100000,
    2100000,
    137438953,
    -137438953,
    2147483647,
    -2147483648,
]
ACT = [0, 1, 1000, 2047, 4095, 4096, 0xFFFFFFFF]
BV = [0, 247, 248, 353, 496, 1489, 2482, 3000, 4095, 0xFFFFFFFF]
T7_PT = [0.0, 1.0, 1.25, 3.0, 5.0, 5.5, -1.0]
T7_TC = [0.0, 0.001, 0.004096, -0.007, 0.07]
T7_RTD = [0.0, 1.0, 1.25, 1.5, 2.5, 3.0]
T7_LC = [0.0, 0.0025, 0.01, 0.02, -0.01]
T7_PT6 = [0.5, 1.0, 2.5, 4.5, 0.0]


def sweep(r: Run, full: bool = True) -> None:
    pkts = b""
    for ch in (1, 2, 3, 4, 5):
        for v in (PT_RATIO if full else PT_RATIO[3:9]):
            pkts += r.raw(0x20, ch, v)
    for ch in (1, 2, 3, 4):
        for v in (PT_LOOP if full else PT_LOOP[3:10]):
            pkts += r.raw(0x20, 0x20 + ch, v, signed=False)
    for ch in (1, 2, 6):
        for v in (LC if full else LC[3:7]):
            pkts += r.raw(0x23, 0x20 + ch, v)
    if full:
        for ch in (1, 2, 3):
            for v in TC:
                pkts += r.raw(0x21, ch, v)
        for ch in (1, 2):
            for v in RTD:
                pkts += r.raw(0x22, ch, v)
        for ch in (1, 2, 3, 0x0B, 0x0F):
            for v in ACT:
                pkts += r.raw(0x30, 0x20 + ch, v, signed=False)
        for ch in (1, 2):
            for v in BV:
                pkts += r.raw(0x33, ch, v, signed=False)
        # T7: a TC sample before any cold junction is not published; NaN / inf are dropped.
        pkts += r.t7(0x02, 0.004096)
        pkts += r.t7(0x0F, 22.0)
        pkts += r.t7(0x01, float("nan"))
        pkts += r.t7(0x01, float("inf"))
    for ain, vs in ((1, T7_PT), (2, T7_TC), (3, T7_RTD), (4, T7_LC), (6, T7_PT6)):
        for v in (vs if full else vs[:3]):
            pkts += r.t7(ain, v)
    if full:
        # Things the service must ignore: our own calibrated ids, channel 0 / 11, a short
        # payload, an unknown type, a T7 AIN with no channel, a type 2 frame.
        pkts += r.raw(0x20, 0x11, 5)
        pkts += r.raw(0x20, 0x00, 5)
        pkts += r.raw(0x20, 0x0B, 5)
        pkts += frame(0x20, 0x01, b"\x00" * 20)
        pkts += r.raw(0x25, 0x01, 5)
        pkts += r.raw(0x24, 0x01, 5)
        pkts += r.t7(0x05, 1.0)
        pkts += frame(0x20, 0x01, r.raw(0x20, 0x01, 5)[8:], ty=2)
        # A PT payload whose channel byte disagrees with its id (published under the id's).
        pkts += r.raw(0x20, 0x02, 429496730, ch=7)
    r.db.send(pkts)
    r.sync()


def burst(r: Run, sends: list[tuple[str, int, float]]) -> bytes:
    """>=3 fresh samples per uid inside one capture window, after a jump that leaves every
    earlier sample out of it. ("pt", lo, adc) etc."""
    r.tick(10_000)
    pkts = b""
    for _ in range(10):
        for kind, lo, v in sends:
            if kind == "pt":
                pkts += r.raw(0x20, lo, int(v))
            elif kind == "loop":
                pkts += r.raw(0x20, lo, int(v), signed=False)
            elif kind == "lc":
                pkts += r.raw(0x23, lo, int(v))
            elif kind == "t7":
                pkts += r.t7(lo, v)
    return pkts


def commands(r: Run) -> None:
    db = r.db
    # Cubic PT with one resumed point: a second point makes a fit.
    db.send(burst(r, [("pt", 3, 600000000)]) + r.cmd(5, 2103, 450.0))
    # The same command bytes again (a second subscription's copy): dropped.
    dup = r.cmd(5, 2103, 450.0)
    db.send(burst(r, [("pt", 3, 640000000)]) + dup + dup)
    # Legacy cubic capture (cmd 3) on the 4-20 mA cubic channel, shunt code units.
    db.send(burst(r, [("loop", 0x23, ma_code(8.0))]) + r.cmd(3, 2203, 1250.0))
    # LC linear: a third point; LC cubic: a fourth.
    db.send(
        burst(r, [("lc", 0x21, 1100000), ("lc", 0x22, 3000000)])
        + r.cmd(5, 4201, 25.0)
        + r.cmd(5, 4202, 61.5)
    )
    # A capture whose window holds a step: recorded, flagged unsettled.
    r.tick(10_000)
    step = b"".join(
        r.raw(0x20, 1, 400000000 if i < 6 else 420000000) for i in range(12)
    )
    db.send(step + r.cmd(5, 2101, 300.0))
    # T7 cubic PT (µV) and T7 linear LC captures.
    db.send(
        burst(r, [("t7", 6, 3.0), ("t7", 4, 0.01)])
        + r.cmd(5, 8106, 1250.0)
        + r.cmd(5, 8104, 250.0)
    )
    db.send(burst(r, [("t7", 4, 0.0)]) + r.cmd(5, 8104, 0.0))
    r.sync()
    r.drain("captures")
    r.files("after captures")

    # Tares: one LC, a non-LC uid (ignored), the T7 LC, then clear one.
    db.send(
        burst(r, [("lc", 0x21, 900000), ("lc", 0x26, 2000000), ("t7", 4, 0.005)])
        + r.cmd(8, 4201, 0.0)
        + r.cmd(8, 2101, 0.0)
        + r.cmd(8, 4206, 0.0)
        + r.cmd(8, 8104, 0.0)
    )
    r.sync()
    r.files("after tares")
    db.send(r.cmd(8, 4206, 1.0))
    # Zero one PT; capture-reference (robust learner only) on a physics PT; save adjustments.
    db.send(
        burst(r, [("pt", 1, 215500000), ("pt", 2, 230000000)])
        + r.cmd(0, 2101, 0.0)
        + r.cmd(1, 2102, 50.0)
        + r.cmd(2, 0, 0.0)
    )
    # Clear a PT (cmd 4) and an LC (cmd 6): back to nothing / physics.
    db.send(r.cmd(4, 2104, 0.0) + r.cmd(6, 4202, 0.0))
    r.sync()
    r.drain("tare / zero / clear")
    r.files("after tare clear / zero / clears")

    # Every stream after the captures.
    sweep(r, full=False)
    r.drain("sweep after captures")

    # Zero All and Tare All over every channel streaming right now.
    every = (
        [("pt", ch, 216000000 + ch) for ch in (1, 2, 3, 4, 5)]
        + [("loop", 0x20 + ch, ma_code(4.0) + ch) for ch in (1, 2, 3, 4)]
        + [("lc", 0x20 + ch, 50000 + ch) for ch in (1, 2, 6)]
        + [("t7", ain, v) for ain, v in ((1, 1.0), (4, 0.0), (6, 0.5))]
    )
    db.send(burst(r, every) + r.cmd(0, 0, 0.0))
    r.sync()
    lcs = [e for e in every if e[0] == "lc" or (e[0] == "t7" and e[1] == 4)]
    db.send(burst(r, lcs) + r.cmd(8, 0, 0.0))
    r.sync()
    r.drain("zero all / tare all")
    r.files("after zero all / tare all")
    db.send(r.cmd(8, 0, 1.0))
    r.sync()
    r.files("after tare clear all")


def profile_swap(r: Run) -> None:
    shutil.copy(
        r.fix / "profiles/restored-sep05.json",
        r.work / CAL_DIR / "cubic_calibration.json",
    )
    r.db.send(r.cmd(7, 0, 0.0))
    r.sync()
    r.drain("profile swap")
    r.files("after profile swap")
    sweep(r, full=False)
    r.drain("sweep after profile swap")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cal", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--keep", action="store_true", help="keep the work dir (debugging)")
    a = ap.parse_args()
    fixtures = Path(a.fixtures).resolve()
    work = Path(tempfile.mkdtemp(prefix="char_cal_stack."))
    try:
        (work / "config").mkdir()
        shutil.copy(fixtures / "stack_config.toml", work / "config/config.toml")
        cal = work / CAL_DIR
        cal.mkdir(parents=True)
        # The live store is absent, so the service seeds it from the committed default.
        shutil.copy(
            fixtures / "store_mixed.json", cal / "cubic_calibration.default.json"
        )
        shutil.copy(fixtures / "lc_tare.json", cal / "lc_tare.json")
        (cal / "tc").mkdir()
        shutil.copy(fixtures / "tc/tc_poly.json", cal / "tc/tc_poly.json")
        (cal / "rtd").mkdir()
        shutil.copy(fixtures / "rtd/root_poly.json", cal / "rtd/root_poly.json")

        r = Run(a.cal, fixtures, work)
        try:
            r.p("== startup ==")
            r.start()
            r.sync()
            r.drain("startup (registrations, subscriptions)")
            r.files("after startup")
            # Commands before any sample: a capture, a zero and a tare have nothing to average
            # and are refused; Zero All and Tare All find no channel.
            r.db.send(
                r.cmd(5, 2105, 100.0)
                + r.cmd(0, 2101, 0.0)
                + r.cmd(8, 4201, 0.0)
                + r.cmd(0, 0, 0.0)
                + r.cmd(8, 0, 0.0)
                + r.cmd(3, 2101, 5.0)
                + r.cmd(1, 2101, 5.0)
                + r.cmd(9, 2101, 1.0)
                + r.cmd(5, 9999, 1.0)
            )
            r.sync()
            r.drain("refused commands")
            r.files("after refused commands")
            r.p("== sweep ==")
            sweep(r)
            r.drain("sweep")
            r.p("== commands ==")
            commands(r)
            r.p("== profile swap ==")
            profile_swap(r)
            r.p("== shutdown ==")
            r.stop()
            r.files("after SIGTERM")
            r.p("== restart ==")
            r.start()
            r.sync()
            r.drain("restart (registrations, subscriptions)")
            r.files("after restart")
            sweep(r, full=False)
            r.drain("sweep after restart")
            r.stop()
        except Exception:
            if r.proc is not None:
                r.proc.kill()
            sys.stderr.write(
                (work / "cal.log").read_text()[-4000:]
                if (work / "cal.log").exists()
                else ""
            )
            raise
        finally:
            r.db.close()
        sys.stdout.write("\n".join(r.out) + "\n")
        return 0
    finally:
        if a.keep:
            sys.stderr.write(f"work dir kept: {work}\n")
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())

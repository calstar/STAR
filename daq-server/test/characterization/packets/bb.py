"""Black-box harness for the characterization goldens that come from the services themselves.

The built service binaries are started against a copy of a committed config with every board
address rewritten to loopback (192.168.2.x -> 127.0.0.x, exactly as the integration harness and the
board simulator do), and what they put on the wire is captured here: UDP datagrams by destination
address, and Elodin traffic by a loopback TCP server standing in for elodin-db. Nothing in this
module knows how a service builds its bytes; it only sees what leaves the process.

Off the stand only, and under test/characterization/with_stack_lock.sh: the services bind real
ports (the board port 5005 among them). Only processes this module started are ever signalled.
The 127.0.0.<board> loopback aliases must exist on macOS (Linux routes all of 127/8 to lo).
"""

from __future__ import annotations

import os
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

# ── golden files ─────────────────────────────────────────────────────────────


def finish(golden_dir: Path, name: str, actual: str) -> int:
    """Compare with golden_dir/name, or rewrite it when CHAR_UPDATE is set. 0 on pass."""
    path = golden_dir / name
    if os.environ.get("CHAR_UPDATE", "0") not in ("", "0"):
        path.write_text(actual)
        print(f"[golden] wrote {path} ({len(actual)} bytes)")
        return 0
    if not path.exists():
        print(f"[golden] MISSING {path}", file=sys.stderr)
        return 1
    expected = path.read_text()
    if expected == actual:
        print(f"[golden] {name}: match ({len(actual)} bytes)")
        return 0
    e, a = expected.splitlines(), actual.splitlines()
    print(
        f"[golden] {name}: MISMATCH ({len(e)} golden lines, {len(a)} actual)",
        file=sys.stderr,
    )
    shown = 0
    for i in range(max(len(e), len(a))):
        el = e[i] if i < len(e) else None
        al = a[i] if i < len(a) else None
        if el == al:
            continue
        print(f"  line {i + 1}:", file=sys.stderr)
        if el is not None:
            print(f"    - {el}", file=sys.stderr)
        if al is not None:
            print(f"    + {al}", file=sys.stderr)
        shown += 1
        if shown >= 60:
            break
    Path(name + ".actual").write_text(actual)
    return 1


# ── text formatting (the same layout as packets/golden.hpp) ──────────────────


def hexs(b: bytes) -> str:
    return " ".join(f"{x:02x}" for x in b)


def hexu(v: int, width: int = 0) -> str:
    return f"0x{v:0{width}x}"


def span(name: str, off: int, b: bytes) -> str:
    return f"  {name} @{off:<4} +{len(b):<3}: {hexs(b)}"


def fields(b: bytes, fs: list[tuple[str, int]]) -> list[str]:
    out, off = [], 0
    for name, size in fs:
        if off >= len(b):
            out.append(f"  {name} @{off}: <missing>")
            continue
        take = size
        short = off + take > len(b)
        if short:
            take = len(b) - off
        out.append(span(name + (" (short)" if short else ""), off, b[off : off + take]))
        off += take
    if off < len(b):
        out.append(span("<trailing>", off, b[off:]))
    return out


def clock_ok(b: bytes, lo: int, hi: int) -> bool:
    """A little-endian u32 millisecond stamp lies between two clock readings (mod 2^32)."""
    (v,) = struct.unpack_from("<I", b)
    lo &= 0xFFFFFFFF
    hi &= 0xFFFFFFFF
    return lo <= v <= hi if lo <= hi else (v >= lo or v <= hi)


def sys_ms() -> int:
    return time.time_ns() // 1_000_000


def steady_ms() -> int:
    """std::chrono::steady_clock in ms: CLOCK_MONOTONIC_RAW under libc++ on macOS (Python's
    monotonic is mach uptime there, which stops across sleep), CLOCK_MONOTONIC on Linux.
    """
    if sys.platform == "darwin":
        return time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW) // 1_000_000
    return time.monotonic_ns() // 1_000_000


# ── configs ──────────────────────────────────────────────────────────────────


def patched(text: str, **sets: str) -> str:
    """Loopback copy: every 192.168.2. becomes 127.0.0.; then `section.key=value` overrides."""
    text = text.replace("192.168.2.", "127.0.0.")
    for dotted, value in sets.items():
        section, key = dotted.split("__", 1)
        text = set_key(text, section, key, value)
    return text


def set_key(text: str, section: str, key: str, value: str) -> str:
    """Replace `key = ...` inside [section] (first occurrence); fail loudly if absent."""
    m = re.search(r"^\[" + re.escape(section) + r"\]\s*$", text, re.M)
    if not m:
        raise KeyError(f"[{section}] not in config")
    end = re.search(r"^\[", text[m.end() :], re.M)
    stop = m.end() + (end.start() if end else len(text) - m.end())
    body = text[m.end() : stop]
    body2, n = re.subn(
        r"^" + re.escape(key) + r"\s*=.*$",
        f"{key} = {value}",
        body,
        count=1,
        flags=re.M,
    )
    if n != 1:
        raise KeyError(f"{key} not in [{section}]")
    return text[: m.end()] + body2 + text[stop:]


def free_port(kind: int = socket.SOCK_DGRAM) -> int:
    s = socket.socket(socket.AF_INET, kind)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def require_aliases(addrs: list[str]) -> None:
    for a in addrs:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.bind((a, 0))
        except OSError as e:
            sys.exit(
                f"loopback alias {a} is missing ({e}); on macOS add it with "
                f"`sudo ifconfig lo0 alias {a}`"
            )
        finally:
            s.close()


# ── processes ────────────────────────────────────────────────────────────────


class Service:
    """A service binary this harness started; stopped with SIGTERM, then SIGKILL."""

    def __init__(self, argv: list[str], cwd: Path, log: Path):
        self.log = open(log, "wb")
        self.p = subprocess.Popen(
            argv,
            cwd=cwd,
            stdout=self.log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    def alive(self) -> bool:
        return self.p.poll() is None

    def stop(self) -> None:
        if self.p.poll() is None:
            self.p.send_signal(signal.SIGTERM)
            try:
                self.p.wait(5)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait(5)
        self.log.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.stop()


# ── UDP capture by destination address ───────────────────────────────────────

_IS_LINUX = sys.platform.startswith("linux")


class UdpCapture:
    """One wildcard socket on a port, so arrival order is send order, recording each datagram's
    destination address (IP_PKTINFO on Linux, IP_RECVDSTADDR on macOS)."""

    def __init__(self, port: int, host: str = "0.0.0.0"):
        self.port = port
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if _IS_LINUX:
            self.s.setsockopt(socket.IPPROTO_IP, socket.IP_PKTINFO, 1)
        else:
            self.s.setsockopt(socket.IPPROTO_IP, socket.IP_RECVDSTADDR, 1)
        self.s.bind((host, port))

    def close(self) -> None:
        self.s.close()

    def recv(self, timeout: float):
        """(dst_ip, src_ip, bytes, arrival_ms) or None."""
        r, _, _ = select.select([self.s], [], [], max(0.0, timeout))
        if not r:
            return None
        data, anc, _, src = self.s.recvmsg(65536, 256)
        dst = "?"
        for level, typ, cd in anc:
            if level != socket.IPPROTO_IP:
                continue
            if _IS_LINUX and typ == socket.IP_PKTINFO and len(cd) >= 12:
                dst = socket.inet_ntoa(cd[8:12])
            elif not _IS_LINUX and typ == socket.IP_RECVDSTADDR and len(cd) >= 4:
                dst = socket.inet_ntoa(cd[:4])
        return dst, src[0], data, sys_ms()

    def collect(
        self, until_quiet: float, max_s: float, first_s: float = 5.0, pred=None
    ):
        """Datagrams until `until_quiet` s pass with none (after the first), or max_s."""
        out, start = [], time.monotonic()
        last = None
        while True:
            now = time.monotonic()
            if now - start > max_s:
                break
            wait = (
                (first_s - (now - start))
                if last is None
                else (until_quiet - (now - last))
            )
            if wait <= 0:
                break
            got = self.recv(wait)
            if got is None:
                continue
            if pred is None or pred(got):
                out.append(got)
                last = time.monotonic()
        return out


# ── a loopback stand-in for elodin-db ────────────────────────────────────────


class FakeElodin:
    """Accepts any number of connections and records every byte each one sends. `push` writes
    bytes to the most recent connection (used to feed the sequencer state to subscribers).
    """

    def __init__(self):
        self.l = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.l.bind(("127.0.0.1", 0))
        self.l.listen(8)
        self.port = self.l.getsockname()[1]
        self.lock = threading.Lock()
        self.conns: list[socket.socket] = []
        self.data: list[bytearray] = []
        self.stamps: list[float] = []  # monotonic time of the last byte per connection
        self.stopped = False
        self.threads: list[threading.Thread] = []
        t = threading.Thread(target=self._accept, daemon=True)
        t.start()
        self.threads.append(t)

    def _accept(self):
        while not self.stopped:
            try:
                c, _ = self.l.accept()
            except OSError:
                return
            if self.stopped:  # the wake-up connection from close()
                c.close()
                return
            with self.lock:
                idx = len(self.conns)
                self.conns.append(c)
                self.data.append(bytearray())
                self.stamps.append(time.monotonic())
            t = threading.Thread(target=self._read, args=(c, idx), daemon=True)
            t.start()
            with self.lock:
                self.threads.append(t)

    def _read(self, c, idx):
        while True:
            try:
                b = c.recv(65536)
            except OSError:
                return
            if not b:
                return
            with self.lock:
                self.data[idx] += b
                self.stamps[idx] = time.monotonic()

    def wait_conn(self, n: int, timeout: float = 10.0) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            with self.lock:
                if len(self.conns) >= n:
                    return True
            time.sleep(0.02)
        return False

    def wait_quiet(self, quiet: float, max_s: float, min_bytes: int = 1) -> None:
        start = time.monotonic()
        while time.monotonic() - start < max_s:
            with self.lock:
                total = sum(len(d) for d in self.data)
                last = max(self.stamps) if self.stamps else start
            if total >= min_bytes and time.monotonic() - last > quiet:
                return
            time.sleep(0.05)

    def push(self, b: bytes) -> None:
        with self.lock:
            for c in self.conns:
                try:
                    c.sendall(b)
                except OSError:
                    pass

    def stream(self) -> bytes:
        with self.lock:
            return b"".join(bytes(d) for d in self.data)

    def close(self):
        """Wake every blocked accept/recv with shutdown() and join the threads before the fds
        are closed. A thread left blocked on a closed fd is not just a leak: under qemu-user
        (amd64 emulated on arm64) its restarted accept() lands on whatever reuses that fd number
        next, i.e. the next FakeElodin's listener, and steals that service's connection.
        """
        self.stopped = True
        try:  # wakes a blocked accept() on every platform (macOS ignores shutdown() on a listener)
            socket.create_connection(("127.0.0.1", self.port), 1).close()
        except OSError:
            pass
        with self.lock:
            socks = [self.l] + list(self.conns)
            threads = list(self.threads)
        for s in socks:
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for t in threads:
            t.join(5)
        for s in socks:
            try:
                s.close()
            except OSError:
                pass


def elodin_frames(stream: bytes):
    """Split an Elodin byte stream into (len, ty, id0, id1, req, payload, raw); plus a tail."""
    out, o = [], 0
    while o + 8 <= len(stream):
        (ln,) = struct.unpack_from("<I", stream, o)
        if ln < 4 or o + 4 + ln > len(stream):
            break
        raw = stream[o : o + 4 + ln]
        out.append((ln, raw[4], raw[5], raw[6], raw[7], raw[8:], raw))
        o += 4 + ln
    return out, stream[o:]


def sequencer_state_frame(state: int, ts_ns: int = 1_700_000_000_000_000_000) -> bytes:
    """A SequencerState [0x50,0x00] TABLE row: u64 ts | u8 state | pad3 | u32 bitmask | u8 debug."""
    payload = struct.pack("<QB3xIB", ts_ns, state, 0, 0)
    return struct.pack("<IB2BB", len(payload) + 4, 1, 0x50, 0x00, 0) + payload

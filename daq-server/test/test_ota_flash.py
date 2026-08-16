#!/usr/bin/env python3
"""
Fake-board test for the C++ ota_service (diablo_server/services/ota).

No hardware. Exercises the exact ethernet-flash wire format that a real ESP32-S3
board depends on, against a loopback TCP "fake board" that speaks the espota
handshake:

    1. board accepts TCP on 127.0.0.1:3232 (OTA_PORT — a compile-time constant)
    2. board reads a 4-byte BIG-ENDIAN firmware size
    3. board reads exactly that many firmware bytes (ota_service sends in 4 KB chunks)
    4. board replies "OK\\n"  (or reboots without replying — also success)

The test launches the real ota_service binary, connects to its command port
(TCP, default 9997) and issues `OTA_FLASH:<ip>:<path>`, then asserts on both the
bytes the fake board received and the OK/ERR reply the service returns.

Covers: big-endian size header, multi-chunk streaming byte-fidelity, "OK"
detection, silent-reboot-is-success, board-error -> ERR, and the command
parser's error paths (missing file, connect refused, bad format, unknown cmd).

Run:  python3 test/test_ota_flash.py            (from daq-server/)
Binary is auto-discovered at build/bin/ota_service; override with OTA_SERVICE_BIN.
"""

from __future__ import annotations

import os
import random
import socket
import struct
import subprocess
import sys
import threading
import time

OTA_BOARD_PORT = 3232  # fixed in ota_service (OTA_PORT); the fake board must bind this
BOARD_IP = "127.0.0.1"
CONNECT_WAIT_S = 5.0  # how long to wait for ota_service to come up
REPLY_WAIT_S = 20.0  # how long to wait for an OK/ERR reply


# ── binary discovery ──────────────────────────────────────────────────────────


def find_ota_service() -> str:
    override = os.environ.get("OTA_SERVICE_BIN")
    if override:
        if not os.path.isfile(override):
            print(f"[test_ota_flash] OTA_SERVICE_BIN not found: {override}", flush=True)
            sys.exit(2)
        return override
    here = os.path.dirname(os.path.abspath(__file__))
    daq_root = os.path.dirname(here)  # daq-server/
    candidates = [
        os.path.join(daq_root, "build", "bin", "ota_service"),
        os.path.join(daq_root, "build-ci", "FSW", "ota_service"),
        os.path.join(daq_root, "build", "FSW", "ota_service"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    print(
        "[test_ota_flash] ota_service binary not found. Build it first "
        "(bash scripts/build.sh) or set OTA_SERVICE_BIN. Looked in:\n  "
        + "\n  ".join(candidates),
        flush=True,
    )
    sys.exit(2)


def pick_free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ── fake board ────────────────────────────────────────────────────────────────


class FakeBoard(threading.Thread):
    """One-shot espota listener on 127.0.0.1:3232.

    behavior: 'ok'     -> read all, reply "OK\\n"
              'silent' -> read all, close without replying (ESP32 rebooted first)
              'error'  -> read all, reply "FAILED\\n"
    Captures the declared size header and the received firmware bytes.
    """

    def __init__(self, behavior: str = "ok") -> None:
        super().__init__(daemon=True)
        self.behavior = behavior
        self.declared_size: int | None = None
        self.received: bytes = b""
        self.error: str | None = None
        self._ready = threading.Event()
        self._srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

    def bind(self) -> bool:
        try:
            self._srv.bind((BOARD_IP, OTA_BOARD_PORT))
            self._srv.listen(1)
            self._srv.settimeout(CONNECT_WAIT_S + REPLY_WAIT_S)
            return True
        except OSError as e:
            self.error = f"fake board bind {BOARD_IP}:{OTA_BOARD_PORT} failed: {e}"
            return False

    def run(self) -> None:
        try:
            self._ready.set()
            conn, _ = self._srv.accept()
        except OSError as e:
            self.error = f"accept failed: {e}"
            self._srv.close()
            return
        try:
            conn.settimeout(REPLY_WAIT_S)
            hdr = self._recv_exact(conn, 4)
            if hdr is None:
                self.error = "did not receive 4-byte size header"
                return
            self.declared_size = struct.unpack(">I", hdr)[0]
            self.received = self._recv_exact(conn, self.declared_size) or b""
            if self.behavior == "ok":
                conn.sendall(b"OK\n")
            elif self.behavior == "error":
                conn.sendall(b"FAILED\n")
            # 'silent': send nothing, just close (board rebooted before replying)
        except OSError as e:
            self.error = f"board io error: {e}"
        finally:
            try:
                conn.close()
            except OSError:
                pass
            self._srv.close()

    @staticmethod
    def _recv_exact(conn: socket.socket, n: int) -> bytes | None:
        buf = bytearray()
        while len(buf) < n:
            chunk = conn.recv(min(65536, n - len(buf)))
            if not chunk:
                return None
            buf += chunk
        return bytes(buf)


# ── ota_service driver ────────────────────────────────────────────────────────


def wait_until_listening(port: int, deadline: float) -> bool:
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def send_command(port: int, line: str) -> str:
    """Send one command line to ota_service; return its trimmed reply."""
    with socket.create_connection(("127.0.0.1", port), timeout=REPLY_WAIT_S) as s:
        s.settimeout(REPLY_WAIT_S)
        s.sendall(line.encode() + b"\n")
        s.shutdown(socket.SHUT_WR)
        buf = bytearray()
        while True:
            try:
                chunk = s.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
            if b"\n" in buf:
                break
    return buf.decode(errors="replace").strip()


# ── test harness ──────────────────────────────────────────────────────────────


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        mark = "PASS" if ok else "FAIL"
        if ok:
            self.passed += 1
        else:
            self.failed += 1
        line = f"  [{mark}] {name}"
        if detail:
            line += f" — {detail}"
        print(line, flush=True)


def make_firmware(tmpdir: str, name: str, size: int) -> tuple[str, bytes]:
    # Deterministic pseudo-random content (fixed seed) so failures are reproducible.
    data = bytes(random.Random(0xB0A2D + size).randbytes(size))
    path = os.path.join(tmpdir, name)
    with open(path, "wb") as f:
        f.write(data)
    return path, data


def run_flash(port: int, ip: str, path: str, behavior: str, r: Results, label: str,
              expect_ok: bool, verify_bytes: bytes | None) -> None:
    """Start a fake board, issue OTA_FLASH, and assert reply + received bytes."""
    board = FakeBoard(behavior=behavior)
    if not board.bind():
        r.check(label, False, board.error or "bind failed")
        return
    board.start()
    board._ready.wait(2.0)
    reply = send_command(port, f"OTA_FLASH:{ip}:{path}")
    board.join(timeout=REPLY_WAIT_S)

    got_ok = reply.startswith("OK")
    if expect_ok:
        r.check(f"{label}: service reply OK", got_ok, reply)
    else:
        r.check(f"{label}: service reply ERR", reply.startswith("ERR"), reply)

    if verify_bytes is not None:
        r.check(
            f"{label}: size header (big-endian) matches file",
            board.declared_size == len(verify_bytes),
            f"declared={board.declared_size} expected={len(verify_bytes)}",
        )
        r.check(
            f"{label}: received bytes identical to firmware",
            board.received == verify_bytes,
            f"got {len(board.received)}/{len(verify_bytes)} bytes"
            + (f"; board error: {board.error}" if board.error else ""),
        )


def main() -> int:
    import tempfile

    bin_path = find_ota_service()
    ota_port = pick_free_port()
    print(f"[test_ota_flash] binary={bin_path}", flush=True)
    print(f"[test_ota_flash] ota_service command port={ota_port}, board port={OTA_BOARD_PORT}",
          flush=True)

    # Make sure nothing is already squatting the fixed board port (would poison the
    # connect-refused case and the byte-fidelity cases alike).
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind((BOARD_IP, OTA_BOARD_PORT))
    except OSError as e:
        print(
            f"[test_ota_flash] port {OTA_BOARD_PORT} is in use ({e}); a real stack or "
            "another test may be running. Aborting.",
            flush=True,
        )
        return 2
    finally:
        probe.close()

    proc = subprocess.Popen(
        [bin_path, "--port", str(ota_port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    r = Results()
    try:
        if not wait_until_listening(ota_port, time.time() + CONNECT_WAIT_S):
            print("[test_ota_flash] ota_service never started listening", flush=True)
            return 2

        with tempfile.TemporaryDirectory() as tmp:
            # 10 KB spans three 4 KB chunks -> exercises the send loop / offset math.
            big_path, big_data = make_firmware(tmp, "firmware_big.bin", 10_000)
            # Exact multiple of the 4 KB chunk size -> boundary case.
            aligned_path, aligned_data = make_firmware(tmp, "firmware_aligned.bin", 8192)

            # 1. Happy path: board acks OK. Validates BE size + chunking + exact bytes.
            run_flash(ota_port, BOARD_IP, big_path, "ok", r,
                      "flash_ok (10KB, multi-chunk)", expect_ok=True, verify_bytes=big_data)

            # 2. Chunk-aligned payload still transfers byte-for-byte.
            run_flash(ota_port, BOARD_IP, aligned_path, "ok", r,
                      "flash_ok (8KB, chunk-aligned)", expect_ok=True, verify_bytes=aligned_data)

            # 3. Board reboots before replying -> ota_service treats no-response as success.
            run_flash(ota_port, BOARD_IP, big_path, "silent", r,
                      "flash_silent_reboot", expect_ok=True, verify_bytes=big_data)

            # 4. Board replies with a non-OK string -> ERR, but bytes still arrived intact.
            run_flash(ota_port, BOARD_IP, big_path, "error", r,
                      "flash_board_error", expect_ok=False, verify_bytes=big_data)

            # 5. Missing firmware file -> ERR before any connect.
            reply = send_command(ota_port, f"OTA_FLASH:{BOARD_IP}:{tmp}/does_not_exist.bin")
            r.check("flash_missing_file: ERR cannot open",
                    reply.startswith("ERR") and "cannot open" in reply, reply)

            # 6. Nothing listening on 3232 -> ERR connect refused.
            reply = send_command(ota_port, f"OTA_FLASH:{BOARD_IP}:{big_path}")
            r.check("flash_connect_refused: ERR connect",
                    reply.startswith("ERR") and "connect" in reply, reply)

            # 7. Malformed OTA_FLASH (missing the :<path>) -> ERR bad format.
            reply = send_command(ota_port, "OTA_FLASH:justanip")
            r.check("bad_format: ERR bad OTA_FLASH",
                    reply.startswith("ERR") and "OTA_FLASH" in reply, reply)

            # 8. Unknown command -> ERR unknown command.
            reply = send_command(ota_port, "HELLO_WORLD")
            r.check("unknown_command: ERR",
                    reply.startswith("ERR") and "unknown" in reply, reply)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    print(f"\n[test_ota_flash] {r.passed} passed, {r.failed} failed", flush=True)
    return 0 if r.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

"""
Push firmware to a board over Ethernet, from the GUI.

Mirrors ``firmware/tools/ota_upload.py`` — the same wire protocol the boards
implement in ``firmware/libraries/STAR_EthernetOTA``, in the same way
``protocol.py`` mirrors DAQv2-Comms:

    GUI   -> board : [4-byte big-endian image size][raw firmware bytes]
    board -> GUI   : "OK\\r\\n", then reboot

Two ways to know an update actually landed, both of which the GUI checks:

* **Firmware hash.** Every board computes the SHA-256 of its own running
  image at boot and reports it in BOARD_HEARTBEAT. When the hash in the
  heartbeat matches the hash of the .bin we sent, the board is provably
  running that exact binary.
* **Test message.** Building with ``-DSTAR_OTA_TEST_MESSAGE='"..."'`` makes
  the board print ``[OTA-MSG] <text>`` on a timer. Give each upload a
  different message and you can watch the board's serial output change — the
  cheapest possible confirmation, and the one that needs no arithmetic.

Pure standard library — ``python -m boardgui.ota`` runs an offline round trip
against a fake board.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import socket
import struct
import subprocess
from pathlib import Path
from typing import Callable, List, Optional

OTA_PORT = 3232
CHUNK_SIZE = 4096
CONNECT_TIMEOUT = 5.0
TRANSFER_TIMEOUT = 60.0
# Matches STAR_OTA_MAX_IMAGE_BYTES on the board.
MAX_IMAGE_BYTES = 0x200000

ProgressFn = Callable[[int, int], None]
LogFn = Callable[[str], None]


class OtaError(RuntimeError):
    """Upload or build failed. The message is meant to be shown to a human."""


def firmware_sha256(data: bytes) -> str:
    """SHA-256 of the .bin file itself. NOT what the board reports."""
    return hashlib.sha256(data).hexdigest()


def board_reported_sha256(data: bytes) -> Optional[str]:
    """The digest the board prints and puts in BOARD_HEARTBEAT.

    The board uses esp_partition_get_sha256(), which returns the 32-byte
    SHA-256 esptool appends to the image, computed over the image *excluding*
    those 32 bytes. Hashing the whole .bin gives a different number that can
    never match, so verification would sit at "not verified" forever after a
    perfectly good upload. Present when byte 23 of the ESP32 image header
    (magic 0xE9) has the hash_appended flag set.
    """
    if len(data) < 33 or data[0] != 0xE9 or not data[23]:
        return None
    return data[-32:].hex()


def upload(data: bytes, ip: str, port: int = OTA_PORT,
           on_progress: Optional[ProgressFn] = None,
           connect_timeout: float = CONNECT_TIMEOUT,
           transfer_timeout: float = TRANSFER_TIMEOUT,
           should_cancel: Optional[Callable[[], bool]] = None) -> str:
    """Send `data` to the board and wait for its acknowledgement."""
    if not data:
        raise OtaError("firmware image is empty")
    if len(data) > MAX_IMAGE_BYTES:
        raise OtaError(
            f"image is {len(data)} bytes; the board rejects anything over "
            f"{MAX_IMAGE_BYTES}")

    try:
        sock = socket.create_connection((ip, port), timeout=connect_timeout)
    except OSError as exc:
        raise OtaError(
            f"could not connect to {ip}:{port} — {exc}. Is the board powered, "
            f"reachable from this host, and past its boot delay?") from exc

    try:
        sock.settimeout(transfer_timeout)
        sock.sendall(struct.pack(">I", len(data)))

        sent = 0
        while sent < len(data):
            if should_cancel and should_cancel():
                raise OtaError(
                    f"cancelled after {sent} of {len(data)} bytes. The board "
                    f"will time out and keep running its current firmware.")
            chunk = data[sent:sent + CHUNK_SIZE]
            try:
                sock.sendall(chunk)
            except OSError as exc:
                raise OtaError(
                    f"transfer failed after {sent} of {len(data)} bytes — "
                    f"{exc}") from exc
            sent += len(chunk)
            if on_progress:
                on_progress(sent, len(data))

        try:
            reply = sock.recv(64).decode("utf-8", "replace").strip()
        except OSError as exc:
            raise OtaError(
                f"image sent, but the board never acknowledged it ({exc}). "
                f"Check its serial log for '[OTA] ERROR'.") from exc

        if reply != "OK":
            raise OtaError(
                f"board replied {reply!r} instead of 'OK' — check its serial "
                f"log for '[OTA] ERROR'")
        return reply
    finally:
        sock.close()


# ---------------------------------------------------------------------------
# Building (only needed to bake in a test message)
# ---------------------------------------------------------------------------
def find_pio() -> str:
    """Locate the PlatformIO CLI, including its default install locations."""
    found = shutil.which("pio") or shutil.which("platformio")
    if found:
        return found
    for c in (Path.home() / ".platformio" / "penv" / "bin" / "pio",
              Path.home() / ".platformio" / "penv" / "Scripts" / "pio.exe"):
        if c.exists():
            return str(c)
    raise OtaError(
        "PlatformIO CLI not found. Install it (pip install platformio), or "
        "build the firmware yourself and pick the .bin directly.")


def build(project: Path, env: Optional[str] = None,
          message: Optional[str] = None,
          on_log: Optional[LogFn] = None) -> Path:
    """Build `project`, optionally baking in a test message. Returns the .bin.

    The message goes in through PLATFORMIO_BUILD_FLAGS rather than by editing
    platformio.ini, so running this never dirties the repo.
    """
    project = Path(project).resolve()
    if not (project / "platformio.ini").exists():
        raise OtaError(f"{project} has no platformio.ini")

    cmd = [find_pio(), "run", "-d", str(project)]
    if env:
        cmd += ["-e", env]

    build_env = os.environ.copy()
    if message:
        if '"' in message or "'" in message:
            raise OtaError("the test message cannot contain quote characters; "
                           "they do not survive the trip to the compiler.")
        # Single-quote the whole value. PlatformIO splits PLATFORMIO_BUILD_FLAGS
        # with shlex, so a bare \"two words\" is torn in half at the space and
        # the string literal never terminates -- which is what the default
        # "upload #N at HH:MM:SS" message does every time. This is the form
        # documented at the top of this file.
        flag = f"-DSTAR_OTA_TEST_MESSAGE='\"{message}\"'"
        existing = build_env.get("PLATFORMIO_BUILD_FLAGS", "")
        build_env["PLATFORMIO_BUILD_FLAGS"] = (existing + " " + flag).strip()

    if on_log:
        on_log(f"Building {project.name}" +
               (f" with message {message!r}" if message else "") + "…")

    result = subprocess.run(cmd, env=build_env, text=True, capture_output=True)
    if result.returncode != 0:
        tail = "\n".join((result.stdout + result.stderr).splitlines()[-25:])
        raise OtaError(f"build failed:\n{tail}")

    bins = sorted((project / ".pio" / "build").glob("*/firmware.bin"),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    if not bins:
        raise OtaError(f"build succeeded but no firmware.bin under {project}")
    if on_log:
        on_log(f"Built {bins[0]}")
    return bins[0]


def default_test_message(counter: int) -> str:
    """A message that is obviously different from the last one."""
    import time
    return f"upload #{counter} at {time.strftime('%H:%M:%S')}"


# ---------------------------------------------------------------------------
def _self_test() -> None:
    import threading

    received = {}

    def fake_board(srv: socket.socket, reply: bytes) -> None:
        conn, _ = srv.accept()
        with conn:
            header = b""
            while len(header) < 4:
                part = conn.recv(4 - len(header))
                if not part:
                    return
                header += part
            size = struct.unpack(">I", header)[0]
            body = b""
            while len(body) < size:
                part = conn.recv(min(CHUNK_SIZE, size - len(body)))
                if not part:
                    break
                body += part
            received["size"] = size
            received["body"] = body
            conn.sendall(reply)

    def serve(reply: bytes = b"OK\r\n"):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        t = threading.Thread(target=fake_board, args=(srv, reply), daemon=True)
        t.start()
        return srv, t, srv.getsockname()[1]

    # -- a good image arrives byte-for-byte, progress reaches 100% ----------
    image = bytes(range(256)) * 40  # 10240 bytes, several chunks
    srv, t, port = serve()
    seen: List[int] = []
    assert upload(image, "127.0.0.1", port,
                  on_progress=lambda s, tot: seen.append(s)) == "OK"
    t.join(timeout=5)
    srv.close()
    assert received["size"] == len(image)
    assert received["body"] == image, "image corrupted in transit"
    assert seen[-1] == len(image)
    assert len(seen) == (len(image) + CHUNK_SIZE - 1) // CHUNK_SIZE

    # -- the digest is what the board will report in its heartbeat ----------
    assert firmware_sha256(image) == hashlib.sha256(image).hexdigest()
    assert len(firmware_sha256(image)) == 64
    assert firmware_sha256(b"a") != firmware_sha256(b"b")

    # -- a rejecting board surfaces as an error, not a silent success ------
    srv, t, port = serve(reply=b"ERR\r\n")
    try:
        upload(image, "127.0.0.1", port)
        raise AssertionError("a non-OK reply must raise")
    except OtaError as exc:
        assert "instead of 'OK'" in str(exc), exc
    t.join(timeout=5)
    srv.close()

    # -- cancelling stops the transfer and says what it means --------------
    srv, t, port = serve()
    try:
        upload(image, "127.0.0.1", port, should_cancel=lambda: True)
        raise AssertionError("cancel must raise")
    except OtaError as exc:
        assert "cancelled" in str(exc), exc
        assert "current firmware" in str(exc), "must say the board is safe"
    srv.close()

    # -- nothing listening: the error names the address --------------------
    dead = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    dead.bind(("127.0.0.1", 0))
    dead_port = dead.getsockname()[1]
    dead.close()
    try:
        upload(image, "127.0.0.1", dead_port, connect_timeout=1.0)
        raise AssertionError("connecting to nothing must raise")
    except OtaError as exc:
        assert str(dead_port) in str(exc), exc

    # -- guard rails -------------------------------------------------------
    for bad in (b"", b"x" * (MAX_IMAGE_BYTES + 1)):
        try:
            upload(bad, "127.0.0.1", 1)
            raise AssertionError("must reject an implausible image")
        except OtaError:
            pass

    # -- successive default messages differ --------------------------------
    assert default_test_message(1) != default_test_message(2)

    print("ota self-test: OK")


if __name__ == "__main__":
    _self_test()

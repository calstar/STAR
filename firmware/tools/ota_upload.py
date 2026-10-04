#!/usr/bin/env python3
"""
Push firmware to a STAR board over Ethernet.

Board-agnostic: anything running ``libraries/STAR_EthernetOTA`` speaks this
protocol, which is all of them (sense boards, actuator, stacklight, encoder,
environmental tracker).

    # upload a binary you already built
    python firmware/tools/ota_upload.py --ip 192.168.2.41 \
        --bin firmware/Hotfire_Code/LC_Hotfire/.pio/build/adafruit_feather_esp32s3/firmware.bin

    # build the project first, then upload it
    python firmware/tools/ota_upload.py --ip 192.168.2.41 \
        --project firmware/Hotfire_Code/LC_Hotfire

    # bake a marker into the build so you can SEE the update land on serial:
    # the board starts printing "[OTA-MSG] third try" instead of whatever it
    # printed before
    python firmware/tools/ota_upload.py --ip 192.168.2.41 \
        --project firmware/Hotfire_Code/LC_Hotfire --message "third try"

Wire protocol (see libraries/STAR_EthernetOTA/src/STAR_EthernetOTA.h):

    client -> board : [4-byte big-endian image size][raw firmware bytes]
    board  -> client: "OK\\r\\n", then reboot

Two different SHA-256 values are involved, and confusing them makes a good
update look like a failed one:

* ``sha256`` of the .bin file — what you get from ``shasum -a 256``.
* the **appended image hash**, the last 32 bytes of the .bin, which is what
  ``esp_partition_get_sha256()`` returns and therefore what the board prints
  at boot and reports in BOARD_HEARTBEAT (see
  ``Hotfire_Code/common/FIRMWARE_HASH_VERIFICATION.md``).

They are never equal. This tool prints both and labels which one to compare
against the board.

Pure standard library. ``python -m ota_upload --self-test`` runs an offline
round trip against a fake board.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional

DEFAULT_PORT = 3232
CHUNK_SIZE = 4096
CONNECT_TIMEOUT = 5.0
TRANSFER_TIMEOUT = 60.0
# Refuse anything the board would reject anyway (STAR_OTA_MAX_IMAGE_BYTES).
MAX_IMAGE_BYTES = 0x200000

ProgressFn = Callable[[int, int], None]


class OtaError(RuntimeError):
    """Upload failed. The message is meant to be shown to a human."""


def firmware_sha256(data: bytes) -> str:
    """SHA-256 of the .bin file itself. NOT what the board reports."""
    return hashlib.sha256(data).hexdigest()


def board_reported_sha256(data: bytes) -> Optional[str]:
    """The digest the board prints for this image, or None if it has none.

    The board uses esp_partition_get_sha256(), which returns the 32-byte
    SHA-256 that esptool appends to the image -- computed over the image
    *excluding* those 32 bytes. Hashing the whole .bin gives a different
    number that will never match, which makes a perfectly good update look
    like a failed one. The appended hash is present when byte 23 of the
    ESP32 image header (magic 0xE9) has the hash_appended flag set.
    """
    if len(data) < 33 or data[0] != 0xE9 or not data[23]:
        return None
    return data[-32:].hex()


def upload(data: bytes, ip: str, port: int = DEFAULT_PORT,
           on_progress: Optional[ProgressFn] = None,
           connect_timeout: float = CONNECT_TIMEOUT,
           transfer_timeout: float = TRANSFER_TIMEOUT) -> str:
    """Send `data` to the board and wait for its acknowledgement.

    Returns the board's reply text. Raises OtaError with something actionable
    on any failure.
    """
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
            f"on this subnet, and past its boot delay?") from exc

    try:
        sock.settimeout(transfer_timeout)
        sock.sendall(struct.pack(">I", len(data)))

        sent = 0
        while sent < len(data):
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

        # The board replies "OK" only after Update.end() validates the image.
        try:
            reply = sock.recv(64).decode("utf-8", "replace").strip()
        except OSError as exc:
            raise OtaError(
                "image sent, but the board never acknowledged it "
                f"({exc}). It may have rejected the image — check its serial "
                f"log for '[OTA] ERROR'.") from exc

        if reply != "OK":
            raise OtaError(
                f"board replied {reply!r} instead of 'OK' — check its serial "
                f"log for '[OTA] ERROR'")
        return reply
    finally:
        sock.close()


# ---------------------------------------------------------------------------
# Building (optional — only when --project is given)
# ---------------------------------------------------------------------------
def find_pio() -> str:
    """Locate the PlatformIO CLI, including its default install locations."""
    found = shutil.which("pio") or shutil.which("platformio")
    if found:
        return found
    candidates = [
        Path.home() / ".platformio" / "penv" / "bin" / "pio",
        Path.home() / ".platformio" / "penv" / "Scripts" / "pio.exe",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    raise OtaError(
        "PlatformIO CLI not found. Install it (pip install platformio) or "
        "build the project yourself and pass --bin.")


def build(project: Path, env: Optional[str] = None,
          message: Optional[str] = None) -> Path:
    """Build `project` and return the path to firmware.bin.

    `message` is injected as STAR_OTA_TEST_MESSAGE through
    PLATFORMIO_BUILD_FLAGS, so nothing in the repo has to be edited to make
    one build visibly different from the last.
    """
    project = project.resolve()
    if not (project / "platformio.ini").exists():
        raise OtaError(f"{project} has no platformio.ini")

    cmd = [find_pio(), "run", "-d", str(project)]
    if env:
        cmd += ["-e", env]

    build_env = os.environ.copy()
    if message is not None:
        if '"' in message or "'" in message:
            raise OtaError("--message cannot contain quote characters; they "
                           "do not survive the trip to the compiler.")
        # Single-quote the whole value. PlatformIO splits PLATFORMIO_BUILD_FLAGS
        # with shlex, so a bare \"two words\" is torn in half at the space and
        # the string literal never terminates. This is the form the library's
        # own header documents: -DSTAR_OTA_TEST_MESSAGE='"hello"'
        flag = f"-DSTAR_OTA_TEST_MESSAGE='\"{message}\"'"
        existing = build_env.get("PLATFORMIO_BUILD_FLAGS", "")
        build_env["PLATFORMIO_BUILD_FLAGS"] = (existing + " " + flag).strip()
        print(f"  baking in test message: {message!r}")

    print(f"  building {project.name}…")
    result = subprocess.run(cmd, env=build_env, text=True,
                            capture_output=True)
    if result.returncode != 0:
        tail = "\n".join((result.stdout + result.stderr).splitlines()[-25:])
        raise OtaError(f"build failed:\n{tail}")

    bins = sorted((project / ".pio" / "build").glob("*/firmware.bin"),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    if not bins:
        raise OtaError(f"build succeeded but no firmware.bin under {project}")
    return bins[0]


# ---------------------------------------------------------------------------
def _progress_printer() -> ProgressFn:
    state = {"bucket": -1, "start": time.time()}

    def report(sent: int, total: int) -> None:
        pct = int(sent * 100 / total)
        if pct // 5 == state["bucket"]:
            return
        state["bucket"] = pct // 5
        elapsed = time.time() - state["start"]
        rate = (sent / elapsed / 1024) if elapsed > 0 else 0
        bar = "#" * (pct // 5) + "." * (20 - pct // 5)
        print(f"\r  [{bar}] {pct:3d}%  {sent}/{total} bytes  {rate:.0f} KB/s",
              end="", flush=True)

    return report


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description="Push firmware to a STAR board over Ethernet.")
    p.add_argument("--ip", help="board IP address")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--bin", type=Path,
                   help="firmware.bin to upload (skip to build with --project)")
    p.add_argument("--project", type=Path,
                   help="PlatformIO project to build, then upload")
    p.add_argument("--env", help="PlatformIO env within --project")
    p.add_argument("--message",
                   help="bake this into the build as STAR_OTA_TEST_MESSAGE, so "
                        "the board visibly prints something new afterwards")
    p.add_argument("--timeout", type=float, default=TRANSFER_TIMEOUT)
    p.add_argument("--self-test", action="store_true",
                   help="run an offline round trip against a fake board")
    args = p.parse_args(argv)

    if args.self_test:
        _self_test()
        return 0

    if not args.ip:
        p.error("--ip is required (or use --self-test)")
    if not args.bin and not args.project:
        p.error("pass --bin (an existing image) or --project (build it first)")

    try:
        bin_path = args.bin
        if args.project:
            bin_path = build(args.project, args.env, args.message)
        elif args.message:
            p.error("--message needs --project: the message is compiled in")

        bin_path = Path(bin_path)
        if not bin_path.exists():
            raise OtaError(f"{bin_path} does not exist")
        data = bin_path.read_bytes()

        digest = firmware_sha256(data)
        board_digest = board_reported_sha256(data)
        print(f"  image:  {bin_path}")
        print(f"  size:   {len(data)} bytes")
        print(f"  sha256: {digest}   (of the .bin file)")
        print(f"  target: {args.ip}:{args.port}")

        upload(data, args.ip, args.port, on_progress=_progress_printer(),
               transfer_timeout=args.timeout)
        print("\n  board acknowledged — rebooting into the new image.")
        if board_digest:
            print("  The board will print this at boot (\"Firmware hash:\") and")
            print("  report it in BOARD_HEARTBEAT -- compare against this, not")
            print("  the file sha256 above:")
            print(f"    {board_digest.upper()}")
        else:
            print("  This image has no appended SHA-256, so the board's own")
            print("  \"Firmware hash:\" line cannot be predicted from here.")
        if args.message:
            print(f'  ...and with "[OTA-MSG] {args.message}" on its serial log.')
        return 0
    except OtaError as exc:
        print(f"\nOTA failed: {exc}", file=sys.stderr)
        return 1


# ---------------------------------------------------------------------------
def _self_test() -> None:
    """Round-trip against a fake board implementing the same wire protocol."""
    import threading

    received = {}

    def fake_board(sock: socket.socket, reply: bytes = b"OK\r\n",
                   truncate: bool = False) -> None:
        conn, _ = sock.accept()
        with conn:
            header = b""
            while len(header) < 4:
                header += conn.recv(4 - len(header))
            size = struct.unpack(">I", header)[0]
            body = b""
            want = size // 2 if truncate else size
            while len(body) < want:
                part = conn.recv(min(CHUNK_SIZE, want - len(body)))
                if not part:
                    break
                body += part
            received["size"] = size
            received["body"] = body
            conn.sendall(reply)

    def serve(**kwargs) -> tuple:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        t = threading.Thread(target=fake_board, args=(srv,), kwargs=kwargs,
                             daemon=True)
        t.start()
        return srv, t

    # -- a good image arrives byte-for-byte ---------------------------------
    image = bytes(range(256)) * 40  # 10240 bytes, spans several chunks
    srv, t = serve()
    port = srv.getsockname()[1]
    seen = []
    assert upload(image, "127.0.0.1", port,
                  on_progress=lambda s, tot: seen.append(s)) == "OK"
    t.join(timeout=5)
    srv.close()
    assert received["size"] == len(image), received["size"]
    assert received["body"] == image, "image corrupted in transit"
    assert seen and seen[-1] == len(image), seen[-1:]
    assert len(seen) == (len(image) + CHUNK_SIZE - 1) // CHUNK_SIZE

    # -- the hash matches what the board would compute ----------------------
    assert firmware_sha256(image) == hashlib.sha256(image).hexdigest()
    assert len(firmware_sha256(image)) == 64

    # -- a board that rejects the image is reported, not silently ignored ---
    srv, t = serve(reply=b"ERR\r\n")
    port = srv.getsockname()[1]
    try:
        upload(image, "127.0.0.1", port)
        raise AssertionError("a non-OK reply must raise")
    except OtaError as exc:
        assert "instead of 'OK'" in str(exc), exc
    t.join(timeout=5)
    srv.close()

    # -- nothing listening: the error names the address ---------------------
    dead = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    dead.bind(("127.0.0.1", 0))
    dead_port = dead.getsockname()[1]
    dead.close()
    try:
        upload(image, "127.0.0.1", dead_port, connect_timeout=1.0)
        raise AssertionError("connecting to nothing must raise")
    except OtaError as exc:
        assert str(dead_port) in str(exc), exc

    # -- guard rails --------------------------------------------------------
    for bad, why in ((b"", "empty"), (b"x" * (MAX_IMAGE_BYTES + 1), "over")):
        try:
            upload(bad, "127.0.0.1", 1)
            raise AssertionError(f"{why} image must raise")
        except OtaError:
            pass

    print("ota_upload self-test: OK")


if __name__ == "__main__":
    raise SystemExit(main())

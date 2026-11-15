#!/usr/bin/env python3
"""Flash the flight computer over its USB-C port: no ST-Link.

  pio run -e usb -t upload                      build + flash (one board plugged in)
  pio run -e usb -t upload --upload-port /dev/cu.usbmodem...   (two boards)
  python3 scripts/usb_upload.py .pio/build/flight/firmware.bin [port]

Steps: send ENTER_DFU over the board's serial port (src/board/board_dfu.h),
wait for the STM32 ROM bootloader to enumerate as USB DFU (0483:df11), then
dfu-util writes the image at 0x08000000 and starts it. A board already in the
bootloader (BOOT0 held, or an earlier try) is flashed directly.

Standard library only, so it runs from PlatformIO's Python or any python3.
"""

import glob
import os
import shutil
import struct
import subprocess
import sys
import termios
import time

ENTER_DFU = 0x31
DFU_MAGIC = 0x21554644  # "DFU!"
DFU_ID = "0483:df11"
FLASH_BASE = 0x08000000


def crc16(data):  # CRC-16/CCITT-FALSE, as usb_frame.c
    c = 0xFFFF
    for b in data:
        c ^= b << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
    return c


def cobs(data):
    out, block = bytearray(), bytearray()
    for b in data:
        if b:
            block.append(b)
        if not b or len(block) == 254:
            out += bytes([len(block) + 1]) + block
            block = bytearray()
    return bytes(out + bytes([len(block) + 1]) + block)


def frame(ty, seq, payload):
    raw = bytes([ty, seq]) + payload
    return cobs(raw + struct.pack("<H", crc16(raw))) + b"\0"


def unframe(wire):
    """COBS-decode one frame (without its 0x00); None if malformed."""
    out, i = bytearray(), 0
    while i < len(wire):
        code = wire[i]
        if code == 0 or i + code > len(wire):
            return None
        out += wire[i + 1 : i + code]
        i += code
        if code < 0xFF and i < len(wire):
            out.append(0)
    if len(out) < 4 or crc16(out[:-2]) != struct.unpack("<H", out[-2:])[0]:
        return None
    return bytes(out[:-2])


def board_ports():
    return sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*"))


def dfu_util():
    for p in (
        os.environ.get("DFU_UTIL"),
        shutil.which("dfu-util"),
        os.path.expanduser("~/.platformio/packages/tool-dfuutil/bin/dfu-util"),
    ):
        if p and os.path.exists(p):
            return p
    sys.exit("dfu-util not found: `pio pkg install -g -t platformio/tool-dfuutil` or `brew install dfu-util`")


def in_bootloader(tool):
    r = subprocess.run([tool, "-l"], capture_output=True, text=True)
    return f"[{DFU_ID}]" in r.stdout


def enter_dfu(port):
    """Ask the board at `port` for its bootloader; raise if it says no."""
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        attrs = termios.tcgetattr(fd)
        attrs[0] = attrs[1] = attrs[3] = 0  # raw
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        attrs[4] = attrs[5] = termios.B115200  # ignored by USB CDC
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        termios.tcflush(fd, termios.TCIOFLUSH)
        os.write(fd, frame(ENTER_DFU, 1, struct.pack("<I", DFU_MAGIC)))
        buf, end = b"", time.time() + 2.0
        while time.time() < end:
            try:
                buf += os.read(fd, 4096)
            except BlockingIOError:
                time.sleep(0.01)
            except OSError:
                break  # the port went away: the board is on its way
            while b"\0" in buf:
                wire, buf = buf.split(b"\0", 1)
                f = unframe(wire)
                # ACK: for_type u8, result u8, detail u16
                if f and f[0] == 0x7F and len(f) >= 6 and f[2] == ENTER_DFU:
                    if f[3] != 0:
                        names = {1: "BAD_FRAME", 4: "WRONG_STATE (armed? un-arm first)", 9: "BAD_MAGIC"}
                        raise RuntimeError(f"board refused ENTER_DFU: {names.get(f[3], f[3])}")
                    return
        raise RuntimeError(
            "no answer to ENTER_DFU: is the app (or another program) holding the port, "
            "or is this firmware older than the USB updater? Then flash once with the ST-Link."
        )
    finally:
        os.close(fd)


def upload(image, port=None):
    tool = dfu_util()
    if not in_bootloader(tool):
        ports = [port] if port else board_ports()
        if not ports:
            sys.exit("No board found on USB (/dev/cu.usbmodem*). Plug in the USB-C cable.")
        if len(ports) > 1:
            sys.exit("Several boards are plugged in; name one: --upload-port <port> (or the 2nd argument)\n  " + "\n  ".join(ports))
        print(f"Asking {ports[0]} for its USB bootloader...")
        try:
            enter_dfu(ports[0])
        except (OSError, RuntimeError) as e:
            sys.exit(str(e))
        # The ROM bootloader takes ~10-15 s to enumerate (rev 1 board: it
        # checks its other interfaces first).
        start = time.time()
        while not in_bootloader(tool):
            if time.time() - start > 40:
                sys.exit("The bootloader did not show up on USB within 40 s (dfu-util -l lists nothing).")
            time.sleep(0.3)
        print(f"Bootloader up after {time.time() - start:.0f} s.")
    print("Flashing over USB...")
    r = subprocess.run([tool, "-d", DFU_ID, "-a", "0", "-s", f"0x{FLASH_BASE:08X}:leave", "-D", image])
    # dfu-util reports an error on :leave when the board resets before the
    # final status request; the download itself is what matters.
    if r.returncode not in (0, 74):
        sys.exit(f"dfu-util failed ({r.returncode})")
    print("Done: the board restarts with the new firmware.")


# ---- PlatformIO: env:usb's upload step -----------------------------------
try:
    Import("env")  # noqa: F821  (only defined inside PlatformIO/SCons)

    def _pio_upload(source, target, env):  # noqa: ARG001
        port = env.subst("$UPLOAD_PORT") or None
        upload(env.subst("$BUILD_DIR/${PROGNAME}.bin"), port)

    env.Replace(UPLOADCMD=_pio_upload)  # noqa: F821
except NameError:
    if __name__ == "__main__":
        if len(sys.argv) < 2:
            sys.exit(__doc__)
        upload(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)

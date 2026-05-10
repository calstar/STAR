#!/usr/bin/env python3
"""
ESP32 Ethernet OTA Upload Script
=================================
Recompiles the OTA_Test_Firmware with a custom serial message,
then pushes the resulting binary to the ESP32 over TCP (W5500 Ethernet).

Usage:
    python ota_upload.py                          # Uses timestamped default message
    python ota_upload.py --message "Hello world"  # Custom message
    python ota_upload.py --ip 192.168.2.10        # Override target IP

Protocol:
    1. Send 4-byte firmware size (big-endian)
    2. Send raw firmware binary in 4 KB chunks
"""

import argparse
import datetime
import os
import socket
import struct
import subprocess
import sys
import time
import shutil

# ── Defaults ──────────────────────────────────────────────────
DEFAULT_IP       = "192.168.2.5"
DEFAULT_PORT     = 3232
CHUNK_SIZE       = 4096
CONNECT_TIMEOUT  = 5      # seconds
TRANSFER_TIMEOUT = 30     # seconds

# Path to the PlatformIO project (relative to this script)
SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR   = os.path.join(SCRIPT_DIR, "OTA_Test_Firmware")
PIO_BUILD_DIR = os.path.join(PROJECT_DIR, ".pio", "build", "adafruit_feather_esp32s3")
FIRMWARE_BIN  = os.path.join(PIO_BUILD_DIR, "firmware.bin")


def print_banner():
    print("=" * 56)
    print("   ESP32-S3 Ethernet OTA Upload Tool")
    print("=" * 56)
    print()


def find_pio_command() -> str:
    """Try to find the 'pio' command in PATH or common installation locations."""
    # 1. Check if it's already in the environment PATH
    pio_path = shutil.which("pio")
    if pio_path:
        return pio_path

    # 2. Check common PlatformIO locations on Windows
    if sys.platform == "win32":
        user_profile = os.environ.get("USERPROFILE", "")
        paths_to_check = [
            os.path.join(user_profile, ".platformio", "penv", "Scripts", "pio.exe"),
            os.path.join(user_profile, "AppData", "Local", "Programs", "Python", "Python313", "Scripts", "pio.exe"), # common alternative
            "C:\\Python313\\Scripts\\pio.exe",
        ]
        for path in paths_to_check:
            if os.path.isfile(path):
                return path

    # Fallback to just "pio" and hope for the best
    return "pio"


def compile_firmware(message: str) -> str:
    """Compile the firmware with the given OTA_MESSAGE baked in.
    
    Returns the path to the compiled .bin file.
    """
    print(f"[COMPILE] Message to bake into firmware:")
    print(f'          "{message}"')
    print()

    # Inject the message as an extra build flag via environment variable.
    # This appends to whatever is in platformio.ini's build_flags.
    env = os.environ.copy()
    escaped_msg = message.replace('"', '\\"')
    extra_flags = f'-DOTA_MESSAGE=\'"{escaped_msg}"\''
    env["PLATFORMIO_BUILD_FLAGS"] = extra_flags

    pio_cmd = find_pio_command()
    print(f"[COMPILE] Running: {pio_cmd} run  (in {PROJECT_DIR})")
    print(f"[COMPILE] Extra build flags: {extra_flags}")
    print()

    try:
        result = subprocess.run(
            [pio_cmd, "run"],
            cwd=PROJECT_DIR,
            env=env,
            capture_output=True,
            text=True
        )
    except FileNotFoundError:
        print("[COMPILE] ERROR: 'pio' command not found.")
        print("          Make sure PlatformIO CLI is installed and in your PATH.")
        print("          Install: pip install platformio")
        sys.exit(1)

    # Print PlatformIO output
    if result.stdout:
        for line in result.stdout.strip().split("\n"):
            print(f"  [PIO] {line}")
    if result.stderr:
        for line in result.stderr.strip().split("\n"):
            # PlatformIO prints progress to stderr; only flag actual errors
            if "error" in line.lower():
                print(f"  [PIO ERROR] {line}")
            else:
                print(f"  [PIO] {line}")

    if result.returncode != 0:
        print()
        print(f"[COMPILE] FAILED (exit code {result.returncode})")
        sys.exit(1)

    if not os.path.isfile(FIRMWARE_BIN):
        print(f"[COMPILE] ERROR: Expected binary not found at:")
        print(f"          {FIRMWARE_BIN}")
        sys.exit(1)

    size = os.path.getsize(FIRMWARE_BIN)
    print()
    print(f"[COMPILE] SUCCESS — firmware.bin = {size:,} bytes")
    print(f"          Path: {FIRMWARE_BIN}")
    print()
    return FIRMWARE_BIN


def upload_firmware(bin_path: str, ip: str, port: int):
    """Send the firmware binary to the ESP32 over TCP."""
    file_size = os.path.getsize(bin_path)

    print(f"[UPLOAD] Target: {ip}:{port}")
    print(f"[UPLOAD] Firmware size: {file_size:,} bytes")
    print()

    # ── Connect ──────────────────────────────────────────────
    print(f"[UPLOAD] Connecting to ESP32...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(CONNECT_TIMEOUT)

    try:
        sock.connect((ip, port))
    except socket.timeout:
        print(f"[UPLOAD] ERROR: Connection timed out after {CONNECT_TIMEOUT}s.")
        print(f"         Is the ESP32 running and reachable at {ip}?")
        sys.exit(1)
    except ConnectionRefusedError:
        print(f"[UPLOAD] ERROR: Connection refused by {ip}:{port}.")
        print(f"         Is the OTA firmware running on the ESP32?")
        sys.exit(1)
    except OSError as e:
        print(f"[UPLOAD] ERROR: Could not connect: {e}")
        sys.exit(1)

    print(f"[UPLOAD] Connected!")
    sock.settimeout(TRANSFER_TIMEOUT)

    try:
        # ── Send size header (4 bytes, big-endian) ───────────
        header = struct.pack(">I", file_size)
        sock.sendall(header)
        print(f"[UPLOAD] Sent size header: {file_size} bytes")

        # ── Stream firmware binary ───────────────────────────
        sent = 0
        last_percent = -1
        start_time = time.time()

        with open(bin_path, "rb") as f:
            while sent < file_size:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                sock.sendall(chunk)
                sent += len(chunk)

                percent = int(sent * 100 / file_size)
                # Print progress every 5%
                if percent // 5 != last_percent // 5:
                    last_percent = percent
                    elapsed = time.time() - start_time
                    rate = sent / elapsed / 1024 if elapsed > 0 else 0
                    print(f"[UPLOAD] Progress: {percent:3d}%  "
                          f"({sent:,} / {file_size:,} bytes)  "
                          f"[{rate:.1f} KB/s]")

        elapsed = time.time() - start_time
        print()
        print(f"[UPLOAD] Transfer complete! {sent:,} bytes in {elapsed:.1f}s")
        print(f"[UPLOAD] Waiting for ESP32 confirmation...")

        try:
            # Wait for "OK" response from ESP32
            response = sock.recv(1024).decode(errors="ignore").strip()
            if "OK" in response:
                print(f"[UPLOAD] SUCCESS: ESP32 received firmware and is rebooting.")
            else:
                print(f"[UPLOAD] WARNING: Connection closed without 'OK' response. Response was: '{response}'")
        except socket.timeout:
            print(f"[UPLOAD] WARNING: Timed out waiting for 'OK' confirmation.")

    except socket.timeout:
        print(f"[UPLOAD] ERROR: Transfer timed out.")
        sys.exit(1)
    except BrokenPipeError:
        print(f"[UPLOAD] ERROR: Connection lost during transfer.")
        sys.exit(1)
    finally:
        sock.close()


def main():
    print_banner()

    parser = argparse.ArgumentParser(
        description="Compile and OTA-upload firmware to ESP32-S3 over Ethernet"
    )
    parser.add_argument(
        "--message", "-m",
        default=None,
        help='Message to bake into firmware (default: timestamped string)'
    )
    parser.add_argument(
        "--ip",
        default=DEFAULT_IP,
        help=f'ESP32 IP address (default: {DEFAULT_IP})'
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=DEFAULT_PORT,
        help=f'ESP32 OTA TCP port (default: {DEFAULT_PORT})'
    )
    parser.add_argument(
        "--skip-compile",
        action="store_true",
        help='Skip compilation, just upload the existing binary'
    )
    args = parser.parse_args()

    # Default message includes a timestamp so you can tell updates apart
    if args.message is None:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        args.message = f"OTA update at {ts}"

    # ── Compile ──────────────────────────────────────────────
    if args.skip_compile:
        if not os.path.isfile(FIRMWARE_BIN):
            print(f"[ERROR] --skip-compile set but no binary found at:")
            print(f"        {FIRMWARE_BIN}")
            sys.exit(1)
        print(f"[COMPILE] Skipped (--skip-compile). Using existing binary.")
        print(f"          {FIRMWARE_BIN} ({os.path.getsize(FIRMWARE_BIN):,} bytes)")
        print()
        bin_path = FIRMWARE_BIN
    else:
        bin_path = compile_firmware(args.message)

    # ── Upload ───────────────────────────────────────────────
    upload_firmware(bin_path, args.ip, args.port)

    print()
    print("=" * 56)
    print("   Done! Watch the ESP32 serial monitor for the")
    print(f'   new message: "{args.message}"')
    print("=" * 56)


if __name__ == "__main__":
    main()

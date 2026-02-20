#!/usr/bin/env python3
"""
Super simple UDP test - bind to USB interface specifically
"""

import socket
import sys

# Get USB interface IP
import subprocess

result = subprocess.run(
    ["ip", "addr", "show", "enx00e04c680240"], capture_output=True, text=True
)
usb_ip = None
for line in result.stdout.split("\n"):
    if "inet " in line and "192.168" in line:
        usb_ip = line.split()[1].split("/")[0]
        break

if not usb_ip:
    print("❌ USB interface (enx00e04c680240) has no IP!")
    print("Assign one: sudo ip addr add 192.168.2.201/24 dev enx00e04c680240")
    sys.exit(1)

print(f"=== Simple UDP Test ===")
print(f"USB Interface IP: {usb_ip}")
print(f"Binding to: {usb_ip}:5006")
print("")

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

try:
    sock.bind((usb_ip, 5006))
    print(f"✅ Bound to {usb_ip}:5006")
    print("")
    print("Listening for packets (30 seconds)...")
    print("Send packets from your board now!")
    print("")

    sock.settimeout(1.0)
    packet_count = 0

    import time

    start = time.time()
    while time.time() - start < 30:
        try:
            data, addr = sock.recvfrom(4096)
            packet_count += 1
            print(f"[{packet_count}] From {addr[0]}:{addr[1]}, size: {len(data)} bytes")
            if len(data) <= 32:
                hex_str = " ".join(f"{b:02x}" for b in data)
                print(f"    Data: {hex_str}")
        except socket.timeout:
            continue

    print("")
    if packet_count > 0:
        print(f"✅ Received {packet_count} packet(s)!")
    else:
        print("❌ No packets received")
        print("")
        print("Troubleshooting:")
        print(f"  1. Verify board sends to: {usb_ip}:5006")
        print(f"  2. Check interface: ip addr show enx00e04c680240")
        print(f"  3. Test ping: ping {usb_ip} (from board)")

except OSError as e:
    print(f"❌ Error: {e}")
    print("")
    print("Try binding to 0.0.0.0 instead:")
    print(
        "  python3 -c \"import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('0.0.0.0', 5006)); print('Bound to 0.0.0.0:5006'); data, addr = s.recvfrom(4096); print(f'Received from {addr}: {len(data)} bytes')\""
    )

finally:
    sock.close()




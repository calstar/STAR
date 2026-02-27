#!/usr/bin/env python3
"""
Raw UDP packet capture - bypasses DAQ bridge to see what's actually arriving
"""

import socket
import sys
import time
from datetime import datetime

PORT = 5006
TIMEOUT = 30

print(f"=== Raw UDP Packet Capture on Port {PORT} ===")
print(f"Listening for {TIMEOUT} seconds...")
print("")

# Create UDP socket
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("0.0.0.0", PORT))
sock.settimeout(1.0)  # 1 second timeout for checking

print(f"✅ Socket bound to 0.0.0.0:{PORT}")
print("")

packet_count = 0
start_time = time.time()

try:
    while time.time() - start_time < TIMEOUT:
        try:
            data, addr = sock.recvfrom(4096)
            packet_count += 1

            print(f"[Packet #{packet_count}] From: {addr[0]}:{addr[1]}")
            print(f"  Size: {len(data)} bytes")
            print(f"  Time: {datetime.now().strftime('%H:%M:%S.%f')[:-3]}")

            # Show first 32 bytes in hex
            hex_str = " ".join(f"{b:02x}" for b in data[:32])
            print(f"  First 32 bytes: {hex_str}")

            # Show first 32 bytes as ASCII (if printable)
            ascii_str = "".join(chr(b) if 32 <= b < 127 else "." for b in data[:32])
            print(f"  ASCII: {ascii_str}")

            # Check if it looks like DiabloAvionics packet
            if len(data) >= 1:
                first_byte = data[0]
                if first_byte == 3:
                    print(f"  ✅ Looks like SENSOR_DATA packet (type=3)")
                elif 1 <= first_byte <= 9:
                    print(f"  ⚠️  Valid packet type ({first_byte}) but not SENSOR_DATA")
                else:
                    print(f"  ⚠️  Unknown packet type: 0x{first_byte:02x}")

            print("")

        except socket.timeout:
            continue
        except KeyboardInterrupt:
            break

except Exception as e:
    print(f"Error: {e}")

finally:
    sock.close()

print(f"\n=== Summary ===")
print(f"Total packets received: {packet_count}")

if packet_count == 0:
    print("\n⚠️  No packets received!")
    print("\nTroubleshooting:")
    print("  1. Check board is sending to correct IP and port")
    print("  2. Check firewall: sudo ufw status")
    print("  3. Check network connectivity")
    print("  4. Verify board is actually sending (check Serial monitor)")

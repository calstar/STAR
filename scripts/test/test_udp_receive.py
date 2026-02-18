#!/usr/bin/env python3
"""Simple UDP receiver to test if packets are arriving on port 5007"""

import socket
import sys


def main():
    port = 5007
    if len(sys.argv) > 1:
        port = int(sys.argv[1])

    print(f"📡 Listening for UDP packets on port {port}...")
    print("Press Ctrl+C to stop\n")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", port))
    sock.settimeout(1.0)  # 1 second timeout

    packet_count = 0
    try:
        while True:
            try:
                data, addr = sock.recvfrom(4096)
                packet_count += 1
                print(
                    f"[{packet_count}] Received {len(data)} bytes from {addr[0]}:{addr[1]}"
                )
                if packet_count <= 3:
                    print(
                        f"    First 16 bytes: {' '.join(f'{b:02x}' for b in data[:16])}"
                    )
            except socket.timeout:
                if packet_count == 0:
                    print(".", end="", flush=True)
                continue
    except KeyboardInterrupt:
        print(f"\n\n✅ Received {packet_count} packets total")

    sock.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Manually send SENSOR_CONFIG to a board (e.g. 192.168.2.22:5005) to test if the board
transitions from WaitingForServer to Active. Run with board powered and Serial monitor open.

Usage: python3 scripts/test/send_sensor_config_manual.py [--ip 192.168.2.22] [--port 5005]
"""
import argparse
import socket
import struct
import time


def make_header(packet_type, version=0):
    ts = int(time.time() * 1000) & 0xFFFFFFFF
    return struct.pack("<BBI", packet_type, version, ts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ip", default="192.168.2.22", help="Board IP")
    ap.add_argument("--port", type=int, default=5005, help="Board config port")
    ap.add_argument(
        "--format",
        choices=["simple", "full"],
        default="simple",
        help="simple=sense_testing_gui (no num_sensors). full=DAQv2 num_sensors+sensor_ids",
    )
    ap.add_argument("-n", type=int, default=5, help="Send N times")
    args = ap.parse_args()

    SENSOR_CONFIG = 5

    if args.format == "simple":
        # Legacy (sense_testing_gui) - boards expect DAQv2 format now, this will likely fail
        pkt = (
            make_header(SENSOR_CONFIG) + struct.pack("<BB", 0, 0) + struct.pack("<B", 1)
        )
        print("Format: simple (legacy) - may fail; use --format full")
    else:
        # DAQv2-Comms: num_sensors, sensor_ids, reference_voltage, necessary_for_abort, [controller_ip], enable_serial_printing
        sensor_ids = [1, 2, 3, 4]  # 1-based connectors
        ref_voltage = 0
        necessary_for_abort = 0
        enable_serial = 1
        pkt = make_header(SENSOR_CONFIG) + struct.pack("<B", len(sensor_ids))
        for sid in sensor_ids:
            pkt += struct.pack("<B", sid)
        pkt += struct.pack("<BB", ref_voltage, necessary_for_abort)
        # no controller_ip when necessary_for_abort=0
        pkt += struct.pack("<B", enable_serial)
        print(
            "Format: full (DAQv2) num_sensors=4, ids=[1,2,3,4], ref=0, necessary=0, enable_serial=1"
        )

    print(f"Sending {len(pkt)} bytes to {args.ip}:{args.port}")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    for i in range(args.n):
        sock.sendto(pkt, (args.ip, args.port))
        print(f"  Sent #{i+1}")
        time.sleep(0.5)

    sock.close()
    print(
        "Done. Check board Serial: expect 'SENSOR_CONFIG received' and 'State -> Active'"
    )


if __name__ == "__main__":
    main()

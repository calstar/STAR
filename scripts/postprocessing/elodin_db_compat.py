#!/usr/bin/env python3
import sys
import socket
import struct
import json
import time
import argparse
import subprocess
import os
from pathlib import Path
from typing import List, Dict, Any, Optional

# Protocol constants from ElodinProtocol.hpp / ElodinClient.ts
PACKET_HEADER_SIZE = 8
PACKET_TYPE_TABLE = 1
PACKET_TYPE_RESPONSE = 2
PACKET_TYPE_QUERY = 3

# IDs based on DatabaseConfig.cpp
ID_PT_RAW = 0x20
ID_TC_RAW = 0x21
ID_RTD_RAW = 0x22
ID_LC_RAW = 0x23
ID_ACT_STATUS = 0x30
ID_ACT_STATE = 0x31


def get_config_roles():
    """Parse config/config.toml for sensor roles and table names."""
    config_path = Path("/home/kush-mahajan/sensor_system/config/config.toml")
    if not config_path.exists():
        return {}

    roles = {"PT": {}, "TC": {}, "RTD": {}, "LC": {}, "ACT": {}}

    current_section = ""
    with open(config_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("[") and line.endswith("]"):
                current_section = line[1:-1]
                continue

            if "=" in line:
                key, val = [x.strip() for x in line.split("=", 1)]
                if key.startswith('"') and key.endswith('"'):
                    key = key[1:-1]
                key = key.replace(" ", "_")

                if current_section == "sensor_roles_pt_board":
                    try:
                        roles["PT"][key] = int(val)
                    except:
                        pass
                elif current_section == "sensor_roles_pt2":
                    try:
                        roles["PT"][key] = int(val) + 10
                    except:
                        pass
                elif current_section == "actuator_roles":
                    try:
                        parts = json.loads(val)
                        if isinstance(parts, list) and len(parts) >= 2:
                            roles["ACT"][key] = int(parts[1])
                    except:
                        pass

    # Add generic channels for others
    for ch in range(1, 21):
        roles["TC"][f"CH{ch}"] = ch
        roles["RTD"][f"CH{ch}"] = ch
        roles["LC"][f"CH{ch}"] = ch

    return roles


def get_table_map():
    """Returns {table_name: (hi, lo, fields)}"""
    roles = get_config_roles()
    m = {}

    # Raw PT
    for name, ch in roles["PT"].items():
        m[f"PT.{name}"] = (
            ID_PT_RAW,
            ch,
            ["timestamp_ns", "channel_id", "raw_adc_counts", "sample_ts_ms", "status"],
        )
        m[f"PT_Cal.{name}"] = (
            ID_PT_RAW,
            0x10 + ch,
            [
                "timestamp_ns",
                "channel_id",
                "calibrated_value",
                "raw_counts",
                "cal_status",
            ],
        )

    # Others
    for prefix, hi, fields in [
        (
            "TC",
            ID_TC_RAW,
            ["timestamp_ns", "channel_id", "raw_adc_counts", "sample_ts_ms", "status"],
        ),
        (
            "RTD",
            ID_RTD_RAW,
            [
                "timestamp_ns",
                "channel_id",
                "raw_resistance_counts",
                "sample_ts_ms",
                "status",
            ],
        ),
        (
            "LC",
            ID_LC_RAW,
            ["timestamp_ns", "channel_id", "raw_adc_counts", "sample_ts_ms", "status"],
        ),
    ]:
        for name, ch in roles[prefix].items():
            m[f"{prefix}.{name}"] = (hi, ch, fields)
            # Calibrated
            cal_fields = [
                "timestamp_ns",
                "channel_id",
                "calibrated_value",
                "raw_counts",
                "cal_status",
            ]
            if prefix == "TC":
                m[f"TC_Cal.{name}"] = (hi, 0x10 + ch, cal_fields)
            elif prefix == "RTD":
                m[f"RTD_Cal.{name}"] = (hi, 0x10 + ch, cal_fields)
            elif prefix == "LC":
                m[f"LC_Cal.{name}"] = (hi, 0x10 + ch, cal_fields)

    # Actuators
    for name, ch in roles["ACT"].items():
        m[f"ACT_STAT.{name}"] = (
            ID_ACT_STATUS,
            ch,
            ["timestamp_ns", "channel_id", "raw_adc_counts", "sample_ts_ms", "status"],
        )
        m[f"ACT.{name}"] = (
            ID_ACT_STATE,
            ch,
            ["timestamp_ns", "channel_id", "actuator_state"],
        )

    # Potential alternative IDs from elodin-client.ts
    m["PT_DATA"] = (
        0x01,
        0x00,
        ["timestamp_ns", "channel_id", "raw_adc_counts", "sample_ts_ms", "status"],
    )  # Placeholder fields
    m["TC_DATA"] = (
        0x02,
        0x00,
        ["timestamp_ns", "channel_id", "raw_adc_counts", "sample_ts_ms", "status"],
    )  # Placeholder fields
    m["IMU_DATA"] = (
        0x03,
        0x00,
        ["timestamp_ns", "channel_id", "x", "y", "z"],
    )  # Placeholder fields
    m["STATE_MACHINE"] = (
        0x20,
        0x00,
        ["timestamp_ns", "state_id", "substate_id"],
    )  # Placeholder fields
    m["COMMAND"] = (
        0xFF,
        0x01,
        ["timestamp_ns", "command_id", "value"],
    )  # Placeholder fields

    return m


def create_header(packet_type: int, payload_len: int, packet_id: List[int]) -> bytes:
    return struct.pack(
        "<IBBB B", payload_len + 4, packet_type, packet_id[0], packet_id[1], 0
    )


def decode_21_byte(data: bytes, fields: List[str]) -> Dict[str, Any]:
    if len(data) < 21:
        return {}
    ts, ch, val, sample_ts, status = struct.unpack("<QB3xIIB", data[:21])
    res = {fields[0]: ts, fields[1]: ch, fields[2]: val}
    if len(fields) > 3:
        res[fields[3]] = sample_ts
    if len(fields) > 4:
        res[fields[4]] = status
    return res


def decode_cal_21_byte(data: bytes, fields: List[str]) -> Dict[str, Any]:
    if len(data) < 21:
        return {}
    ts, ch, val, raw, status = struct.unpack("<QB3xfIB", data[:21])
    return {
        fields[0]: ts,
        fields[1]: ch,
        fields[2]: val,
        fields[3]: raw,
        fields[4]: status,
    }


def decode_act_state(data: bytes, fields: List[str]) -> Dict[str, Any]:
    if len(data) < 10:
        return {}
    ts, ch, state = struct.unpack("<QB B", data[:10])
    return {fields[0]: ts, fields[1]: ch, fields[2]: state}


def export_csv(
    db_path: str, table_name: str, start_time: float = 0, end_time: float = 0
):
    table_map = get_table_map()
    if table_name not in table_map:
        print(
            f"Error: Table {table_name} not found in config mapping.", file=sys.stderr
        )
        return

    hi, lo, fields = table_map[table_name]

    server_started_by_us = False
    server_proc = None

    # Check if a server is already running on 2240
    try:
        sock_test = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock_test.settimeout(0.5)
        sock_test.connect(("127.0.0.1", 2240))
        sock_test.close()
        print(f"Connected to existing elodin-db server.", file=sys.stderr)
    except:
        print(f"Starting elodin-db server for {db_path}...", file=sys.stderr)
        server_proc = subprocess.Popen(
            ["elodin-db", "run", "127.0.0.1:2240", db_path],
            stdout=sys.stderr,
            stderr=sys.stderr,
        )
        server_started_by_us = True
        time.sleep(2.0)

    data_records = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5.0)
        sock.connect(("127.0.0.1", 2240))

        # Determine time range (in milliseconds if using Date.now() style)
        # But if the DB actually uses nanoseconds for timestamps, we need to match it.
        # FSW uses nanoseconds for timestamp_ns.
        # Let's try wide range.
        query = {
            "packet_id": [hi, lo],
            "start_time": start_time or 0,
            "end_time": end_time or 0x7FFFFFFFFFFFFFFF,
            "limit": 1000000,
        }
        print(f"Sending QUERY for [0x{hi:02x}, 0x{lo:02x}]: {query}", file=sys.stderr)
        payload = json.dumps(query).encode("utf-8")
        header = create_header(PACKET_TYPE_QUERY, len(payload), [0, 0])
        sock.sendall(header + payload)

        last_packet_time = time.time()
        while time.time() - last_packet_time < 3.0:
            try:
                header_data = sock.recv(8)
                if not header_data:
                    break

                p_len, p_ty, p_hi, p_lo, p_req = struct.unpack("<IBBB B", header_data)
                payload_len = p_len - 4

                print(
                    f"Received packet: ty={p_ty}, id=[0x{p_hi:02x}, 0x{p_lo:02x}], len={payload_len}",
                    file=sys.stderr,
                )

                payload_data = b""
                while len(payload_data) < payload_len:
                    chunk = sock.recv(min(8192, payload_len - len(payload_data)))
                    if not chunk:
                        break
                    payload_data += chunk

                last_packet_time = time.time()

                if p_ty == PACKET_TYPE_TABLE and p_hi == hi and p_lo == lo:
                    if "Cal" in table_name:
                        data_records.append(decode_cal_21_byte(payload_data, fields))
                    elif "ACT" in table_name and "STAT" not in table_name:
                        data_records.append(decode_act_state(payload_data, fields))
                    else:
                        data_records.append(decode_21_byte(payload_data, fields))
                elif p_ty == PACKET_TYPE_RESPONSE:
                    try:
                        resp = json.loads(payload_data.decode("utf-8"))
                        raw_data = resp.get("data", [])
                        if raw_data:
                            for item in raw_data:
                                if isinstance(item, dict):
                                    data_records.append(item)
                    except:
                        pass
                    break
            except socket.timeout:
                break

        sock.close()
    except Exception as e:
        print(f"Error during export: {e}", file=sys.stderr)
    finally:
        if server_started_by_us and server_proc:
            server_proc.terminate()
            server_proc.wait()

    if data_records:
        data_records.sort(key=lambda x: x.get("timestamp_ns", 0))
        import csv

        writer = csv.DictWriter(sys.stdout, fieldnames=fields)
        writer.writeheader()
        for r in data_records:
            writer.writerow(r)
    else:
        print(
            f"No data found for table {table_name}. ID=[0x{hi:02x}, 0x{lo:02x}]",
            file=sys.stderr,
        )


def scan_ids(full=False):
    print(f"Scanning for active packet IDs (full={full})...", file=sys.stderr)
    active = []

    # Range of high bytes to scan
    hi_range = (
        range(256)
        if full
        else [
            0x10,
            0x20,
            0x21,
            0x22,
            0x23,
            0x30,
            0x31,
            0x40,
            0x41,
            0x42,
            0x50,
            0x51,
            0x80,
            0x81,
        ]
    )

    for hi in hi_range:
        for lo in range(256 if full else 32):
            try:
                # Use a small limit and tiny time range for scan
                with socket.create_connection(("127.0.0.1", 2240), timeout=0.1) as sock:
                    query = {
                        "packet_id": [hi, lo],
                        "start_time": 0,
                        "end_time": 1,
                        "limit": 1,
                    }
                    payload = json.dumps(query).encode("utf-8")
                    header = create_header(PACKET_TYPE_QUERY, len(payload), [0, 0])
                    sock.sendall(header + payload)

                    # Wait for ANY response
                    resp_header = sock.recv(8)
                    if resp_header and len(resp_header) == 8:
                        active.append((hi, lo))
                        print(
                            f"Found active ID: [0x{hi:02x}, 0x{lo:02x}]",
                            file=sys.stderr,
                        )
            except (socket.timeout, ConnectionRefusedError, socket.error):
                continue
    return active


def main():
    parser = argparse.ArgumentParser(description="Elodin DB Compatibility Wrapper")
    subparsers = parser.add_subparsers(dest="command")

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("db_path", help="Path to DB")

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("db_path", help="Path to DB")
    export_parser.add_argument(
        "table", help="Table name (from config) or numeric ID (0xXXXX)"
    )
    export_parser.add_argument(
        "--start", type=float, default=0, help="Start timestamp (ns)"
    )
    export_parser.add_argument(
        "--end", type=float, default=0, help="End timestamp (ns)"
    )

    scan_parser = subparsers.add_parser("scan", help="Scan for active packet IDs")
    scan_parser.add_argument(
        "--full", action="store_true", help="Scan all possible 16-bit IDs (slow)"
    )

    args = parser.parse_args()

    if args.command == "list":
        roles = get_table_map()
        for name in roles:
            print(name)
    elif args.command == "export":
        mapping = get_table_map()
        table_name = args.table

        # Support numeric IDs
        if table_name.startswith("0x"):
            try:
                val = int(table_name, 16)
                hi = (val >> 8) & 0xFF
                lo = val & 0xFF
                # Use a generic name for numeric IDs
                export_csv(
                    args.db_path,
                    f"ID_{val:04x}",
                    start_time=args.start,
                    end_time=args.end,
                    hi_override=hi,
                    lo_override=lo,
                )
            except ValueError:
                print(f"Error: Invalid hex ID {table_name}")
                sys.exit(1)
        elif table_name in mapping:
            export_csv(
                args.db_path, table_name, start_time=args.start, end_time=args.end
            )
        else:
            print(f"Error: Table {table_name} not found in config mapping.")
            sys.exit(1)
    elif args.command == "scan":
        active = scan_ids(full=args.full)
        for hi, lo in active:
            print(f"0x{hi:02x}{lo:02x}")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

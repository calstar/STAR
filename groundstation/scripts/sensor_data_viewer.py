#!/usr/bin/env python3
"""
Groundstation Sensor Data Viewer
Connects to the local Elodin database and displays real-time sensor data
"""

import socket
import struct
import time
import sys
import json
from typing import Dict, Any, List
from datetime import datetime


class GroundstationSensorViewer:
    def __init__(self, host: str = "127.0.0.1", port: int = 2240):
        self.host = host
        self.port = port
        self.socket = None
        self.sensor_stats = {}

    def connect(self) -> bool:
        """Connect to the Elodin database"""
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.connect((self.host, self.port))
            print(f"✅ Connected to Elodin database at {self.host}:{self.port}")
            return True
        except Exception as e:
            print(f"❌ Failed to connect to database: {e}")
            return False

    def disconnect(self):
        """Disconnect from the database"""
        if self.socket:
            self.socket.close()
            print("🔌 Disconnected from database")

    def read_packet_header(self) -> Dict[str, Any]:
        """Read a packet header from the database"""
        if not self.socket:
            return None

        try:
            # Read packet header (12 bytes)
            header_data = self.socket.recv(12)
            if len(header_data) < 12:
                return None

            # Unpack header: len (4), ty (1), packet_id (2), request_id (1), padding (4)
            len_val, ty, packet_id_1, packet_id_2, request_id = struct.unpack(
                "<IBBB4x", header_data
            )

            return {
                "len": len_val,
                "type": ty,
                "packet_id": (packet_id_1, packet_id_2),
                "request_id": request_id,
            }
        except Exception as e:
            print(f"Error reading header: {e}")
            return None

    def read_packet_data(self, length: int) -> bytes:
        """Read packet data from the database"""
        if not self.socket:
            return b""

        try:
            data = b""
            while len(data) < length:
                chunk = self.socket.recv(length - len(data))
                if not chunk:
                    break
                data += chunk
            return data
        except Exception as e:
            print(f"Error reading data: {e}")
            return b""

    def parse_sensor_data(self, packet_id: tuple, data: bytes) -> Dict[str, Any]:
        """Parse sensor data based on packet ID"""
        sensor_types = {
            (0x01, 0x00): "PT Sensor",
            (0x02, 0x00): "TC Sensor",
            (0x03, 0x00): "RTD Sensor",
            (0x04, 0x00): "IMU Sensor",
            (0x05, 0x00): "Barometer Sensor",
            (0x06, 0x00): "GPS Position",
            (0x07, 0x00): "GPS Velocity",
        }

        sensor_name = sensor_types.get(
            packet_id, f"Unknown ({packet_id[0]:02x}:{packet_id[1]:02x})"
        )

        try:
            if packet_id == (0x01, 0x00):  # PT Sensor
                if len(data) >= 24:  # 3 doubles + 1 uint64
                    time_pt, pressure, temperature, time_mono = struct.unpack(
                        "<dddQ", data[:24]
                    )
                    return {
                        "sensor": sensor_name,
                        "time_pt": time_pt,
                        "pressure": f"{pressure:.2f} Pa",
                        "temperature": f"{temperature:.2f} °C",
                        "time_monotonic": time_mono,
                    }
            elif packet_id == (0x02, 0x00):  # TC Sensor
                if len(data) >= 25:  # 2 doubles + 1 uint8 + 1 uint64
                    time_tc, temperature, voltage, tc_type, time_mono = struct.unpack(
                        "<ddBQ", data[:25]
                    )
                    return {
                        "sensor": sensor_name,
                        "time_tc": time_tc,
                        "temperature": f"{temperature:.2f} °C",
                        "voltage": f"{voltage:.4f} V",
                        "tc_type": tc_type,
                        "time_monotonic": time_mono,
                    }
            elif packet_id == (0x03, 0x00):  # RTD Sensor
                if len(data) >= 25:  # 2 doubles + 1 uint8 + 1 uint64
                    time_rtd, temperature, resistance, rtd_type, time_mono = (
                        struct.unpack("<ddBQ", data[:25])
                    )
                    return {
                        "sensor": sensor_name,
                        "time_rtd": time_rtd,
                        "temperature": f"{temperature:.2f} °C",
                        "resistance": f"{resistance:.2f} Ω",
                        "rtd_type": rtd_type,
                        "time_monotonic": time_mono,
                    }
            elif packet_id == (0x04, 0x00):  # IMU Sensor
                if len(data) >= 48:  # 6 doubles + 1 uint64
                    (
                        time_imu,
                        accel_x,
                        accel_y,
                        accel_z,
                        gyro_x,
                        gyro_y,
                        gyro_z,
                        time_mono,
                    ) = struct.unpack("<ddddddQ", data[:48])
                    return {
                        "sensor": sensor_name,
                        "time_imu": time_imu,
                        "accel": f"[{accel_x:.3f}, {accel_y:.3f}, {accel_z:.3f}] m/s²",
                        "gyro": f"[{gyro_x:.3f}, {gyro_y:.3f}, {gyro_z:.3f}] rad/s",
                        "time_monotonic": time_mono,
                    }
            elif packet_id == (0x05, 0x00):  # Barometer Sensor
                if len(data) >= 32:  # 3 doubles + 1 uint64
                    time_bar, pressure, altitude, temperature, time_mono = (
                        struct.unpack("<dddQ", data[:32])
                    )
                    return {
                        "sensor": sensor_name,
                        "time_bar": time_bar,
                        "pressure": f"{pressure:.2f} Pa",
                        "altitude": f"{altitude:.2f} m",
                        "temperature": f"{temperature:.2f} °C",
                        "time_monotonic": time_mono,
                    }
            elif packet_id == (0x06, 0x00):  # GPS Position
                if len(data) >= 40:  # 2 uint32 + 3 doubles + 2 floats + 1 uint8
                    time_mono, time_gps, status, lat, lon, alt, h_acc, v_acc, sats = (
                        struct.unpack("<QIdddffB", data[:40])
                    )
                    return {
                        "sensor": sensor_name,
                        "time_monotonic": time_mono,
                        "time_gps": time_gps,
                        "status": status,
                        "latitude": f"{lat:.6f}°",
                        "longitude": f"{lon:.6f}°",
                        "altitude": f"{alt:.2f} m",
                        "horizontal_accuracy": f"{h_acc:.2f} m",
                        "vertical_accuracy": f"{v_acc:.2f} m",
                        "satellites": sats,
                    }
            elif packet_id == (0x07, 0x00):  # GPS Velocity
                if len(data) >= 24:  # 1 uint64 + 1 uint32 + 3 floats + 1 float
                    time_mono, time_gps, vel_x, vel_y, vel_z, speed_acc = struct.unpack(
                        "<QIffff", data[:24]
                    )
                    return {
                        "sensor": sensor_name,
                        "time_monotonic": time_mono,
                        "time_gps": time_gps,
                        "velocity": f"[{vel_x:.2f}, {vel_y:.2f}, {vel_z:.2f}] m/s",
                        "speed_accuracy": f"{speed_acc:.2f} m/s",
                    }
        except Exception as e:
            print(f"Error parsing {sensor_name} data: {e}")

        return {
            "sensor": sensor_name,
            "raw_data": data.hex()[:32] + "..." if len(data) > 16 else data.hex(),
        }

    def update_stats(self, sensor_data: Dict[str, Any]):
        """Update sensor statistics"""
        sensor_name = sensor_data["sensor"]
        if sensor_name not in self.sensor_stats:
            self.sensor_stats[sensor_name] = {
                "count": 0,
                "last_update": None,
                "first_update": None,
            }

        self.sensor_stats[sensor_name]["count"] += 1
        self.sensor_stats[sensor_name]["last_update"] = datetime.now()

        if self.sensor_stats[sensor_name]["first_update"] is None:
            self.sensor_stats[sensor_name]["first_update"] = datetime.now()

    def print_stats(self):
        """Print sensor statistics"""
        print("\n" + "=" * 60)
        print("📊 SENSOR STATISTICS")
        print("=" * 60)

        for sensor_name, stats in self.sensor_stats.items():
            duration = "N/A"
            if stats["first_update"] and stats["last_update"]:
                duration = str(stats["last_update"] - stats["first_update"]).split(".")[
                    0
                ]

            print(
                f"{sensor_name:20} | Count: {stats['count']:6} | Duration: {duration}"
            )

        print("=" * 60)

    def run(self, max_packets: int = 0, show_stats: bool = True):
        """Run the sensor data viewer"""
        if not self.connect():
            return

        print(f"📊 Groundstation Sensor Data Viewer")
        print(f"   Connected to: {self.host}:{self.port}")
        print(f"   Max packets: {'Unlimited' if max_packets == 0 else max_packets}")
        print("   Press Ctrl+C to stop\n")

        packet_count = 0
        last_stats_time = time.time()

        try:
            while max_packets == 0 or packet_count < max_packets:
                # Read packet header
                header = self.read_packet_header()
                if not header:
                    break

                # Read packet data
                data_length = header["len"] - 4  # Subtract header length
                data = self.read_packet_data(data_length)
                if not data:
                    break

                # Parse and display sensor data
                sensor_data = self.parse_sensor_data(header["packet_id"], data)
                self.update_stats(sensor_data)

                # Format output
                timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                print(f"[{timestamp}] {sensor_data['sensor']}")

                for key, value in sensor_data.items():
                    if key != "sensor":
                        print(f"  {key:20}: {value}")
                print()

                packet_count += 1

                # Show stats every 30 seconds
                if show_stats and time.time() - last_stats_time > 30:
                    self.print_stats()
                    last_stats_time = time.time()

        except KeyboardInterrupt:
            print("\n🛑 Stopped by user")
        except Exception as e:
            print(f"❌ Error: {e}")
        finally:
            if show_stats:
                self.print_stats()
            self.disconnect()
            print(f"📈 Total packets received: {packet_count}")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Groundstation Sensor Data Viewer")
    parser.add_argument(
        "--host", default="127.0.0.1", help="Database host (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--port", type=int, default=2240, help="Database port (default: 2240)"
    )
    parser.add_argument(
        "--max-packets",
        type=int,
        default=0,
        help="Maximum packets to read (0 = unlimited)",
    )
    parser.add_argument(
        "--no-stats", action="store_true", help="Disable statistics display"
    )

    args = parser.parse_args()

    viewer = GroundstationSensorViewer(args.host, args.port)
    viewer.run(args.max_packets, not args.no_stats)


if __name__ == "__main__":
    main()

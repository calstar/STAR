#!/usr/bin/env python3
"""
Simple script to view sensor data from the Elodin database
"""

import socket
import struct
import time
import sys
from typing import Dict, Any

class SensorDataViewer:
    def __init__(self, host: str = "127.0.0.1", port: int = 2240):
        self.host = host
        self.port = port
        self.socket = None
        
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
            len_val, ty, packet_id_1, packet_id_2, request_id = struct.unpack('<IBBB4x', header_data)
            
            return {
                'len': len_val,
                'type': ty,
                'packet_id': (packet_id_1, packet_id_2),
                'request_id': request_id
            }
        except Exception as e:
            print(f"Error reading header: {e}")
            return None
    
    def read_packet_data(self, length: int) -> bytes:
        """Read packet data from the database"""
        if not self.socket:
            return b''
            
        try:
            data = b''
            while len(data) < length:
                chunk = self.socket.recv(length - len(data))
                if not chunk:
                    break
                data += chunk
            return data
        except Exception as e:
            print(f"Error reading data: {e}")
            return b''
    
    def parse_sensor_data(self, packet_id: tuple, data: bytes) -> Dict[str, Any]:
        """Parse sensor data based on packet ID"""
        sensor_types = {
            (0x01, 0x00): "PT Sensor",
            (0x02, 0x00): "TC Sensor", 
            (0x03, 0x00): "RTD Sensor",
            (0x04, 0x00): "IMU Sensor",
            (0x05, 0x00): "Barometer Sensor",
            (0x06, 0x00): "GPS Position",
            (0x07, 0x00): "GPS Velocity"
        }
        
        sensor_name = sensor_types.get(packet_id, f"Unknown ({packet_id[0]:02x}:{packet_id[1]:02x})")
        
        try:
            if packet_id == (0x01, 0x00):  # PT Sensor
                if len(data) >= 24:  # 3 doubles + 1 uint64
                    time_pt, pressure, temperature, time_mono = struct.unpack('<dddQ', data[:24])
                    return {
                        'sensor': sensor_name,
                        'time_pt': time_pt,
                        'pressure': pressure,
                        'temperature': temperature,
                        'time_monotonic': time_mono
                    }
            elif packet_id == (0x02, 0x00):  # TC Sensor
                if len(data) >= 25:  # 2 doubles + 1 uint8 + 1 uint64
                    time_tc, temperature, voltage, tc_type, time_mono = struct.unpack('<ddBQ', data[:25])
                    return {
                        'sensor': sensor_name,
                        'time_tc': time_tc,
                        'temperature': temperature,
                        'voltage': voltage,
                        'tc_type': tc_type,
                        'time_monotonic': time_mono
                    }
            elif packet_id == (0x03, 0x00):  # RTD Sensor
                if len(data) >= 25:  # 2 doubles + 1 uint8 + 1 uint64
                    time_rtd, temperature, resistance, rtd_type, time_mono = struct.unpack('<ddBQ', data[:25])
                    return {
                        'sensor': sensor_name,
                        'time_rtd': time_rtd,
                        'temperature': temperature,
                        'resistance': resistance,
                        'rtd_type': rtd_type,
                        'time_monotonic': time_mono
                    }
            elif packet_id == (0x04, 0x00):  # IMU Sensor
                if len(data) >= 48:  # 6 doubles + 1 uint64
                    time_imu, accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z, time_mono = struct.unpack('<ddddddQ', data[:48])
                    return {
                        'sensor': sensor_name,
                        'time_imu': time_imu,
                        'accel': [accel_x, accel_y, accel_z],
                        'gyro': [gyro_x, gyro_y, gyro_z],
                        'time_monotonic': time_mono
                    }
            elif packet_id == (0x05, 0x00):  # Barometer Sensor
                if len(data) >= 32:  # 3 doubles + 1 uint64
                    time_bar, pressure, altitude, temperature, time_mono = struct.unpack('<dddQ', data[:32])
                    return {
                        'sensor': sensor_name,
                        'time_bar': time_bar,
                        'pressure': pressure,
                        'altitude': altitude,
                        'temperature': temperature,
                        'time_monotonic': time_mono
                    }
            elif packet_id == (0x06, 0x00):  # GPS Position
                if len(data) >= 40:  # 2 uint32 + 3 doubles + 2 floats + 1 uint8
                    time_mono, time_gps, status, lat, lon, alt, h_acc, v_acc, sats = struct.unpack('<QIdddffB', data[:40])
                    return {
                        'sensor': sensor_name,
                        'time_monotonic': time_mono,
                        'time_gps': time_gps,
                        'status': status,
                        'latitude': lat,
                        'longitude': lon,
                        'altitude': alt,
                        'horizontal_accuracy': h_acc,
                        'vertical_accuracy': v_acc,
                        'satellites': sats
                    }
            elif packet_id == (0x07, 0x00):  # GPS Velocity
                if len(data) >= 24:  # 1 uint64 + 1 uint32 + 3 floats + 1 float
                    time_mono, time_gps, vel_x, vel_y, vel_z, speed_acc = struct.unpack('<QIffff', data[:24])
                    return {
                        'sensor': sensor_name,
                        'time_monotonic': time_mono,
                        'time_gps': time_gps,
                        'velocity': [vel_x, vel_y, vel_z],
                        'speed_accuracy': speed_acc
                    }
        except Exception as e:
            print(f"Error parsing {sensor_name} data: {e}")
            
        return {
            'sensor': sensor_name,
            'raw_data': data.hex()[:32] + '...' if len(data) > 16 else data.hex()
        }
    
    def run(self, max_packets: int = 100):
        """Run the sensor data viewer"""
        if not self.connect():
            return
            
        print(f"📊 Reading up to {max_packets} sensor packets...")
        print("Press Ctrl+C to stop\n")
        
        packet_count = 0
        try:
            while packet_count < max_packets:
                # Read packet header
                header = self.read_packet_header()
                if not header:
                    break
                    
                # Read packet data
                data_length = header['len'] - 4  # Subtract header length
                data = self.read_packet_data(data_length)
                if not data:
                    break
                
                # Parse and display sensor data
                sensor_data = self.parse_sensor_data(header['packet_id'], data)
                
                # Format output
                timestamp = time.strftime("%H:%M:%S")
                print(f"[{timestamp}] {sensor_data['sensor']}:")
                
                for key, value in sensor_data.items():
                    if key != 'sensor':
                        if isinstance(value, list):
                            print(f"  {key}: {value}")
                        elif isinstance(value, float):
                            print(f"  {key}: {value:.3f}")
                        else:
                            print(f"  {key}: {value}")
                print()
                
                packet_count += 1
                
        except KeyboardInterrupt:
            print("\n🛑 Stopped by user")
        except Exception as e:
            print(f"❌ Error: {e}")
        finally:
            self.disconnect()
            print(f"📈 Total packets read: {packet_count}")

def main():
    if len(sys.argv) > 1:
        try:
            max_packets = int(sys.argv[1])
        except ValueError:
            print("Usage: python3 view_sensor_data.py [max_packets]")
            sys.exit(1)
    else:
        max_packets = 100
    
    viewer = SensorDataViewer()
    viewer.run(max_packets)

if __name__ == "__main__":
    main()



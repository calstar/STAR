#!/usr/bin/env python3
"""
Fake DiabloEthernet packet generator for testing FSW system
Sends SensorDataPacket packets to FSW's UDP listener
"""

import socket
import struct
import time
import sys

# DiabloEthernet Protocol Constants
PACKET_TYPE_SENSOR_DATA = 3
PROTOCOL_VERSION = 2

# Board Types
PT_BOARD = 0x10
TC_BOARD = 0x20
RTD_BOARD = 0x30
LC_BOARD = 0x40

def create_sensor_data_packet(board_type, sensor_id, sensor_value, timestamp_01ms=None):
    """
    Create a SensorDataPacket according to DiabloEthernet protocol
    
    Packet structure:
    - PacketHeader (6 bytes): packet_type, version, timestamp_01ms
    - num_chunks (1 byte)
    - num_sensors (1 byte)
    - For each chunk:
      - Chunk header (4 bytes): chunk_id, sequence_num, etc.
      - For each datapoint:
        - Sensor ID (1 byte, 1-indexed)
        - Sensor data (4 bytes float)
    """
    if timestamp_01ms is None:
        timestamp_01ms = int(time.time() * 10000)  # Convert to 0.1ms units
    
    packet = bytearray()
    
    # PacketHeader
    packet.append(PACKET_TYPE_SENSOR_DATA)
    packet.append(PROTOCOL_VERSION)
    packet.extend(struct.pack('<I', timestamp_01ms))  # Little-endian uint32
    
    # num_chunks (1 chunk)
    packet.append(1)
    
    # num_sensors (1 sensor in this packet)
    packet.append(1)
    
    # Chunk header (4 bytes): chunk_id (1), sequence_num (2), reserved (1)
    packet.append(0)  # chunk_id
    packet.extend(struct.pack('<H', 0))  # sequence_num (little-endian uint16)
    packet.append(0)  # reserved
    
    # Datapoint: sensor_id (1-indexed), sensor_value (float)
    packet.append(sensor_id + 1)  # Convert to 1-indexed
    packet.extend(struct.pack('<f', sensor_value))  # Little-endian float
    
    return bytes(packet)

def send_packets(host, port, count=10):
    """Send fake sensor packets to FSW"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    
    print(f"📡 Sending {count} fake DiabloEthernet packets to {host}:{port}")
    print("")
    
    for i in range(count):
        # Send PT packet
        pt_packet = create_sensor_data_packet(PT_BOARD, 0, 100.0 + i * 0.1)
        sock.sendto(pt_packet, (host, port))
        print(f"  Packet {i+1}: PT sensor 0 = {100.0 + i * 0.1}")
        
        # Send TC packet
        tc_packet = create_sensor_data_packet(TC_BOARD, 0, 25.0 + i * 0.5)
        sock.sendto(tc_packet, (host, port))
        print(f"  Packet {i+1}: TC sensor 0 = {25.0 + i * 0.5}")
        
        time.sleep(0.1)
    
    sock.close()
    print("")
    print("✅ Packets sent!")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 fake_diablo_packet.py <host> <port> [count]")
        print("Example: python3 fake_diablo_packet.py 127.0.0.1 8888 10")
        sys.exit(1)
    
    host = sys.argv[1]
    port = int(sys.argv[2])
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 10
    
    send_packets(host, port, count)


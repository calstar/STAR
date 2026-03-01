import socket
import sys

target_ip = "127.0.0.1"
target_port = 5006
source_ip = "192.168.2.101"

print(f"Testing UDP from {source_ip} to {target_ip}:{target_port}")
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((source_ip, 0))
    print(f"Bound to {source_ip}")
    sock.sendto(b"test packet", (target_ip, target_port))
    print("Sent packet")
except Exception as e:
    print(f"Error: {e}")
finally:
    sock.close()

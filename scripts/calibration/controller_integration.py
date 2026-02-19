#!/usr/bin/env python3
"""
Controller Integration Module
Provides actuator command/status communication and controller wrapper
for integration with the calibration orchestrator.

Uses exact DiabloAvionics packet format from combined_gui.py
"""

import socket
import struct
import time
import threading
import logging
from typing import Dict, Optional, Tuple, List
from dataclasses import dataclass
from collections import deque

logger = logging.getLogger(__name__)

# ── DiabloAvionics Protocol Constants (from combined_gui.py) ─────────────
DIABLO_COMMS_VERSION = 0
MAX_PACKET_SIZE = 512


class PacketType:
    BOARD_HEARTBEAT = 1
    SERVER_HEARTBEAT = 2
    SENSOR_DATA = 3
    ACTUATOR_COMMAND = 4
    SENSOR_CONFIG = 5
    ACTUATOR_CONFIG = 6
    ABORT = 7
    ABORT_DONE = 8
    CLEAR_ABORT = 9
    PWM_ACTUATOR_COMMAND = 10


# Struct format strings (little-endian, matching C++ packed structs)
PACKET_HEADER_FORMAT = "<BBI"  # 6 bytes total
PACKET_HEADER_SIZE = 6

ACTUATOR_COMMAND_PACKET_FORMAT = "<B"  # 1 byte
ACTUATOR_COMMAND_PACKET_SIZE = 1

ACTUATOR_COMMAND_FORMAT = "<BB"  # 2 bytes
ACTUATOR_COMMAND_SIZE = 2

PWM_ACTUATOR_COMMAND_PACKET_FORMAT = "<B"
PWM_ACTUATOR_COMMAND_PACKET_SIZE = 1
# PWM Command: actuator_id (u8), duration_ms (u32), duty_cycle (float), frequency (float)
PWM_ACTUATOR_COMMAND_FORMAT = "<BIff"
PWM_ACTUATOR_COMMAND_SIZE = 13


@dataclass
class ActuatorCommand:
    """Actuator command structure"""

    actuator_id: int  # 1-10 (1-indexed)
    state: int  # 0=OFF, 1=ON
    timestamp: float = 0.0


@dataclass
class ActuatorStatus:
    """Actuator status from current sense"""

    actuator_id: int
    current_voltage: float  # Current sense voltage
    timestamp: float


class ActuatorComm:
    """Actuator command/status communication handler"""

    def __init__(
        self, actuator_board_ip: str, command_port: int = 5005, status_port: int = 5006
    ):
        self.actuator_ip = actuator_board_ip
        self.command_port = command_port
        self.status_port = status_port

        # UDP sockets
        self.command_sock: Optional[socket.socket] = None
        self.status_sock: Optional[socket.socket] = None

        # Status tracking
        self.actuator_statuses: Dict[int, ActuatorStatus] = {}
        self.status_queue: deque = deque(maxlen=1000)

        # Threading
        self.status_thread: Optional[threading.Thread] = None
        self.running = False

    def start(self) -> bool:
        """Start actuator communication"""
        try:
            # Command socket (sender)
            self.command_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            logger.info(
                f"📡 Actuator command socket ready (→ {self.actuator_ip}:{self.command_port})"
            )

            # Status socket (receiver) - shares port 5006 with sensors
            self.status_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.status_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.status_sock.settimeout(0.2)
            # Note: Status comes on same port as sensors, filtered by source IP
            # We'll parse it in the main receiver thread

            self.running = True
            logger.info("✅ Actuator communication started")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to start actuator comm: {e}")
            return False

    def stop(self):
        """Stop actuator communication"""
        self.running = False
        if self.command_sock:
            self.command_sock.close()
        if self.status_sock:
            self.status_sock.close()
        logger.info("🛑 Actuator communication stopped")

    def create_actuator_command_packet(self, commands: List[Tuple[int, int]]) -> bytes:
        """
        Create an actuator command packet (exact format from combined_gui.py).

        Args:
            commands: List of (actuator_id, actuator_state) tuples
            actuator_id: 1-10 (1-indexed)
            actuator_state: 0 = OFF, non-zero = ON

        Returns:
            Packet bytes, or empty bytes if invalid
        """
        if len(commands) == 0 or len(commands) > 255:
            return b""

        # Calculate packet size
        header_size = PACKET_HEADER_SIZE
        body_size = ACTUATOR_COMMAND_PACKET_SIZE
        commands_size = len(commands) * ACTUATOR_COMMAND_SIZE
        total_size = header_size + body_size + commands_size

        if total_size > MAX_PACKET_SIZE:
            return b""

        # Create packet buffer
        packet = bytearray(total_size)
        offset = 0

        # Packet header
        packet_type = PacketType.ACTUATOR_COMMAND
        version = DIABLO_COMMS_VERSION
        timestamp = (
            int(time.time() * 1000) & 0xFFFFFFFF
        )  # 32-bit timestamp in milliseconds

        struct.pack_into(
            PACKET_HEADER_FORMAT, packet, offset, packet_type, version, timestamp
        )
        offset += PACKET_HEADER_SIZE

        # Actuator command packet body
        num_commands = len(commands)
        struct.pack_into(ACTUATOR_COMMAND_PACKET_FORMAT, packet, offset, num_commands)
        offset += ACTUATOR_COMMAND_PACKET_SIZE

        # Actuator commands
        for actuator_id, actuator_state in commands:
            struct.pack_into(
                ACTUATOR_COMMAND_FORMAT, packet, offset, actuator_id, actuator_state
            )
            offset += ACTUATOR_COMMAND_SIZE

        return bytes(packet)

    def send_command(self, actuator_id: int, state: int) -> bool:
        """
        Send actuator command via UDP (exact DiabloAvionics format).

        Args:
            actuator_id: 1-10 (1-indexed channel on actuator board)
            state: 0=OFF, 1=ON (hardware level)

        Returns:
            True if sent successfully
        """
        if not self.command_sock:
            logger.error("Command socket not initialized")
            return False

        try:
            commands = [(actuator_id, state)]
            packet = self.create_actuator_command_packet(commands)
            if len(packet) > 0:
                self.command_sock.sendto(packet, (self.actuator_ip, self.command_port))
                logger.debug(
                    f"📤 Sent: actuator {actuator_id} → {'ON' if state else 'OFF'}"
                )
                return True
            else:
                logger.error(f"Failed to create packet for actuator {actuator_id}")
                return False
        except OSError as e:
            err = e.errno
            if err == 65:
                msg = f"No route to host — check device IP ({self.actuator_ip})"
            elif err == 64:
                msg = f"Network unreachable — check WiFi/Ethernet"
            else:
                msg = f"Network error: [{err}] {e}"
            logger.error(f"Error sending command: {msg}")
            return False
        except Exception as e:
            logger.error(f"Failed to send actuator command: {e}")
            return False

    def send_commands_batch(self, commands: List[Tuple[int, int]]) -> bool:
        """
        Send multiple actuator commands in a single packet.

        Args:
            commands: List of (actuator_id, state) tuples

        Returns:
            True if sent successfully
        """
        if not self.command_sock:
            return False

        try:
            packet = self.create_actuator_command_packet(commands)
            if len(packet) > 0:
                self.command_sock.sendto(packet, (self.actuator_ip, self.command_port))
                logger.debug(f"📤 Sent batch: {len(commands)} commands")
                return True
            return False
        except Exception as e:
            logger.error(f"Failed to send batch commands: {e}")
            return False

    def parse_actuator_status(
        self, data: bytes, source_ip: str
    ) -> List[ActuatorStatus]:
        """
        Parse actuator current sense data from sensor data packet.
        Actuator board sends current sense as PT samples on same port as sensors (5006).
        These come as sensor data packets with channel_id = actuator_id (1-10).

        Returns:
            List of ActuatorStatus objects
        """
        if source_ip != self.actuator_ip:
            return []

        # Parse sensor data packet (same format as PT board)
        # Packet format: [header:6] [num_chunks:1] [num_samples:1] [chunks...]
        # Each chunk: [timestamp:4] [samples...]
        # Each sample: [sensor_id:1] [adc_code:4]
        try:
            if len(data) < 8:
                return []

            # Skip header (6 bytes)
            offset = 6
            num_chunks, num_samples = struct.unpack("<BB", data[offset : offset + 2])
            offset += 2

            statuses = []
            for _ in range(num_chunks):
                if offset + 4 > len(data):
                    break
                # timestamp = struct.unpack('<I', data[offset:offset+4])[0]
                offset += 4

                for _ in range(num_samples):
                    if offset + 5 > len(data):
                        break
                    sensor_id, adc_raw = struct.unpack("<BI", data[offset : offset + 5])
                    offset += 5

                    # Convert ADC to voltage (2.5V ref, 24-bit sign-extended to 32-bit)
                    signed = adc_raw if adc_raw < 0x80000000 else adc_raw - 0x100000000
                    voltage = (signed * 2.5) / 2147483648.0

                    statuses.append(
                        ActuatorStatus(
                            actuator_id=sensor_id,
                            current_voltage=voltage,
                            timestamp=time.time(),
                        )
                    )

            return statuses
        except Exception as e:
            logger.debug(f"Failed to parse actuator status: {e}")
            return []

    # Note: RobustDDPController runs in C++ (FSW/src/control/RobustDDPController.cpp)
    # This module only handles actuator communication (send commands, receive status)
    # The controller integration happens in daq_bridge_main.cpp or a separate control process

    def reset(self):
        """Reset controller state"""
        pass

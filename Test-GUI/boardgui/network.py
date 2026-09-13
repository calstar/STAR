"""
UDP link between this GUI (acting as the DAQ *server*) and a board.

One socket is bound to ``listen_port`` (5006) and used for BOTH:
  * receiving  BOARD_HEARTBEAT / SENSOR_DATA / SELF_TEST from the board, and
  * sending    SERVER_HEARTBEAT / SENSOR_CONFIG / ABORT / CLEAR_ABORT to the
               board at ``board_ip:control_port`` (5005),
so the board's replies come straight back to us (matches the firmware, which
hard-codes the server at 192.168.2.20:5006).

The receiver runs in a QThread and emits typed signals carrying the parsed
dataclasses from ``protocol``. Ethernet/packet statistics (counts, rates,
per-type tallies, malformed count) are tracked here and polled by the GUI.

Which address we send *to* is decided by ``discovery.DiscoveryPolicy`` — a
board holds whatever address the ground station assigned it, so the target is
learned from its packets rather than assumed. That policy is pure stdlib and separately
testable (``python -m boardgui.discovery``).
"""

from __future__ import annotations

import socket
import time
from collections import deque
from dataclasses import dataclass, field
from threading import Lock
from typing import Deque, Dict, Optional

from . import protocol
from .discovery import ADOPTED, UNREACHABLE, DiscoveryPolicy, host_can_reach
from .profile import BoardProfile
from .qt import QThread, pyqtSignal

__all__ = ["PacketStats", "UdpLink", "host_can_reach"]

# Packet types that originate from the board — used to learn its address.
_BOARD_ORIGIN_TYPES = frozenset({
    protocol.PacketType.BOARD_HEARTBEAT,
    protocol.PacketType.SENSOR_DATA,
    protocol.PacketType.SELF_TEST,
})


@dataclass
class PacketStats:
    total_packets: int = 0
    total_bytes: int = 0
    malformed: int = 0
    by_type: Dict[int, int] = field(default_factory=dict)
    last_src_ip: str = "—"
    start_time: Optional[float] = None
    # timestamps of recent packets, for a rolling packets/sec figure
    recent: Deque[float] = field(default_factory=lambda: deque(maxlen=400))

    def rate_pps(self, window_sec: float = 2.0) -> float:
        if not self.recent:
            return 0.0
        now = time.time()
        n = sum(1 for t in self.recent if now - t <= window_sec)
        return n / window_sec

    def bytes_per_sec(self) -> float:
        if self.start_time is None:
            return 0.0
        elapsed = time.time() - self.start_time
        return self.total_bytes / elapsed if elapsed > 0 else 0.0


class UdpLink(QThread):
    # parsed-object, source-ip
    heartbeat_received = pyqtSignal(object, str)
    sensor_data_received = pyqtSignal(object, str)
    self_test_received = pyqtSignal(object, str)
    # packet_type, size_bytes, source_ip  (every well-formed packet, for the log)
    packet_received = pyqtSignal(int, int, str)
    # size_bytes, source_ip  (undecodable / too-short packets)
    malformed_received = pyqtSignal(int, str)
    status = pyqtSignal(str)
    # board's actual source IP, emitted the first time it is seen and again
    # whenever it changes (e.g. a DHCP-assigned address differs from board_ip)
    board_discovered = pyqtSignal(str)

    def __init__(self, profile: BoardProfile, bind_ip: str = "0.0.0.0"):
        super().__init__()
        self.profile = profile
        self.bind_ip = bind_ip
        self.sock: Optional[socket.socket] = None
        self._stop = False
        self._stats_lock = Lock()
        self.stats = PacketStats()
        # Where control/ABORT/OTA actually go. The board may hold a DHCP lease
        # or be on its static fallback, so its address is learned from its
        # packets rather than assumed to be profile.board_ip.
        self.discovery = DiscoveryPolicy(profile.board_ip, profile.control_port)

    # -- lifecycle -----------------------------------------------------------
    def run(self) -> None:
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.sock.settimeout(0.2)
            self.sock.bind((self.bind_ip, self.profile.listen_port))
        except OSError as exc:
            self.status.emit(f"Bind failed on {self.bind_ip}:{self.profile.listen_port} — {exc}")
            return

        with self._stats_lock:
            self.stats.start_time = time.time()
        self.status.emit(f"Listening on {self.bind_ip}:{self.profile.listen_port}")

        while not self._stop:
            try:
                data, addr = self.sock.recvfrom(protocol.MAX_PACKET_SIZE)
            except socket.timeout:
                continue
            except OSError:
                break
            self._handle(data, addr[0])

        try:
            if self.sock:
                self.sock.close()
        finally:
            self.sock = None
        self.status.emit("Stopped")

    def stop(self) -> None:
        self._stop = True

    @property
    def target_ip(self) -> str:
        """IP the send path currently targets (discovered, else configured)."""
        return self.discovery.target_ip

    @property
    def discovered_ip(self) -> Optional[str]:
        return self.discovery.discovered_ip

    def set_board_ip(self, ip: str) -> None:
        """User picked an address: send there until the board is seen again."""
        self.profile.board_ip = ip
        self.discovery.set_configured_ip(ip)

    # -- receive path --------------------------------------------------------
    def _handle(self, data: bytes, src_ip: str) -> None:
        with self._stats_lock:
            self.stats.total_packets += 1
            self.stats.total_bytes += len(data)
            self.stats.last_src_ip = src_ip
            self.stats.recent.append(time.time())

        header = protocol.parse_header(data)
        if header is None:
            self._count_malformed(len(data), src_ip)
            return

        with self._stats_lock:
            self.stats.by_type[header.packet_type] = \
                self.stats.by_type.get(header.packet_type, 0) + 1

        ptype = header.packet_type
        if ptype in _BOARD_ORIGIN_TYPES:
            self._learn_board_ip(src_ip)
        if ptype == protocol.PacketType.BOARD_HEARTBEAT:
            hb = protocol.parse_board_heartbeat(data)
            if hb is None:
                self._count_malformed(len(data), src_ip)
                return
            self.heartbeat_received.emit(hb, src_ip)
        elif ptype == protocol.PacketType.SENSOR_DATA:
            sd = protocol.parse_sensor_data(data)
            if sd is None:
                self._count_malformed(len(data), src_ip)
                return
            self.sensor_data_received.emit(sd, src_ip)
        elif ptype == protocol.PacketType.SELF_TEST:
            st = protocol.parse_self_test(data)
            if st is None:
                self._count_malformed(len(data), src_ip)
                return
            self.self_test_received.emit(st, src_ip)
        # Other types (server->board control) shouldn't arrive here, but we
        # still count them above and log them via packet_received below.

        self.packet_received.emit(ptype, len(data), src_ip)

    def _learn_board_ip(self, src_ip: str) -> None:
        """Adopt the board's real source IP — but only one we can reach.

        A board can broadcast from an address this host has no route to.
        Adopting it blindly points every control packet at a dead destination,
        so the address has to survive a route check first.
        """
        decision, ip = self.discovery.observe(src_ip)
        if decision is ADOPTED:
            self.board_discovered.emit(ip)
        elif decision is UNREACHABLE:
            self.status.emit(
                f"Board also broadcasting from {ip}, but this host has no "
                f"route there — still sending to {self.target_ip}")

    def _count_malformed(self, size: int, src_ip: str) -> None:
        with self._stats_lock:
            self.stats.malformed += 1
        self.malformed_received.emit(size, src_ip)

    def get_stats(self) -> PacketStats:
        with self._stats_lock:
            # shallow copy is fine; callers only read scalars / dict
            s = PacketStats(
                total_packets=self.stats.total_packets,
                total_bytes=self.stats.total_bytes,
                malformed=self.stats.malformed,
                by_type=dict(self.stats.by_type),
                last_src_ip=self.stats.last_src_ip,
                start_time=self.stats.start_time,
            )
            s.recent = deque(self.stats.recent, maxlen=400)
            return s

    # -- send path (server -> board on control_port) -------------------------
    def _send(self, packet: bytes) -> bool:
        if self.sock is None:
            self.status.emit("Cannot send: link not started")
            return False
        # Prefer the board's learned source IP; fall back to the configured
        # static IP until the first board packet arrives.
        dest_ip = self.target_ip
        try:
            self.sock.sendto(packet, (dest_ip, self.profile.control_port))
            return True
        except OSError as exc:
            # A real failure outranks the route check: drop the learned address
            # and fall back to the configured one rather than failing forever.
            if self.discovery.note_send_failure(dest_ip):
                self.status.emit(
                    f"Send to {dest_ip} failed ({exc}) — no route from this host; "
                    f"falling back to {self.discovery.configured_ip}")
            else:
                self.status.emit(f"Send failed: {exc}")
            return False

    def send_server_heartbeat(self, engine_state: int = protocol.EngineState.SAFE) -> bool:
        return self._send(protocol.build_server_heartbeat(engine_state))

    def send_sensor_config(self, sensor_ids, reference_voltage, necessary_for_abort,
                           controller_ip, enable_serial_printing) -> bool:
        pkt = protocol.build_sensor_config(
            sensor_ids=sensor_ids,
            reference_voltage=reference_voltage,
            necessary_for_abort=necessary_for_abort,
            controller_ip=controller_ip,
            enable_serial_printing=enable_serial_printing,
        )
        return self._send(pkt)

    def send_actuator_config(self, is_abort_controller, abort_actuators,
                             abort_pts, enable_serial_printing) -> bool:
        pkt = protocol.build_actuator_config(
            is_abort_controller=is_abort_controller,
            abort_actuators=abort_actuators,
            abort_pts=abort_pts,
            enable_serial_printing=enable_serial_printing,
        )
        return self._send(pkt)

    def send_actuator_command(self, commands) -> bool:
        return self._send(protocol.build_actuator_command(commands))

    def send_pwm_actuator_command(self, commands) -> bool:
        return self._send(protocol.build_pwm_actuator_command(commands))

    def send_abort(self) -> bool:
        return self._send(protocol.build_header_only(protocol.PacketType.ABORT))

    def send_clear_abort(self) -> bool:
        return self._send(protocol.build_header_only(protocol.PacketType.CLEAR_ABORT))

    def send_no_connection_abort(self) -> bool:
        return self._send(protocol.build_header_only(protocol.PacketType.NO_CONNECTION_ABORT))

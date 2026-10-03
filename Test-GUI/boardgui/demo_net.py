"""
The network half of the fake boards: ask the ground station for an address.

Mirrors what the firmware does (``firmware/Hotfire_Code/common/board_net.h``):

  * at startup, ask for an address by DHCP and use whatever the ground station
    gives — the board does not choose,
  * fall back to the static ``192.168.2.<id>`` only if nothing answers, and say
    so, because an address nobody assigned is worth noticing,
  * broadcast BOARD_HEARTBEAT until some server talks to it, learn that
    server's address from its packet, and go back to broadcasting if the
    server goes quiet.

This lets the GUI's address-assignment path (``boardgui.dhcp``) and its
discovery path (``boardgui.discovery``) both be exercised with no hardware.

**What is faithful:** the DHCP exchange itself (a real DISCOVER/REQUEST, the
same one the W5500 sends), the fallback, broadcast-until-heard, learning the
server, and the silence timeout.

**What is not:** the source IP of the data packets. A laptop cannot send from
the address it was leased without actually configuring that address, which
needs root. The fake board reports the address it was assigned and behaves as
if it held it; pass ``--bind-ip`` with an address you really have configured if
you need the GUI to see a genuinely different source.
"""

from __future__ import annotations

import argparse
import socket
import time
from typing import Optional, Tuple

from . import dhcp

# Firmware defaults, from hotfire_config.h / board_net.h.
SERVER_SILENCE_MS = 10000
HEARTBEAT_INTERVAL_MS = 1000
DHCP_TIMEOUT_S = 5.0


def is_loopback(ip: str) -> bool:
    return ip.startswith("127.")


def add_network_args(p: argparse.ArgumentParser) -> None:
    """The networking flags, shared by both fake boards."""
    p.add_argument("--dhcp-server", metavar="HOST[:PORT]",
                   help="ask this address server for an IP at startup, the way "
                        "a real board does. Point it at the GUI running its "
                        "DHCP server (e.g. 127.0.0.1:6767 for a local test).")
    p.add_argument("--discover", action="store_true",
                   help="broadcast BOARD_HEARTBEAT until a server is heard and "
                        "learn the server's address from its packets, the way "
                        "the LC/Actuator builds do")
    p.add_argument("--broadcast-ip", default=None,
                   help="where discovery heartbeats go (default: "
                        "255.255.255.255, or 127.0.0.1 when --server-ip is "
                        "loopback, so a one-laptop test needs no network)")
    p.add_argument("--bind-ip", default=None,
                   help="bind the send socket to this local address; use an "
                        "address you have really configured to make the GUI "
                        "see a different source IP")
    p.add_argument("--mac", default="de:ad:be:ef:2a:3c",
                   help="board MAC — what the ground station keys its IP "
                        "reservation on")
    p.add_argument("--silence-ms", type=int, default=SERVER_SILENCE_MS,
                   help=f"server-silence timeout (firmware: {SERVER_SILENCE_MS})")


def _split_host_port(text: str, default_port: int) -> Tuple[str, int]:
    if ":" in text:
        host, _, port = text.rpartition(":")
        return host, int(port)
    return text, default_port


def request_address(dhcp_server: str, mac: str,
                    timeout: float = DHCP_TIMEOUT_S,
                    tag: str = "demo") -> Optional[str]:
    """Do a real DHCP exchange. Returns the assigned address, or None.

    Deliberately the same DISCOVER -> OFFER -> REQUEST -> ACK the W5500's
    client does, so a GUI that can answer this can answer a real board.
    """
    host, port = _split_host_port(dhcp_server, dhcp.SERVER_PORT)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    except OSError:
        pass
    sock.settimeout(timeout)
    try:
        sock.bind(("0.0.0.0", 0))
        xid = int(time.time()) & 0xFFFFFFFF

        sock.sendto(dhcp.build_request(dhcp.DISCOVER, mac, xid=xid), (host, port))
        offer = dhcp.parse_reply(sock.recv(2048))
        if not offer or offer["msg_type"] != dhcp.OFFER:
            print(f"[{tag}] [NET] no usable OFFER from {host}:{port}")
            return None
        offered = offer["your_ip"]

        sock.sendto(dhcp.build_request(dhcp.REQUEST, mac, xid=xid,
                                       requested_ip=offered), (host, port))
        ack = dhcp.parse_reply(sock.recv(2048))
        if not ack or ack["msg_type"] != dhcp.ACK:
            print(f"[{tag}] [NET] server refused {offered} "
                  f"({dhcp.MSG_TYPE_NAMES.get(ack['msg_type'] if ack else 0, '?')})")
            return None
        return ack["your_ip"]
    except socket.timeout:
        return None
    except OSError as exc:
        print(f"[{tag}] [NET] DHCP failed: {exc}")
        return None
    finally:
        sock.close()


class BoardNetwork:
    """The board's view of the network: where it was put, and who it talks to."""

    def __init__(self, tx: socket.socket, args, board_id: int, tag: str) -> None:
        self.tx = tx
        self.tag = tag
        self.mac = dhcp.format_mac(dhcp.parse_mac(args.mac))
        self.server_port: int = args.server_port
        self.silence_ms: int = args.silence_ms
        self.discover: bool = args.discover or bool(args.dhcp_server)

        self.static_ip = f"192.168.2.{board_id}"
        self.address: Optional[str] = None
        self.address_source = "none"

        self.configured_server: str = args.server_ip
        self.server_ip: Optional[str] = None if self.discover else args.server_ip

        if args.broadcast_ip:
            self.broadcast_ip = args.broadcast_ip
        elif is_loopback(args.server_ip):
            # A one-laptop test has no useful broadcast domain; loopback stands
            # in for it so the GUI still hears us before we know about it.
            self.broadcast_ip = "127.0.0.1"
        else:
            self.broadcast_ip = "255.255.255.255"

        self.last_server_packet = 0.0

        if self.broadcast_ip == "255.255.255.255":
            try:
                self.tx.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            except OSError as exc:
                print(f"[{tag}] cannot enable broadcast ({exc}); "
                      f"pass --broadcast-ip")

        self._acquire_address(args)

    # -- addressing ------------------------------------------------------
    def _acquire_address(self, args) -> None:
        """Ask the ground station, then fall back — exactly like board_net.h."""
        if args.dhcp_server:
            print(f"[{self.tag}] [NET] requesting an address by DHCP from "
                  f"{args.dhcp_server}...")
            assigned = request_address(args.dhcp_server, self.mac, tag=self.tag)
            if assigned:
                self.address = assigned
                self.address_source = "DHCP (assigned by the server)"
                print(f"[{self.tag}] [NET] server assigned us {assigned}")
                return
            print(f"[{self.tag}] [NET] no DHCP server answered")

        self.address = self.static_ip
        self.address_source = "static fallback (no DHCP server answered)"
        if args.dhcp_server:
            print(f"[{self.tag}] [NET] WARNING: falling back to {self.static_ip} "
                  f"— this address was NOT assigned by the server")

    def describe(self) -> str:
        bits = [f"MAC {self.mac}", f"at {self.address} [{self.address_source}]"]
        if self.discover:
            bits.append(f"broadcasting to {self.broadcast_ip}:{self.server_port}")
        else:
            bits.append(f"sending to {self.configured_server}")
        return ", ".join(bits)

    # -- the firmware's loop() decisions ----------------------------------
    def tick(self, now: float) -> None:
        """Time out a silent server, as BoardNet::serverWentSilent does."""
        if not self.discover or self.server_ip is None:
            return
        if (now - self.last_server_packet) * 1000 >= self.silence_ms:
            print(f"[{self.tag}] [NET] server silent -- resuming discovery")
            self.server_ip = None

    def on_server_packet(self, src_ip: str, now: float) -> None:
        """BoardNet::onServerPacket — adopt whoever is talking to us."""
        if not self.discover:
            return
        self.last_server_packet = now
        if src_ip != self.server_ip:
            self.server_ip = src_ip
            print(f"[{self.tag}] [NET] server learned: {src_ip}")

    # -- sending ---------------------------------------------------------
    def destinations(self, is_heartbeat: bool) -> Tuple[Tuple[str, int], ...]:
        """Where a packet goes right now.

        Heartbeats double as the discovery broadcast while no server is known;
        sensor data has nowhere to go until one is, exactly as on the board.
        """
        if not self.discover:
            return ((self.configured_server, self.server_port),)
        if self.server_ip is not None:
            return ((self.server_ip, self.server_port),)
        return (((self.broadcast_ip, self.server_port),) if is_heartbeat else ())

    def send(self, packet: bytes, is_heartbeat: bool = False) -> None:
        for dest in self.destinations(is_heartbeat):
            try:
                self.tx.sendto(packet, dest)
            except OSError as exc:
                print(f"[{self.tag}] send to {dest[0]} failed: {exc}")


def make_tx_socket(bind_ip: Optional[str]) -> socket.socket:
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if bind_ip:
        tx.bind((bind_ip, 0))
    return tx


# ---------------------------------------------------------------------------
def _self_test() -> None:
    import threading

    MAC = "de:ad:be:ef:2a:3c"

    class Args:
        dhcp_server = None
        discover = True
        mac = MAC
        server_ip = "127.0.0.1"
        server_port = 5006
        broadcast_ip = None
        bind_ip = None
        silence_ms = SERVER_SILENCE_MS

    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    # -- no DHCP server configured: we sit on the static fallback ----------
    b = BoardNetwork(tx, Args(), board_id=41, tag="t")
    assert b.address == "192.168.2.41"
    assert b.address_source.startswith("static fallback")
    assert b.broadcast_ip == "127.0.0.1", "loopback stands in for broadcast"

    # before anyone talks to us: heartbeats broadcast, data goes nowhere
    assert b.destinations(is_heartbeat=True) == (("127.0.0.1", 5006),)
    assert b.destinations(is_heartbeat=False) == ()

    now = time.time()
    b.on_server_packet("192.168.2.20", now)
    assert b.server_ip == "192.168.2.20"
    assert b.destinations(is_heartbeat=False) == (("192.168.2.20", 5006),)

    # silence puts us back to broadcasting
    b.last_server_packet = now
    b.tick(now + SERVER_SILENCE_MS / 1000.0)
    assert b.server_ip is None
    assert b.destinations(is_heartbeat=True) == (("127.0.0.1", 5006),)

    # -- a real DHCP exchange against a real server ------------------------
    res = dhcp.Reservations()
    res.set(MAC, "192.168.2.41", board_id=41)
    cfg = dhcp.ServerConfig(server_ip="192.168.2.20", port=0,
                            bind_ip="127.0.0.1")
    srv = dhcp.DhcpServer(res, cfg)
    srv.bind()
    cfg.port = srv.sock.getsockname()[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        args = Args()
        args.dhcp_server = f"127.0.0.1:{cfg.port}"
        leased = BoardNetwork(tx, args, board_id=41, tag="t")
        assert leased.address == "192.168.2.41", leased.address
        assert leased.address_source.startswith("DHCP"), leased.address_source

        # an unregistered board is answered by nobody and falls back, loudly
        stranger = Args()
        stranger.dhcp_server = f"127.0.0.1:{cfg.port}"
        stranger.mac = "00:11:22:33:44:55"
        fell_back = BoardNetwork(tx, stranger, board_id=99, tag="t")
        assert fell_back.address == "192.168.2.99"
        assert fell_back.address_source.startswith("static fallback")
    finally:
        srv.stop()
        t.join(timeout=3)

    # -- discovery off: straight to the configured server ------------------
    off = Args()
    off.discover = False
    o = BoardNetwork(tx, off, board_id=41, tag="t")
    assert o.destinations(is_heartbeat=False) == (("127.0.0.1", 5006),)
    o.tick(time.time() + 999)
    assert o.server_ip == "127.0.0.1"

    tx.close()
    print("demo_net self-test: OK")


if __name__ == "__main__":
    _self_test()

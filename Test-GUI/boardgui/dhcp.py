"""
A DHCP server, so the ground station — not the board — decides addresses.

The boards already ask: every STAR board spends its first 5 seconds sending
DHCP DISCOVER (``Ethernet.begin(mac, 5000, 2000)`` in
``firmware/Hotfire_Code/common/SensorHotfireCore.h``). Until now nothing
answered, so each board fell back to picking its own address. This module
answers, from a table of **MAC -> IP reservations** the GUI owns, which is what
makes the GUI the authority: it knows every board's MAC and it decides the
address that MAC gets.

Addresses are reservations, not a rotating pool — a board with a given MAC gets
the same IP every boot, so ``daq-server/config/config.toml``'s per-board static
IPs keep working untouched.

Two things to know before running it:

* **Port 67 may need privileges — but usually not on macOS.** On Linux, ports
  below 1024 are root-only, so the GUI has to be started with ``sudo`` there.
  Current macOS does not enforce that for a UDP bind (there is no
  ``net.inet.ip.portrange.reservedhigh``), and binding 67 as a normal user
  works — verified on Darwin 25. Either way a refused bind raises
  PermissionError and the GUI says so rather than dying.
  ``port``/``client_port`` are overridable so the tests — and anyone
  experimenting — can use unprivileged ports.
* **Setting the host's own address does need root**, whatever the OS:
  ``sudo ifconfig <nic> alias <server_ip> 255.255.255.0``. That is separate
  from running this server, and is easy to mistake for a DHCP failure.
* **A second DHCP server on a shared network is disruptive.** By default this
  answers *only* MACs already in the reservation table, so it cannot hand
  addresses to unrelated machines. Turn on ``adopt_unknown`` deliberately, and
  only on a test network, to pick up a board you have not registered yet.

Pure standard library — ``python -m boardgui.dhcp`` runs a real DISCOVER /
OFFER / REQUEST / ACK exchange against itself on a high port.
"""

from __future__ import annotations

import json
import socket
import struct
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

def interface_with_address(ip: str) -> Optional[str]:
    """The NIC currently holding `ip`, or None if no interface has it.

    Only used to default the GUI's interface picker, so the common case needs
    no thought from the user. Shells out because the stdlib exposes interface
    names but not their addresses.
    """
    try:
        if sys.platform == "darwin" or "bsd" in sys.platform:
            out = subprocess.run(["ifconfig"], capture_output=True, text=True,
                                 timeout=5).stdout
            current = None
            for line in out.splitlines():
                if line[:1] and not line[:1].isspace():
                    current = line.split(":", 1)[0]
                elif line.strip().startswith(f"inet {ip} "):
                    return current
        else:
            out = subprocess.run(["ip", "-o", "-4", "addr"], capture_output=True,
                                 text=True, timeout=5).stdout
            for line in out.splitlines():
                f = line.split()
                if len(f) > 3 and f[3].split("/")[0] == ip:
                    return f[1]
    except (OSError, subprocess.SubprocessError):
        pass
    return None


# --- wire format (RFC 2131) -------------------------------------------------
SERVER_PORT = 67
CLIENT_PORT = 68
MAGIC_COOKIE = 0x63825363
# op(1) htype(1) hlen(1) hops(1) xid(4) secs(2) flags(2)
# ciaddr(4) yiaddr(4) siaddr(4) giaddr(4) chaddr(16) sname(64) file(128) magic(4)
_HEADER_FMT = "!BBBBIHHIIII16s64s128sI"
_HEADER_LEN = struct.calcsize(_HEADER_FMT)   # 240

# Darwin/BSD: pin a socket to one NIC by interface index (<netinet/in.h>).
IP_BOUND_IF = 25


def bind_socket_to_interface(sock: socket.socket, name: str) -> None:
    """Send this socket's packets out of `name`, whatever the routing table says.

    Without this the limited broadcast 255.255.255.255 follows the default
    route -- the laptop's Wi-Fi -- so a board on the stand wire never hears the
    OFFER. It DISCOVERs again, we OFFER again, and the lease never completes:
    the board falls back to its static address and looks like it ignored us.
    """
    if hasattr(socket, "SO_BINDTODEVICE"):                      # Linux
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE,
                        name.encode() + b"\0")
    else:                                                        # macOS / BSD
        sock.setsockopt(socket.IPPROTO_IP, IP_BOUND_IF,
                        socket.if_nametoindex(name))


BOOTREQUEST, BOOTREPLY = 1, 2
DISCOVER, OFFER, REQUEST, DECLINE, ACK, NAK, RELEASE, INFORM = range(1, 9)

MSG_TYPE_NAMES = {
    DISCOVER: "DISCOVER", OFFER: "OFFER", REQUEST: "REQUEST",
    DECLINE: "DECLINE", ACK: "ACK", NAK: "NAK", RELEASE: "RELEASE",
    INFORM: "INFORM",
}

# Option codes we care about
OPT_SUBNET_MASK = 1
OPT_ROUTER = 3
OPT_DNS = 6
OPT_HOSTNAME = 12
OPT_REQUESTED_IP = 50
OPT_LEASE_TIME = 51
OPT_MSG_TYPE = 53
OPT_SERVER_ID = 54
OPT_PARAM_REQUEST = 55
OPT_END = 255

DEFAULT_LEASE_SECONDS = 24 * 3600


def format_mac(raw: bytes) -> str:
    return ":".join(f"{b:02x}" for b in raw[:6])


def parse_mac(text: str) -> bytes:
    parts = text.replace("-", ":").strip().split(":")
    if len(parts) != 6:
        raise ValueError(f"MAC must have 6 octets, got {text!r}")
    return bytes(int(p, 16) for p in parts)


@dataclass
class DhcpRequest:
    """What a client just asked us for."""
    msg_type: int
    xid: int
    mac: str
    flags: int
    requested_ip: Optional[str] = None
    hostname: Optional[str] = None
    server_id: Optional[str] = None

    @property
    def wants_broadcast(self) -> bool:
        # A client with no address yet cannot receive a unicast reply, so it
        # sets the broadcast flag. We honour it rather than guessing.
        return bool(self.flags & 0x8000)


def _parse_options(blob: bytes) -> Dict[int, bytes]:
    opts: Dict[int, bytes] = {}
    i = 0
    while i < len(blob):
        code = blob[i]
        if code == OPT_END:
            break
        if code == 0:            # pad
            i += 1
            continue
        if i + 1 >= len(blob):
            break
        length = blob[i + 1]
        opts[code] = blob[i + 2:i + 2 + length]
        i += 2 + length
    return opts


def parse_packet(data: bytes) -> Optional[DhcpRequest]:
    """Decode a BOOTREQUEST. Returns None for anything that is not one."""
    if len(data) < _HEADER_LEN:
        return None
    (op, htype, hlen, _hops, xid, _secs, flags, _ciaddr, _yiaddr, _siaddr,
     _giaddr, chaddr, _sname, _file, magic) = struct.unpack(
        _HEADER_FMT, data[:_HEADER_LEN])

    if op != BOOTREQUEST or magic != MAGIC_COOKIE:
        return None
    if htype != 1 or hlen != 6:      # ethernet only
        return None

    opts = _parse_options(data[_HEADER_LEN:])
    if OPT_MSG_TYPE not in opts or not opts[OPT_MSG_TYPE]:
        return None

    req_ip = opts.get(OPT_REQUESTED_IP)
    server_id = opts.get(OPT_SERVER_ID)
    hostname = opts.get(OPT_HOSTNAME)
    return DhcpRequest(
        msg_type=opts[OPT_MSG_TYPE][0],
        xid=xid,
        mac=format_mac(chaddr),
        flags=flags,
        requested_ip=socket.inet_ntoa(req_ip) if req_ip and len(req_ip) == 4 else None,
        server_id=socket.inet_ntoa(server_id) if server_id and len(server_id) == 4 else None,
        hostname=hostname.decode("utf-8", "replace").strip("\x00") if hostname else None,
    )


def build_reply(req: DhcpRequest, msg_type: int, offered_ip: str,
                server_ip: str, subnet_mask: str = "255.255.255.0",
                router: Optional[str] = None, dns: Optional[str] = None,
                lease_seconds: int = DEFAULT_LEASE_SECONDS) -> bytes:
    """Build an OFFER, ACK or NAK for `req`."""
    yiaddr = 0 if msg_type == NAK else struct.unpack("!I", socket.inet_aton(offered_ip))[0]
    header = struct.pack(
        _HEADER_FMT,
        BOOTREPLY, 1, 6, 0,
        req.xid, 0, req.flags,
        0,                       # ciaddr
        yiaddr,                  # yiaddr — the address we are assigning
        0, 0,                    # siaddr, giaddr
        parse_mac(req.mac) + b"\x00" * 10,
        b"\x00" * 64, b"\x00" * 128,
        MAGIC_COOKIE,
    )

    def opt(code: int, payload: bytes) -> bytes:
        return bytes([code, len(payload)]) + payload

    options = opt(OPT_MSG_TYPE, bytes([msg_type]))
    options += opt(OPT_SERVER_ID, socket.inet_aton(server_ip))
    if msg_type != NAK:
        options += opt(OPT_LEASE_TIME, struct.pack("!I", lease_seconds))
        options += opt(OPT_SUBNET_MASK, socket.inet_aton(subnet_mask))
        if router:
            options += opt(OPT_ROUTER, socket.inet_aton(router))
        if dns:
            options += opt(OPT_DNS, socket.inet_aton(dns))
    options += bytes([OPT_END])

    # BOOTP clients expect at least a 300-byte datagram.
    packet = header + options
    if len(packet) < 300:
        packet += b"\x00" * (300 - len(packet))
    return packet


# ---------------------------------------------------------------------------
# Reservations — the table that makes the GUI the authority
# ---------------------------------------------------------------------------
@dataclass
class Reservation:
    mac: str
    ip: str
    board_id: Optional[int] = None
    label: str = ""
    last_seen: Optional[float] = None

    def to_json(self) -> dict:
        return {"mac": self.mac, "ip": self.ip, "board_id": self.board_id,
                "label": self.label}


class Reservations:
    """MAC -> IP, persisted so a board keeps its address across sessions.

    This is deliberately the only thing that decides an address. There is no
    free pool by default: an unknown MAC gets nothing until someone registers
    it (or ``adopt_unknown`` hands it the next address from ``pool``).
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path) if path else None
        self._by_mac: Dict[str, Reservation] = {}
        if self.path and self.path.exists():
            self.load()

    # -- persistence -----------------------------------------------------
    def load(self) -> None:
        if not self.path or not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return
        for entry in raw.get("reservations", []):
            try:
                mac = format_mac(parse_mac(entry["mac"]))
            except (KeyError, ValueError):
                continue
            self._by_mac[mac] = Reservation(
                mac=mac, ip=entry.get("ip", ""),
                board_id=entry.get("board_id"), label=entry.get("label", ""))

    def save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"reservations": [r.to_json() for r in self.all()]}
        self.path.write_text(json.dumps(payload, indent=2) + "\n")

    # -- lookups ---------------------------------------------------------
    def ip_for(self, mac: str) -> Optional[str]:
        r = self._by_mac.get(format_mac(parse_mac(mac)))
        return r.ip if r else None

    def get(self, mac: str) -> Optional[Reservation]:
        return self._by_mac.get(format_mac(parse_mac(mac)))

    def all(self) -> List[Reservation]:
        return sorted(self._by_mac.values(), key=lambda r: r.ip)

    def ips_in_use(self) -> set:
        return {r.ip for r in self._by_mac.values()}

    # -- edits -----------------------------------------------------------
    def set(self, mac: str, ip: str, board_id: Optional[int] = None,
            label: str = "") -> Reservation:
        mac = format_mac(parse_mac(mac))
        existing = self._by_mac.get(mac)
        r = Reservation(mac=mac, ip=ip,
                        board_id=board_id if board_id is not None
                        else (existing.board_id if existing else None),
                        label=label or (existing.label if existing else ""),
                        last_seen=existing.last_seen if existing else None)
        self._by_mac[mac] = r
        self.save()
        return r

    def remove(self, mac: str) -> None:
        self._by_mac.pop(format_mac(parse_mac(mac)), None)
        self.save()

    def note_seen(self, mac: str) -> None:
        r = self._by_mac.get(format_mac(parse_mac(mac)))
        if r:
            r.last_seen = time.time()


# ---------------------------------------------------------------------------
@dataclass
class ServerConfig:
    server_ip: str = "192.168.2.20"      # this host, the DAQ server address
    subnet_mask: str = "255.255.255.0"
    router: Optional[str] = None          # None: boards stay on-link (correct
                                          # for an isolated stand network)
    dns: Optional[str] = None
    lease_seconds: int = DEFAULT_LEASE_SECONDS
    port: int = SERVER_PORT
    client_port: int = CLIENT_PORT
    bind_ip: str = "0.0.0.0"
    # Reply out of this NIC by name (e.g. "en5"). Leave None only when
    # the stand network is the default route, which on a laptop with
    # Wi-Fi up it never is. See bind_socket_to_interface().
    bind_interface: Optional[str] = None
    # Answer a MAC with no reservation by allocating from `pool`. Off by
    # default: a DHCP server that answers strangers is a hazard on any shared
    # network, and on a stand network it can silently re-address someone's
    # laptop.
    adopt_unknown: bool = False
    pool: Tuple[str, ...] = ()


class DhcpServer:
    """Answers DHCP from the reservation table. Runs until stop()."""

    def __init__(self, reservations: Reservations,
                 config: Optional[ServerConfig] = None,
                 on_event: Optional[Callable[[str], None]] = None,
                 on_lease: Optional[Callable[[str, str], None]] = None,
                 on_unknown: Optional[Callable[[str], None]] = None) -> None:
        self.reservations = reservations
        self.config = config or ServerConfig()
        self.on_event = on_event or (lambda msg: None)
        self.on_lease = on_lease or (lambda mac, ip: None)
        self.on_unknown = on_unknown or (lambda mac: None)
        self.sock: Optional[socket.socket] = None
        self._stop = False
        self._unknown_reported: set = set()
        # mac -> ip we most recently offered, so REQUEST can be matched
        self.offered: Dict[str, str] = {}

    # -- address policy --------------------------------------------------
    def address_for(self, mac: str) -> Optional[str]:
        """The address this MAC is entitled to, or None to stay silent."""
        ip = self.reservations.ip_for(mac)
        if ip:
            return ip
        if not self.config.adopt_unknown:
            return None
        taken = self.reservations.ips_in_use() | set(self.offered.values())
        for candidate in self.config.pool:
            if candidate not in taken:
                return candidate
        return None

    # -- lifecycle -------------------------------------------------------
    def bind(self) -> None:
        """Open the socket. Raises PermissionError on an unprivileged port 67."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        except OSError:
            pass
        sock.settimeout(0.3)
        if self.config.bind_interface:
            try:
                bind_socket_to_interface(sock, self.config.bind_interface)
            except (OSError, ValueError) as exc:
                sock.close()
                raise OSError(
                    f"could not pin the DHCP socket to "
                    f"{self.config.bind_interface} - {exc}. Check the name "
                    f"against ifconfig.")
        try:
            sock.bind((self.config.bind_ip, self.config.port))
        except PermissionError:
            sock.close()
            raise PermissionError(
                f"this OS refused UDP port {self.config.port} to a normal "
                f"user (Linux reserves everything below 1024; macOS usually "
                f"does not). Start the GUI with sudo to hand out addresses, "
                f"or leave the DHCP server off and let boards use their "
                f"fallback address.")
        except OSError as exc:
            sock.close()
            raise OSError(
                f"could not bind UDP {self.config.bind_ip}:{self.config.port} "
                f"— {exc}. Another DHCP server may already be running here.")
        self.sock = sock

    def serve_forever(self) -> None:
        if self.sock is None:
            self.bind()
        self.on_event(
            f"DHCP server listening on {self.config.bind_ip}:{self.config.port}"
            f" — {len(self.reservations.all())} reservation(s)")
        while not self._stop:
            try:
                data, addr = self.sock.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                self.handle(data, addr)
            except Exception as exc:                  # never die on one packet
                self.on_event(f"DHCP: ignoring malformed packet ({exc})")
        if self.sock:
            self.sock.close()
            self.sock = None
        self.on_event("DHCP server stopped")

    def stop(self) -> None:
        self._stop = True

    # -- request handling ------------------------------------------------
    def handle(self, data: bytes, addr) -> Optional[bytes]:
        """Process one datagram. Returns the reply sent, for tests."""
        req = parse_packet(data)
        if req is None:
            return None

        if req.msg_type not in (DISCOVER, REQUEST):
            # RELEASE/DECLINE/INFORM need no address decision from us.
            self.on_event(f"DHCP: {MSG_TYPE_NAMES.get(req.msg_type, '?')} "
                          f"from {req.mac} (ignored)")
            return None

        ip = self.address_for(req.mac)
        if ip is None:
            if req.mac not in self._unknown_reported:
                self._unknown_reported.add(req.mac)
                self.on_event(
                    f"DHCP: {req.mac} asked for an address but has no "
                    f"reservation — ignoring it. Add one to assign it an IP.")
                self.on_unknown(req.mac)
            return None

        if req.msg_type == DISCOVER:
            self.offered[req.mac] = ip
            reply = self._reply(req, OFFER, ip)
            self.on_event(f"DHCP: OFFER {ip} to {req.mac}")
            self._send(reply, req, ip, addr)
            return reply

        # REQUEST — confirm only the address this MAC is entitled to.
        if req.requested_ip and req.requested_ip != ip:
            reply = self._reply(req, NAK, ip)
            self.on_event(
                f"DHCP: NAK {req.mac} — it asked for {req.requested_ip}, "
                f"its reservation is {ip}")
            self._send(reply, req, ip, addr)
            return reply

        reply = self._reply(req, ACK, ip)
        self.reservations.note_seen(req.mac)
        self.on_event(f"DHCP: ACK {ip} to {req.mac}")
        self.on_lease(req.mac, ip)
        self._send(reply, req, ip, addr)
        return reply

    def _reply(self, req: DhcpRequest, msg_type: int, ip: str) -> bytes:
        c = self.config
        return build_reply(req, msg_type, ip, c.server_ip, c.subnet_mask,
                           c.router, c.dns, c.lease_seconds)

    def _send(self, packet: bytes, req: DhcpRequest, ip: str, addr) -> None:
        if self.sock is None:
            return
        # A client with no address yet can only hear a broadcast. Where the
        # test harness (or a relay) unicast to us, answer the way we were
        # asked so the exchange still completes on a loopback socket.
        if addr and addr[0] not in ("0.0.0.0", "255.255.255.255"):
            dest = (addr[0], addr[1] or self.config.client_port)
        elif req.wants_broadcast:
            dest = ("255.255.255.255", self.config.client_port)
        else:
            dest = (ip, self.config.client_port)
        try:
            self.sock.sendto(packet, dest)
        except OSError as exc:
            self.on_event(f"DHCP: could not reply to {req.mac} — {exc}")


# ---------------------------------------------------------------------------
def build_request(msg_type: int, mac: str, xid: int = 0x12345678,
                  requested_ip: Optional[str] = None,
                  hostname: Optional[str] = None,
                  broadcast: bool = True) -> bytes:
    """Build a client DISCOVER/REQUEST. Used by the self-test; mirrors what
    the W5500's DHCP client sends."""
    header = struct.pack(
        _HEADER_FMT,
        BOOTREQUEST, 1, 6, 0,
        xid, 0, 0x8000 if broadcast else 0,
        0, 0, 0, 0,
        parse_mac(mac) + b"\x00" * 10,
        b"\x00" * 64, b"\x00" * 128,
        MAGIC_COOKIE,
    )

    def opt(code: int, payload: bytes) -> bytes:
        return bytes([code, len(payload)]) + payload

    options = opt(OPT_MSG_TYPE, bytes([msg_type]))
    if requested_ip:
        options += opt(OPT_REQUESTED_IP, socket.inet_aton(requested_ip))
    if hostname:
        options += opt(OPT_HOSTNAME, hostname.encode())
    options += opt(OPT_PARAM_REQUEST, bytes([OPT_SUBNET_MASK, OPT_ROUTER,
                                             OPT_DNS]))
    options += bytes([OPT_END])
    packet = header + options
    return packet + b"\x00" * max(0, 300 - len(packet))


def find_existing_server(interface: Optional[str] = None,
                         timeout: float = 2.0,
                         port: int = SERVER_PORT,
                         host: str = "255.255.255.255",
                         probe_mac: str = "02:00:00:5a:5a:5a") -> Optional[str]:
    """Is something already serving DHCP on this wire? Return its IP, or None.

    Two DHCP servers on one segment is a race: a board takes whichever OFFER
    lands first, so the same board can come up on a different address run to
    run. daq-server's dnsmasq is the authority on the stand, and this GUI
    carries a bench server for stands that have no DAQ host -- they must never
    both be running, so the GUI probes before it starts.

    Sends a DISCOVER from a locally-administered MAC that belongs to no board
    and never follows up with a REQUEST, so nothing is leased; a server may
    briefly hold the offered address, which the pool is sized to absorb.

    Finds any server that answers a MAC it does not know -- which is dnsmasq,
    because of its dynamic pool, and dnsmasq is the case this guards against.
    It cannot see a reservation-only server (another copy of this GUI, with
    adopt_unknown off): such a server answers nobody it has not been told
    about, including this probe. So None means "no pool server answered", not
    "the wire is definitely clear".

    Any error means "could not tell", reported as None rather than a false
    all-clear -- the caller decides what to do with an inconclusive probe.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if interface:
            try:
                bind_socket_to_interface(sock, interface)
            except OSError:
                pass  # best effort; an unbound probe still usually works
        sock.settimeout(timeout)
        sock.bind(("0.0.0.0", 0))
        xid = 0x5A5A0001
        sock.sendto(build_request(DISCOVER, probe_mac, xid=xid), (host, port))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            sock.settimeout(max(0.05, deadline - time.monotonic()))
            try:
                data, addr = sock.recvfrom(1024)
            except (socket.timeout, OSError):
                break
            reply = parse_reply(data)
            if reply and reply.get("msg_type") == OFFER and reply["xid"] == xid:
                return reply.get("server_id") or addr[0]
    except OSError:
        return None
    finally:
        sock.close()
    return None


def parse_reply(data: bytes) -> Optional[dict]:
    """Decode a BOOTREPLY, for the self-test and for diagnostics."""
    if len(data) < _HEADER_LEN:
        return None
    (op, _htype, _hlen, _hops, xid, _secs, _flags, _ciaddr, yiaddr, _siaddr,
     _giaddr, chaddr, _sname, _file, magic) = struct.unpack(
        _HEADER_FMT, data[:_HEADER_LEN])
    if op != BOOTREPLY or magic != MAGIC_COOKIE:
        return None
    opts = _parse_options(data[_HEADER_LEN:])
    mask = opts.get(OPT_SUBNET_MASK)
    return {
        "msg_type": opts[OPT_MSG_TYPE][0] if OPT_MSG_TYPE in opts else None,
        "xid": xid,
        "mac": format_mac(chaddr),
        "your_ip": socket.inet_ntoa(struct.pack("!I", yiaddr)),
        "server_id": socket.inet_ntoa(opts[OPT_SERVER_ID]) if OPT_SERVER_ID in opts else None,
        "subnet_mask": socket.inet_ntoa(mask) if mask and len(mask) == 4 else None,
        "lease_seconds": struct.unpack("!I", opts[OPT_LEASE_TIME])[0]
        if OPT_LEASE_TIME in opts else None,
    }


# ---------------------------------------------------------------------------
def _self_test() -> None:
    import tempfile

    LC_MAC = "de:ad:be:ef:2a:3c"
    ACT_MAC = "de:ad:be:ef:11:11"
    STRANGER = "00:11:22:33:44:55"

    # -- packet round trip --------------------------------------------------
    disc = build_request(DISCOVER, LC_MAC, xid=0xABCD1234)
    req = parse_packet(disc)
    assert req is not None
    assert req.msg_type == DISCOVER and req.mac == LC_MAC
    assert req.xid == 0xABCD1234 and req.wants_broadcast
    assert parse_packet(b"not dhcp") is None
    assert parse_packet(disc[:100]) is None, "a truncated packet must not parse"
    # a BOOTREPLY is not a request
    assert parse_packet(build_reply(req, OFFER, "192.168.2.41", "192.168.2.20")) is None

    reply = parse_reply(build_reply(req, OFFER, "192.168.2.41", "192.168.2.20"))
    assert reply["msg_type"] == OFFER
    assert reply["your_ip"] == "192.168.2.41", reply
    assert reply["mac"] == LC_MAC and reply["xid"] == 0xABCD1234
    assert reply["server_id"] == "192.168.2.20"
    assert reply["subnet_mask"] == "255.255.255.0"

    # -- reservations persist ----------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "reservations.json"
        res = Reservations(path)
        res.set(LC_MAC, "192.168.2.41", board_id=41, label="LC #1")
        res.set(ACT_MAC, "192.168.2.11", board_id=11, label="ACT #1")
        assert res.ip_for(LC_MAC) == "192.168.2.41"
        assert res.ip_for("DE-AD-BE-EF-2A-3C") == "192.168.2.41", "MAC form must not matter"
        assert res.ip_for(STRANGER) is None

        reloaded = Reservations(path)
        assert reloaded.ip_for(ACT_MAC) == "192.168.2.11"
        assert reloaded.get(ACT_MAC).label == "ACT #1"
        assert len(reloaded.all()) == 2
        reloaded.remove(ACT_MAC)
        assert Reservations(path).ip_for(ACT_MAC) is None

    # -- policy: strangers get nothing unless we opt in ---------------------
    res = Reservations()
    res.set(LC_MAC, "192.168.2.41", board_id=41)
    srv = DhcpServer(res, ServerConfig(port=0))
    assert srv.address_for(LC_MAC) == "192.168.2.41"
    assert srv.address_for(STRANGER) is None, "unknown MAC must get nothing"

    srv.config.adopt_unknown = True
    srv.config.pool = ("192.168.2.41", "192.168.2.150", "192.168.2.151")
    got = srv.address_for(STRANGER)
    assert got == "192.168.2.150", f"must skip the reserved .41, got {got}"

    # -- a real exchange over a socket, on an unprivileged port -------------
    res = Reservations()
    res.set(LC_MAC, "192.168.2.41", board_id=41)
    leases, unknowns = [], []
    cfg = ServerConfig(server_ip="192.168.2.20", port=0, client_port=0,
                       bind_ip="127.0.0.1")
    srv = DhcpServer(res, cfg, on_lease=lambda m, i: leases.append((m, i)),
                     on_unknown=unknowns.append)
    srv.bind()
    cfg.port = srv.sock.getsockname()[1]

    client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    client.bind(("127.0.0.1", 0))
    client.settimeout(2.0)
    cfg.client_port = client.getsockname()[1]

    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        # DISCOVER -> OFFER
        client.sendto(build_request(DISCOVER, LC_MAC, xid=1), ("127.0.0.1", cfg.port))
        offer = parse_reply(client.recv(2048))
        assert offer["msg_type"] == OFFER, offer
        assert offer["your_ip"] == "192.168.2.41", offer

        # REQUEST for that address -> ACK
        client.sendto(build_request(REQUEST, LC_MAC, xid=1,
                                    requested_ip="192.168.2.41"),
                      ("127.0.0.1", cfg.port))
        ack = parse_reply(client.recv(2048))
        assert ack["msg_type"] == ACK, ack
        assert ack["your_ip"] == "192.168.2.41", ack
        assert ack["lease_seconds"] == DEFAULT_LEASE_SECONDS

        # REQUEST for a DIFFERENT address -> NAK: the board does not get to
        # keep an address it chose for itself.
        client.sendto(build_request(REQUEST, LC_MAC, xid=2,
                                    requested_ip="192.168.2.99"),
                      ("127.0.0.1", cfg.port))
        nak = parse_reply(client.recv(2048))
        assert nak["msg_type"] == NAK, nak

        # an unregistered board gets silence, and is reported once
        client.sendto(build_request(DISCOVER, STRANGER, xid=3), ("127.0.0.1", cfg.port))
        try:
            client.recv(2048)
            raise AssertionError("a stranger must not be answered")
        except socket.timeout:
            pass
        client.sendto(build_request(DISCOVER, STRANGER, xid=4), ("127.0.0.1", cfg.port))
        try:
            client.recv(2048)
            raise AssertionError("still no answer")
        except socket.timeout:
            pass
    finally:
        srv.stop()
        t.join(timeout=3)
        client.close()

    assert leases == [(LC_MAC, "192.168.2.41")], leases
    assert unknowns == [STRANGER], f"one report per unknown MAC, got {unknowns}"

    # ---- find_existing_server: the guard against two servers on one wire ----
    # It spots a server that answers an unknown MAC -- i.e. one with a pool,
    # which is the dnsmasq case it exists to catch.
    pool_cfg = ServerConfig(port=9067, client_port=9068, bind_ip="127.0.0.1",
                            server_ip="127.0.0.1", adopt_unknown=True,
                            pool=("192.168.2.200", "192.168.2.201"))
    pool_srv = DhcpServer(Reservations(), pool_cfg, on_event=lambda m: None)
    pool_srv.bind()
    pt = threading.Thread(target=pool_srv.serve_forever, daemon=True)
    pt.start()
    try:
        found = find_existing_server(timeout=1.5, port=9067, host="127.0.0.1")
        assert found is not None, "probe missed a running DHCP server"
    finally:
        pool_srv.stop()
        pt.join(timeout=3)

    # ...and reports nothing once that server is gone.
    assert find_existing_server(timeout=0.5, port=9067,
                                host="127.0.0.1") is None, \
        "probe reported a server that is not running"

    print("dhcp self-test: OK")


if __name__ == "__main__":
    _self_test()

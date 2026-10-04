"""
Which address do we send control packets to?

A board does not necessarily live at the IP its profile says. It holds
whatever address the ground station assigned it (see ``dhcp``), or — if no
address server answered — its static fallback, and it BROADCASTS its heartbeat
from whichever it currently holds. Broadcasts arrive here regardless of subnet,
so we can see a source address this host cannot send back to.

This module is the policy for that: learn the board's real address from its
packets, but only adopt one we can actually reach, and fall back cleanly when
a send proves otherwise. It is deliberately free of Qt and sockets-in-anger so
it can be exercised without hardware or a display:

    python -m boardgui.discovery      # -> "discovery self-test: OK"

``network.UdpLink`` owns the socket and the signals; it delegates every
address decision to ``DiscoveryPolicy``.
"""

from __future__ import annotations

import socket
from typing import Callable, Dict, Optional, Set, Tuple

# What observe() decided, for the caller to log / signal.
ADOPTED = "adopted"            # (ADOPTED, ip)  -> retarget the send path here
UNREACHABLE = "unreachable"    # (UNREACHABLE, ip) -> first sighting, no route
IGNORED = "ignored"            # nothing new to say


def host_can_reach(ip: str, port: int) -> bool:
    """Does this host have a route to `ip`?

    UDP ``connect()`` only does a route lookup — no packet leaves the machine —
    so this is a cheap, authoritative check. Without it, a board broadcasting
    from an address on some other subnet would have every control packet
    pointed at a destination that fails with ENETUNREACH (WinError 10051).
    """
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect((ip, port))
            return True
        finally:
            probe.close()
    except OSError:
        return False


class DiscoveryPolicy:
    """Tracks where the board actually is.

    `configured_ip` is the profile default (or whatever the user typed); it is
    the destination until a reachable board address is learned.
    """

    def __init__(self, configured_ip: str, control_port: int,
                 can_reach: Callable[[str, int], bool] = host_can_reach) -> None:
        self.configured_ip = configured_ip
        self.control_port = control_port
        self._can_reach = can_reach
        self.discovered_ip: Optional[str] = None
        # Route lookups are cached so the per-packet path doesn't probe every
        # time a heartbeat lands.
        self._reachable: Dict[str, bool] = {}
        self._unreachable_reported: Set[str] = set()

    # -- where sends go --------------------------------------------------
    @property
    def target_ip(self) -> str:
        return self.discovered_ip or self.configured_ip

    def set_configured_ip(self, ip: str) -> None:
        """User typed an address: honor it until the board is re-discovered."""
        self.configured_ip = ip
        self.discovered_ip = None

    # -- learning --------------------------------------------------------
    def observe(self, src_ip: str) -> Tuple[str, Optional[str]]:
        """A packet arrived from the board at `src_ip`. Decide what to do."""
        if not src_ip or src_ip == self.discovered_ip:
            return (IGNORED, None)

        reachable = self._reachable.get(src_ip)
        if reachable is None:
            reachable = self._can_reach(src_ip, self.control_port)
            self._reachable[src_ip] = reachable

        if not reachable:
            # Report a given dead address once, not once per heartbeat.
            if src_ip in self._unreachable_reported:
                return (IGNORED, None)
            self._unreachable_reported.add(src_ip)
            return (UNREACHABLE, src_ip)

        self.discovered_ip = src_ip
        return (ADOPTED, src_ip)

    def note_send_failure(self, ip: str) -> bool:
        """A send to `ip` failed. Returns True if we gave up on that address.

        The route check can be wrong — an address can look routable and
        still not be — so a real failure is the authoritative signal.
        """
        self._reachable[ip] = False
        if self.discovered_ip == ip:
            self.discovered_ip = None
            return True
        return False


# ---------------------------------------------------------------------------
def _self_test() -> None:
    board = "192.168.2.21"
    off_subnet = "10.7.0.9"

    # -- nothing learned yet: sends go to the configured address ------------
    p = DiscoveryPolicy(board, 5005, can_reach=lambda ip, port: True)
    assert p.target_ip == board
    assert p.discovered_ip is None

    # -- a reachable board address is adopted and retargets the send path ---
    assert p.observe("192.168.2.137") == (ADOPTED, "192.168.2.137")
    assert p.target_ip == "192.168.2.137"
    # ...and the same address again is not news
    assert p.observe("192.168.2.137") == (IGNORED, None)

    # -- an unreachable broadcast source is reported once, never adopted ----
    reach = {board: True, off_subnet: False}
    p = DiscoveryPolicy(board, 5005, can_reach=lambda ip, port: reach.get(ip, False))
    assert p.observe(off_subnet) == (UNREACHABLE, off_subnet)
    assert p.discovered_ip is None
    assert p.target_ip == board, "must keep sending to the configured address"
    assert p.observe(off_subnet) == (IGNORED, None), "one report per address"

    # -- the address we CAN route to wins ----------------------------------
    assert p.observe(board) == (ADOPTED, board)
    assert p.target_ip == board

    # -- route check said yes but the send failed: drop the learned address -
    p = DiscoveryPolicy(board, 5005, can_reach=lambda ip, port: True)
    p.observe(off_subnet)
    assert p.target_ip == off_subnet
    assert p.note_send_failure(off_subnet) is True
    assert p.target_ip == board, "fall back to configured after a failed send"
    # and it is not re-adopted on the next broadcast from the same address
    assert p.observe(off_subnet) == (UNREACHABLE, off_subnet)
    assert p.target_ip == board

    # a failure on the configured address doesn't clear a learned one
    p = DiscoveryPolicy(board, 5005, can_reach=lambda ip, port: True)
    p.observe("192.168.2.99")
    assert p.note_send_failure(board) is False
    assert p.target_ip == "192.168.2.99"

    # -- a manual override beats whatever was discovered -------------------
    p = DiscoveryPolicy(board, 5005, can_reach=lambda ip, port: True)
    p.observe("192.168.2.137")
    p.set_configured_ip("192.168.2.42")
    assert p.target_ip == "192.168.2.42"
    # ...until the board is seen again
    assert p.observe("192.168.2.137") == (ADOPTED, "192.168.2.137")
    assert p.target_ip == "192.168.2.137"

    # -- empty source is never adopted -------------------------------------
    p = DiscoveryPolicy(board, 5005, can_reach=lambda ip, port: True)
    assert p.observe("") == (IGNORED, None)
    assert p.discovered_ip is None

    # -- host_can_reach is a route lookup, not a ping ----------------------
    assert host_can_reach("127.0.0.1", 5005) is True

    print("discovery self-test: OK")


if __name__ == "__main__":
    _self_test()

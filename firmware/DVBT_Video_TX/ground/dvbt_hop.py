"""Ground side of a frequency hop: read the transmitter's channel table out
of the received transport stream and decide when to retune the receiver.

The transmitter (esp32p4/components/ts_mux) sends a private section on PID
0x1FF0 every 100 ms, and at once when it changes:

    table_id 0xF0, table_id_extension 0x4850 ("HP"), version (bumped on change)
    u8 format (1) | u8 flags (bit 0: hop pending) | u16 seq
    u32 current kHz | u32 next kHz | 48-bit hop PCR (adaptation-field coding)
    CRC-32/MPEG-2

How the ground follows a hop (Follower):
  1. A table with the pending flag set: the transmitter has accepted a hop
     to `next_khz` at stream time `hop_pcr`. Only this -- never the
     telemetry uplink's own acknowledgement -- arms the retune, because it
     proves the transmitter is going.
  2. Retune when the received stream's PCR is within margin_ms (100) of
     hop_pcr, or when the receiver loses lock after the table was seen.
     Not at hop_pcr itself: a receiver's output trails the air by its
     pipeline, and the packets still in it when the signal leaves are never
     delivered (gr-dtv: the last ~45 ms), so it would wait for a PCR that
     never comes. Retuning early only gives up the tail it would lose
     anyway, and it is already listening when the transmitter arrives.
  3. On the new channel, a table with current_khz == next_khz confirms it.
If the receiver ever loses lock with no hop pending (a missed table, a
fade), cycle through the pad's channel list until one locks (the station
software's job; Follower.hunt_list gives the order: last good channel first).

Pure Python, no receiver dependency: feed it the 188-byte packets your
receiver hands you (HiDes UT-130B: its SDK's TS callback).
"""
from __future__ import annotations

from dataclasses import dataclass

HOP_PID = 0x1FF0
PCR_WRAP = 300 << 33                       # 27 MHz ticks


def crc32_mpeg(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc


@dataclass(frozen=True)
class ChanTable:
    version: int
    pending: bool
    seq: int
    current_khz: int
    next_khz: int
    hop_pcr: int                            # 27 MHz ticks, mod PCR_WRAP


def pid(pkt: bytes) -> int:
    return ((pkt[1] & 0x1F) << 8) | pkt[2]


def pcr_of(pkt: bytes) -> int | None:
    """The PCR in a packet's adaptation field, in 27 MHz ticks, if any."""
    if pkt[0] != 0x47 or not (pkt[3] & 0x20) or pkt[4] < 7 or not (pkt[5] & 0x10):
        return None
    return decode_pcr(pkt[6:12])


def decode_pcr(b: bytes) -> int:
    base = (b[0] << 25) | (b[1] << 17) | (b[2] << 9) | (b[3] << 1) | (b[4] >> 7)
    ext = ((b[4] & 1) << 8) | b[5]
    return base * 300 + ext


def parse_table(pkt: bytes) -> ChanTable | None:
    """The channel table in one packet, or None (other PID, bad CRC, not ours)."""
    if len(pkt) != 188 or pkt[0] != 0x47 or pid(pkt) != HOP_PID or not (pkt[1] & 0x40):
        return None
    s = pkt[5 + pkt[4]:]
    if len(s) < 3 or s[0] != 0xF0:
        return None
    n = 3 + (((s[1] & 0x0F) << 8) | s[2])
    sec = s[:n]
    if len(sec) != n or n < 8 + 18 + 4 or crc32_mpeg(sec) != 0:
        return None
    if (sec[3], sec[4]) != (0x48, 0x50) or sec[8] != 1:
        return None
    p = sec[8:]
    return ChanTable(version=(sec[5] >> 1) & 0x1F, pending=bool(p[1] & 1), seq=(p[2] << 8) | p[3],
                     current_khz=int.from_bytes(p[4:8], "big"), next_khz=int.from_bytes(p[8:12], "big"),
                     hop_pcr=decode_pcr(p[12:18]))


def tables(ts: bytes) -> list[tuple[int, ChanTable]]:
    """Every channel table in a stream, with its packet index."""
    out = []
    for i in range(0, len(ts) - 187, 188):
        t = parse_table(ts[i:i + 188])
        if t:
            out.append((i // 188, t))
    return out


class Follower:
    """Feed packets as they arrive; returns the kHz to retune to when it is time."""

    def __init__(self, tuned_khz: int, channels: list[int], margin_ms: float = 100.0):
        self.tuned = tuned_khz
        self.channels = list(channels)
        self.margin = int(margin_ms * 27000)
        self.armed: ChanTable | None = None
        self.last_pcr: int | None = None
        self.confirmed = False

    def feed(self, pkt: bytes) -> int | None:
        t = parse_table(pkt)
        if t:
            if t.pending and t.next_khz != self.tuned:
                self.armed = t
            elif not t.pending and t.current_khz == self.tuned:
                self.confirmed = True
        p = pcr_of(pkt)
        if p is not None:
            self.last_pcr = p
            if self.armed and _reached(p, self.armed.hop_pcr - self.margin):
                return self._retune()
        return None

    def lost_lock(self) -> int | None:
        """The receiver lost lock: if a hop was announced, that was it."""
        return self._retune() if self.armed else None

    def _retune(self) -> int:
        self.tuned = self.armed.next_khz
        self.armed = None
        self.confirmed = False
        return self.tuned

    def hunt_list(self) -> list[int]:
        """Lost with no hop pending: try these in order (current first)."""
        return [self.tuned] + [c for c in self.channels if c != self.tuned]


def _reached(pcr: int, target: int) -> bool:
    """pcr at or past target on the wrapping 27 MHz timeline (within half a wrap)."""
    return (pcr - target) % PCR_WRAP < PCR_WRAP // 2

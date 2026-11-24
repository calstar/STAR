"""Decode and normalise what reached the capture port. The rules here are the README's N1-N7.

Layouts are ported from lib/daq-protocol/src/DiabloPackets.h (PacketHeader, ActuatorCommandPacket,
PWMActuatorCommandPacket) and DiabloEnums.h (PacketType). Every packet starts with the 6-byte
PacketHeader: u8 packet_type, u8 version, u32 timestamp (LE). Bytes 2..5 are a clock, so they are
masked everywhere (N1) and the raw hex is printed with them as `........`.
"""

from __future__ import annotations

import struct
from collections import Counter

PACKET_TYPES = {
    1: "BOARD_HEARTBEAT",
    2: "SERVER_HEARTBEAT",
    3: "SENSOR_DATA",
    4: "ACTUATOR_COMMAND",
    5: "SENSOR_CONFIG",
    6: "ACTUATOR_CONFIG",
    7: "ABORT",
    8: "ABORT_DONE",
    9: "CLEAR_ABORT",
    10: "PWM_ACTUATOR_COMMAND",
    11: "NO_CONNECTION_ABORT",
    12: "SELF_TEST",
    13: "ENVIRONMENTAL_DATA",
    14: "STACKLIGHT_COMMAND",
    15: "LOGS",
}

REPEAT_WINDOW_NS = (
    500_000_000  # N2: the same bytes (clock included) within 0.5 s: a retransmit
)
MERGE_NS = 150_000_000  # N3a: the same send again within 150 ms is one line, xK sends
PWM_STREAM_NS = (
    100_000_000  # N7: PWM sends < 100 ms apart with one content are a stream
)
TICK_AGE_NS = (
    700_000_000  # N5: an actuator send >= 0.7 s into its state's loop is a republish
)
BOUNDARY_LOOKAHEAD_NS = (
    60_000_000  # N5: entry sends precede the transition publish by < 60 ms
)
# N5: an abort entry's lookahead is one 50 ms step longer. It was measured for main, where
# doTransitionTo's second triggerAbort() joined the first one's ABORT_DONE thread, which only saw
# the cancel after its current 50 ms sleep_for step, before the transition was published (C1-10).
# triggerAbort() now runs once and the ABORT_DONE wait wakes on cancel, so an abort entry publishes
# as promptly as any other; the extra step is kept as slack, not as a property of the code.
ABORT_DONE_STEP_NS = 50_000_000


def masked(raw: bytes) -> bytes:
    return raw[:2] + b"\0\0\0\0" + raw[6:] if len(raw) >= 6 else raw


def masked_hex(raw: bytes) -> str:
    h = raw.hex()
    return h[:4] + "........" + h[12:] if len(raw) >= 6 else h


def bucket_ms(ns: int, stage: bool = False) -> int:
    """N4. A staged delay below 1 s: nearest 50 ms. Anything else: floored (waits only overshoot)."""
    ms = ns / 1e6
    if stage and ms < 1000:
        return int(round(ms / 50.0)) * 50
    if ms < 1000:
        return int(ms // 100) * 100
    if ms < 2000:
        return int(ms // 250) * 250
    return int(ms // 1000) * 1000


def fmt_ms(ms: int) -> str:
    return (
        f"+{ms}ms"
        if ms < 1000
        else (f"+{ms / 1000:.2f}s" if ms < 2000 else f"+{ms // 1000}s")
    )


def ms_bucket(ns: int) -> str:
    return fmt_ms(bucket_ms(ns))


# The continuous loop's republish period. Not configuration: ActuatorCommander::startContinuousLoop
# sleeps 100 x 10 ms between passes. Asserted as a bound, never as an observed value (README, N5).
REPUBLISH_S = 1.0
REPUBLISH_BOUNDS = (0.8, 1.5)


def period_ok(ns: int) -> bool:
    lo, hi = REPUBLISH_BOUNDS
    return lo * REPUBLISH_S <= ns / 1e9 <= hi * REPUBLISH_S


def period_text(values: list[int]) -> str:
    """N5: every interval within the bounds prints the same text; any outside prints itself."""
    bad = sorted({f"{v / 1e9:.2f}s" for v in values if not period_ok(v)})
    lo, hi = REPUBLISH_BOUNDS
    if bad:
        return f"OUTSIDE [{lo}, {hi}] x {REPUBLISH_S:g} s: " + ", ".join(bad)
    return f"{REPUBLISH_S:g} s within [{lo}, {hi}]x"


# N4: a staged send must land at or after its configured delay, and before this much past it.
STAGE_EARLY_S = 0.005
STAGE_HEADROOM = (0.1, 0.25)  # seconds, plus this fraction of the delay


def stage_ok(measured_s: float, d: float) -> bool:
    return (
        d - STAGE_EARLY_S <= measured_s <= d + STAGE_HEADROOM[0] + STAGE_HEADROOM[1] * d
    )


def period_bucket(ns: int) -> str:
    """N5: republish period, floored to 1 s (the 100 x 10 ms loop runs 1.0-1.6 s under load)."""
    return f"~{int((ns / 1e6) // 1000)}s"


class RoleMap:
    """(board, channel) -> the role [actuator_roles] puts there. For readability only: the board
    itself is what is frozen, from the address the datagram was sent to."""

    def __init__(self, roles: dict[str, tuple[str, int, int]]):
        self.by: dict[tuple[int, int], list[str]] = {}
        for name, (_kind, ch, board) in sorted(roles.items()):
            self.by.setdefault((board, ch), []).append(name)

    def names(self, board, ch: int) -> str:
        return "|".join(self.by.get((board, ch), ["?"]))


def board_of(dest: str):
    """Board id from a destination 127.0.0.<id>; None for 127.0.0.1 (broadcast, heartbeat)."""
    last = int(dest.rsplit(".", 1)[1])
    return None if last == 1 else last


def where(dest: str) -> str:
    b = board_of(dest)
    return "to 127.0.0.1" if b is None else f"to board {b}"


def decode(raw: bytes, roles: RoleMap, dest: str = "127.0.0.1") -> str:
    board = board_of(dest)
    if len(raw) < 6:
        return f"SHORT({len(raw)}B)"
    ptype, ver = raw[0], raw[1]
    name = PACKET_TYPES.get(ptype, f"TYPE{ptype}")
    head = f"{name} v{ver}"
    body = raw[6:]
    if ptype == 4 and body:
        n = body[0]
        pairs = [
            (body[1 + 2 * i], body[2 + 2 * i])
            for i in range(n)
            if 2 + 2 * i < len(body)
        ]
        items = " ".join(f"ch{c}={s}[{roles.names(board, c)}]" for c, s in pairs)
        extra = "" if len(body) == 1 + 2 * n else f" TRAILING({len(body) - 1 - 2 * n}B)"
        return f"{head} n={n}: {items}{extra}"
    if ptype == 10 and body:
        n = body[0]
        items = []
        for i in range(n):
            off = 1 + 13 * i
            if off + 13 > len(body):
                items.append("TRUNCATED")
                break
            ch, dur, duty, freq = struct.unpack_from("<BIff", body, off)
            items.append(
                f"ch{ch}[{roles.names(board, ch)}] dur={dur}ms duty={duty:.4g} freq={freq:.4g}Hz"
            )
        return f"{head} n={n}: " + "; ".join(items)
    if ptype in (7, 8, 9):
        return head + ("" if not body else f" +{len(body)}B")
    return head + f" +{len(body)}B"


class Send:
    """One logical send: a datagram and its retransmits (N2)."""

    def __init__(self, t: int, raw: bytes, i: int = 0, dest: str = "127.0.0.1"):
        self.i = i  # index of its first datagram in the session's packet list
        self.dest = dest  # the address it was sent to: which board
        self.t = t
        self.raw = raw
        self.count = 1
        self.last = t
        self.tick = False
        self.repeats: list[int] = []  # PWM run members after the first (N7)

    @property
    def ptype(self) -> int:
        return self.raw[0] if self.raw else -1

    @property
    def key(self):
        return (self.ptype, self.dest, masked(self.raw))


def to_sends(packets: list[tuple[int, bytes, str]]) -> list[Send]:
    sends: list[Send] = []
    open_: dict[tuple[str, bytes], Send] = {}
    for i, (t, raw, dest) in enumerate(packets):
        s = open_.get((dest, raw))
        if s is not None and t - s.t <= REPEAT_WINDOW_NS and raw[:1] != b"\x0a":
            s.count += 1
            s.last = t
            continue
        s = Send(t, raw, i, dest)
        open_[(dest, raw)] = s
        sends.append(s)
    return sends


def mark_ticks(sends: list[Send], boundaries: list[tuple[int, str]], *, aborts) -> None:
    """N5: flag 1 Hz republishes. `boundaries` = [(t_ns, state)] in time order, boot first.

    A send belongs to the latest boundary it precedes by less than the lookahead: an entry's sends
    go out before its transition publish. `aborts` = the abort states, whose lookahead is one
    ABORT_DONE step longer (see ABORT_DONE_STEP_NS)."""
    for s in sends:
        idx = 0
        for i, (b, st) in enumerate(boundaries):
            ahead = BOUNDARY_LOOKAHEAD_NS + (ABORT_DONE_STEP_NS if st in aborts else 0)
            if b <= s.t + ahead:
                idx = i
        s.loop = idx
        s.age = s.t - boundaries[idx][0]
        s.tick = s.ptype == 4 and s.age >= TICK_AGE_NS


def _pairs(s: Send) -> Counter:
    body = s.raw[6:]
    n = body[0] if body else 0
    return Counter(
        (body[1 + 2 * i], body[2 + 2 * i]) for i in range(n) if 2 + 2 * i < len(body)
    )


def _first_pass_of(s: Send, earlier: list[Send]):
    """N3c: the earlier send `s` is the loop's first pass of, or None."""
    if s.ptype != 4 or s.count != 3:
        return None
    mine = _pairs(s)
    for p in reversed(earlier):
        if p.ptype != 4 or p.dest != s.dest or s.t - p.t > MERGE_NS:
            continue
        extra = mine - _pairs(p)
        if not extra or _pairs(p) - mine:
            continue
        staged = Counter()
        for q in earlier:
            if q is not p and q.ptype == 4 and q.dest == s.dest and p.t <= q.t <= s.t:
                staged += _pairs(q)
        if all(staged[k] >= v for k, v in extra.items()):
            return p
    return None


def mark_pwm_tails(sends: list[Send]) -> None:
    """N7b: the controller loop's last stream packet can land just after the close command.

    setFireActive(false) sends the close while the 100 Hz loop may already have read "active" and
    send one more stream packet after it (seen in the 3x runs; reported as a defect). A PWM send
    whose content repeats the stream that was running < 50 ms before, after a different PWM send
    intervened, is that stray and is dropped from the record.
    """
    last_t: dict = {}
    start: dict = {}  # key -> when the stream it belongs to began
    prev_key = None
    for s in sends:
        if s.ptype != 10:
            continue
        t_prev = last_t.get(s.key)
        if (
            t_prev is not None
            and prev_key not in (None, s.key)
            and s.t - t_prev < 50_000_000
        ):
            s.tail = True
        else:
            # N7: a stream packet that continues one running when its window opened belongs to
            # that stream (already recorded where it started), not to the new window.
            if (
                t_prev is not None
                and s.t - t_prev < PWM_STREAM_NS
                and prev_key == s.key
            ):
                s.stream_start = start[s.key]
            else:
                start[s.key] = s.t
                s.stream_start = s.t
            last_t[s.key] = s.t
            prev_key = s.key


def collapse_pwm(sends: list[Send]) -> list[Send]:
    """N7: consecutive PWM sends with the same masked content are one record (a stream)."""
    out: list[Send] = []
    last_pwm: Send | None = None
    for s in sends:
        if s.ptype == 10:
            last_t = last_pwm.repeats[-1] if last_pwm and last_pwm.repeats else None
            last_t = (
                last_t if last_t is not None else (last_pwm.t if last_pwm else None)
            )
            if (
                last_pwm is not None
                and last_pwm.key == s.key
                and s.t - last_t < PWM_STREAM_NS
            ):
                last_pwm.repeats.append(s.t)
                continue
            last_pwm = s
        out.append(s)
    return out


def render_window(
    sends: list[Send],
    roles: RoleMap,
    boundaries,
    summary=False,
    t_open=0,
    from_open=False,
    t_close=None,
    stage_delay=lambda state, dest, raw: None,
) -> list[str]:
    """Events (N3 ordering, N4 times) then a republish summary per loop seen in the window (N5)."""
    lines: list[str] = []
    events = [
        s
        for s in sends
        if not s.tick
        and not getattr(s, "tail", False)
        and getattr(s, "stream_start", s.t) >= t_open
    ]
    ticks = [s for s in sends if s.tick]
    events = collapse_pwm(events)
    if events:
        # A command window is timed from its first datagram; a note (no command) from the note,
        # so what follows it is timed from when the harness changed something.
        anchor = t_open if from_open else events[0].t
        # Arrival order is frozen once, for the window's first datagram: that is the ordering the
        # code guarantees (the ABORT broadcast leaves before any valve moves).
        lines.append(
            f"  first datagram: {PACKET_TYPES.get(events[0].ptype, events[0].ptype)}"
        )
        # N3a: the same send again within 150 ms (entry apply + the loop's first pass; the two
        # abort bursts) is one line with its multiplicity.
        merged: list[Send] = []
        for s in events:
            prev = next(
                (m for m in reversed(merged) if m.key == s.key and m.count == s.count),
                None,
            )
            if prev is not None and s.t - prev.t <= MERGE_NS and not s.repeats:
                prev.mult = getattr(prev, "mult", 1) + 1
                continue
            # N3c: the loop's first pass skips roles whose stage is still pending
            # (ActuatorCommander::applyForState, pending_roles_), and a stage due in ~1 ms (Fire's
            # LOX Main, 0.001 s) races it on another thread. A pass that is an earlier send to the
            # same board plus exactly the pairs a stage already sent there is that first pass.
            base = _first_pass_of(s, merged)
            if base is not None:
                base.mult = getattr(base, "mult", 1) + 1
                continue
            merged.append(s)
        # N3b/N4: a staged actuator send (the anchor's own state, timed by the delays CSV) gets the
        # fine band; everything else the floored one. Lines in one bucket are in canonical order
        # (type, bytes), never arrival order: the loop's first pass, a +1 ms stage, the second
        # abort broadcast and the controller's PWM answer race inside a few tens of ms.
        a_loop = events[0].loop
        rows = []
        for s in merged:
            d = None
            if not from_open and s.ptype == 4 and s.loop == a_loop:
                d = stage_delay(boundaries[s.loop][1], s.dest, s.raw)
            m = s.t - anchor
            if d is None:
                b = bucket_ms(m)
                label = fmt_ms(b)
            elif stage_ok(m / 1e9, d):
                # The configured delay, not the measurement: proven within its bounds.
                b = int(round(d * 1000))
                label = f"+{d:g}s"
            else:
                b = bucket_ms(m, True)
                label = f"{fmt_ms(b)}!=cfg{d:g}s"
            rows.append((b, s.key, s.count, s, label))
        rows.sort(key=lambda r: (r[0], r[1], r[2]))
        for b, _k, count, s, tb in rows:
            mult = getattr(s, "mult", 1)
            times = f"x{count}" + (f" (x{mult} sends)" if mult > 1 else "")
            lines.append(
                f"  {tb:>8} {times} {where(s.dest)}: {decode(s.raw, roles, s.dest)}"
            )
            lines.append(f"  {'':>8}    raw {masked_hex(s.raw)}")
            if s.repeats:
                gaps = sorted(y - x for x, y in zip([s.t] + s.repeats, s.repeats))
                med = gaps[len(gaps) // 2]
                # Its end is not timed: it is whatever event stops it (the close command
                # that follows), and a stream stops within one period either side of that.
                if t_close is not None and t_close - s.repeats[-1] < PWM_STREAM_NS:
                    end = "still running when the window closed"
                else:
                    end = "then stopped"
                lines.append(
                    f"  {'':>8}    repeated every ~{int(med // 1e7) * 10}ms, {end}"
                )
    if summary and ticks:
        by_loop: dict[int, list[Send]] = {}
        for s in ticks:
            by_loop.setdefault(s.loop, []).append(s)
        for loop, ts in sorted(by_loop.items()):
            state = boundaries[loop][1]
            # A republish is one send per board; its period is measured board by board.
            per_dest: dict[str, list[Send]] = {}
            for x in ts:
                per_dest.setdefault(x.dest, []).append(x)
            gap_ns = [b.t - a.t for d in per_dest.values() for a, b in zip(d, d[1:])]
            gaps = [period_text(gap_ns)] if gap_ns else []
            contents = sorted({(s.dest, masked_hex(s.raw)) for s in ts})
            # The first tick's age only means something when the state was entered in this window.
            first = (
                f" first after {period_text([ts[0].age])}"
                if boundaries[loop][0] >= t_open
                else ""
            )
            lines.append(
                f"  republish [{state}]:{first}"
                + (f"{',' if first else ''} every {'/'.join(gaps)}" if gaps else "")
            )
            for dest, c in contents:
                raw = bytes.fromhex(c.replace(".", "0"))
                lines.append(f"  {'':>8}    {where(dest)}: {decode(raw, roles, dest)}")
                lines.append(f"  {'':>8}    raw {c}")
    return lines

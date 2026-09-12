"""
Per-board clock sync for plotting — a Python port of the DAQ server's
``fsw::time::BoardClockSync``.

Straight port of:
  daq-server/diablo_server/lib/include/time/BoardClockSync.hpp
  daq-server/diablo_server/lib/src/time/BoardClockSync.cpp
as used by the bridge in daq_bridge/daq_bridge_main.cpp. Keep the two in step —
the algorithm, the config defaults, and the invariants below are theirs, not
ours. Config defaults mirror [time_sync] in daq-server/config/config.toml.

The problem it solves is the same one the GUI had: boards stamp each sensor
chunk with uint32 millis() from a cheap local crystal (accurate RELATIVE
spacing, meaningless absolute value, wraps at 2^32 ms). Stamping every chunk of
a UDP packet with the one arrival time flattens a multi-chunk batch onto a
single instant — which plots as a vertical spike per packet joined by a
diagonal — and leaks network jitter into the timeline.

  - UNWRAP:    uint32 board ms extended to 64-bit via modular forward deltas.
               A forward step beyond max_plausible_gap is a reboot -> resync.
               A wrap is just a small modular step -> seamless, no resync.
  - OFFSET:    sliding-window MINIMUM of residual = arrival - board_time.
               Network delay is one-sided (a packet cannot arrive before it was
               sent), so residuals scatter ABOVE the true offset and the window
               floor is the best estimate; congestion cannot drag it.
  - SPREADING: each chunk stamped at board_time + offset, so batched scans keep
               their true spacing instead of collapsing onto arrival time.
  - INVARIANTS: the current packet's residual participates in the window min,
               so offset <= residual and the newest chunk never stamps in the
               future. Every stamp is clamped to
               [arrival - max_batch_age, arrival] (violation -> flat arrival
               fallback + counter), and emitted chunk timestamps per board are
               forced non-decreasing.

Mode "arrival" reproduces the pre-sync behaviour exactly (revert switch).

Pure stdlib and deterministic: no sockets, no real clock — arrival times are
inputs. Run ``python -m boardgui.clocksync`` for the self-test, which mirrors
lib/test/test_board_clock_sync.cpp.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Tuple

NS_PER_MS = 1_000_000
_JITTER_EMA_ALPHA = 0.1
_UINT32 = 0xFFFFFFFF

MODE_BOARD_CLOCK = "board-clock"
MODE_ARRIVAL = "arrival"


@dataclass
class TimeSyncConfig:
    """Mirrors [time_sync] in daq-server/config/config.toml."""

    mode: str = MODE_BOARD_CLOCK
    window_seconds: int = 10        # residual-min sliding window
    max_plausible_gap_s: int = 60   # modular forward step beyond this = reboot
    max_batch_age_s: int = 5        # stamps confined to [arrival - this, arrival]
    resync_threshold_ms: int = 1000  # |residual - offset| beyond this = lost lock
    log_interval_s: int = 10        # diagnostics cadence (used by the bridge)


@dataclass
class BoardStats:
    offset_ms: float = 0.0        # current arrival-vs-board offset estimate
    jitter_ms: float = 0.0        # EMA of residual excess over the offset floor
    resyncs: int = 0              # reboot / lost-lock re-initializations
    clamp_fallbacks: int = 0      # chunks stamped at flat arrival (safety clamp)
    packets: int = 0
    locked: bool = False


@dataclass
class _BoardState:
    locked: bool = False
    last_raw_ms: int = 0          # newest chunk of the previous packet (raw)
    last_unwrapped_ms: int = 0    # 64-bit unwrapped counterpart
    offset_ns: int = 0            # arrival_ns - unwrapped_board_ns (window min)
    # (arrival_ns, residual_ns) per packet; pruned to window_seconds by arrival.
    window: Deque[Tuple[int, int]] = field(default_factory=deque)
    last_emitted_ns: int = 0      # per-board monotonic guard
    stats: BoardStats = field(default_factory=BoardStats)


def _forward_step_ms(a: int, b: int) -> int:
    """Modular uint32 forward step (wrap-safe): how far b advanced past a."""
    return (b - a) & _UINT32


def _board_ns(unwrapped_ms: int) -> int:
    """Board timeline position in ns (exact int math, as in the C++)."""
    return unwrapped_ms * NS_PER_MS


class BoardClockSync:
    def __init__(self, cfg: TimeSyncConfig | None = None) -> None:
        self.cfg = cfg or TimeSyncConfig()
        self._boards: Dict[str, _BoardState] = {}

    def _resync(self, s: _BoardState, newest_raw_ms: int, arrival_ns: int,
                count: bool) -> None:
        """Re-anchor: the newest chunk is assumed sent "just now".

        Accuracy for THIS packet equals the legacy arrival-stamping; the window
        rebuilds from here.
        """
        s.last_raw_ms = newest_raw_ms
        s.last_unwrapped_ms = newest_raw_ms   # restart the 64-bit timeline
        residual = arrival_ns - _board_ns(s.last_unwrapped_ms)
        s.offset_ns = residual
        s.window.clear()
        s.window.append((arrival_ns, residual))
        s.locked = True
        if count:
            s.stats.resyncs += 1

    def stamp_packet(self, board_key: str, arrival_ns: int,
                     chunk_ms: List[int]) -> List[int]:
        """Stamp one packet's chunks for one board.

        board_key  stable identity of the source board (source IP)
        arrival_ns receive time of the packet (epoch ns)
        chunk_ms   the packet's chunk timestamps in send order (board uint32
                   millis; may wrap mid-packet)
        Returns one epoch-ns timestamp per chunk, same order as chunk_ms.
        """
        out = [arrival_ns] * len(chunk_ms)
        if not chunk_ms:
            return out

        s = self._boards.setdefault(board_key, _BoardState())
        s.stats.packets += 1

        if self.cfg.mode == MODE_ARRIVAL:
            # Revert switch: historical behaviour, every chunk at arrival time.
            s.stats.locked = False
            return out

        max_gap_ms = self.cfg.max_plausible_gap_s * 1000
        newest_raw = chunk_ms[-1]

        # -- Unwrap the packet's newest chunk against the previous packet -----
        reinitialized = False
        if not s.locked:
            self._resync(s, newest_raw, arrival_ns, count=False)  # first packet
            reinitialized = True
        else:
            step = _forward_step_ms(s.last_raw_ms, newest_raw)
            if step <= max_gap_ms:
                # Continuous (a uint32 wrap lands here too — small modular step).
                s.last_unwrapped_ms += step
                s.last_raw_ms = newest_raw
            else:
                # Implausible forward jump: reboot (millis reset) or a stall
                # longer than max_plausible_gap. The old anchor is useless.
                self._resync(s, newest_raw, arrival_ns, count=True)
                reinitialized = True

        if not reinitialized:
            # -- Offset update: sliding-window minimum of residuals -----------
            residual = arrival_ns - _board_ns(s.last_unwrapped_ms)
            resync_thr_ns = self.cfg.resync_threshold_ms * NS_PER_MS
            if abs(residual - s.offset_ns) > resync_thr_ns:
                # Lost lock: discontinuity that kept a plausible step size.
                self._resync(s, newest_raw, arrival_ns, count=True)
            else:
                s.window.append((arrival_ns, residual))
                window_ns = self.cfg.window_seconds * 1000 * NS_PER_MS
                while s.window and s.window[0][0] + window_ns < arrival_ns:
                    s.window.popleft()
                # Includes the current packet's residual -> offset <= residual,
                # so the newest chunk never stamps past arrival.
                s.offset_ns = min(e[1] for e in s.window)
                # Jitter diagnostic: delivery excess above the floor.
                excess_ms = (residual - s.offset_ns) / NS_PER_MS
                s.stats.jitter_ms += _JITTER_EMA_ALPHA * (excess_ms - s.stats.jitter_ms)

        # -- Stamp every chunk: unwrap within the packet, offset, clamp -------
        # Walk backward from the newest chunk (anchored at last_unwrapped_ms);
        # modular steps make mid-packet wraps exact.
        n = len(chunk_ms)
        unwrapped = [0] * n
        valid = [True] * n
        unwrapped[n - 1] = s.last_unwrapped_ms
        for i in range(n - 2, -1, -1):
            step = _forward_step_ms(chunk_ms[i], chunk_ms[i + 1])
            if step <= max_gap_ms and unwrapped[i + 1] >= step:
                unwrapped[i] = unwrapped[i + 1] - step
                valid[i] = valid[i + 1]
            else:
                # Garbage intra-packet spacing — clamp this and older chunks.
                valid[i] = False

        age_ns = self.cfg.max_batch_age_s * 1000 * NS_PER_MS
        lower = arrival_ns - age_ns

        for i in range(n):
            t = _board_ns(unwrapped[i]) + s.offset_ns
            if not valid[i] or t < lower or t > arrival_ns:
                # Safety clamp: flat arrival time — exactly the pre-sync behaviour.
                t_ns = arrival_ns
                s.stats.clamp_fallbacks += 1
            else:
                t_ns = t
            # Per-board monotonic guard: emitted timestamps never decrease.
            if t_ns < s.last_emitted_ns:
                t_ns = s.last_emitted_ns
            s.last_emitted_ns = t_ns
            out[i] = t_ns

        s.stats.offset_ms = s.offset_ns / NS_PER_MS
        s.stats.locked = s.locked
        return out

    def stats(self, board_key: str) -> BoardStats:
        """Stats for one board (default-constructed if unknown)."""
        st = self._boards.get(board_key)
        return st.stats if st else BoardStats()

    def boards(self) -> List[str]:
        """All boards seen (for periodic diagnostics)."""
        return list(self._boards)


# -----------------------------------------------------------------------------
def _self_test() -> None:
    """Mirrors daq-server/diablo_server/lib/test/test_board_clock_sync.cpp."""
    S = 1_000_000_000  # ns per second

    # -- spreading: chunks keep their true spacing, not the arrival instant ---
    cs = BoardClockSync()
    base = 1_700_000_000 * S
    cs.stamp_packet("a", base, [1000, 1012, 1024, 1036])
    out = cs.stamp_packet("a", base + 50_000_000, [1048, 1060, 1072, 1084])
    gaps = [out[i + 1] - out[i] for i in range(3)]
    assert all(g == 12 * NS_PER_MS for g in gaps), gaps
    assert out[-1] <= base + 50_000_000, "newest chunk must not stamp in the future"

    # -- min filter: a late packet must not drag the offset -------------------
    cs = BoardClockSync()
    for i in range(20):
        cs.stamp_packet("b", base + i * 50_000_000, [1000 + i * 50])
    clean = cs.stats("b").offset_ms
    cs.stamp_packet("b", base + 20 * 50_000_000 + 30_000_000, [2000])  # +30 ms late
    assert abs(cs.stats("b").offset_ms - clean) < 1e-6, "window min moved on a late packet"
    assert cs.stats("b").jitter_ms > 0, "jitter should register the late delivery"

    # -- reboot: implausible forward jump re-anchors and counts a resync ------
    cs = BoardClockSync()
    cs.stamp_packet("c", base, [500_000])
    cs.stamp_packet("c", base + 50_000_000, [10])  # millis() restarted
    assert cs.stats("c").resyncs == 1, cs.stats("c")

    # -- uint32 wrap between packets is seamless, NOT a resync ---------------
    cs = BoardClockSync()
    cs.stamp_packet("d", base, [_UINT32 - 20])
    out = cs.stamp_packet("d", base + 50_000_000, [10])  # wrapped past 2^32
    assert cs.stats("d").resyncs == 0, "a wrap must not count as a resync"
    assert out[0] <= base + 50_000_000

    # -- wrap mid-packet: chunk spacing stays exact across the boundary -------
    cs = BoardClockSync()
    cs.stamp_packet("e", base, [_UINT32 - 100])
    out = cs.stamp_packet("e", base + 50_000_000,
                          [_UINT32 - 24, _UINT32 - 12, _UINT32, 11])
    gaps = [out[i + 1] - out[i] for i in range(3)]
    assert gaps == [12 * NS_PER_MS] * 3, gaps

    # -- monotonic guard: emitted stamps never decrease -----------------------
    cs = BoardClockSync()
    prev = 0
    for i in range(50):
        for t in cs.stamp_packet("f", base + i * 50_000_000,
                                 [1000 + i * 48, 1012 + i * 48]):
            assert t >= prev, "emitted timestamps went backwards"
            prev = t

    # -- multi-board: state is per board_key ---------------------------------
    cs = BoardClockSync()
    cs.stamp_packet("192.168.2.21", base, [1000])
    cs.stamp_packet("192.168.2.22", base, [900_000])
    assert sorted(cs.boards()) == ["192.168.2.21", "192.168.2.22"]
    assert cs.stats("192.168.2.21").offset_ms != cs.stats("192.168.2.22").offset_ms

    # -- arrival mode reproduces the old flat behaviour exactly ---------------
    cs = BoardClockSync(TimeSyncConfig(mode=MODE_ARRIVAL))
    out = cs.stamp_packet("g", base, [1000, 1012, 1024])
    assert out == [base] * 3, out
    assert not cs.stats("g").locked

    # -- invariants hold under adversarial input -----------------------------
    cs = BoardClockSync()
    arrival = base
    board = 5000
    prev = 0
    for i in range(300):
        arrival += 50_000_000 + (i % 7) * 3_000_000      # jittery delivery
        board += 48 + (i % 3)                            # slightly drifting clock
        chunks = [(board + k * 12) & _UINT32 for k in range(4)]
        for t in cs.stamp_packet("h", arrival, chunks):
            assert t <= arrival, "stamped in the future"
            assert t >= arrival - cs.cfg.max_batch_age_s * 1000 * NS_PER_MS, "stamped too old"
            assert t >= prev, "non-monotonic"
            prev = t

    print("clocksync self-test: OK (spreading, min-filter, reboot, wrap, "
          "monotonic, multi-board, arrival mode, invariants)")


if __name__ == "__main__":
    _self_test()

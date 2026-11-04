"""Channel agility and hops, host side: the flight computer's UART protocol
(fc_link), the channel table the mux carries (ts_mux), the ground station's
reader of it (ground/dvbt_hop.py), and a PLL plan for every channel in the
band. The hop itself, end to end, is test/e2e's test_hop_*."""
from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

import pytest

import fwlib
from test_host import APlan
from test_ts_mux import MUX_BYTES, Cfg, dvbt_rate, parse, x264_access_units

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "ground"))
import dvbt_hop  # noqa: E402

FC_HOP, FC_QUERY, FC_BAD_CSUM, FC_BAD_SYNTAX = range(4)


class FcCmd(ctypes.Structure):
    _fields_ = [("kind", ctypes.c_int), ("seq", ctypes.c_uint16), ("khz", ctypes.c_uint32)]


class FcRx(ctypes.Structure):
    _fields_ = [("buf", ctypes.c_char * 96), ("n", ctypes.c_size_t), ("in_line", ctypes.c_bool),
                ("overflow", ctypes.c_bool)]


class Chan(ctypes.Structure):
    _fields_ = [("cur_khz", ctypes.c_uint32), ("next_khz", ctypes.c_uint32), ("seq", ctypes.c_uint16),
                ("pending", ctypes.c_bool), ("hop_t27", ctypes.c_uint64)]


def line(body: str) -> bytes:
    cs = 0
    for c in body.encode():
        cs ^= c
    return f"${body}*{cs:02X}\r\n".encode()


def feed(data: bytes, rx: FcRx | None = None) -> list[tuple[int, int, int]]:
    lib = fwlib.load()
    rx = rx or FcRx()
    out = []
    for b in data:
        c = FcCmd()
        if lib.fc_rx_byte(ctypes.byref(rx), ctypes.c_uint8(b), ctypes.byref(c)):
            out.append((c.kind, c.seq, c.khz))
    return out


# ------------------------------------------------------------ fc_link --
def test_fc_hop_and_query():
    assert feed(line("HOP,7,1255000")) == [(FC_HOP, 7, 1255000)]
    assert feed(line("CH?")) == [(FC_QUERY, 0, 0)]
    # Lower-case checksum, no CR, two lines back to back, noise between them.
    lo = line("HOP,65535,1296500").replace(b"\r", b"").lower().replace(b"$hop", b"$HOP")
    assert feed(b"\x00junk" + lo + b"noise" + line("CH?")) == [(FC_HOP, 65535, 1296500), (FC_QUERY, 0, 0)]


@pytest.mark.parametrize("raw,kind", [
    (b"$HOP,7,1255000*00\r\n", FC_BAD_CSUM),          # wrong checksum
    (b"$HOP,7,1255000\r\n", FC_BAD_CSUM),             # none at all
    (line("HOP,7,1255000").replace(b"1255000", b"1255001"), FC_BAD_CSUM),   # a flipped digit
    (line("HOP,65536,1255000"), FC_BAD_SYNTAX),       # seq above 16 bits
    (line("HOP,7,12x5000"), FC_BAD_SYNTAX),
    (line("HOP,7,"), FC_BAD_SYNTAX),
    (line("HOP,,1255000"), FC_BAD_SYNTAX),
    (line("HOP,7,1255000,9"), FC_BAD_SYNTAX),         # extra field
    (line("HOP 7 1255000"), FC_BAD_SYNTAX),
    (line("RESET"), FC_BAD_SYNTAX),
    (b"$" + b"A" * 200 + b"*00\r\n", FC_BAD_SYNTAX),  # longer than any command
])
def test_fc_rejects(raw, kind):
    got = feed(raw)
    assert len(got) == 1 and got[0][0] == kind, got


def test_fc_dollar_restarts_a_line():
    """A line cut off by a reset of the flight computer, then a whole one:
    the whole one is read, the fragment is not."""
    assert feed(b"$HOP,1,12" + line("HOP,2,1260000")) == [(FC_HOP, 2, 1260000)]


def test_fc_format_round_trips():
    lib = fwlib.load()
    buf = ctypes.create_string_buffer(120)
    n = lib.fc_format(buf, 120, b"ACK,7,1255000,500,123456789")
    assert buf.value == line("ACK,7,1255000,500,123456789") and n == len(buf.value)
    assert lib.fc_format(buf, 10, b"ACK,7,1255000,500,123456789") == 0      # does not fit: nothing


# ------------------------------------------------------ channel table --
def mux_with_hops(aus, keys, events, seconds):
    """Mux real H.264 with the channel table on; events: {packet: Chan}."""
    lib = fwlib.load()
    rate = dvbt_rate()
    ring = (ctypes.c_uint8 * (1 << 20))()
    cfg = Cfg(rate.numerator, rate.denominator, 1, 1, 1, 0x1000, 0x100, b"STAR", b"N0CALL", 0, 0, 0,
              ctypes.cast(ring, ctypes.POINTER(ctypes.c_uint8)), len(ring), dvbt_hop.HOP_PID, 0)
    m = ctypes.create_string_buffer(MUX_BYTES)
    lib.ts_mux_init(m, ctypes.byref(cfg))
    lib.ts_mux_now_90k.restype = ctypes.c_uint64
    lib.ts_mux_now_27.restype = ctypes.c_uint64
    pkt_time = Fraction(188 * 8) / rate
    out, pkt, fi = bytearray(), (ctypes.c_uint8 * 188)(), 0
    for n in range(int(seconds / pkt_time)):
        if n in events:
            c = events[n](lib.ts_mux_now_27(m))
            lib.ts_mux_set_chan(m, ctypes.byref(c))
        while fi < len(aus) and Fraction(fi, 30) <= n * pkt_time:
            lib.ts_mux_put(m, aus[fi], len(aus[fi]), ctypes.c_uint64(lib.ts_mux_now_90k(m) + 45000), keys[fi])
            fi += 1
        lib.ts_mux_next(m, pkt)
        out += bytes(pkt)
    return bytes(out), rate


@pytest.mark.skipif(not shutil.which("ffmpeg") and not os.environ.get("DVBT_REQUIRE_TOOLS"),
                    reason="needs ffmpeg/ffprobe")
def test_channel_table_in_a_real_stream():
    """The table every 100 ms, at once on a change, CRC good, fields as set;
    and a decoder still sees a clean stream (the PMT does not list it)."""
    tmp = Path(tempfile.mkdtemp())
    aus, keys = x264_access_units(tmp, seconds=2)
    rate = dvbt_rate()
    pkt_t = Fraction(188 * 8) / rate
    at = int(Fraction(1) / pkt_t)                       # 1 s in
    hop_t27 = {}

    def pending(now27):
        hop_t27["t"] = now27 + 500 * 27000
        return Chan(1279000, 1255000, 7, True, hop_t27["t"])

    ts, _ = mux_with_hops(aus, keys, {0: lambda now: Chan(1279000, 1279000, 0, False, 0), at: pending}, 2.5)
    out = tmp / "out.ts"
    out.write_bytes(ts)

    tabs = dvbt_hop.tables(ts)
    before = [(n, t) for n, t in tabs if n < at]
    after = [(n, t) for n, t in tabs if n >= at]
    assert before and all(not t.pending and t.current_khz == t.next_khz == 1279000 for _, t in before)
    gaps = [(b - a) * pkt_t for (a, _), (b, _) in zip(before, before[1:])]
    assert max(gaps) <= Fraction(105, 1000) and min(gaps) >= Fraction(95, 1000), [float(g) for g in gaps]
    n0, t0 = after[0]
    assert n0 - at <= 1, "a change goes out in the next slot"
    assert (t0.pending, t0.seq, t0.current_khz, t0.next_khz) == (True, 7, 1279000, 1255000)
    assert t0.hop_pcr == hop_t27["t"] % dvbt_hop.PCR_WRAP
    assert t0.version != before[-1][1].version

    pkts, pids, pcrs, pts, cc_err = parse(ts)
    assert cc_err == 0
    pr = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_programs", "-count_frames", "-of", "json",
                                    str(out)], capture_output=True, text=True, check=True).stdout)
    assert [s["codec_name"] for s in pr["programs"][0]["streams"]] == ["h264"]
    dec = subprocess.run(["ffmpeg", "-v", "warning", "-i", str(out), "-f", "null", "-"], capture_output=True, text=True)
    assert dec.returncode == 0 and dec.stderr.strip() == "", dec.stderr[-2000:]


def test_table_crc_is_checked():
    ts, _ = mux_with_hops([], [], {0: lambda now: Chan(1279000, 1279000, 0, False, 0)}, 0.15)
    i = next(n for n, _ in dvbt_hop.tables(ts))
    p = bytearray(ts[i * 188:(i + 1) * 188])
    assert dvbt_hop.parse_table(bytes(p))
    p[5 + p[4] + 14] ^= 0x01                            # one bit of current_khz
    assert dvbt_hop.parse_table(bytes(p)) is None


# ---------------------------------------------------- ground follower --
def test_follower_retunes_at_the_announced_time():
    """Armed only by a pending table; retunes once the received PCR reaches
    the hop (less its margin); lost lock after the table also retunes."""
    rate = dvbt_rate()
    pkt_t = Fraction(188 * 8) / rate
    at = int(Fraction(1, 5) / pkt_t)
    ts, _ = mux_with_hops([], [], {0: lambda now: Chan(1279000, 1279000, 0, False, 0),
                                   at: lambda now: Chan(1279000, 1255000, 3, True, now + 300 * 27000)}, 0.8)
    f = dvbt_hop.Follower(1279000, [1279000, 1255000, 1265000])
    hits = [(i, k) for i, k in ((i, f.feed(ts[i * 188:(i + 1) * 188])) for i in range(len(ts) // 188)) if k]
    assert len(hits) == 1 and hits[0][1] == 1255000, hits
    t_hit = hits[0][0] * pkt_t - at * pkt_t
    # hop at +300 ms less the 100 ms margin, seen on the first PCR after (20 ms apart)
    assert Fraction(200, 1000) <= t_hit <= Fraction(221, 1000), float(t_hit)
    g = dvbt_hop.Follower(1279000, [1279000, 1255000])
    assert g.lost_lock() is None, "no table: a lost lock is not a hop"
    for i in range(at + 2):
        g.feed(ts[i * 188:(i + 1) * 188])
    assert g.lost_lock() == 1255000 and g.hunt_list() == [1255000, 1279000]


# --------------------------------------------------------- PLL plans --
def test_every_channel_in_the_band_has_a_plan():
    """Every 125 kHz from 1243.5 to 1296.5 MHz, from the 40 MHz TCXO at its
    5 ppm (the flight configuration): a plan, within 1 Hz, PFD <= 40 MHz at
    the fast end, VCO inside 2310-4800 MHz, RFDIV 0 (Table 6)."""
    lib = fwlib.load()
    for khz in range(1243500, 1296501, 125):
        p = APlan()
        assert lib.adrf6755_plan_tol(ctypes.c_uint32(40_000_000), ctypes.c_uint32(5), ctypes.c_uint64(khz * 1000),
                                     ctypes.byref(p)), khz
        assert abs(p.lo_hz - khz * 1e3) < 1.0, (khz, p.lo_hz)
        assert p.pfd_hz * (1 + 5e-6) <= 40e6
        assert 2310e6 <= p.lo_hz * 2 * (1 << p.rfdiv) <= 4800e6 and p.rfdiv == 0

"""The TS muxer (components/ts_mux) checked with independent tools: real
H.264 from x264 in, ffprobe and ffmpeg's decoder on what comes out, and the
stream's timing parsed against the DVB-T channel rate."""
from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

import pytest

import fwlib

# CI sets DVBT_REQUIRE_TOOLS so a missing ffmpeg fails the job instead of skipping it green.
pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg") and not os.environ.get("DVBT_REQUIRE_TOOLS"),
                                reason="needs ffmpeg/ffprobe")


class Cfg(ctypes.Structure):
    _fields_ = [("rate_num", ctypes.c_uint64), ("rate_den", ctypes.c_uint64),
                ("tsid", ctypes.c_uint16), ("onid", ctypes.c_uint16), ("program", ctypes.c_uint16),
                ("pmt_pid", ctypes.c_uint16), ("video_pid", ctypes.c_uint16),
                ("provider", ctypes.c_char_p), ("service", ctypes.c_char_p),
                ("pat_ms", ctypes.c_uint32), ("sdt_ms", ctypes.c_uint32), ("pcr_ms", ctypes.c_uint32),
                ("buf", ctypes.POINTER(ctypes.c_uint8)), ("buf_size", ctypes.c_size_t)]


MUX_BYTES = 16384      # comfortably larger than ts_mux_t


def dvbt_rate(bw=6, mod=0, rate=0, guard=2):
    n, d = ctypes.c_uint64(), ctypes.c_uint64()
    fwlib.load().ts_dvbt_rate(bw, mod, rate, guard, ctypes.byref(n), ctypes.byref(d))
    return Fraction(n.value, d.value)


def test_dvbt_rate_matches_en300744():
    """EN 300 744 Annex A: 6 MHz, QPSK 1/2, guard 1/8 -> 4.15 Mbit/s;
    8 MHz 64QAM 7/8 1/32 -> 31.67 Mbit/s (the table's corner values)."""
    assert abs(float(dvbt_rate(6, 0, 0, 2)) - 4.147e6) < 1e3
    assert abs(float(dvbt_rate(8, 2, 4, 0)) - 31.67e6) < 0.01e6
    assert abs(float(dvbt_rate(8, 0, 0, 3)) - 4.98e6) < 0.01e6
    # exact: 1512 * 2 * 1/2 * 188/204 per 336 us symbol
    assert dvbt_rate(6, 0, 0, 2) == Fraction(1512 * 188, 204) / Fraction(336, 1_000_000)


def x264_access_units(tmp: Path, seconds=4, kbps=3300):
    raw = tmp / "v.h264"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30",
                    "-t", str(seconds), "-c:v", "libx264", "-preset", "veryfast", "-bf", "0",
                    "-g", "30", "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k", "-bufsize", f"{kbps // 2}k",
                    "-x264-params", "aud=1:nal-hrd=none", "-pix_fmt", "yuv420p", str(raw)], check=True)
    data = raw.read_bytes()
    aud = b"\x00\x00\x00\x01\x09"
    starts = []
    i = data.find(aud)
    while i >= 0:
        starts.append(i)
        i = data.find(aud, i + 1)
    aus = [data[a:b] for a, b in zip(starts, starts[1:] + [len(data)])]
    def nal_types(au):
        i = au.find(b"\x00\x00\x01")
        while i >= 0:
            yield au[i + 3] & 0x1F
            i = au.find(b"\x00\x00\x01", i + 3)
    keys = [5 in set(nal_types(au)) for au in aus]          # IDR slice
    return aus, keys


def mux(aus, keys, service=b"N0CALL", delay_90k=45000, extra_s=1.0):
    lib = fwlib.load()
    rate = dvbt_rate()
    ring = (ctypes.c_uint8 * (1 << 20))()
    cfg = Cfg(rate.numerator, rate.denominator, 1, 1, 1, 0x1000, 0x100, b"STAR", service, 0, 0, 0,
              ctypes.cast(ring, ctypes.POINTER(ctypes.c_uint8)), len(ring))
    m = ctypes.create_string_buffer(MUX_BYTES)
    lib.ts_mux_init(m, ctypes.byref(cfg))
    lib.ts_mux_now_90k.restype = ctypes.c_uint64
    out = bytearray()
    pkt = (ctypes.c_uint8 * 188)()
    pkt_time = Fraction(188 * 8) / rate
    n_pkts = int((len(aus) / 30 + extra_s) / pkt_time)
    fi = 0
    for n in range(n_pkts):
        t = n * pkt_time
        while fi < len(aus) and Fraction(fi, 30) <= t:     # camera delivers a frame every 1/30 s
            now = lib.ts_mux_now_90k(m)
            ok = lib.ts_mux_put(m, aus[fi], len(aus[fi]), ctypes.c_uint64(now + delay_90k), keys[fi])
            assert ok, f"frame {fi} did not fit"
            fi += 1
        lib.ts_mux_next(m, pkt)
        out += bytes(pkt)
    return bytes(out), rate


def parse(ts: bytes):
    """Minimal TS walk: per-PID packet times, PCRs, PES PTS, CC errors."""
    pkts = [ts[i:i + 188] for i in range(0, len(ts), 188)]
    seen, pcrs, pts, cc_err, pids = {}, [], [], 0, {}
    for n, p in enumerate(pkts):
        assert p[0] == 0x47, f"sync lost at packet {n}"
        pid = ((p[1] & 0x1F) << 8) | p[2]
        afc, cc = (p[3] >> 4) & 3, p[3] & 15
        pids.setdefault(pid, []).append(n)
        if pid != 0x1FFF and pid in seen:
            # payload: +1; adaptation field only: the same value again
            want = (seen[pid] + 1) % 16 if afc & 1 else seen[pid]
            cc_err += cc != want
        if pid != 0x1FFF:
            seen[pid] = cc
        o = 4
        if afc & 2:
            alen = p[4]
            if alen and p[5] & 0x10:
                b = p[6:12]
                base = (b[0] << 25) | (b[1] << 17) | (b[2] << 9) | (b[3] << 1) | (b[4] >> 7)
                ext = ((b[4] & 1) << 8) | b[5]
                pcrs.append((n, base * 300 + ext))
            o = 5 + alen
        if afc & 1 and p[1] & 0x40 and pid == 0x100:
            h = p[o:o + 14]
            assert h[:4] == b"\x00\x00\x01\xe0", "PES start"
            v = (((h[9] >> 1) & 7) << 30) | (h[10] << 22) | ((h[11] >> 1) << 15) | (h[12] << 7) | (h[13] >> 1)
            pts.append((n, v))
    return pkts, pids, pcrs, pts, cc_err


def test_mux_with_real_h264():
    tmp = Path(tempfile.mkdtemp())
    aus, keys = x264_access_units(tmp)
    assert len(aus) == 120 and keys[0]
    ts, rate = mux(aus, keys)
    out = tmp / "out.ts"
    out.write_bytes(ts)

    # 1. ffprobe: one program, H.264 1080p, the service name, every frame.
    pr = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_programs", "-show_streams",
                                    "-count_frames", "-of", "json", str(out)],
                                   capture_output=True, text=True, check=True).stdout)
    prog = pr["programs"][0]
    assert prog["tags"]["service_name"] == "N0CALL" and prog["tags"]["service_provider"] == "STAR"
    st = prog["streams"][0]
    assert (st["codec_name"], st["width"], st["height"]) == ("h264", 1920, 1080)
    assert int(st["nb_read_frames"]) == len(aus), f"{st['nb_read_frames']} frames decoded of {len(aus)}"

    # 2. ffmpeg's decoder and TS demuxer: no errors or warnings at all.
    dec = subprocess.run(["ffmpeg", "-v", "warning", "-i", str(out), "-f", "null", "-"],
                         capture_output=True, text=True)
    assert dec.returncode == 0 and dec.stderr.strip() == "", dec.stderr[-2000:]

    # 3. Timing against the channel rate.
    pkts, pids, pcrs, pts, cc_err = parse(ts)
    assert cc_err == 0, f"{cc_err} continuity errors"
    pkt_t = Fraction(188 * 8) / rate
    assert set(pids) <= {0x0000, 0x0011, 0x1000, 0x0100, 0x1FFF}
    for pid, limit_ms in ((0x0000, 100), (0x1000, 100), (0x0011, 2000)):
        gaps = [(b - a) * pkt_t for a, b in zip(pids[pid], pids[pid][1:])]
        assert max(gaps) <= Fraction(limit_ms, 1000) * Fraction(105, 100), f"PID {pid:#x} gap {float(max(gaps))*1e3:.1f} ms"
    pcr_gaps = [Fraction(b - a, 27_000_000) for (_, a), (_, b) in zip(pcrs, pcrs[1:])]
    assert max(pcr_gaps) <= Fraction(40, 1000), f"PCR gap {float(max(pcr_gaps))*1e3:.1f} ms"
    for n, v in pcrs:                                     # PCR = arrival time of byte 10
        want = (n * 188 + 10) * 8 * 27_000_000 / rate
        assert abs(v - want) <= 1, f"PCR at packet {n}: {v} vs {float(want)}"
    pcr_at = dict(pcrs)
    for n, p in pts:                                      # every frame decodable on time
        clock = (n * 188) * 8 * 90_000 / rate
        assert p > clock, f"PTS {p} behind the clock {float(clock)} at packet {n}"
    nulls = len(pids.get(0x1FFF, []))
    print(f"{len(pkts)} packets, {nulls} null ({100*nulls/len(pkts):.0f}%), {len(pcrs)} PCRs")


def test_idle_stream_is_valid():
    """No video at all: PAT/PMT/SDT, PCR-only packets and nulls, still a valid
    constant-rate stream (what goes out before the camera starts)."""
    ts, rate = mux([], [], extra_s=1.0)
    pkts, pids, pcrs, pts, cc_err = parse(ts)
    assert not pts and cc_err == 0 and len(pcrs) >= 45
    assert len(pids[0x1FFF]) > 0.9 * len(pkts)


def test_idr_detection_matches_x264():
    """video_src flags key frames with h264_au_is_idr: it must agree with the
    NAL types x264 wrote (one IDR per 30-frame GOP)."""
    tmp = Path(tempfile.mkdtemp())
    aus, keys = x264_access_units(tmp, seconds=3)
    lib = fwlib.load()
    lib.h264_au_is_idr.restype = ctypes.c_bool
    got = [lib.h264_au_is_idr(au, len(au)) for au in aus]
    assert got == keys and sum(got) == 3 and got[0] and got[30] and got[60]


def test_skip_keeps_pcr_on_the_air_timeline():
    """The FPGA inserts nulls when the P4 falls behind; after ts_mux_skip(n)
    the PCRs again equal the packets' true arrival times on air (within the
    tick), as if the mux had made those nulls itself. Without the skip they
    stay n packets late for good."""
    lib = fwlib.load()
    rate = dvbt_rate()
    null = b"\x47\x1f\xff\x10" + bytes(184)

    def stream(skip: bool):
        ring = (ctypes.c_uint8 * (1 << 16))()
        cfg = Cfg(rate.numerator, rate.denominator, 1, 1, 1, 0x1000, 0x100, b"STAR", b"N0CALL", 0, 0, 0,
                  ctypes.cast(ring, ctypes.POINTER(ctypes.c_uint8)), len(ring))
        m = ctypes.create_string_buffer(MUX_BYTES)
        lib.ts_mux_init(m, ctypes.byref(cfg))
        pkt = (ctypes.c_uint8 * 188)()
        air = bytearray()
        for n in range(3000):
            if n == 1000:                     # a stall: the FPGA sends 47 nulls of its own
                air += null * 47
                if skip:
                    lib.ts_mux_skip(m, ctypes.c_uint64(47))
            lib.ts_mux_next(m, pkt)
            air += bytes(pkt)
        return bytes(air)

    for skip in (True, False):
        _, _, pcrs, _, _ = parse(stream(skip))
        late = [n for n, v in pcrs if n > 1100 and abs(v - (n * 188 + 10) * 8 * 27_000_000 / rate) > 1]
        if skip:
            assert not late, f"PCR off the air timeline at packets {late[:5]}"
        else:
            assert late, "control: without the skip the PCRs must be late"

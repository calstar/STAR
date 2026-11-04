"""End-to-end test: the firmware that flies, the FPGA's RTL, chip models,
then a receiver.

    cd firmware/DVBT_Video_TX/test/e2e && /usr/bin/python3.12 -m pytest -q -n 4 test_e2e.py

python3.12 because Ubuntu's gnuradio bindings (the receiver) are built for
it. Each test runs the harness (e2e.cpp: tx_app and every driver, compiled
for the host, against the Verilated dvbt_tx_top and the Si5351A, ECP5,
AD9116 and ADRF6755 models), demodulates what left the DAC with gr-dtv's
DVB-T receiver, and checks the result:

  * no model violations: every register, pin and protocol rule the
    datasheets state, from the Si5351A's SYS_INIT to the ADRF6755's
    "modulator on only after lock";
  * the clocks, LO and DAC format as programmed (decoded from the models'
    registers, not taken from the firmware);
  * the received transport stream equals what the firmware handed the
    FPGA, packet for packet (the FPGA's own null packets aside);
  * the received stream as a viewer gets it: ffprobe finds the service
    named after the callsign with 1920x1080 H.264, ffmpeg decodes it with
    no errors, and its PCR and PTS hold the timing a receiver needs.

Fault scenarios inject what a flight can throw at the board -- no FPGA
image, a corrupt one, the wrong bitstream, the LO losing lock, the FPGA
losing its configuration, the P4 stalling -- and check the firmware's
fallback or recovery end to end.
"""
from __future__ import annotations

import json
import os
import random
import re
import shutil
import subprocess
import sys
import zlib
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "model"))
sys.path.insert(0, str(ROOT / "esp32p4/tools"))
sys.path.insert(0, str(ROOT / "esp32p4/test/host"))
sys.path.insert(0, str(ROOT / "ground"))

import build  # noqa: E402
import make_fpga_image  # noqa: E402

# CI sets DVBT_REQUIRE_TOOLS so a missing tool fails the job instead of skipping it green.
pytestmark = pytest.mark.skipif((not shutil.which("verilator") or not shutil.which("ffmpeg"))
                                and not os.environ.get("DVBT_REQUIRE_TOOLS"),
                                reason="needs verilator and ffmpeg")

RATE = Fraction(1512 * 188 * 8, 204 * 8) / Fraction(336, 1_000_000)      # QPSK 1/2, 1/8, 6 MHz
CALLSIGN = "N0CALL"
F_NOT_NULLS = 0x1EF                                                        # every fault bit but NULLS
F_NULLS, F_FPGA_LOST, F_LO_UNLOCK = 1 << 4, 1 << 5, 1 << 6


# ------------------------------------------------------------------ fixtures --
@pytest.fixture(scope="session")
def harness(tmp_path_factory):
    return build.build()


@pytest.fixture(scope="session")
def bitstream(tmp_path_factory):
    return make_bitstream(tmp_path_factory.mktemp("fpga"))


def make_bitstream(d: Path):
    """A stand-in bitstream the size of the LFE5U-25F's (the ECP5 model only
    checks it arrives intact), its image, and a valid image of another one."""
    bit = random.Random(7).randbytes(579_000)
    other = random.Random(8).randbytes(579_000)
    (d / "fpga.img").write_bytes(make_fpga_image.make(bit))
    bad = bytearray(make_fpga_image.make(bit))
    bad[5000] ^= 0x10
    (d / "corrupt.img").write_bytes(bytes(bad))
    (d / "other.img").write_bytes(make_fpga_image.make(other))
    return d, zlib.crc32(bit) & 0xFFFFFFFF


@pytest.fixture(scope="session")
def video(tmp_path_factory):
    return make_video(tmp_path_factory.mktemp("video"))


def make_video(d: Path, seconds: int = 2) -> Path:
    """1080p30 H.264 as the P4's encoder makes it (GOP 30, no B-frames,
    3.3 Mbit/s), one access unit per frame without access-unit delimiters
    (the muxer must add them)."""
    raw = d / "v.h264"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
                    "-t", str(seconds), "-c:v", "libx264", "-preset", "veryfast", "-bf", "0", "-g", "30",
                    "-b:v", "3300k", "-maxrate", "3300k", "-bufsize", "1650k",
                    "-x264-params", "aud=1:nal-hrd=none", "-pix_fmt", "yuv420p", str(raw)], check=True)
    data = raw.read_bytes()
    aud = b"\x00\x00\x00\x01\x09\xf0"
    starts = [m.start() for m in re.finditer(re.escape(aud[:5]), data)]
    out = bytearray()
    for a, b in zip(starts, starts[1:] + [len(data)]):
        au = data[a + 6:b]                                    # drop the AUD NAL
        key = b"\x00\x00\x01\x65" in au or b"\x00\x00\x00\x01\x65" in au or b"\x00\x00\x01\x25" in au
        out += len(au).to_bytes(4, "little") + bytes([key]) + au
    (d / "aus.bin").write_bytes(bytes(out))
    return d / "aus.bin"


# ------------------------------------------------------------------- helpers --
def run(harness, out: Path, *args, timeout=3600) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    p = subprocess.run([str(harness), "--out", str(out), *map(str, args)], capture_output=True, text=True,
                       timeout=timeout)
    (out / "stderr.txt").write_text(p.stderr)
    assert p.returncode == 0, p.stderr[-3000:]
    rep = json.loads((out / "report.json").read_text())
    rep["_events"] = [(float(m.group(1)), m.group(2)) for e in rep["events"]
                      for m in [re.match(r"\[([\d.]+) s\] (.*)", e)] if m]
    return rep


def demodulate(out: Path, rep: dict | None = None, khz: int | None = None, start_s: float = 0.0,
               name: str = "rx.ts") -> bytes:
    """What a receiver tuned to 1279 MHz gets: the DAC's I/Q at 27.43 MS/s,
    filtered and decimated to the DVB-T sample rate, through gr-dtv.
    With khz: a receiver tuned to that channel, so only the samples the
    transmitter sent on it (report's rf_segments), from start_s on (when the
    ground retuned to it)."""
    from scipy import signal
    import dvbt_rx
    iq = np.fromfile(out / "rf.iq", np.int16).reshape(-1, 2).astype(np.float32)
    x = iq[:, 0] + 1j * iq[:, 1]
    if khz is not None:
        keep = np.zeros(len(x), bool)
        segs = rep["rf_segments"] + [[len(x), 0, 0, 0]]
        for (a, t, on, lo), (b, *_rest) in zip(segs, segs[1:]):
            if on and abs(lo - khz * 1e3) < 1:
                keep[a:b] = True
        x = np.where(keep, x, 0)
        t0 = rep["rf_segments"][0][1]
        x = x[max(0, int((start_s - t0) * rep["dac_rate_hz"])):]
    taps = signal.firwin(801, 3.2, window=("kaiser", 10), fs=4 * 48 / 7) * 4
    y = signal.resample_poly(x, 1, 4, window=taps)
    ts = dvbt_rx.receive(y)
    (out / name).write_bytes(ts)
    return ts


def packets(ts: bytes) -> list[bytes]:
    return [ts[i:i + 188] for i in range(0, len(ts) - 187, 188)]


def pid(p: bytes) -> int:
    return ((p[1] & 0x1F) << 8) | p[2]


def match(rx: bytes, sent: bytes, window: int = 4000) -> tuple[int, int, list[int]]:
    """Walk the received packets through what the firmware sent (null
    packets dropped from both: the FPGA inserts its own when it runs dry).
    Returns (matched, unmatched, where): where[i] is the matched packet's
    index among the sent non-null packets; where.full[i] its index in the
    whole sent stream (x 1504 bits / rate = when it entered the FPGA)."""
    allp = packets(sent)
    keep = [i for i, p in enumerate(allp) if pid(p) != 0x1FFF]
    s = [allp[i] for i in keep]
    r = [p for p in packets(rx) if pid(p) != 0x1FFF]
    pos, ok, bad, where = 0, 0, 0, []
    for p in r:
        k = next((j for j in range(pos, min(len(s), pos + window)) if s[j] == p), None)
        if k is None:
            bad += 1
            continue
        ok += 1
        where.append(k)
        pos = k + 1
    where = Where(where)
    where.full = [keep[k] for k in where]
    return ok, bad, where


class Where(list):
    full: list[int]


def common_checks(rep: dict, via: int = 1) -> None:
    assert rep["violations"] == [], "\n".join(rep["violations"])
    assert rep["bringup_err"] == 0
    assert rep["fpga_via"] == via, rep["fpga_via"]
    assert abs(rep["clk0_hz"] - 192e6 / 7) < 0.01 and abs(rep["clk1_hz"] - rep["clk0_hz"]) < 1e-6
    assert abs(rep["lo_hz"] - 1279e6) < 1.0, rep["lo_hz"]          # Equation 2, from the registers
    assert 2310e6 <= rep["vco_hz"] <= 4800e6
    # The DAC decodes what the FPGA sends: two's complement, I on the rising edge, I first.
    assert (rep["dac_twos"], rep["dac_irising"], rep["dac_ifirst"], rep["dac_searching"]) == (1, 1, 1, 0)
    assert rep["rf_while_dac_off"] == 0


def ts_timing(ts: bytes) -> dict:
    """PCR against the packet count (the channel rate), PTS ahead of the
    clock, continuity: as a set-top box would need them."""
    from test_ts_mux import parse
    pkts, pids, pcrs, pts, cc_err = parse(ts)
    assert cc_err == 0, f"{cc_err} continuity errors in the received stream"
    for (na, a), (nb, b) in zip(pcrs, pcrs[1:]):
        want = (nb - na) * 188 * 8 * 27_000_000 / RATE
        assert abs((b - a) - want) <= 2, f"PCR step {b - a} over {nb - na} packets, want {float(want)}"
        assert (b - a) / 27e6 <= 0.040, "PCR gap above 40 ms"
    if pcrs:
        n0, v0 = pcrs[0]
        for n, p in pts:
            clock = (v0 + (n - n0) * 188 * 8 * 27_000_000 / RATE) / 300
            assert p > clock, f"PTS {p} behind the clock at packet {n}: frame would be late"
    return {"pcrs": len(pcrs), "pts": len(pts), "pids": sorted(pids)}


def viewer(ts_path: Path, sdt: bool = True) -> dict:
    """What ffprobe makes of the received stream. The SDT (service name)
    goes out once a second, so only runs longer than that carry one."""
    pr = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_programs", "-show_streams",
                                    "-count_frames", "-of", "json", str(ts_path)],
                                   capture_output=True, text=True, check=True).stdout)
    assert pr["programs"], "no PAT/PMT received"
    prog = pr["programs"][0]
    assert prog["pmt_pid"] == 0x1000 and prog["pcr_pid"] == 0x100, prog
    if sdt:
        assert prog["tags"]["service_name"] == CALLSIGN and prog["tags"]["service_provider"] == "STAR"
    st = prog["streams"][0] if prog["streams"] else {}
    return st


def complete_frames(ts: bytes) -> bytes:
    """The stream up to the last video PES start: the run stops wherever it
    stops, usually mid-frame, and a frame cut off by the end of the capture
    is not a transmitter fault."""
    pk = packets(ts)
    last = max(i for i, p in enumerate(pk) if pid(p) == 0x100 and p[1] & 0x40)
    return b"".join(pk[:last])


def events(rep, text):
    return [t for t, e in rep["_events"] if text in e]


# --------------------------------------------------------------------- tests --
@pytest.mark.slow
def test_boot_to_video(harness, bitstream, video, tmp_path):
    """Power-up to 1080p on a receiver: the whole flight path, clean."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--aus", video,
              "--air-ms", 1250, "--video-start-ms", 150)
    common_checks(rep)
    assert rep["faults"] & F_NOT_NULLS == 0 and rep["recoveries"] == 0, hex(rep["faults"])
    assert rep["nulls"] == 0, "the FPGA had to insert nulls: the P4 fell behind"
    assert rep["frames_dropped"] == 0 and rep["frames_put"] >= 25
    assert rep["rf_unlocked_max_s"] == 0, "RF out with the LO unlocked"
    t_ldet, t_rf = events(rep, "LDET high")[0], events(rep, "TXDIS low")[0]
    assert t_rf > t_ldet, "RF on before the PLL locked"
    assert rep["t_bringup_s"] - 0.3 < 0.5, "bring-up slower than 0.5 s"

    rx = demodulate(tmp_path)
    ok, bad, where = match(rx, (tmp_path / "sent.ts").read_bytes())
    assert bad == 0, f"{bad} received packets differ from what the firmware sent ({ok} match)"
    assert ok > 1500, f"only {ok} packets received"
    assert all(b == a + 1 for a, b in zip(where, where[1:])), "packets lost between the P4 and the air"
    tim = ts_timing(rx)
    assert tim["pts"] >= 15, tim

    st = viewer(tmp_path / "rx.ts")
    assert (st["codec_name"], st["width"], st["height"]) == ("h264", 1920, 1080), st
    assert int(st["nb_read_frames"]) >= 15, st["nb_read_frames"]
    (tmp_path / "rx_complete.ts").write_bytes(complete_frames(rx))
    dec = subprocess.run(["ffmpeg", "-v", "warning", "-i", str(tmp_path / "rx_complete.ts"), "-f", "null", "-"],
                         capture_output=True, text=True)
    assert dec.returncode == 0 and dec.stderr.strip() == "", dec.stderr[-2000:]


def test_no_image_boots_from_flash(harness, bitstream, video, tmp_path):
    """Empty partition: the FPGA boots from its W25Q32 and the link works."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--good-crc", f"{crc:08x}", "--aus", video, "--air-ms", 300)
    common_checks(rep, via=2)
    assert rep["fpga_sspi_err"] == 0x105                       # ESP_ERR_NOT_FOUND
    rx = demodulate(tmp_path)
    ok, bad, _ = match(rx, (tmp_path / "sent.ts").read_bytes())
    assert bad == 0 and ok > 150, (ok, bad)
    ts_timing(rx)
    viewer(tmp_path / "rx.ts", sdt=False)


def test_corrupt_image_boots_from_flash(harness, bitstream, tmp_path):
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "corrupt.img", "--good-crc", f"{crc:08x}", "--air-ms", 30)
    common_checks(rep, via=2)
    assert rep["fpga_sspi_err"] == 0x109                       # ESP_ERR_INVALID_CRC, before any SPI
    assert not events(rep, "ECP5 loaded"), "a corrupt image must not reach the FPGA"


def test_rejected_bitstream_boots_from_flash(harness, bitstream, tmp_path):
    """A valid image of a bitstream the FPGA rejects (status FAIL)."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "other.img", "--good-crc", f"{crc:08x}", "--air-ms", 30)
    common_checks(rep, via=2)
    assert rep["fpga_sspi_err"] == 0x109
    assert events(rep, "wrong CRC") or events(rep, "master-SPI boot")


def test_nothing_boots_keeps_rf_off(harness, bitstream, tmp_path):
    d, crc = bitstream
    rep = run(harness, tmp_path, "--good-crc", f"{crc:08x}", "--no-flash", "--air-ms", 10)
    assert rep["bringup_err"] != 0 and rep["rf_samples"] == 0
    assert not events(rep, "TXDIS low"), "RF must stay off when the FPGA never configures"
    assert rep["violations"] == [], rep["violations"]


def test_pll_never_locks_keeps_rf_off(harness, bitstream, tmp_path):
    """The ADRF6755's PLL never locks (a dead loop filter, a bad TCXO):
    bring-up must stop with the RF never on, not transmit off-frequency."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--pll-broken",
              "--air-ms", 10)
    assert rep["bringup_err"] == 0x107, hex(rep["bringup_err"])          # ESP_ERR_TIMEOUT
    assert rep["rf_samples"] == 0 and not events(rep, "TXDIS low")
    assert rep["violations"] == [], rep["violations"]


@pytest.mark.slow
def test_lo_unlock_recovers(harness, bitstream, video, tmp_path):
    """The LO loses lock in flight (the VCO drifts out of its band): RF off
    within one health period, relock, back on air, and the receiver picks
    the stream up again."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--aus", video,
              "--air-ms", 500, "--health-ms", 10, "--inject-ldet", 200)
    common_checks(rep)
    assert rep["faults"] & F_LO_UNLOCK and rep["recoveries"] == 1, (hex(rep["faults"]), rep["recoveries"])
    assert rep["rf_unlocked_max_s"] <= 0.010 + 0.001, f"RF unlocked for {rep['rf_unlocked_max_s']*1e3:.1f} ms"
    t_inj = events(rep, "loses lock")[0]
    t_off = [t for t in events(rep, "TXDIS high") if t >= t_inj][0]
    t_on = [t for t in events(rep, "TXDIS low") if t >= t_off][0]
    assert t_off - t_inj <= 0.011 and t_on - t_off < 0.001, (t_inj, t_off, t_on)   # relock ~170 us
    rx = demodulate(tmp_path)
    ok, bad, where = match(rx, (tmp_path / "sent.ts").read_bytes())
    assert ok > 400, (ok, bad)
    sent_t = 188 * 8 / float(RATE)
    t_up = rep["t_bringup_s"]
    assert max(where.full) * sent_t > t_inj - t_up + 0.05, "nothing received after the recovery"


@pytest.mark.slow
def test_fpga_loss_recovers(harness, bitstream, video, tmp_path):
    """The FPGA loses its configuration (e.g. a brownout on its rail): the
    health check sees the ID register wrong, turns RF off, reloads the FPGA
    over slave SPI, re-primes and goes back on air."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--aus", video,
              "--air-ms", 800, "--health-ms", 10, "--inject-fpga", 150)
    common_checks(rep)
    assert rep["faults"] & F_FPGA_LOST and rep["recoveries"] == 1, (hex(rep["faults"]), rep["recoveries"])
    assert rep["fpga_loads"] == 2
    t_lost = events(rep, "FPGA loses")[0]
    t_off = [t for t in events(rep, "TXDIS high") if t >= t_lost][0]
    assert t_off - t_lost <= 0.011, "RF stayed on with the FPGA down"
    t_back = [t for t in events(rep, "TXDIS low") if t > t_off]
    assert t_back, "never back on air"
    rx = demodulate(tmp_path)
    ok, bad, where = match(rx, (tmp_path / "sent.ts").read_bytes())
    assert ok > 300, (ok, bad)
    sent_t = 188 * 8 / float(RATE)
    assert max(where.full) * sent_t > t_back[0] - rep["t_bringup_s"] + 0.05, "nothing received after the reload"


@pytest.mark.slow
def test_p4_stall_longer_than_fifo(harness, bitstream, video, tmp_path):
    """The P4 stops sending for 40 ms, longer than the FPGA's 16 KB FIFO
    (~29 ms): the FPGA fills the gap with null packets, so the multiplex
    stays valid and the receiver never loses sync, and the health check
    moves the mux's clock on by the nulls, so the PCRs stay on the air's
    timeline (without that they are late by ~2.9 ms for good)."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--aus", video,
              "--air-ms", 500, "--health-ms", 10, "--inject-stall", "250,40")
    common_checks(rep)
    assert rep["faults"] & F_NULLS and rep["nulls"] > 0 and rep["faults"] & F_NOT_NULLS == 0, hex(rep["faults"])
    rx = demodulate(tmp_path)
    ok, bad, where = match(rx, (tmp_path / "sent.ts").read_bytes())
    assert bad == 0 and ok > 400, (ok, bad)
    assert all(b == a + 1 for a, b in zip(where, where[1:])), "packets lost across the stall"
    assert sum(pid(p) == 0x1FFF for p in packets(rx)) > rep["nulls"] // 2
    ts_timing(rx)                                         # PCR steps match the packet count again


@pytest.mark.slow
def test_p4_under_load_needs_no_nulls(harness, bitstream, video, tmp_path):
    """A busy P4 (frame gaps, interrupt latency, 8 ms preemptions: the
    'worst' profile of impairments.py) is absorbed by the 16 KB FIFO: the
    FPGA never has to insert a null packet. (With the old 2 KB FIFO it
    inserted 47 and the PCRs went 2.9 ms late.)"""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--aus", video,
              "--air-ms", 600, "--impair", "p4_gap_us=10,isr_us=40,stall_prob=0.02,stall_ms=8,sck_ppm=-30,"
              "sck_jitter_ps=500,cam_ppm=-100,enc_jitter_ms=20")
    common_checks(rep)
    assert rep["p4_stalls"] >= 10 and rep["nulls"] == 0, (rep["p4_stalls"], rep["nulls"])


@pytest.mark.parametrize("ppm", [2.5, -2.5])
def test_tcxo_tolerance_still_locks(harness, bitstream, tmp_path, ppm):
    """A 40 MHz TCXO 2.5 ppm fast used to put the ADRF6755's PFD past its
    40 MHz maximum and the PLL never locked; the planner now divides by 2."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--air-ms", 10,
              "--impair", f"tcxo_ppm={ppm}")
    assert rep["violations"] == [] and rep["bringup_err"] == 0, rep["violations"]
    assert rep["pfd_hz"] < 40e6 and abs(rep["lo_hz"] - 1279e6 * (1 + ppm * 1e-6)) < 1


def rf_receive(tmp_path, rep, **over):
    import rf_chain
    import dvbt_rx
    z, _ = rf_chain.run(str(tmp_path / "rf.iq"), rep["dac_rate_hz"], rf_chain.Chain().with_(**over),
                        lo_offset_hz=rep["lo_hz"] - 1279e6)
    ts, car = dvbt_rx.receive(z, carriers=True)
    return ts, dvbt_rx.mer_db(car[120:])


@pytest.mark.slow
def test_lo_feedthrough_calibration(harness, bitstream, tmp_path):
    """The ADRF6755's -43 dBc LO feedthrough is above a single OFDM carrier at
    our back-off, and corrupts the receiver's channel estimate on the symbols
    whose scattered pilot sits on the centre carrier. The bench calibration
    (DC offsets into the FPGA's DCOFF) removes it."""
    import rf_chain
    d, crc = bitstream
    leak = dict(lo_leak_dbc=-43)
    dc = rf_chain.lo_null_codes(rf_chain.Chain().with_(**leak))
    ref = run(harness, tmp_path / "raw", "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--air-ms", 400)
    cal = run(harness, tmp_path / "cal", "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--air-ms", 400,
              "--cal", f"dc_i={dc[0]},dc_q={dc[1]}")
    _, m_raw = rf_receive(tmp_path / "raw", ref, **leak)
    _, m_cal = rf_receive(tmp_path / "cal", cal, **leak)
    # The damage sits on one symbol in four (the scattered pilot crosses the
    # centre carrier every fourth symbol): MER of the worst of the 4 phases.
    def worst_phase(m):
        return min(float(np.mean(m[k::4])) for k in range(4))
    raw, cal_ = worst_phase(m_raw), worst_phase(m_cal)
    assert raw < cal_ - 4, f"control: uncalibrated worst phase {raw:.1f} dB vs calibrated {cal_:.1f} dB"
    assert cal_ > 28, f"calibrated MER on the centre-pilot symbols {cal_:.1f} dB"


@pytest.mark.slow
def test_flight_profile_15km(harness, bitstream, video, tmp_path):
    """Everything typical at once, at 15 km: Si5351A/TCXO/P4/camera timing,
    DAC errors, 5 % filter mismatch, modulator quadrature error, feedthrough
    and phase noise, PA AM-PM, roll ripple, ground reflection, Doppler and
    its rate, receiver tuner and clock offsets, a 10-bit ADC. The link must
    carry every packet, and the video must decode cleanly."""
    import impairments as I
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--aus", video,
              "--air-ms", 1250, "--video-start-ms", 150, "--impair", I.DIG["typical"])
    assert rep["violations"] == [] and rep["bringup_err"] == 0
    rx, m = rf_receive(tmp_path, rep, **I.FLIGHT)
    (tmp_path / "rx.ts").write_bytes(rx)
    ok, bad, where = match(rx, (tmp_path / "sent.ts").read_bytes())
    assert bad == 0 and ok > 1500 and all(b == a + 1 for a, b in zip(where, where[1:])), (ok, bad)
    assert np.median(m) > 10, f"MER {np.median(m):.1f} dB"
    ts_timing(rx)
    (tmp_path / "rx_complete.ts").write_bytes(complete_frames(rx))
    st = viewer(tmp_path / "rx_complete.ts", sdt=False)
    assert int(st["nb_read_frames"]) >= 20


# ------------------------------------------------------------ channels, hops --
def fc(body: str) -> str:
    """A flight-computer line ($BODY*HH), as fc_link.h defines it."""
    cs = 0
    for c in body.encode():
        cs ^= c
    return f"${body}*{cs:02X}"


def fc_tx(rep) -> list[str]:
    """What the firmware said to the flight computer, checksums checked and stripped."""
    out = []
    for _, line in rep["fc_tx"]:
        body, cs = line[1:].split("*")
        assert fc(body) == line, f"bad checksum from the P4: {line}"
        out.append(body)
    return out


def lo_changes(rep) -> list[float]:
    """The LO of every stretch with the RF on, consecutive repeats merged."""
    los = [round(lo / 1e3) * 1e3 for _, _, on, lo in rep["rf_segments"] if on]   # the plan is within 1 Hz
    return [lo for i, lo in enumerate(los) if i == 0 or lo != los[i - 1]]


def rf_gaps(rep) -> list[float]:
    """How long each RF-off stretch after the first RF lasted (s)."""
    segs = rep["rf_segments"]
    return [b[1] - a[1] for a, b in zip(segs, segs[1:]) if not a[2]]


@pytest.mark.parametrize("khz", [1243500, 1296500])
def test_boots_at_either_end_of_the_band(harness, bitstream, tmp_path, khz):
    """Pad agility: the first-boot channel anywhere in the band locks, the
    LO from the registers is that channel, and the table says so."""
    import dvbt_hop
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--air-ms", 150,
              "--lo-khz", khz)
    assert rep["violations"] == [] and rep["bringup_err"] == 0, rep["violations"]
    assert abs(rep["lo_hz"] - khz * 1e3) < 1.0 and 2310e6 <= rep["vco_hz"] <= 4800e6
    tabs = dvbt_hop.tables((tmp_path / "sent.ts").read_bytes())
    assert len(tabs) >= 1 and all(t.current_khz == t.next_khz == khz and not t.pending for _, t in tabs)


def test_out_of_band_boot_channel_keeps_rf_off(harness, bitstream, tmp_path):
    """1300 MHz would put half the signal outside the band: no bring-up, no RF."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--air-ms", 10,
              "--lo-khz", 1300000)
    assert rep["bringup_err"] != 0 and rep["rf_samples"] == 0 and not events(rep, "TXDIS low")


def test_hop_commands_retries_and_refusals(harness, bitstream, tmp_path):
    """The protocol against the flight code, no receiver: a bad checksum, an
    out-of-band channel, another hop while one is pending and a seq reused
    for a different channel are refused with nothing changed; retries of an
    accepted hop get the same answer and never hop twice; a hop to the
    channel already on air is done at once. Exactly one LO change, to the
    commanded channel, with the RF never on while the PLL is unlocked, and
    the hop announced in the stream (sent.ts) before it happens."""
    import dvbt_hop
    d, crc = bitstream
    hop = fc("HOP,2,1296500")
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--air-ms", 560,
              "--hop-lead-ms", 150,
              "--fc", "40:$HOP,1,1255000*00",            # bad checksum
              "--fc", "50:" + fc("HOP,1,1230000"),       # below the band
              "--fc", "60:" + hop,
              "--fc", "75:" + hop,                       # retry while pending
              "--fc", "90:" + fc("HOP,3,1250000"),       # another while pending
              "--fc", "100:" + fc("CH?"),
              "--fc", "330:" + hop,                      # retry after it is done
              "--fc", "340:" + fc("HOP,2,1250000"),      # seq 2 again, other channel
              "--fc", "350:" + fc("HOP,4,1296500"),      # already there
              "--fc", "360:" + fc("CH?"))
    assert rep["violations"] == [], "\n".join(rep["violations"])
    said = fc_tx(rep)
    ack = [x for x in said if x.startswith("ACK,2,")]
    # A retry names the same hop (seq, channel, stream time) with the time left.
    f0, f1 = (a.split(",") for a in ack) if len(ack) == 2 else ([], [])
    assert len(ack) == 2 and f0[:3] == f1[:3] and f0[4] == f1[4], said
    lead_ms, pcr = f0[3], f0[4]
    assert lead_ms == "150" and 0 < 150 - int(f1[3]) <= 20, ack
    assert said == ["ERR,CSUM", "NAK,1,RANGE", ack[0], ack[1], "NAK,3,BUSY", "CH,1279000,PENDING,2,1296500",
                    "DONE,2,1296500,OK", "DONE,2,1296500,OK", "NAK,2,SEQ", "ACK,4,1296500,0,0",
                    "DONE,4,1296500,OK", "CH,1296500,IDLE"], said
    assert (rep["hops"], rep["hops_failed"], rep["cur_khz"], rep["fc_bad"]) == (1, 0, 1296500, 1)
    assert lo_changes(rep) == [1279e6, 1296.5e6], lo_changes(rep)
    assert abs(rep["lo_hz"] - 1296.5e6) < 1.0
    assert rep["rf_unlocked_max_s"] == 0, "RF on with the PLL unlocked"
    gaps = rf_gaps(rep)
    assert len(gaps) == 1 and gaps[0] < 0.001, f"hop dark for {gaps}"
    assert rep["keyframes"] == 1, "one key frame, 250 ms after the hop (for the ground's decoder)"
    # When: DONE comes the FIFO's depth after the stream time it announced.
    t_ack = next(t for t, x in rep["fc_tx"] if x.startswith("$ACK,2,"))
    t_done = next(t for t, x in rep["fc_tx"] if x.startswith("$DONE,2,"))
    fifo_s = 16384 * 8 / float(RATE)
    assert abs((t_done - t_ack) - (0.150 + fifo_s)) < 0.003, (t_done - t_ack, fifo_s)
    # The stream announced it: pending tables from the ACK on, then the new channel.
    tabs = dvbt_hop.tables((tmp_path / "sent.ts").read_bytes())
    pend = [t for _, t in tabs if t.pending]
    assert len(pend) >= 2 and all((t.seq, t.current_khz, t.next_khz, t.hop_pcr) == (2, 1279000, 1296500, int(pcr))
                                  for t in pend), pend
    assert not tabs[-1][1].pending and tabs[-1][1].current_khz == 1296500


def test_hop_to_a_channel_that_will_not_lock_falls_back(harness, bitstream, tmp_path):
    """This board's VCO will not lock at 1260 MHz: the hop gives up after the
    LDET timeout, goes back on air on the old channel, says FAIL, and the
    table never claims the new channel."""
    import dvbt_hop
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--air-ms", 300,
              "--hop-lead-ms", 100, "--pll-bad-lo-khz", 1260000, "--fc", "50:" + fc("HOP,5,1260000"))
    assert rep["violations"] == [], "\n".join(rep["violations"])
    said = fc_tx(rep)
    assert len(said) == 2 and said[0].startswith("ACK,5,1260000,100,") and said[1] == "DONE,5,1260000,FAIL", said
    assert (rep["hops"], rep["hops_failed"], rep["cur_khz"]) == (1, 1, 1279000)
    assert lo_changes(rep) == [1279e6] and abs(rep["lo_hz"] - 1279e6) < 1.0
    assert rep["rf_unlocked_max_s"] == 0
    gaps = rf_gaps(rep)
    assert len(gaps) == 1 and gaps[0] < 0.012, gaps          # 10 ms LDET timeout + the relock
    tabs = [t for _, t in dvbt_hop.tables((tmp_path / "sent.ts").read_bytes())]
    assert all(t.current_khz == 1279000 for t in tabs) and not tabs[-1].pending


@pytest.mark.slow
def test_hop_followed_by_the_ground(harness, bitstream, video, tmp_path):
    """In flight, video on: the flight computer asks for 1255 MHz. A ground
    receiver on 1279 MHz sees the hop announced in the stream, its Follower
    retunes when the stream reaches the announced time, and a receiver on
    1255 MHz from then on gets the stream back: every packet as sent, the
    new channel confirmed in its table, the video decoding."""
    import dvbt_hop
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--aus", video,
              "--air-ms", 1500, "--video-start-ms", 100, "--hop-lead-ms", 300,
              "--fc", "300:" + fc("HOP,7,1255000"))
    common_checks_except_lo = dict(rep, lo_hz=1279e6)
    common_checks(common_checks_except_lo)
    said = fc_tx(rep)
    assert len(said) == 2 and said[0].startswith("ACK,7,1255000,300,") and said[1] == "DONE,7,1255000,OK", said
    hop_pcr = int(said[0].split(",")[4])
    assert lo_changes(rep) == [1279e6, 1255e6] and rep["rf_unlocked_max_s"] == 0
    t_hop = next(t for _, t, on, lo in rep["rf_segments"] if on and abs(lo - 1255e6) < 1)
    sent = (tmp_path / "sent.ts").read_bytes()

    # On 1279 MHz: the announcement, and the stream up to the hop.
    rx_a = demodulate(tmp_path, rep, 1279000, name="rx_1279.ts")
    ok, bad, where_a = match(rx_a, sent)
    assert bad == 0 and ok > 700, (ok, bad)
    assert all(b == a + 1 for a, b in zip(where_a, where_a[1:])), "packets lost before the hop"
    pend = [t for _, t in dvbt_hop.tables(rx_a) if t.pending]
    assert len(pend) >= 2 and all((t.seq, t.next_khz, t.hop_pcr) == (7, 1255000, hop_pcr) for t in pend), pend
    f = dvbt_hop.Follower(1279000, [1279000, 1255000])
    retune = [i for i, p in enumerate(packets(rx_a)) if f.feed(p)]
    assert len(retune) == 1 and f.tuned == 1255000, retune
    # The transmitter left when the packet stamped hop_pcr was on air (the
    # fast test times DONE to the millisecond). The receiver delivers up to
    # its pipeline's depth before that (gr-dtv ~45 ms) and PCRs come every
    # 20 ms, so the last PCR it hands over is 45-70 ms short of the hop --
    # which is why the Follower retunes 100 ms early, not at hop_pcr.
    pcrs = [v for v in map(dvbt_hop.pcr_of, packets(rx_a)) if v is not None]
    assert -0.080 <= (pcrs[-1] - hop_pcr) / 27e6 <= 0.002, (pcrs[-1] - hop_pcr) / 27e6

    # On 1255 MHz from the hop on (the ground retuned on the table, which it
    # had 300 ms ahead).
    rx_b = demodulate(tmp_path, rep, 1255000, start_s=t_hop, name="rx_1255.ts")
    ok_b, bad_b, where_b = match(rx_b, sent)
    assert bad_b == 0 and ok_b > 500, (ok_b, bad_b)
    assert all(b == a + 1 for a, b in zip(where_b, where_b[1:])), "packets lost on the new channel"
    tabs_b = [t for _, t in dvbt_hop.tables(rx_b)]
    assert tabs_b and all(t.current_khz == 1255000 and not t.pending for t in tabs_b)
    sent_t = 188 * 8 / float(RATE)
    outage = (where_b.full[0] - where_a.full[-1]) * sent_t
    # ~45 ms in the old receiver's pipeline + its acquisition on the new channel
    assert outage < 0.25, f"{outage * 1e3:.0f} ms of stream lost across the hop"
    (tmp_path / "rx_1255_complete.ts").write_bytes(complete_frames(rx_b))
    st = viewer(tmp_path / "rx_1255_complete.ts", sdt=False)
    assert st.get("codec_name") == "h264" and int(st["nb_read_frames"]) >= 8, st

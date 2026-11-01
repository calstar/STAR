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

import build  # noqa: E402
import make_fpga_image  # noqa: E402

pytestmark = pytest.mark.skipif(not shutil.which("verilator") or not shutil.which("ffmpeg"),
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
    """A stand-in bitstream the size of the LFE5U-25F's (the ECP5 model only
    checks it arrives intact), its image, and a valid image of another one."""
    d = tmp_path_factory.mktemp("fpga")
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
    """1080p30 H.264 as the P4's encoder makes it (GOP 30, no B-frames,
    3.3 Mbit/s), one access unit per frame without access-unit delimiters
    (the muxer must add them)."""
    d = tmp_path_factory.mktemp("video")
    raw = d / "v.h264"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
                    "-t", "2", "-c:v", "libx264", "-preset", "veryfast", "-bf", "0", "-g", "30",
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


def demodulate(out: Path) -> bytes:
    """What a receiver tuned to 1279 MHz gets: the DAC's I/Q at 27.43 MS/s,
    filtered and decimated to the DVB-T sample rate, through gr-dtv."""
    from scipy import signal
    import dvbt_rx
    iq = np.fromfile(out / "rf.iq", np.int16).reshape(-1, 2).astype(np.float32)
    x = iq[:, 0] + 1j * iq[:, 1]
    taps = signal.firwin(801, 3.2, window=("kaiser", 10), fs=4 * 48 / 7) * 4
    y = signal.resample_poly(x, 1, 4, window=taps)
    ts = dvbt_rx.receive(y)
    (out / "rx.ts").write_bytes(ts)
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
def test_p4_stall_fills_with_nulls(harness, bitstream, video, tmp_path):
    """The P4 stops sending for 5 ms (longer than the FIFO's 3.6 ms): the
    FPGA fills with null packets, so the multiplex stays valid and the
    receiver never loses sync; the health check counts the nulls."""
    d, crc = bitstream
    rep = run(harness, tmp_path, "--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--aus", video,
              "--air-ms", 450, "--health-ms", 10, "--inject-stall", "250,5")
    common_checks(rep)
    assert rep["faults"] & F_NULLS and rep["nulls"] > 0 and rep["faults"] & F_NOT_NULLS == 0, hex(rep["faults"])
    rx = demodulate(tmp_path)
    ok, bad, where = match(rx, (tmp_path / "sent.ts").read_bytes())
    assert bad == 0 and ok > 400, (ok, bad)
    assert all(b == a + 1 for a, b in zip(where, where[1:])), "packets lost across the stall"
    nulls_rx = sum(pid(p) == 0x1FFF for p in packets(rx))
    nulls_tx = sum(pid(p) == 0x1FFF for p in packets((tmp_path / "sent.ts").read_bytes()))
    assert nulls_rx > 0 and rep["nulls"] > 0, (nulls_rx, nulls_tx)

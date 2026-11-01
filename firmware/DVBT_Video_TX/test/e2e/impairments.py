#!/usr/bin/env python3
"""What realistic imperfections do to the link, one at a time and together.

Digital and timing impairments go into the harness (--impair: clock ppm and
jitter, PLL phase, DAC-bus skew, P4 latency and stalls, camera timing); the
analog chain and the air go through model/rf_chain.py on the harness's DAC
output; the receiver is gr-dtv. For each case: MER, received packets that
differ from what the firmware sent, packets lost, the worst 50 ms dropout,
frames ffmpeg decodes and whether it complains.

    /usr/bin/python3.12 test/e2e/impairments.py [out_dir] [case-filter]
"""
from __future__ import annotations

import json
import math
import multiprocessing as mp
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "model"))
import build  # noqa: E402
import test_e2e as T  # noqa: E402
import rf_chain  # noqa: E402

AIR_MS = 1400
PKT_S = 188 * 8 / float(T.RATE)

# ---- digital profiles (harness) ------------------------------------------------
DIG = {
    "ideal": "",
    # Si5351A 25 MHz crystal +-20 ppm + aging; 30 ps RMS edge jitter; ECP5 PLL 90 deg
    # step accuracy and jitter; 400 ps pin/trace skew; P4 under load (logging, camera,
    # SD card): frame gaps, interrupt latency, an occasional preemption.
    "typical": "si_ppm=20,tcxo_ppm=-2,clk_jitter_ps=30,pll_phase_ps=150,pll_jitter_ps=20,io_skew_ps=400,"
               "p4_gap_us=3,isr_us=10,stall_prob=0.002,stall_ms=2,sck_ppm=10,sck_jitter_ps=200,"
               "cam_ppm=50,enc_jitter_ms=8",
    "worst": "si_ppm=-50,tcxo_ppm=-2.5,clk_jitter_ps=100,pll_phase_ps=500,pll_jitter_ps=80,io_skew_ps=1500,"
             "p4_gap_us=10,isr_us=40,stall_prob=0.01,stall_ms=8,sck_ppm=-30,sck_jitter_ps=500,"
             "cam_ppm=-100,enc_jitter_ms=20",
    "tcxo_fast": "tcxo_ppm=2",
}
DIG["worst2"] = DIG["worst"]          # re-run with today's firmware and FPGA (16 KB FIFO, mux skip)

C0 = rf_chain.Chain()
DAC_TYP = dict(dac_gain_err_i=0.01, dac_gain_err_q=-0.01, dac_offset_i=2, dac_offset_q=-2, dac_inl=0.68,
               dac_nsd=-153, clkin_jitter_ps=12)
DAC_WORST = dict(dac_gain_err_i=0.02, dac_gain_err_q=-0.02, dac_offset_i=4, dac_offset_q=-4, dac_inl=0.68,
                 dac_nsd=-153, clkin_jitter_ps=40)
MOD_TYP = dict(iq_gain_db=0.12, iq_phase_deg=0.8, lo_leak_dbc=-43, phase_noise=1, mod_floor_dbm_hz=-160.5)
AIR_15 = dict(range_m=15000, tx_ant_dbi=0, rx_ant_dbi=12, rx_nf_db=6)
FLIGHT = {**DAC_TYP, **MOD_TYP, "lpf_tol_i": 0.05, "lpf_tol_q": -0.05, "pa_ampm_deg": 5,
          **AIR_15, "roll_hz": 2, "roll_ripple_db": 6, "ground_rho": 0.2, "ground_fade_hz": 1.5,
          "v_radial": 300, "a_radial": -30, "rx_lo_ppm": 5, "rx_clk_ppm": 20, "rx_adc_bits": 10}

# (name, digital profile, chain overrides)
CASES = [
    ("ideal", "ideal", {}),
    ("dac typical", "ideal", DAC_TYP),
    ("dac worst", "ideal", DAC_WORST),
    ("lpf 5% I/Q mismatch", "ideal", dict(lpf_tol_i=0.05, lpf_tol_q=-0.05)),
    ("lpf 10% mismatch", "ideal", dict(lpf_tol_i=0.10, lpf_tol_q=-0.10)),
    ("modulator typical", "ideal", MOD_TYP),
    ("phase noise +10 dB", "ideal", {**MOD_TYP, "pn_scale_db": 10}),
    ("phase noise +20 dB", "ideal", {**MOD_TYP, "pn_scale_db": 20}),
    ("PA P1dB 32.8 dBm", "ideal", dict(pa_ampm_deg=5)),
    ("PA P1dB 30 dBm", "ideal", dict(pa_p1db_dbm=30, pa_ampm_deg=5)),
    ("PA P1dB 28 dBm", "ideal", dict(pa_p1db_dbm=28, pa_ampm_deg=5)),
    ("PA P1dB 26 dBm", "ideal", dict(pa_p1db_dbm=26, pa_ampm_deg=8)),
    ("CFO 5 kHz (TCXO+Doppler)", "ideal", dict(rx_lo_ppm=-5e3 / 1279)),
    ("CFO 15 kHz", "ideal", dict(rx_lo_ppm=-15e3 / 1279)),
    ("CFO 20 kHz", "ideal", dict(rx_lo_ppm=-20e3 / 1279)),
    ("CFO 25 kHz (rx tuner 20 ppm)", "ideal", dict(rx_lo_ppm=-25e3 / 1279)),
    ("Doppler 680 m/s, 10 g", "ideal", dict(v_radial=680, a_radial=-100)),
    ("Doppler rate 30 g", "ideal", dict(v_radial=300, a_radial=300)),
    ("rx clock 50 ppm", "ideal", dict(rx_clk_ppm=50)),
    ("range 10 km", "ideal", dict(AIR_15, range_m=10000)),
    ("range 15 km", "ideal", AIR_15),
    ("range 20 km", "ideal", dict(AIR_15, range_m=20000)),
    ("range 30 km", "ideal", dict(AIR_15, range_m=30000)),
    ("range 40 km", "ideal", dict(AIR_15, range_m=40000)),
    ("15 km, roll 10 dB ripple", "ideal", dict(AIR_15, roll_hz=2, roll_ripple_db=10)),
    ("15 km, roll 20 dB nulls", "ideal", dict(AIR_15, roll_hz=2, roll_ripple_db=20)),
    ("15 km, tx antenna -10 dBi (tail-on)", "ideal", dict(AIR_15, tx_ant_dbi=-10)),
    ("15 km, linear tx (3 dB pol)", "ideal", dict(AIR_15, pol_loss_db=3)),
    ("rx ADC 8 bit", "ideal", dict(rx_adc_bits=8)),
    ("flight 15 km (typical everything)", "typical", FLIGHT),
    ("flight 15 km, LNA (NF 1.5)", "typical", dict(FLIGHT, rx_nf_db=1.5)),
    ("flight, worst digital", "worst", FLIGHT),
    ("TCXO +2 ppm (firmware)", "tcxo_fast", {}),
    ("digital typical only", "typical", {}),
    ("digital worst only", "worst", {}),
    # where it breaks: weaker and weaker links, fading on top
    ("range 60 km", "ideal", dict(AIR_15, range_m=60000)),
    ("range 80 km", "ideal", dict(AIR_15, range_m=80000)),
    ("range 100 km", "ideal", dict(AIR_15, range_m=100000)),
    ("30 km, roll 20 dB nulls", "ideal", dict(AIR_15, range_m=30000, roll_hz=2, roll_ripple_db=20)),
    ("15 km tail-on -15 dBi", "ideal", dict(AIR_15, tx_ant_dbi=-15)),
    ("15 km tail-on -15 dBi + roll 10 dB", "ideal", dict(AIR_15, tx_ant_dbi=-15, roll_hz=2, roll_ripple_db=10)),
    ("CFO 30 kHz", "ideal", dict(rx_lo_ppm=-30e3 / 1279)),
    ("CFO 35 kHz", "ideal", dict(rx_lo_ppm=-35e3 / 1279)),
    # the fixes, re-checked
    ("modulator typical, calibrated", "typical_cal", dict(DAC_TYP, **MOD_TYP)),
    ("modulator typical, uncalibrated", "typical", dict(DAC_TYP, **MOD_TYP)),
    ("lpf 8 MHz, 5% mismatch", "ideal", dict(lpf_fc_hz=8e6, lpf_tol_i=0.05, lpf_tol_q=-0.05)),
    ("lpf 8 MHz, 2% mismatch", "ideal", dict(lpf_fc_hz=8e6, lpf_tol_i=0.02, lpf_tol_q=-0.02)),
    ("flight, worst digital (fixed)", "worst2", FLIGHT),
]


# A calibrated board: the DC offsets a bench calibration finds for the
# modulator's -43 dBc feedthrough (rf_chain.lo_null_codes).
_dc = rf_chain.lo_null_codes(C0.with_(lo_leak_dbc=-43))
CAL = {"typical_cal": ("typical", f"dc_i={_dc[0]},dc_q={_dc[1]}")}


def harness_run(prof: str, out: Path, assets) -> dict:
    d, crc, aus = assets
    args = ["--image", d / "fpga.img", "--good-crc", f"{crc:08x}", "--aus", aus, "--air-ms", AIR_MS,
            "--video-start-ms", 150, "--health-ms", 100]
    base, cal = CAL.get(prof, (prof, ""))
    if DIG[base]:
        args += ["--impair", DIG[base]]
    if cal:
        args += ["--cal", cal]
    out.mkdir(parents=True, exist_ok=True)
    if (out / "report.json").exists():
        return json.loads((out / "report.json").read_text())
    return T.run(build.build(), out, *args)


def evaluate(name, prof, over, outdir: Path) -> dict:
    import dvbt_rx
    hdir = outdir / f"h_{prof}"
    rep = json.loads((hdir / "report.json").read_text())
    res = {"case": name, "digital": prof, "bringup": rep["bringup_err"], "violations": len(rep["violations"]),
           "faults": rep["faults"], "fpga_nulls": rep["nulls"], "dac_timing_err": rep.get("dac_timing_errors", 0),
           "setup_ps": rep.get("dac_setup_margin_ps"), "hold_ps": rep.get("dac_hold_margin_ps"),
           "lo_err_hz": rep["lo_hz"] - 1279e6 if rep["lo_hz"] else None}
    if rep["bringup_err"] != 0:
        res["verdict"] = "BRING-UP FAILED: " + "; ".join(rep["violations"][:2])
        return res
    t0 = time.time()
    ch = C0.with_(**over)
    info = {}
    z, fs = rf_chain.run(str(hdir / "rf.iq"), rep["dac_rate_hz"], ch, lo_offset_hz=rep["lo_hz"] - 1279e6,
                         report=info)
    ts, car = dvbt_rx.receive(z, carriers=True)
    m = dvbt_rx.mer_db(car[200:]) if len(car) > 220 else np.array([0.0])
    sent = (hdir / "sent.ts").read_bytes()
    ok, bad, where = T.match(ts, sent)
    res.update(mer_med=float(np.median(m)), mer_p5=float(np.percentile(m, 5)), rx_pkts=ok, bad_pkts=bad,
               pa_avg=info.get("pa_out_avg_dbm"), pa_peak=info.get("pa_out_peak_dbm"),
               rx_dbm=info.get("rx_power_dbm"), snr=info.get("rx_snr_db"), secs=round(time.time() - t0))
    # Lost packets between the first and last received (the receiver needs ~0.15 s to lock).
    full = sorted(set(where.full))
    if full:
        s_all = T.packets(sent)
        span = [i for i in range(full[0], full[-1] + 1) if T.pid(s_all[i]) != 0x1FFF]
        got = set(full)
        lost = [i for i in span if i not in got]
        res["lost"] = len(lost)
        w = int(0.05 / PKT_S)
        worst = 0
        if lost:
            arr = np.zeros(full[-1] + 1)
            arr[lost] = 1
            worst = int(np.max(np.convolve(arr, np.ones(w), "valid"))) if len(arr) > w else int(arr.sum())
        res["worst_50ms_lost"] = worst
    else:
        res["lost"] = None
    # The viewer's side.
    p = outdir / f"rx_{name.replace(' ', '_').replace('/', '_')}.ts"
    try:
        p.write_bytes(T.complete_frames(ts))
        st = T.viewer(p, sdt=False)
        res["frames"] = int(st.get("nb_read_frames", 0))
        dec = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-f", "null", "-"], capture_output=True, text=True)
        res["ffmpeg_errors"] = len([ln for ln in dec.stderr.splitlines() if ln.strip()])
        try:
            T.ts_timing(ts)
            res["timing"] = "ok"
        except AssertionError as e:
            res["timing"] = str(e)[:80]
    except Exception as e:                                       # noqa: BLE001
        res["frames"] = 0
        res["viewer"] = str(e)[:80]
    good = bad == 0 and res.get("lost") == 0 and res.get("ffmpeg_errors", 1) == 0 and res.get("timing") == "ok"
    res["verdict"] = "ok" if good else "DEGRADED" if ok > 500 else "BROKEN"
    return res


def _eval(args):
    name, outdir = args[0], args[3]
    cache = outdir / "res" / (name.replace(" ", "_").replace("/", "_") + ".json")
    if cache.exists():
        return json.loads(cache.read_text())
    try:
        r = evaluate(*args)
    except Exception as e:                                       # noqa: BLE001
        r = {"case": name, "verdict": f"ERROR {type(e).__name__}: {e}"[:200]}
    cache.parent.mkdir(exist_ok=True)
    cache.write_text(json.dumps(r))
    print(f"done: {name}: {r.get('verdict')}", flush=True)
    return r


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--one":
        outdir, name = Path(sys.argv[2]), sys.argv[3]
        n, p, o = next(c for c in CASES if c[0] == name)
        _eval((n, p, o, outdir))
        return
    outdir = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/dvbt_impair")
    filt = sys.argv[2] if len(sys.argv) > 2 else ""
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "fpga").mkdir(exist_ok=True)
    d, crc = T.make_bitstream(outdir / "fpga")
    vd = outdir / "video"
    vd.mkdir(exist_ok=True)
    aus = vd / "aus.bin" if (vd / "aus.bin").exists() else T.make_video(vd, seconds=2)
    cases = [c for c in CASES if filt in c[0]]
    profs = sorted({c[1] for c in cases})
    # spawn, not fork: gnuradio's threads do not survive a fork
    ctx = mp.get_context("spawn")
    with ctx.Pool(min(4, len(profs))) as pool:
        pool.starmap(harness_run, [(p, outdir / f"h_{p}", (d, crc, aus)) for p in profs])
    # One process per case: gr-dtv can crash (heap corruption seen at +50 ppm
    # receiver clock), and a crash must cost that case, not the sweep.
    from concurrent.futures import ThreadPoolExecutor

    def one(name):
        cache = outdir / "res" / (name.replace(" ", "_").replace("/", "_") + ".json")
        if not cache.exists():
            p = subprocess.run([sys.executable, __file__, "--one", str(outdir), name], capture_output=True, text=True)
            if not cache.exists():
                cache.parent.mkdir(exist_ok=True)
                tail = [ln for ln in (p.stderr or "").splitlines() if "buffer_double" not in ln][-2:]
                cache.write_text(json.dumps({"case": name, "verdict": "RECEIVER CRASHED (gr-dtv): " + " | ".join(tail)}))
            print(f"done: {name}", flush=True)
        return json.loads(cache.read_text())

    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(one, [n for n, _, _ in cases]))
    (outdir / "results.json").write_text(json.dumps(results, indent=1))
    cols = ["case", "verdict", "mer_med", "mer_p5", "bad_pkts", "lost", "worst_50ms_lost", "frames", "ffmpeg_errors",
            "timing", "pa_avg", "pa_peak", "rx_dbm", "snr", "fpga_nulls", "faults"]
    print("| " + " | ".join(cols) + " |")
    print("|" + "---|" * len(cols))
    for r in results:
        cells = []
        for c in cols:
            v = r.get(c, "")
            cells.append(f"{v:.1f}" if isinstance(v, float) and not math.isnan(v) else str(v))
        print("| " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()

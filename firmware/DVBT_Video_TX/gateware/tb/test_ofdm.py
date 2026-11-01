"""cocotb tests for the OFDM back end: FFT core against numpy, the full
modulator against gr-dtv. Configuration from the environment, as test_stages.
"""

from __future__ import annotations

import os

import cocotb
import numpy as np

from streams import reset, seed, stream

N = 2048
SCALE = 32  # the core halves in 5 of its 11 butterflies
MIN_SNR_DB = float(os.environ.get("MIN_SNR_DB", "60"))


def _s18(v: int) -> int:
    return v - (1 << 18) if v >= (1 << 17) else v


def _bitrev(n: int, bits: int = 11) -> int:
    return int(f"{n:0{bits}b}"[::-1], 2)


def snr_db(got: np.ndarray, want: np.ndarray) -> float:
    err = got - want
    return 10 * np.log10(np.sum(np.abs(want) ** 2) / max(np.sum(np.abs(err) ** 2), 1e-30))


@cocotb.test()
async def fft2048(dut):
    """Forward FFT of random OFDM-like blocks against numpy, block by block.

    Input: 1705 random QPSK cells at 1.0 = 8192 in a 2048 block (the rest
    zero), so the levels are the modulator's. Two extra blocks flush the
    pipeline (latency 2047 samples of delay lines plus ~36 registers). Each output block must match numpy's FFT / 32 to MIN_SNR_DB, in
    bit-reversed order, with m_first on its first sample.
    """
    rng = np.random.default_rng(seed())
    n_blk = 4
    x = np.zeros((n_blk + 2, N), dtype=np.complex128)
    for b in range(n_blk):
        cells = (rng.choice([-1, 1], 1705) + 1j * rng.choice([-1, 1], 1705)) * 5793
        x[b, :1705] = cells
        x[b] = np.roll(x[b], rng.integers(0, N))  # don't always start at bin 0
    ins = [{"s_re": int(v.real) & 0x3FFFF, "s_im": int(v.imag) & 0x3FFFF} for v in x.reshape(-1)]
    await reset(dut)
    out = await stream(dut, ins, ["re", "im", "first"], n_blk * N)
    got = np.array([_s18(o["re"]) + 1j * _s18(o["im"]) for o in out]).reshape(n_blk, N)
    first = [k for k, o in enumerate(out) if o["first"]]
    assert first == [b * N for b in range(n_blk)], f"m_first at {first[:6]}"
    perm = [_bitrev(i) for i in range(N)]
    for b in range(n_blk):
        want = np.fft.fft(x[b])[perm] / SCALE
        s = snr_db(got[b], want)
        peak = np.abs(got[b]).max()
        # Rounding (not truncating) when halving: the error must be unbiased.
        # Truncation leaves SNR above 60 dB but shifts every output by about
        # -1 LSB per halving stage, an offset the DAC would show as carrier leak.
        bias = np.mean(got[b] - want)
        cocotb.log.info("block %d: SNR %.1f dB vs numpy, bias %.2f%+.2fj LSB, peak %.0f of 131071",
                        b, s, bias.real, bias.imag, peak)
        assert s >= MIN_SNR_DB, f"block {b}: SNR {s:.1f} dB < {MIN_SNR_DB}"
        assert abs(bias) < 0.2, f"block {b}: output biased by {bias:.2f} LSB"


GUARD = {0: 64, 1: 128, 2: 256, 3: 512}
STARTUP_SYMS = 10  # symbols still carrying the outer interleaver's zero fill


@cocotb.test()
async def modulator(dut):
    """TS bytes in, baseband OFDM out, against gr-dtv.

    The expected samples are gr-dtv's own transmitted carriers (the FFT of its
    output; golden.carriers) put back through an exact IFFT at the RTL's scale
    (8192 per unit carrier / 32) with the cyclic prefix in front -- gr-dtv's
    signal in the RTL's units, not a model of the RTL. Also reports MER: the
    RTL's output, guard stripped and FFT'd, against gr-dtv's carriers.
    """
    import golden

    mod = os.environ.get("MOD", "qpsk")
    rate = os.environ.get("RATE", "1/2")
    n_pkt = int(os.environ.get("N_PKT", "48"))
    ng = GUARD[2]  # golden model runs guard 1/8
    ts = golden.random_ts(n_pkt, seed=seed())
    car = golden.carriers(ts, mod, rate)
    n_sym = len(car) - 3  # the last symbols are still inside the pipeline
    assert n_sym >= 4, f"only {n_sym} symbols to compare"
    bins = np.zeros((n_sym, N), dtype=np.complex128)
    bins[:, [(k - 852) % N for k in range(1705)]] = car[:n_sym]
    t = np.fft.ifft(bins, axis=1) * N * 8192 / SCALE
    want = np.concatenate([t[:, -ng:], t], axis=1)

    dut.cfg_mod.value = {"qpsk": 0, "16qam": 1, "64qam": 2}[mod]
    dut.cfg_rate.value = {"1/2": 0, "2/3": 1, "3/4": 2, "5/6": 3, "7/8": 4}[rate]
    dut.cfg_guard.value = 2
    await reset(dut)
    ins = [{"s_data": int(b), "s_sop": int(k % 188 == 0)} for k, b in enumerate(ts)]
    out = await stream(dut, ins, ["i", "q", "sos"], want.size, p_valid=0.9, p_ready=0.8)
    got = np.array([_s18(o["i"]) + 1j * _s18(o["q"]) for o in out]).reshape(n_sym, N + ng)
    sos = [k for k, o in enumerate(out) if o["sos"]]
    assert sos == [s * (N + ng) for s in range(n_sym)], f"m_sos at {sos[:4]}"
    assert int(dut.err_align.value) == 0, "err_align set"

    if os.environ.get("TB_DUMP"):
        np.savez(os.environ["TB_DUMP"], got=got, want=want, car=car[:n_sym])
    # Start-up: the outer interleaver's delay lines power up zeroed (as
    # gr-dtv's do) and zeros bypass the energy dispersal, so the first few
    # symbols carry long runs of identical cells that add up coherently at
    # t = 0 -- beyond the 18-bit range. The RTL must clip those to the rail;
    # it may do so only in those symbols, and nothing else may differ.
    over = (np.abs(want.real) > 131071) | (np.abs(want.imag) > 131071)
    clipped_syms = sorted(set(np.nonzero(over)[0].tolist()))
    assert all(sy < STARTUP_SYMS for sy in clipped_syms), (
        f"full-scale overflow outside start-up, symbols {clipped_syms}")
    rails = np.clip(want.real, -131071, 131071) + 1j * np.clip(want.imag, -131071, 131071)
    assert np.all(np.abs(got[over] - rails[over]) < 64), "overflowing samples not clipped to the rail"
    # Per-symbol SNR: inside the start-up symbols the FFT's intermediate
    # stages saturate too, so samples near (not only beyond) the rail differ.
    per_sym = [snr_db(got[k], want[k]) for k in range(n_sym)]
    bad = [k for k, v in enumerate(per_sym) if v < MIN_SNR_DB]
    cocotb.log.info("per-symbol SNR, first %d: %s", STARTUP_SYMS,
                    " ".join(f"{v:.0f}" for v in per_sym[:STARTUP_SYMS]))
    assert all(k < STARTUP_SYMS for k in bad), f"symbols below {MIN_SNR_DB} dB: {bad}"
    s = snr_db(got[STARTUP_SYMS:], want[STARTUP_SYMS:])
    steady = got[STARTUP_SYMS:]
    rx = np.fft.fft(steady[:, ng:], axis=1)[:, [(k - 852) % N for k in range(1705)]]
    mer = snr_db(rx / (8192 * N / SCALE), car[STARTUP_SYMS:n_sym])
    peak = np.abs(steady).max()
    rms = np.sqrt(np.mean(np.abs(steady) ** 2))
    cocotb.log.info("modulator %s %s: %d symbols, steady-state SNR %.1f dB vs gr-dtv (%d start-up samples "
                    "clipped, symbols %s), steady state: MER %.1f dB, RMS %.0f, peak %.0f "
                    "(PAPR %.1f dB) of 131071", mod, rate, n_sym, s, int(over.sum()),
                    clipped_syms, mer, rms, peak, 20 * np.log10(peak / rms))
    assert s >= MIN_SNR_DB, f"SNR {s:.1f} dB < {MIN_SNR_DB}"
    assert n_sym > STARTUP_SYMS + 4, "too few steady-state symbols"

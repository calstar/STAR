"""cocotb tests: each RTL stage against gr-dtv, bit for bit.

Each test feeds the stage gr-dtv's own output from the stage before, so a
failure points at one block; ``fec_chain`` then runs the four together from raw
TS. Configuration comes from the environment (set by ``test_rtl.py``):
``MOD`` (qpsk/16qam/64qam), ``RATE`` (1/2 ... 7/8), ``TB_SEED``, ``N_PKT``.
"""

from __future__ import annotations

import os

import cocotb
import numpy as np

from streams import first_mismatch, reset, seed, stream, ts_inputs

import golden  # noqa: E402  (path set up by streams)

MOD = os.environ.get("MOD", "qpsk")
RATE = os.environ.get("RATE", "1/2")
N_PKT = int(os.environ.get("N_PKT", "48"))  # multiple of 8: whole PRBS groups
MOD_CODE = {"qpsk": 0, "16qam": 1, "64qam": 2}[MOD]
RATE_CODE = {"1/2": 0, "2/3": 1, "3/4": 2, "5/6": 3, "7/8": 4}[RATE]


def _ts() -> np.ndarray:
    return golden.random_ts(N_PKT, seed=seed())


def _check(got: list[int], want: np.ndarray, what: str) -> None:
    got_a = np.array(got, dtype=np.int64)
    want_a = np.asarray(want, dtype=np.int64)
    n = min(len(got_a), len(want_a))
    assert n > 0, f"{what}: nothing to compare"
    ok = np.array_equal(got_a[:n], want_a[:n])
    assert ok, f"{what}: {first_mismatch(got_a[:n], want_a[:n])}"
    cocotb.log.info("%s: %d items match gr-dtv (%s, %s, seed %d)", what, n, MOD, RATE, seed())


@cocotb.test()
async def energy_dispersal(dut):
    ts = _ts()
    want = golden.run("energy", ts)
    await reset(dut)
    out = await stream(dut, ts_inputs(ts), ["data"], len(want))
    _check([o["data"] for o in out], want, "energy dispersal")


@cocotb.test()
async def rs_encoder(dut):
    ts = _ts()
    x = golden.run("energy", ts)
    want = golden.run("rs", ts)
    await reset(dut)
    out = await stream(dut, ts_inputs(x), ["data", "sop"], len(want))
    _check([o["data"] for o in out], want, "RS(204,188)")
    sops = [k for k, o in enumerate(out) if o["sop"]]
    assert sops == list(range(0, len(out), 204)), "m_sop not on every 204th byte"


@cocotb.test()
async def outer_interleaver(dut):
    ts = _ts()
    x = golden.run("rs", ts)
    want = golden.run("outer", ts)
    await reset(dut)
    out = await stream(dut, ts_inputs(x, sop_every=None), ["data"], len(want))
    _check([o["data"] for o in out], want, "outer interleaver")


@cocotb.test()
async def inner_coder(dut):
    ts = _ts()
    x = golden.run("outer", ts, MOD, RATE)
    want = golden.run("inner", ts, MOD, RATE)
    dut.cfg_mod.value = MOD_CODE
    dut.cfg_rate.value = RATE_CODE
    await reset(dut)
    out = await stream(dut, ts_inputs(x, sop_every=None), ["sym"], len(want))
    _check([o["sym"] for o in out], want, "inner coder")


def sym_inputs(x) -> list[dict[str, int]]:
    return [{"s_sym": int(v)} for v in x]


@cocotb.test()
async def bit_interleaver(dut):
    ts = _ts()
    x = golden.run("inner", ts, MOD, RATE)
    want = golden.run("bit", ts, MOD, RATE)
    dut.cfg_mod.value = MOD_CODE
    await reset(dut)
    out = await stream(dut, sym_inputs(x), ["sym"], len(want))
    _check([o["sym"] for o in out], want, "bit interleaver")


@cocotb.test()
async def symbol_interleaver(dut):
    ts = _ts()
    x = golden.run("bit", ts, MOD, RATE)
    want = golden.run("symbol", ts, MOD, RATE)
    await reset(dut)
    out = await stream(dut, sym_inputs(x), ["sym", "sos"], len(want))
    _check([o["sym"] for o in out], want, "symbol interleaver")
    sos = [k for k, o in enumerate(out) if o["sos"]]
    assert sos == list(range(0, len(out), 1512)), "m_sos not on every 1512th symbol"


@cocotb.test()
async def fec_chain(dut):
    ts = _ts()
    want = golden.run("symbol", ts, MOD, RATE)
    dut.cfg_mod.value = MOD_CODE
    dut.cfg_rate.value = RATE_CODE
    await reset(dut)
    out = await stream(dut, ts_inputs(ts), ["sym", "sos"], len(want))
    _check([o["sym"] for o in out], want, "FEC chain")
    sos = [k for k, o in enumerate(out) if o["sos"]]
    assert sos == list(range(0, len(out), 1512)), "m_sos not on every 1512th symbol"


ONE = 8192  # fixed-point 1.0 in the mapper and frame builder


def _signed16(v: int) -> int:
    return v - 65536 if v >= 32768 else v


def _check_cplx(got_i, got_q, want: np.ndarray, what: str, tol: float = 1.0) -> None:
    """Fixed-point (1.0 = 8192) against gr-dtv's float, within ``tol`` LSB.

    Rounding to 1/8192 costs at most 0.5 LSB; the closest distinct points the
    stages can produce are ~2000 LSB apart, so 1 LSB is still exact in kind.
    """
    g = (np.array(got_i, dtype=np.float64) + 1j * np.array(got_q, dtype=np.float64)) / ONE
    n = min(len(g), len(want))
    assert n > 0, f"{what}: nothing to compare"
    err = np.abs(g[:n] - want[:n]) * ONE
    bad = np.nonzero(err > tol)[0]
    assert len(bad) == 0, (
        f"{what}: {len(bad)} of {n} off by > {tol} LSB; first at {bad[0]}: "
        f"got {g[bad[0]]:.5f} want {want[bad[0]]:.5f}"
    )
    cocotb.log.info("%s: %d cells within %.1f LSB of gr-dtv (max %.2f; %s, %s, seed %d)",
                    what, n, tol, err.max(), MOD, RATE, seed())


@cocotb.test()
async def mapper(dut):
    ts = _ts()
    x = golden.run("symbol", ts, MOD, RATE)
    want = golden.run("map", ts, MOD, RATE).astype(np.complex128)
    dut.cfg_mod.value = MOD_CODE
    await reset(dut)
    ins = [{"s_sym": int(v), "s_sos": int(k % 1512 == 0)} for k, v in enumerate(x)]
    out = await stream(dut, ins, ["i", "q", "sos"], len(want))
    _check_cplx([_signed16(o["i"]) for o in out], [_signed16(o["q"]) for o in out], want, "mapper")
    assert [k for k, o in enumerate(out) if o["sos"]] == list(range(0, len(out), 1512))


def _frame_outputs(out, want):
    _check_cplx([_signed16(o["i"]) for o in out], [_signed16(o["q"]) for o in out],
                want.reshape(-1), "frame")
    n_sym = len(out) // 1705
    assert [k for k, o in enumerate(out) if o["sos"]] == [s * 1705 for s in range(n_sym)]
    assert [k for k, o in enumerate(out) if o["sof"]] == [s * 1705 for s in range(0, n_sym, 68)]
    assert n_sym > 136, f"only {n_sym} symbols: need > 2 frames to cover frame wrap and TPS"


@cocotb.test()
async def frame_builder(dut):
    ts = _ts()
    mapped = golden.run("map", ts, MOD, RATE).astype(np.complex128)
    want = golden.carriers(ts, MOD, RATE)
    dut.cfg_mod.value = MOD_CODE
    dut.cfg_rate.value = RATE_CODE
    dut.cfg_guard.value = 2  # 1/8, as the golden model
    await reset(dut)
    q = np.round(mapped * ONE)
    ins = [{"s_i": int(a.real) & 0xFFFF, "s_q": int(a.imag) & 0xFFFF, "s_sos": int(k % 1512 == 0)}
           for k, a in enumerate(q)]
    out = await stream(dut, ins, ["i", "q", "sos", "sof"], want.size)
    _frame_outputs(out, want)
    assert int(dut.err_align.value) == 0, "err_align set on an aligned stream"


@cocotb.test()
async def carrier_chain(dut):
    ts = _ts()
    want = golden.carriers(ts, MOD, RATE)
    dut.cfg_mod.value = MOD_CODE
    dut.cfg_rate.value = RATE_CODE
    dut.cfg_guard.value = 2
    await reset(dut)
    out = await stream(dut, ts_inputs(ts), ["i", "q", "sos", "sof"], want.size, p_valid=0.9)
    _frame_outputs(out, want)
    assert int(dut.err_align.value) == 0, "err_align set"

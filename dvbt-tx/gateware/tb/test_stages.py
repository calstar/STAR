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

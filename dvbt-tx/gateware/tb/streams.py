"""Valid/ready stream driver + monitor for cocotb, with random stalls.

Every RTL block here registers its outputs and computes ``s_ready`` without
looking at ``s_valid`` (it may look at ``m_ready``), so the testbench works on
the falling edge: read the settled outputs, set ``m_ready``, let ``s_ready``
settle, then offer an input -- and know which transfers the next rising edge
makes.
"""

from __future__ import annotations

import os
import random
import sys
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, RisingEdge, Timer

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "model"))


def seed() -> int:
    return int(os.environ.get("TB_SEED", "1"))


async def reset(dut, cycles: int = 4) -> None:
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    dut.rst.value = 1
    dut.s_valid.value = 0
    dut.m_ready.value = 0
    for _ in range(cycles):
        await RisingEdge(dut.clk)
    dut.rst.value = 0


async def stream(
    dut,
    inputs: list[dict[str, int]],
    out_fields: list[str],
    n_out: int,
    p_valid: float = 0.7,
    p_ready: float = 0.7,
    max_cycles: int | None = None,
) -> list[dict[str, int]]:
    """Feed ``inputs`` (each a dict of ``s_<field>`` values) and collect
    ``n_out`` output transfers of ``m_<field>`` for each field in ``out_fields``.

    ``p_valid`` / ``p_ready`` are the chance per cycle that the testbench
    offers a byte / accepts one, so both handshake directions get exercised.
    """
    rng = random.Random(seed())
    outs: list[dict[str, int]] = []
    i = 0
    cycles = 0
    limit = max_cycles or 20 * (len(inputs) + n_out) + 1000
    while len(outs) < n_out:
        await FallingEdge(dut.clk)
        cycles += 1
        assert cycles < limit, f"stalled: {len(outs)}/{n_out} out, {i}/{len(inputs)} in"
        m_valid = int(dut.m_valid.value)
        # Outputs: settled values, transferred at the coming rising edge if we accept.
        accept = rng.random() < p_ready
        dut.m_ready.value = int(accept)
        if accept and m_valid:
            outs.append({f: int(getattr(dut, f"m_{f}").value) for f in out_fields})
        # s_ready may depend on m_ready combinationally: let it settle.
        await Timer(1, unit="ns")
        s_ready = int(dut.s_ready.value)
        # Inputs.
        offer = i < len(inputs) and rng.random() < p_valid
        if offer:
            for k, val in inputs[i].items():
                getattr(dut, k).value = val
        dut.s_valid.value = int(offer)
        if offer and s_ready:
            i += 1
    return outs


def ts_inputs(data, sop_every: int | None = 188) -> list[dict[str, int]]:
    """Byte stream as stream inputs, with ``s_sop`` every ``sop_every`` bytes."""
    if sop_every is None:
        return [{"s_data": int(b)} for b in data]
    return [{"s_data": int(b), "s_sop": int(k % sop_every == 0)} for k, b in enumerate(data)]


def first_mismatch(got, want) -> str:
    for k, (a, b) in enumerate(zip(got, want)):
        if a != b:
            lo = max(0, k - 3)
            return (
                f"first mismatch at {k}: got {a} want {b}; "
                f"got[{lo}:{k + 4}]={list(got[lo:k + 4])} want={list(want[lo:k + 4])}"
            )
    return "lengths differ" if len(got) != len(want) else "equal"

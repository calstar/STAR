"""pytest entry point: build each RTL top with Icarus and run its cocotb test.

    cd dvbt-tx/gateware && /usr/bin/python3.12 -m pytest -q -n auto test_rtl.py

python3.12 because Ubuntu's gnuradio bindings (the golden model) are built
for it; cocotb embeds the interpreter pytest runs under.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from cocotb_tools.runner import get_results, get_runner

HERE = Path(__file__).resolve().parent
# DVBT_RTL_DIR points the build at a mutated copy (scripts/mutation_check.py).
RTL = Path(os.environ.get("DVBT_RTL_DIR", HERE / "rtl"))
TB = HERE / "tb"

CASES = [
    # (toplevel, cocotb test, MOD, RATE[, N_PKT])
    ("dvbt_energy_dispersal", "energy_dispersal", "qpsk", "1/2"),
    ("dvbt_rs_encoder", "rs_encoder", "qpsk", "1/2"),
    ("dvbt_outer_interleaver", "outer_interleaver", "qpsk", "1/2"),
    *[
        ("dvbt_inner_coder", "inner_coder", m, r)
        for m in ("qpsk", "16qam", "64qam")
        for r in ("1/2", "2/3", "3/4", "5/6", "7/8")
    ],
    *[("dvbt_bit_interleaver", "bit_interleaver", m, "1/2") for m in ("qpsk", "16qam", "64qam")],
    *[("dvbt_symbol_interleaver", "symbol_interleaver", m, "1/2") for m in ("qpsk", "64qam")],
    ("dvbt_fec_chain", "fec_chain", "qpsk", "1/2"),
    ("dvbt_fec_chain", "fec_chain", "qpsk", "2/3"),
    ("dvbt_fec_chain", "fec_chain", "16qam", "1/2"),
    *[("dvbt_mapper", "mapper", m, "1/2") for m in ("qpsk", "16qam", "64qam")],
    # > 2 frames (136 OFDM symbols) of TS: frame wrap and every TPS field.
    ("dvbt_frame_builder", "frame_builder", "qpsk", "1/2", 160),
    ("dvbt_frame_builder", "frame_builder", "16qam", "3/4", 400),
    ("dvbt_carrier_chain", "carrier_chain", "qpsk", "1/2", 160),
    ("dvbt_carrier_chain", "carrier_chain", "64qam", "2/3", 576),
    # OFDM back end (tb/test_ofdm.py): FFT core vs numpy, modulator vs gr-dtv.
    ("dvbt_fft2048", "fft2048", "qpsk", "1/2"),
    ("dvbt_modulator", "modulator", "qpsk", "1/2", 48),
    ("dvbt_modulator", "modulator", "16qam", "3/4", 160),
    # Sample-rate back end (tb/test_dsp.py): trims + 4x interpolation.
    ("dvbt_interp", "interp", "qpsk", "1/2"),
    ("dvbt_interp", "interp_spectrum", "qpsk", "1/2"),
    ("dvbt_dac_out", "dac_out", "qpsk", "1/2"),
    # I/O (tb/test_io.py)
    ("dvbt_fifo", "fifo", "qpsk", "1/2"),
    ("dvbt_host", "host", "qpsk", "1/2"),
]
CASES = [c if len(c) == 5 else (*c, 48) for c in CASES]
OFDM_TESTS = {"fft2048", "modulator"}
DSP_TESTS = {"interp", "interp_spectrum", "dac_out"}
IO_TESTS = {"fifo", "host", "tx_core"}
PARAMS = {"dvbt_fifo": {"AW": 4}}  # small instances where the corners matter


@pytest.mark.parametrize("seed", [1, 2])
@pytest.mark.parametrize(
    "top,test,mod,rate,n_pkt", CASES, ids=[f"{c[1]}-{c[2]}-{c[3].replace('/', '')}" for c in CASES]
)
def test_rtl(top: str, test: str, mod: str, rate: str, n_pkt: int, seed: int) -> None:
    runner = get_runner("icarus")
    # One build directory per case, so pytest -n (xdist) runs don't collide.
    build_dir = Path(os.environ.get("DVBT_SIM_BUILD", HERE / "sim_build")) / f"{top}-{test}-{mod}-{rate.replace('/', '')}-{seed}"
    runner.build(
        sources=sorted(RTL.glob("*.v")) + sorted((TB / "models").glob("*.v")),
        hdl_toplevel=top,
        build_dir=build_dir,
        build_args=["-Wall"],
        defines={"DVBT_ROM_DIR": f'"{RTL}/rom"'},
        timescale=("1ns", "1ps"),
        parameters=PARAMS.get(top, {}),
        always=True,
    )
    # The filter matches the full name, "test_stages.<test>".
    results = runner.test(
        hdl_toplevel=top,
        test_module=("test_ofdm" if test in OFDM_TESTS else "test_dsp" if test in DSP_TESTS
                     else "test_io" if test in IO_TESTS else "test_stages"),
        test_dir=TB,
        build_dir=build_dir,
        test_filter=rf"\.{test}$",
        extra_env={"MOD": mod, "RATE": rate, "TB_SEED": str(seed), "N_PKT": str(n_pkt)},
        results_xml=str(build_dir / f"{test}-{mod}-{rate.replace('/', '')}-{seed}.xml"),
    )
    # The runner does not raise on a failed or missing test: check the results.
    n_tests, n_fail = get_results(results)
    assert n_tests == 1, f"expected 1 cocotb test to run, ran {n_tests}"
    assert n_fail == 0, f"cocotb test {test} failed (see log above)"

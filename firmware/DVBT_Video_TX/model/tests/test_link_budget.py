"""The RF chain's link budget, checked against arithmetic rather than itself.

Fast (about a second): a band-limited Gaussian stands in for the DAC's OFDM at
the FPGA's reset level (-13.5 dBFS RMS), so the PA sees the same average power
the end-to-end test drives it with. The numbers are the ones the design doc and
test/e2e/IMPAIRMENTS.md state: SNR about 17.6 dB at 15 km in the flight
profile, 12 dB above the 5.5 dB where the receiver starts to see errors.
"""
from __future__ import annotations

import dataclasses
import math
import sys
from pathlib import Path

import numpy as np
import pytest
from scipy import signal

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "model"), str(ROOT / "test/e2e")]
import impairments as I  # noqa: E402
import rf_chain  # noqa: E402

FS_DAC = 192e6 / 7            # Si5351A CLK1, the AD9116's sample rate
ERRORS_AT_SNR_DB = 5.5        # IMPAIRMENTS.md, noise row: errors at 5.5 dB (60 km)


@pytest.fixture(scope="module")
def iq(tmp_path_factory):
    rng = np.random.default_rng(1)
    x = rng.standard_normal(1 << 16) + 1j * rng.standard_normal(1 << 16)
    x = signal.lfilter(signal.firwin(255, 2.86e6, fs=FS_DAC), 1, x)
    x *= 2047 * 10 ** (-13.5 / 20) / np.sqrt(np.mean(np.abs(x) ** 2))
    p = tmp_path_factory.mktemp("rf") / "rf.iq"
    np.stack([x.real, x.imag], 1).round().astype(np.int16).tofile(p)
    return str(p)


def link(iq, **over):
    rep: dict = {}
    rf_chain.run(iq, FS_DAC, rf_chain.Chain().with_(**{**I.FLIGHT, **over}), report=rep)
    return rep


def test_flight_margin_at_15km(iq):
    snr = link(iq)["rx_snr_db"]
    assert abs(snr - 17.6) < 0.5, snr
    assert snr - ERRORS_AT_SNR_DB > 11.5, "the doc promises about 12 dB of margin at 15 km"


def test_rx_coax_costs_snr_db_for_db(iq):
    """No LNA: the coax sits in front of the UT-130B's noise figure."""
    base = link(iq)
    one_m = link(iq, rx_cable_loss_db=1.2)
    assert one_m["rx_snr_db"] == pytest.approx(base["rx_snr_db"] - 1.2, abs=1e-9)
    assert one_m["rx_power_dbm"] == pytest.approx(base["rx_power_dbm"] - 1.2, abs=1e-9)


def test_noise_figure_costs_snr_db_for_db(iq):
    assert link(iq, rx_nf_db=1.5)["rx_snr_db"] == pytest.approx(link(iq)["rx_snr_db"] + 4.5, abs=1e-9)


def test_free_space_goes_as_range_squared(iq):
    d = link(iq)["rx_snr_db"] - link(iq, range_m=40e3)["rx_snr_db"]
    assert d == pytest.approx(20 * math.log10(40 / 15), abs=1e-9)


def test_every_param_has_a_provenance():
    ch = rf_chain.Chain()
    bare = [f.name for f in dataclasses.fields(ch) if not getattr(ch, f.name).source.strip()]
    assert not bare, f"Params with no source: {bare}"

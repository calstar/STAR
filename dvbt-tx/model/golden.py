"""Golden vectors from GNU Radio's gr-dtv DVB-T transmitter blocks.

This module is the *reference* the RTL is checked against. It is deliberately
not our own model of EN 300 744: gr-dtv is an independent implementation that
real receivers have locked to, so agreeing with it is evidence; agreeing with a
model we wrote alongside the RTL would not be.

Needs the Ubuntu ``gnuradio`` package, whose Python bindings are built for the
system ``python3.12`` (run tests with ``/usr/bin/python3.12``).

Each ``run_*`` function pushes a numpy array through the gr-dtv chain from the
start of the transmitter up to and including the named stage, and returns the
flat output. Parameters are the flight default from the design doc:
2K, QPSK, code rate 1/2, guard 1/8, non-hierarchical.
"""

from __future__ import annotations

import numpy as np
from gnuradio import blocks, dtv, gr

TS_LEN = 188
RS_LEN = 204
SYNC = 0x47

MODES = {
    "qpsk": dtv.MOD_QPSK,
    "16qam": dtv.MOD_16QAM,
    "64qam": dtv.MOD_64QAM,
}
RATES = {"1/2": dtv.C1_2, "2/3": dtv.C2_3, "3/4": dtv.C3_4, "5/6": dtv.C5_6, "7/8": dtv.C7_8}

# Order matters: each stage feeds the next.
STAGES = ("energy", "rs", "outer", "inner", "bit", "symbol", "map", "frame")


def random_ts(n_packets: int, seed: int = 1) -> np.ndarray:
    """``n_packets`` MPEG-TS packets: sync byte 0x47 then random payload."""
    rng = np.random.default_rng(seed)
    pk = rng.integers(0, 256, size=(n_packets, TS_LEN), dtype=np.uint8)
    pk[:, 0] = SYNC
    return pk.reshape(-1)


def _chain(stage: str, constellation: str, rate: str):
    """The gr-dtv blocks from the transmitter input up to ``stage``.

    Returns (list of blocks, input item size, output vlen, output dtype).
    """
    c = MODES[constellation]
    r = RATES[rate]
    chain = [
        (dtv.dvbt_energy_dispersal(1), 1504),
        (dtv.dvbt_reed_solomon_enc(2, 8, 0x11D, 255, 239, 8, 51, 1), 204),
        (dtv.dvbt_convolutional_interleaver(136, 12, 17), 1),
        (dtv.dvbt_inner_coder(1, 1512, c, dtv.NH, r), 1512),
        (dtv.dvbt_bit_inner_interleaver(1512, c, dtv.NH, dtv.T2k), 1512),
        (dtv.dvbt_symbol_inner_interleaver(1512, dtv.T2k, 1), 1512),
        (dtv.dvbt_map(1512, c, dtv.NH, dtv.T2k, 1), 1512),
        (
            dtv.dvbt_reference_signals(
                gr.sizeof_gr_complex, 1512, 2048, c, dtv.NH, r, r, dtv.GI_1_8, dtv.T2k, 0, 0
            ),
            2048,
        ),
    ]
    n = STAGES.index(stage) + 1
    return chain[:n]


def run(stage: str, ts: np.ndarray, constellation: str = "qpsk", rate: str = "1/2") -> np.ndarray:
    """Push the byte stream ``ts`` through gr-dtv up to ``stage``; flat output."""
    chain = _chain(stage, constellation, rate)
    complex_out = STAGES.index(stage) >= STAGES.index("map")
    tb = gr.top_block()
    src = blocks.vector_source_b(ts.astype(np.uint8).tolist(), False, 1)
    prev = src
    for blk, _ in chain:
        # Adapt between the byte stream / vector item sizes the blocks expect.
        need = blk.input_signature().sizeof_stream_item(0)
        have = prev.output_signature().sizeof_stream_item(0)
        if need != have:
            # Through a byte stream: flatten, then regroup.
            if have != 1:
                flat = blocks.vector_to_stream(1, have)
                tb.connect(prev, flat)
                prev = flat
            if need != 1:
                grp = blocks.stream_to_vector(1, need)
                tb.connect(prev, grp)
                prev = grp
        tb.connect(prev, blk)
        prev = blk
    vlen = chain[-1][1]
    if complex_out:
        sink = blocks.vector_sink_c(vlen)
    else:
        sink = blocks.vector_sink_b(vlen)
    tb.connect(prev, sink)
    tb.run()
    if complex_out:
        return np.array(sink.data(), dtype=np.complex64)
    return np.array(sink.data(), dtype=np.uint8)

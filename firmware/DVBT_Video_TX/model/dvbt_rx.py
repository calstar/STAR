"""A DVB-T receiver from GNU Radio's gr-dtv blocks (2K mode), for the
end-to-end test: complex baseband at 48/7 MS/s in, transport stream out.

Independent of the transmitter under test: synchronisation (cyclic-prefix
correlation, then the pilots), channel estimation, demapping, Viterbi,
Reed-Solomon and descrambling are all gr-dtv's. The chain follows GNU
Radio's dvbt_rx_demo flowgraph.

    python3.12 -c 'import dvbt_rx; ...'   # gnuradio's bindings are built for 3.12
"""
from __future__ import annotations

import os
import tempfile

import numpy as np
from gnuradio import blocks, dtv, fft, gr
from gnuradio.fft import window

MODS = {"qpsk": dtv.MOD_QPSK, "16qam": dtv.MOD_16QAM, "64qam": dtv.MOD_64QAM}
RATES = {"1/2": dtv.C1_2, "2/3": dtv.C2_3, "3/4": dtv.C3_4, "5/6": dtv.C5_6, "7/8": dtv.C7_8}
GUARDS = {"1/32": (dtv.GI_1_32, 64), "1/16": (dtv.GI_1_16, 128), "1/8": (dtv.GI_1_8, 256),
          "1/4": (dtv.GI_1_4, 512)}


def receive(x: np.ndarray, constellation: str = "qpsk", rate: str = "1/2", guard: str = "1/8",
            snr_db: float = 30.0) -> bytes:
    """Demodulate complex baseband x (48/7 MS/s, 2K mode) to TS bytes. The
    output starts at the first packet the receiver recovered after locking
    (the decoder chain discards its start-up)."""
    c, r = MODS[constellation], RATES[rate]
    gi, cp = GUARDS[guard]
    with tempfile.TemporaryDirectory() as d:
        src_path, dst_path = os.path.join(d, "in.c64"), os.path.join(d, "out.ts")
        np.asarray(x, np.complex64).tofile(src_path)
        tb = gr.top_block()
        src = blocks.file_source(gr.sizeof_gr_complex, src_path, False)
        acq = dtv.dvbt_ofdm_sym_acquisition(1, 2048, 1705, cp, snr_db)
        dft = fft.fft_vcc(2048, True, window.rectangular(2048), True, 1)
        ref = dtv.dvbt_demod_reference_signals(gr.sizeof_gr_complex, 2048, 1512, c, dtv.NH, r, r,
                                               gi, dtv.T2k, 0, 0)
        demap = dtv.dvbt_demap(1512, c, dtv.NH, dtv.T2k, 1)
        sdi = dtv.dvbt_symbol_inner_interleaver(1512, dtv.T2k, 0)
        bdi = dtv.dvbt_bit_inner_deinterleaver(1512, c, dtv.NH, dtv.T2k)
        v2s = blocks.vector_to_stream(1, 1512)
        vit = dtv.dvbt_viterbi_decoder(c, dtv.NH, r, 768)
        cdi = dtv.dvbt_convolutional_deinterleaver(136, 12, 17)
        rs = dtv.dvbt_reed_solomon_dec(2, 8, 0x11D, 255, 239, 8, 51, 8)
        des = dtv.dvbt_energy_descramble(8)
        dst = blocks.file_sink(1, dst_path, False)
        dst.set_unbuffered(False)
        tb.connect(src, acq, dft, ref, demap, sdi, bdi, v2s, vit, cdi, rs, des, dst)
        tb.run()
        dst.close()
        return open(dst_path, "rb").read()


def ofdm_time(car: np.ndarray, guard_len: int = 256) -> np.ndarray:
    """Carriers (symbols x 1705) to 48/7 MS/s baseband with cyclic prefix,
    the way a DVB-T transmitter's IFFT does it (for testing the receiver)."""
    n = 2048
    bins = np.zeros((len(car), n), complex)
    bins[:, [(k - 852) % n for k in range(1705)]] = car
    t = np.fft.ifft(bins, axis=1)
    return np.concatenate([t[:, -guard_len:], t], axis=1).reshape(-1)

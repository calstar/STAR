"""Sample-by-sample model of the radix-2^2 single-path delay-feedback FFT that
rtl/dvbt_fft_r22sdf.v implements, used to check its *structure* (control,
trivial -j rotations, twiddle indices, bit-reversed output) against numpy
before it is written in Verilog. The RTL itself is checked against numpy's
FFT and against gr-dtv, never against this model.

Decimation in frequency, N = 2048 = 4^5 * 2: five R2^2 stage pairs
(butterfly spans L = 1024, 256, 64, 16, 4 and half of each), a twiddle
multiplier after each pair, then a last radix-2 stage of span 1.

Derivation for one pair of sub-FFT size M = 2L: stage A's DIF twiddle on its
bottom half is W_M^n, n = n1 L/2 + n2. W_M^n = (-j)^n1 W_M^n2; the (-j)^n1 part
is applied in place (a swap and a negation), and W_M^n2, being common to both
inputs of stage B's butterfly, is moved past it and merged with stage B's own
twiddle into one multiplier: W_M^(n2 (h + 2 b)), h = which half of A's output,
b = which half of B's output.
"""

from __future__ import annotations

import numpy as np

N = 2048


def stage(x: np.ndarray, L: int, rot: bool) -> np.ndarray:
    """One SDF radix-2 DIF butterfly stage of span L over a stream of blocks.

    Per block of 2L: out = [a + b for the pairs, then a - b], where a is the
    first half and b the second. With ``rot`` the bottom outputs whose index
    within the half is >= L/2 are multiplied by -j (stage A of a pair).
    """
    out = np.empty_like(x)
    for blk in range(0, len(x), 2 * L):
        a = x[blk : blk + L]
        b = x[blk + L : blk + 2 * L]
        bot = a - b
        if rot:
            bot = bot.copy()
            bot[L // 2 :] *= -1j
        out[blk : blk + L] = a + b
        out[blk + L : blk + 2 * L] = bot
    return out


def twiddle_after_pair(x: np.ndarray, M: int) -> np.ndarray:
    """Multiplier after a pair of sub-FFT size M: W_M^(n2 (h + 2b))."""
    L = M // 2
    out = x.copy()
    for t in range(len(x)):
        q = t % M          # position in the pair's block
        h = q // L         # 0: from A's top, 1: from A's bottom
        r = q % L
        b = r // (L // 2)  # 0: B's top, 1: B's bottom
        n2 = r % (L // 2)
        out[t] = x[t] * np.exp(-2j * np.pi * n2 * (h + 2 * b) / M)
    return out


def fft_r22sdf(x: np.ndarray) -> np.ndarray:
    """Forward FFT of one 2048 block, output in bit-reversed order."""
    y = x.astype(np.complex128)
    M = N
    while M >= 8:
        L = M // 2
        y = stage(y, L, rot=True)
        y = stage(y, L // 2, rot=False)
        y = twiddle_after_pair(y, M)
        M //= 4
    return stage(y, 1, rot=False)


def bitrev(n: int, bits: int = 11) -> int:
    return int(f"{n:0{bits}b}"[::-1], 2)


if __name__ == "__main__":
    rng = np.random.default_rng(0)
    x = rng.standard_normal(N) + 1j * rng.standard_normal(N)
    y = fft_r22sdf(x)
    ref = np.fft.fft(x)
    nat = np.empty_like(y)
    for i in range(N):
        nat[bitrev(i)] = y[i]
    print("max error vs numpy:", np.abs(nat - ref).max())

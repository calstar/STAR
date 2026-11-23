#!/usr/bin/env python3
"""Print the DVB RS(204,188) generator polynomial coefficients g0..g16.

g(x) = (x + a^0)(x + a^1)...(x + a^15) over GF(2^8) with p(x) = 0x11D, a = 2
(EN 300 744 §4.3.2). These are the constants in rtl/dvbt_rs_encoder.v.
Expected: 3b 24 32 62 e5 29 41 a3 08 1e d1 44 bd 68 0d 3b 01.
"""


def gf_mul(a: int, b: int) -> int:
    r = 0
    while b:
        if b & 1:
            r ^= a
        a <<= 1
        if a & 0x100:
            a ^= 0x11D
        b >>= 1
    return r


def generator() -> list[int]:
    g = [1]
    root = 1
    for _ in range(16):
        nxt = [0] * (len(g) + 1)
        for j, c in enumerate(g):
            nxt[j] ^= gf_mul(c, root)
            nxt[j + 1] ^= c
        g = nxt
        root = gf_mul(root, 2)
    return g


if __name__ == "__main__":
    print(" ".join(f"{c:02x}" for c in generator()))

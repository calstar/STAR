#!/usr/bin/env python3
"""Fixed-point constellation and pilot levels for rtl/dvbt_mapper.v and
rtl/dvbt_frame_builder.v: round(8192 * level / sqrt(norm)), 1.0 = 8192."""
from math import sqrt

ONE = 8192
print("QPSK  1:", round(ONE / sqrt(2)))
print("16QAM 1, 3:", [round(ONE * a / sqrt(10)) for a in (1, 3)])
print("64QAM 1, 3, 5, 7:", [round(ONE * a / sqrt(42)) for a in (1, 3, 5, 7)])
print("pilot 4/3:", round(ONE * 4 / 3), " TPS 1:", ONE)

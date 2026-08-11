"""Port of OpenRocket's ``info.openrocket.core.motor.MotorDigest`` (release-24.12).

A motor "digest" is an MD5 over a quantised, byte-exact serialisation of a motor's
functional data (time / mass / CG / thrust). OpenRocket uses it to recognise when two
motor files describe the same motor. We port it verbatim for one reason: it lets our
parsers be validated **byte-for-byte** against OpenRocket's own JUnit fixtures
(``TestMotorLoader``'s DIGEST1/2/3), which is a far stronger check than eyeballing arrays.

The quantisation and byte layout must match Java exactly, so three details are load-bearing:

* ``next(v) = v + signum(v)*EPSILON`` is applied **twice** -- once before and once after
  multiplying by the type's scale -- to keep values off rounding boundaries.
* Rounding is Java ``Math.round``: ``floor(v + 0.5)`` (NOT Python's banker's rounding).
* Integers are written big-endian two's-complement in 4 bytes, matching Java's ``>>>``.

Updates must be issued in strictly increasing ``DataType`` order; the loaders below rely on
that ordering, mirroring how ``RASPMotorLoader``/``RockSimMotorLoader`` build their digests.
"""

from __future__ import annotations

import hashlib
import math
from enum import Enum

_EPSILON = 0.00000000001


class DataType(Enum):
    """(order, multiplier) exactly as in MotorDigest.DataType."""

    TIME_ARRAY = (0, 1000)  # seconds -> ms
    MASS_SPECIFIC = (1, 10000)  # kg -> 0.1 g
    MASS_PER_TIME = (2, 10000)  # kg -> 0.1 g
    CG_SPECIFIC = (3, 1000)  # m -> mm
    CG_PER_TIME = (4, 1000)  # m -> mm
    FORCE_PER_TIME = (5, 1000)  # N -> mN

    @property
    def order(self) -> int:
        return self.value[0]

    @property
    def multiplier(self) -> int:
        return self.value[1]


def _next(v: float) -> float:
    # Math.signum(0.0) == 0.0, so zero is left untouched, as in Java.
    sign = 0.0 if v == 0 else math.copysign(1.0, v)
    return v + sign * _EPSILON


def _round_half_up(v: float) -> int:
    # Java Math.round(double) == floor(v + 0.5), then narrowed to int.
    return int(math.floor(v + 0.5))


def _int_bytes(value: int) -> bytes:
    # Big-endian two's-complement 4 bytes, matching Java's byte() >>> layout.
    return (value & 0xFFFFFFFF).to_bytes(4, "big")


class MotorDigest:
    def __init__(self) -> None:
        self._md5 = hashlib.md5()
        self._last_order = -1
        self._used = False

    def update(self, data_type: DataType, *values: float) -> None:
        multiplier = data_type.multiplier
        int_values = []
        for v in values:
            v = _next(v)
            v *= multiplier
            v = _next(v)
            int_values.append(_round_half_up(v))
        self._update_ints(data_type, int_values)

    def _update_ints(self, data_type: DataType, values: list[int]) -> None:
        if self._last_order >= data_type.order:
            raise ValueError(
                f"Called with type={data_type} order={data_type.order} "
                f"while lastOrder={self._last_order}"
            )
        self._last_order = data_type.order
        self._md5.update(_int_bytes(data_type.order))
        self._md5.update(_int_bytes(len(values)))
        for v in values:
            self._md5.update(_int_bytes(v))

    def hexdigest(self) -> str:
        if self._used:
            raise RuntimeError("MotorDigest already used")
        self._used = True
        return self._md5.hexdigest()

"""Motor thrust-curve database: OpenRocket-faithful parsers + thrustcurve.org mirror.

Ports of OpenRocket's RASP/RockSim loaders (``rasp``, ``rocksim``) produce ``Motor``
objects whose mass/CG behaviour -- and digests -- match OpenRocket bit-for-bit. The
``thrustcurve``/``fetch``/``db`` modules mirror the thrustcurve.org catalog offline.
"""

from __future__ import annotations

from .motor import Motor
from .rasp import load_rasp
from .rocksim import load_rocksim


def load_motor_text(filename: str, text: str) -> list[Motor]:
    """Dispatch on file extension, mirroring GeneralMotorLoader for the two text formats."""
    lower = filename.lower()
    if lower.endswith(".rse"):
        return load_rocksim(text)
    if lower.endswith(".eng"):
        return load_rasp(text)
    raise ValueError(f"Unsupported motor file type: {filename}")


__all__ = ["Motor", "load_rasp", "load_rocksim", "load_motor_text"]

"""Where gauge and absolute pressure meet, and nowhere else.

Every pressure inside the model is absolute -- the equation of state, the
choking ratios and the regulator all need it that way. Every pressure a person
reads or types on a stand is gauge, because that is what a PT with atmosphere
cancelled out reports and what the dial on a regulator is marked in.

:func:`psig` and :func:`from_psig` are the only two places the two meet. Moved
here from the feed-twin app (``backend/run.py``, which re-exports them) when the
marching session became library code, so a second caller -- EngineDesign's
Layer X -- converts through the same two functions rather than its own.

The zero is the **standard** atmosphere, deliberately and only for gauge
readings: it is the convention the stand's DAQ and the cockpit share. A caller
that knows the absolute pressure it wants (an engine config states psia) should
convert with :func:`from_psig` of ``(p_abs - ATMOSPHERE) / PSI`` -- which is
exact -- rather than assume its site's atmosphere is this one.
"""

from __future__ import annotations

from feedtwin.model.units import get_unit

#: One psi [Pa].
PSI: float = get_unit("psi").factor

#: Standard atmosphere [Pa]. The zero of every gauge on the stand.
ATMOSPHERE = 101325.0


def psig(pascal: float) -> float:
    """Absolute pressure [Pa] as the stand's transducers would read it [psig].

    A vented vessel reads 0.0, not 14.7.
    """
    return (pascal - ATMOSPHERE) / PSI


def from_psig(gauge: float) -> float:
    """A gauge reading or dial setting [psig] as the absolute pressure the model
    integrates [Pa]."""
    return gauge * PSI + ATMOSPHERE


def psig_from_psia(psia: float) -> float:
    """An absolute pressure stated in psia, as the gauge reading [psig] that
    :func:`from_psig` turns back into exactly ``psia * PSI`` pascals."""
    return (psia * PSI - ATMOSPHERE) / PSI

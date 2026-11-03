"""Where gauge and absolute pressure meet, and what a person is shown.

Every pressure inside the model is absolute -- the equation of state, the
choking ratios and the regulator all need it that way. Every pressure a person
reads or types is absolute too, in psia (ADR 0007): the slides, the datasheets
and EngineDesign all quote psia, and a screen that said psig sat 14.7 psi off
every one of them.

What crosses the wire and what is saved stays **gauge**: a knob's ``psig``, the
API's ``*_psi`` fields, run records, hookups, stand documents. That is what the
stand's DAQ logs and what every saved file already holds; changing it would
make each old record mean something else. :func:`psig` and :func:`from_psig`
are the only two places the wire meets the model. Moved here from the
feed-twin app when the marching session became library code, so a second
caller -- EngineDesign's Layer X -- converts through the same two functions
rather than its own.

Text meant for people goes through :func:`say`, which prints psia from the
model's own absolute pascals (it and :func:`psia` live in
:mod:`feedtwin.model.pressure`, so the drawing reader can use them without
importing the session; this is their address). A difference -- a bias, a
droop, a sag, a residual -- is the same size either way and is written in
plain psi.

The zero is the **standard** atmosphere, deliberately and only for gauge
readings: it is the convention the stand's DAQ and the cockpit share. A caller
that knows the absolute pressure it wants (an engine config states psia) should
convert with :func:`from_psig` of ``(p_abs - ATMOSPHERE) / PSI`` -- which is
exact -- rather than assume its site's atmosphere is this one.
"""

from __future__ import annotations

from feedtwin.model.pressure import psia as psia
from feedtwin.model.pressure import say as say
from feedtwin.model.units import get_unit

#: One psi [Pa].
PSI: float = get_unit("psi").factor

#: Standard atmosphere [Pa]. The zero of every gauge on the stand.
ATMOSPHERE = 101325.0

#: Standard atmosphere [psia], 14.696: what a gauge number on the wire gains to
#: be shown as psia, and what a vented vessel reads.
ATMOSPHERE_PSI: float = ATMOSPHERE / PSI


def psig(pascal: float) -> float:
    """Absolute pressure [Pa] as the stand's transducers log it [psig].

    A vented vessel reads 0.0, not 14.7. For the wire and saved files; text a
    person reads goes through :func:`say`.
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

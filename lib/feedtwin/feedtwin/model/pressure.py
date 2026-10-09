"""Which pressures on a drawing are absolute, which are differences, and what a
bare "psi" means.

The model works in absolute pascals. People do not: a tank "at 500 psi" is at
500 psig, a COPV "at 4500" is at 4500 psig, a regulator "set to 500" holds 500 on
a gauge. Every shipped drawing's own notes say so ("500 psig operating
pressure", "bottle gauge", "gives 550 at the tanks"). The library used to read a
bare "psi" as absolute, so every one of those was 14.7 psi low -- the drawn dome
loader disagreed with the dome knob by an atmosphere, a delivered bottle started
an atmosphere under its own fill target, and the Hookup tab printed a psia number
labelled psig.

So on a drawing, two rules, both here and nowhere else:

* **An absolute pressure written bare is gauge.** ``psi`` on a tank's
  ``pressure`` or a regulator's ``setpoint`` reads as ``psig``; ``bar`` as
  ``barg``, ``kPa`` as ``kPag``. Write ``psia`` (``bara``, ``kPaa``) to mean
  absolute. ``atm`` is absolute by nature and stays so.
* **Except at the engine.** A chamber pressure is quoted absolute, by long
  convention and everywhere EngineDesign quotes one; on an ENGINE or INJECTOR
  symbol a bare pressure is read as absolute.
* **A difference never carries a reference.** A droop, a dome bias, a crack or
  relief set pressure is the same size in psia and psig; ``psig`` on one is a
  drawing error, refused with the parameter named, because an atmosphere
  silently added to a 50 psi bias is a 65 psi bias.

A pressure parameter in neither list is read as absolute -- what nearly every
pressure on a drawing is -- so a field pid-designer adds tomorrow still imports.
``tests/test_pressure_reference.py`` fails until it is listed here, which is what
keeps the lists complete.
"""

from __future__ import annotations

from feedtwin.model.units import get_unit

#: Pressures measured from zero: what a gauge or a transducer reads at a place.
ABSOLUTE = frozenset(
    {
        "pressure",  # a tank, bottle, dewar or source boundary
        "chamber_pressure",
        "setpoint",  # a regulator's outlet
        "dome_pressure",
        "inlet_reference",  # retired: the supply effect is measured from zero inlet
        "MAWP",
        "burst_pressure",
        "range_max",  # an instrument's full scale
        "range_min",
    }
)

#: Pressures that are a difference between two places.
DIFFERENCE = frozenset(
    {
        "dome_bias",
        "flow_droop",
        "lockup_rise",
        "cracking_pressure",
        "set_pressure",  # a relief's, across the valve
        "reseat_pressure",
        "min_inlet_differential",
        "pressure_drop",
        "dp",
    }
)

#: A bare spelling's gauge counterpart.
GAUGE = {"psi": "psig", "bar": "barg", "kPa": "kPag", "MPa": "MPag", "Pa": "Pag"}
#: Spellings that say which reference they are.
QUALIFIED = frozenset(
    {"psia", "bara", "kPaa", "MPaa", "psig", "barg", "kPag", "MPag", "Pag", "atm"}
)


class PressureReferenceError(ValueError):
    """A pressure on a drawing whose reference cannot be read."""


#: Symbols whose pressures are quoted absolute: the chamber.
ABSOLUTE_SYMBOLS = frozenset({"ENGINE", "INJECTOR"})


def drawn_unit(name: str, unit: str, symbol: str = "") -> str:
    """The unit a drawing's ``name`` parameter is really in.

    Not a pressure: unchanged. A difference: unchanged, unless it names a
    reference, which is refused. Anything else is an absolute pressure, and
    written bare it is its gauge spelling.
    """
    if get_unit(unit).dimension != "pressure":
        return unit
    if name in DIFFERENCE:
        if unit in QUALIFIED:
            raise PressureReferenceError(
                f"{name} is a pressure difference; write it in {_bare(unit)}, not "
                f"{unit} -- a difference has no gauge or absolute reference"
            )
        return unit
    if symbol in ABSOLUTE_SYMBOLS:
        return unit
    return GAUGE.get(unit, unit)


def _bare(unit: str) -> str:
    for bare, gauge in GAUGE.items():
        if unit in (gauge, bare + "a"):
            return bare
    return "psi"

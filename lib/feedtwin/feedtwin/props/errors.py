"""Property-layer errors.

Three, and the distinction between them is what makes the fallback chain in
:mod:`feedtwin.props.fluid` possible rather than a pile of ``except Exception``.

``OutOfRange`` in particular is the load-bearing one: a fast tabulated backend
refusing a state point is *routine* -- it means "ask a slower backend" -- while
any other failure is a real error that must not be swallowed.
"""

from __future__ import annotations


class PropertyError(Exception):
    """Base for every failure in the property layer."""


class OutOfRange(PropertyError):
    """A backend was asked for a state point outside its validity envelope.

    Routine, not exceptional: tabulated backends cover a bounded region and
    raising here is how they say so. The fluid's backend chain catches this and
    tries the next backend. It is a bug to treat it as fatal without first
    exhausting the chain, and a worse bug to catch it and return a number.
    """

    def __init__(self, backend: str, fluid: str, detail: str) -> None:
        super().__init__(f"{backend} has no coverage for {fluid}: {detail}")
        self.backend = backend
        self.fluid = fluid
        self.detail = detail


class UnsupportedProperty(PropertyError):
    """A backend cannot compute a property that another backend can.

    Real and specific: CoolProp's BICUBIC tables implement density, viscosity
    and conductivity but not ``compressibility_factor``. Like OutOfRange this
    is answered by falling through the chain rather than by failing the call --
    but unlike OutOfRange it is a property of the backend, not of the state, so
    it can be answered once instead of per state point.
    """

    def __init__(self, backend: str, prop: str) -> None:
        super().__init__(f"backend {backend!r} does not implement {prop!r}")
        self.backend = backend
        self.prop = prop


class UnknownFluid(PropertyError):
    """No species by that name or alias is registered."""

    def __init__(self, name: str, known: list[str]) -> None:
        import difflib

        close = difflib.get_close_matches(name.lower(), known, n=3, cutoff=0.4)
        hint = f" Did you mean {', '.join(repr(c) for c in close)}?" if close else ""
        super().__init__(
            f"unknown fluid {name!r}.{hint} Registered: "
            f"{', '.join(sorted(known))}. Add it to feedtwin/props/species.toml, "
            "or register it at runtime with feedtwin.props.register_species()."
        )
        self.name = name

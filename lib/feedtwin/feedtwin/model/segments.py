"""A line's loss, as the drawing states it.

A P&ID line is rarely one bore of one length. It is a run: some tube, an elbow,
a reducer, more tube, a tee. `pid-designer` records exactly that -- an itemised
list of segments, each with a tube size, a bore, a developed length and a
counted list of fittings -- and this module is the shape that list arrives in.

How a loss is known, and which one wins
---------------------------------------
A segment declares one method. They are ordered by authority, and exactly one is
in force -- the vocabulary and the order are the drawing's, reproduced here
rather than reinvented:

1. ``curve``      -- Delta p against mdot from a cold flow. Beats everything.
2. ``measured_K`` -- one K fitted from a run. Same authority, less data.
3. ``itemised``   -- tube size, length, fittings. The correlations are used here.
4. ``lumped_K``   -- one K somebody estimated.
5. ``unstated``   -- nothing said; defaulted, and reported unchecked.

The point of the order is that "how well do we know this line" stops being a
matter of opinion. A line that has been flowed has a number that beats every
correlation; a line that has not been built yet has an itemised estimate. Both
are first-class, and which one is in force is never ambiguous.

The trap this module exists to avoid
------------------------------------
**A fitting's K already contains its own friction.** Crane TP-410, Hooper 2K and
Darby 3K all price the whole fitting -- the flow through it, not just the extra
loss over an equivalent length of tube. So if a run is measured end to end and
that number is used as ``L`` *while* the elbows in it are also counted as K, the
elbows get paid for twice.

On a 1.6 m run with three long-radius elbows at r/D 1.5 in a 10 mm bore, the
arcs are about 71 mm of the total: a 4.4% over-count of length. Friction is
roughly half the loss on a run like that, so it is about 2% on Delta p -- the
same order as miscounting an elbow, and in the same direction every time.

So the friction term uses the **tube** length, and fittings contribute **K
only**. A fitting's body length is not a loss input; it is recorded for the cut
list, which is the fabricator's problem. That is what :attr:`LineSegment.length_basis`
is for: ``"tube"`` means the stated length is already just tube, and
``"overall"`` means it is end to end and the fitting bodies have to come out of
it before it is used as ``L``.
"""

from __future__ import annotations

from dataclasses import dataclass

from feedtwin.model.curve import Curve
from feedtwin.model.param import Param

#: Loss methods, ordered by authority. Lower index wins.
LOSS_METHODS: tuple[str, ...] = (
    "curve",
    "measured_K",
    "itemised",
    "lumped_K",
    "unstated",
)

#: What a segment means when it does not say.
#:
#: The drawing's own default. A segment exists because somebody started
#: itemising it, so reading a silent one as ``unstated`` would throw away the
#: fittings they had already counted.
DEFAULT_METHOD = "itemised"


def method_rank(method: str) -> int:
    """Where a method sits on the ladder. Unknown methods rank last."""
    try:
        return LOSS_METHODS.index(method)
    except ValueError:
        return len(LOSS_METHODS)


@dataclass(frozen=True, slots=True)
class Fitting:
    """One kind of fitting, counted.

    ``kind`` is the drawing's vocabulary, which is deliberately identical to
    :func:`feedtwin.comps.correlations.registered_fittings` -- no mapping table
    stands between the drawing and the correlation. A kind this library cannot
    price is kept and reported rather than dropped: the drawing is allowed to be
    ahead of the solver, and a silently ignored elbow is worse than a warning.
    """

    kind: str
    count: int = 1
    bore: float = 0.0
    """Through-bore [m]. Zero means "use the segment's bore"."""
    length: float = 0.0
    """Body length [m]. **Not a loss input** -- see the module docstring."""
    engagement: float = 0.0
    """Thread engagement [m]. For the cut list, not the solve."""
    K: float = 0.0
    """An explicit K for this fitting, overriding the correlation. Zero means
    "price it"."""


@dataclass(frozen=True, slots=True)
class LineSegment:
    """One length of one bore, with whatever is fitted to it."""

    id: str
    method: str = DEFAULT_METHOD
    bore: Param | None = None
    length: Param | None = None
    roughness: Param | None = None
    elevation_change: Param | None = None
    K: Param | None = None
    length_basis: str = "tube"
    tube_size: str = ""
    standard: str = ""
    fittings: tuple[Fitting, ...] = ()
    curve: Curve | None = None
    """Measured Delta p against mdot. A :class:`~feedtwin.model.curve.Curve`,
    so it carries its own units and provenance and is evaluated in SI like
    every other curve in the library."""

    @property
    def has_curve(self) -> bool:
        return self.curve is not None

    @property
    def bore_si(self) -> float:
        """Flow diameter [m], or zero if the segment does not state one."""
        return self.bore.si if self.bore is not None else 0.0

    @property
    def stated_length(self) -> float:
        """The length as written [m], whatever its basis."""
        return self.length.si if self.length is not None else 0.0

    def tube_length(self) -> float:
        """Straight tube in this segment [m], with fitting bodies removed.

        With ``length_basis == "overall"`` the stated length runs end to end, so
        each fitting's body less its thread engagement comes out -- otherwise the
        fittings are paid for twice, once as K and once as the tube they
        displace.

        This refuses to guess. If the basis is overall and any fitting has no
        body length, the stated length is returned whole; the reader has already
        warned about it. A partial subtraction is a wrong number that looks
        careful, which is worse than a stated one that is flagged.
        """
        stated = self.stated_length
        if self.length_basis != "overall" or not self.fittings:
            return stated
        if any(f.length <= 0.0 for f in self.fittings):
            return stated
        bodies = sum((f.length - f.engagement) * f.count for f in self.fittings)
        return max(stated - bodies, 0.0)


@dataclass(frozen=True, slots=True)
class LineLoss:
    """Every segment on one line, and the method in force across it."""

    segments: tuple[LineSegment, ...] = ()
    warnings: tuple[str, ...] = ()

    def __bool__(self) -> bool:
        return bool(self.segments)

    def __len__(self) -> int:
        return len(self.segments)

    @property
    def method(self) -> str:
        """The most authoritative method any segment declares.

        One line, one label. A run that is half flowed and half estimated is
        reported as well as its *best*-known part claims -- which is why this is
        a maximum over the ladder and not a mixture. It is a description of the
        line, not the recipe: each segment is still evaluated by its own method.
        """
        if not self.segments:
            return "unstated"
        return min((s.method for s in self.segments), key=method_rank)

    @property
    def weakest_method(self) -> str:
        """The least authoritative method on the line.

        The one worth acting on. A run is only as trustworthy as its worst
        segment, so this is what a "which lines still need flowing" report reads.
        """
        if not self.segments:
            return "unstated"
        return max((s.method for s in self.segments), key=method_rank)

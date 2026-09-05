"""Helpers ported from OpenRocket's ``AbstractMotorLoader`` (release-24.12).

These are the correctness core shared by the RASP and RockSim loaders: mass is
reconstructed from the thrust curve assuming a constant exhaust velocity, and the
thrust curve is cleaned up (leading zero point, duplicate points) exactly the way
OpenRocket does. Reproduced line-for-line so the resulting motors -- and their
digests -- match OpenRocket bit-for-bit.

Lists are mutated in place to mirror the Java control flow (including one place where
OpenRocket removes a point from time/thrust but not the parallel lists; see
``finalize_thrust_curve``).
"""

from __future__ import annotations

import re

_EPSILON = 0.00000001  # MathUtil.EPSILON


def math_equals(a: float, b: float, epsilon: float = _EPSILON) -> bool:
    """Relative equality, matching ``MathUtil.equals``."""
    absb = abs(b)
    if absb < epsilon / 2:
        return abs(a) < epsilon / 2
    return abs(a - b) < epsilon * absb


def split(string: str, delim: str | None = None) -> list[str]:
    """Tokenise like ``AbstractMotorLoader.split``.

    Whitespace split (``delim=None``) uses Python's own splitter, which already drops
    the leading/trailing empties Java strips. For an explicit regex delimiter we mirror
    Java ``String.split`` (drop trailing empties) plus the leading-empty removal.
    """
    if delim is None:
        return string.split()
    pieces = re.split(delim, string)
    while pieces and pieces[-1] == "":
        pieces.pop()
    if pieces and pieces[0] == "":
        pieces = pieces[1:]
    return pieces


def remove_delay(designation: str) -> str:
    """Strip a trailing ``-<delay>`` or ``-P`` from a designation."""
    if re.search(r"-([0-9]+|[pP])$", designation):
        return designation[: designation.rfind("-")]
    return designation


def calculate_mass(
    time: list[float], thrust: list[float], total: float, prop: float
) -> list[float]:
    """Mass at each time point from initial/propellant mass and the thrust curve.

    Assumes constant exhaust velocity (F = m'·v), so the mass consumed between two
    samples is proportional to the impulse over that interval. Ported verbatim from
    ``AbstractMotorLoader.calculateMass``.
    """
    deltam: list[float] = []
    t0 = time[0]
    f0 = thrust[0]
    total_mass_change = 0.0
    for i in range(1, len(time)):
        t1 = time[i]
        f1 = thrust[i]
        dm = 0.5 * (f0 + f1) * (t1 - t0)
        deltam.append(dm)
        total_mass_change += dm
        t0 = t1
        f0 = f1

    mass = [total]
    scale = prop / total_mass_change
    for dm in deltam:
        total -= dm * scale
        if total < 0:  # correct rounding-induced negative mass
            total = 0.0
        mass.append(total)
    return mass


def finalize_thrust_curve(
    time: list[float], thrust: list[float], *lists: list
) -> None:
    """Clean up a raw thrust curve in place, matching ``finalizeThrustCurve``.

    ``lists`` are extra parallel lists (mass, cg) kept in step with time/thrust --
    except in the double-zero-at-start branch, where OpenRocket edits only time/thrust,
    which we replicate deliberately.
    """
    if len(time) == 0:
        return

    # If there is no datapoint at t=0, add one (normal for RASP files).
    if not math_equals(time[0], 0):
        time.insert(0, 0.0)
        thrust.insert(0, 0.0)
        for l in lists:
            l.insert(0, l[0])

    # Two points at t=0, one zero-thrust: drop the first (time/thrust only, as in Java).
    if math_equals(time[0], 0) and math_equals(time[1], 0):
        time.pop(0)
        thrust.pop(0)

    # Duplicate consecutive (time, thrust) points: drop the duplicates.
    i = 0
    while i < len(time) - 1:
        while (
            i < len(time) - 1
            and math_equals(time[i], time[i + 1])
            and math_equals(thrust[i], thrust[i + 1])
        ):
            time.pop(i)
            thrust.pop(i)
            for l in lists:
                l.pop(i)
        i += 1

    # Two final points at the same time, one zero-thrust: drop the zero one.
    n = len(time) - 1
    if math_equals(time[n - 1], time[n]):
        if math_equals(thrust[n - 1], 0):
            time.pop(n - 1)
            thrust.pop(n - 1)
            for l in lists:
                l.pop(n - 1)
        elif math_equals(thrust[n], 0):
            time.pop(n)
            thrust.pop(n)
            for l in lists:
                l.pop(n)


def sort_lists(primary: list[float], *lists: list) -> None:
    """Stable co-sort of parallel lists by ``primary`` (usually already sorted).

    Mirrors ``AbstractMotorLoader.sortLists`` -- a bubble sort, kept because the data is
    essentially sorted already and matching the exact permutation keeps digests identical.
    """
    while True:
        swapped = False
        for index in range(len(primary) - 1):
            if primary[index + 1] < primary[index]:
                primary[index], primary[index + 1] = primary[index + 1], primary[index]
                for l in lists:
                    l[index], l[index + 1] = l[index + 1], l[index]
                swapped = True
                break
        if not swapped:
            break

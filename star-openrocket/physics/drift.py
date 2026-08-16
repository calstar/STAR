"""Downwind drift under recovery. PLAN.md §21 (Phase 2).

Now a thin reader over the **coupled** descent: `solver.integrate` carries the
horizontal ground position `(x, y)` in its state, integrating the real
equation of horizontal motion --

    m dv_h/dt = -0.5 rho CdS |v_rel| (v_h - v_wind(z))

so the canopy relaxes toward the local wind over the drag time
`tau = 2m/(rho CdS |v_rel|)` rather than matching it instantly. That captures
both the apogee lateral velocity (carried, then decaying) and the vehicle
lagging a *changing* wind through shear -- neither of which the old
`v_horizontal(z) = v_wind(z)` post-process could represent. With no wind and no
lateral velocity the track is identically zero, exactly as before.

Assumptions still first-order and matching §21: horizontal wind only (no
thermals), a round non-gliding canopy (no pendulum / lift).
"""

import math

import numpy as np


class DriftResult:
    """Horizontal ground track and its summary. East = +x, North = +y."""

    __slots__ = ("t", "z", "x", "y", "distance", "bearing_deg")

    def __init__(self, t, z, x, y, distance, bearing_deg):
        self.t = t                    # s, from apogee
        self.z = z                    # m AGL, matches the descent trajectory
        self.x = x                    # m east of the pad
        self.y = y                    # m north of the pad
        self.distance = distance      # m, straight-line pad-to-landing
        self.bearing_deg = bearing_deg  # compass bearing pad->landing, deg

    def __repr__(self):
        return ("DriftResult(distance=%.0f m, bearing=%.0f deg)"
                % (self.distance, self.bearing_deg))


def compute_drift(run, wind=None):
    """Read the coupled ground track off `run`. Returns a `DriftResult`.

    `run` is a `solver.RunResult` whose trajectory already carries the integrated
    horizontal position `(x, y)` (the wind, the apogee lateral velocity and shear
    lag are all in the descent). `wind` is accepted for backward-compatible call
    sites but is no longer needed -- the drift is the descent's own ground track.
    """
    t = np.asarray(run.traj.t, dtype=float)
    z = np.asarray(run.traj.z, dtype=float)
    x = np.asarray(run.traj.x, dtype=float)
    y = np.asarray(run.traj.y, dtype=float)

    if t.size < 2:
        # A degenerate run (never left the pad). No descent, no drift.
        zero = np.zeros(t.size)
        return DriftResult(t, z, zero, zero, 0.0, 0.0)

    x_end, y_end = float(x[-1]), float(y[-1])
    distance = math.hypot(x_end, y_end)
    # Compass bearing pad -> landing: 0 = north, 90 = east.
    bearing = math.degrees(math.atan2(x_end, y_end)) % 360.0 if distance else 0.0

    return DriftResult(t, z, x, y, distance, bearing)

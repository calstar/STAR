"""Downwind drift under recovery. PLAN.md §21 (Phase 2).

Post-processing, not a second integration: it takes the descent a `solver.run`
already produced and carries the vehicle sideways with the wind. That is
sufficient here because the model is deliberately the **equilibrium** one --

    horizontally the only force on the canopy is drag, and drag drives its
    horizontal velocity to match the local wind, so v_horizontal(z) = v_wind(z)

-- which needs only the altitude-vs-time history, not a coupled 2-D state. The
same Cd*S that sets the descent rate is what couples the canopy to the wind, so
there is no separate "how much wind it catches" term; a round (non-gliding)
canopy simply goes where the air goes.

Assumptions, all first-order and matching §21:
  * **Horizontal wind only** -- no vertical air motion (thermals are left as
    future uncertainty, not modelled here).
  * **No response lag** -- the ~1 s relaxation to a new wind is neglected, so
    the canopy is taken to match the wind instantly. This biases drift very
    slightly high in shear, which is the conservative direction.
  * **No pendulum / glide** -- a round canopy, so no net lift.

This is the altitude-resolved version of the mastersheet's scalar estimate
(`mastersheet.py`: drift = wind * descent_time). Integrating over the trajectory
instead weights the wind by the time spent at each altitude, so the slow descent
under the main correctly picks up more of the low-altitude wind.
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


def compute_drift(run, wind):
    """Integrate the wind over `run`'s descent. Returns a `DriftResult`.

    `run` is a `solver.RunResult`; `wind` is a `wind.WindProfile`. The track
    starts at the pad (0, 0) at apogee and accumulates by the trapezoid rule,
    so it lands where the summed wind carried it.
    """
    t = np.asarray(run.traj.t, dtype=float)
    z = np.asarray(run.traj.z, dtype=float)

    if t.size < 2:
        # A degenerate run (never left the pad). No descent, no drift.
        zero = np.zeros(t.size)
        return DriftResult(t, z, zero, zero, 0.0, 0.0)

    # Wind at each trajectory altitude. WindProfile is scalar per call; the
    # trajectory is ~a few thousand samples, evaluated once.
    u = np.array([wind.u(zi) for zi in z])
    v = np.array([wind.v(zi) for zi in z])

    dt = np.diff(t)
    # Trapezoid: mean of the endpoint winds over each step, since the canopy
    # moves with the local wind at every instant.
    x = np.concatenate(([0.0], np.cumsum(0.5 * (u[:-1] + u[1:]) * dt)))
    y = np.concatenate(([0.0], np.cumsum(0.5 * (v[:-1] + v[1:]) * dt)))

    x_end, y_end = float(x[-1]), float(y[-1])
    distance = math.hypot(x_end, y_end)
    # Compass bearing pad -> landing: 0 = north, 90 = east.
    bearing = math.degrees(math.atan2(x_end, y_end)) % 360.0 if distance else 0.0

    return DriftResult(t, z, x, y, distance, bearing)

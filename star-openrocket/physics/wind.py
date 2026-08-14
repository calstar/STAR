"""Horizontal wind profile. PLAN.md §21 (Phase 2 wind/drift).

Stdlib only, like `atmosphere.py`, so `site-climatology/` can import it without
a venv and the CLI stays dependency-light. Immutable once constructed.

**Shape is chosen for RocketPy.** The unified simulator we are heading toward
runs on RocketPy, whose `Environment.set_atmospheric_model("custom_atmosphere",
wind_u=..., wind_v=...)` wants wind as two orthogonal components, in m/s, as a
function of altitude MSL:

    wind_u  east  (x) component
    wind_v  north (y) component

So that is exactly what this stores and returns. `to_rocketpy()` emits the
`[height_msl, value]` point arrays RocketPy accepts directly, and the drift
integrator in `drift.py` is the only other consumer.

**Meteorological convention.** A reported wind *direction* is the compass
bearing the wind blows *from*, clockwise from north (270 deg = a westerly, out
of the west, blowing toward the east). The vector the vehicle actually feels
points the other way, so:

    u_east  = -speed * sin(dir)
    v_north = -speed * cos(dir)

`heading()` inverts this back to the bearing the wind blows *toward*, which is
the direction a drifting canopy travels.

**Altitude convention** matches `Atmosphere`: methods take geometric altitude
AGL (the solver's state variable z, §1.1) and add `site_elev` internally to
reach the MSL grid. The climatology grid is geopotential MSL; the
geopotential/geometric gap is under 0.13% at 8 km, four orders below the wind's
own month-to-month spread, so it is treated as MSL directly rather than carrying
the eq (1) conversion into a quantity this uncertain.
"""

import bisect
import math

from physics.site import FAR_ELEV_M


def uv_from_speed_dir(speed, direction_from_deg):
    """(u_east, v_north) m/s from speed and the bearing wind blows *from*."""
    r = math.radians(direction_from_deg)
    return (-speed * math.sin(r), -speed * math.cos(r))


class WindProfile:
    """Horizontal wind as (u_east, v_north) m/s vs altitude. Immutable.

    Construct with `constant(...)` for a uniform wind or `from_grid(...)` for a
    tabulated profile (e.g. a monthly climatology). Altitudes passed to `u`,
    `v`, `speed` and `heading` are geometric AGL; `site_elev` is added to reach
    the MSL grid.
    """

    __slots__ = ("site_elev", "_h", "_u", "_v")

    def __init__(self, heights_msl, u, v, site_elev=FAR_ELEV_M):
        if not (len(heights_msl) == len(u) == len(v)):
            raise ValueError("heights, u and v must be the same length")
        if len(heights_msl) == 0:
            raise ValueError("wind profile needs at least one level")
        # Sort by height so bisect works and callers need not pre-sort.
        order = sorted(range(len(heights_msl)), key=lambda i: heights_msl[i])
        self._h = [float(heights_msl[i]) for i in order]
        self._u = [float(u[i]) for i in order]
        self._v = [float(v[i]) for i in order]
        self.site_elev = float(site_elev)

    # -- constructors -------------------------------------------------------

    @classmethod
    def constant(cls, speed, direction_from_deg, site_elev=FAR_ELEV_M):
        """A uniform wind of `speed` m/s blowing *from* `direction_from_deg`."""
        if speed < 0.0:
            raise ValueError("wind speed must be non-negative, got %r" % speed)
        u, v = uv_from_speed_dir(speed, direction_from_deg)
        # A single level suffices; interpolation holds it at every altitude.
        return cls([site_elev], [u], [v], site_elev=site_elev)

    @classmethod
    def from_grid(cls, heights_msl, u, v, site_elev=FAR_ELEV_M):
        """A tabulated profile: u/v m/s at each MSL height. See class docstring."""
        return cls(heights_msl, u, v, site_elev=site_elev)

    # -- evaluation ---------------------------------------------------------

    def _interp(self, z_agl, table):
        """Linear interpolation of `table` at geometric altitude AGL, held flat
        outside the tabulated band (no extrapolation of a fitted slope)."""
        z = z_agl + self.site_elev
        h = self._h
        if len(h) == 1 or z <= h[0]:
            return table[0]
        if z >= h[-1]:
            return table[-1]
        i = bisect.bisect_right(h, z)
        h0, h1 = h[i - 1], h[i]
        t0, t1 = table[i - 1], table[i]
        return t0 + (t1 - t0) * (z - h0) / (h1 - h0)

    def u(self, z_agl):
        """East (x) component, m/s, at geometric altitude AGL."""
        return self._interp(z_agl, self._u)

    def v(self, z_agl):
        """North (y) component, m/s, at geometric altitude AGL."""
        return self._interp(z_agl, self._v)

    def speed(self, z_agl):
        """Wind speed magnitude, m/s."""
        return math.hypot(self.u(z_agl), self.v(z_agl))

    def heading(self, z_agl):
        """Bearing the wind blows *toward*, degrees clockwise from north.

        This is the direction a drifting canopy travels; it is the reported
        met direction plus 180. Returns 0 for calm.
        """
        u, v = self.u(z_agl), self.v(z_agl)
        if u == 0.0 and v == 0.0:
            return 0.0
        return math.degrees(math.atan2(u, v)) % 360.0

    # -- RocketPy handoff ---------------------------------------------------

    def to_rocketpy(self):
        """`(wind_u, wind_v)` as `[[height_msl, value], ...]` point arrays.

        Feeds straight into
        `Environment.set_atmospheric_model("custom_atmosphere",
        wind_u=..., wind_v=...)` -- the whole reason this class stores u/v vs
        MSL altitude.
        """
        wind_u = [[h, u] for h, u in zip(self._h, self._u)]
        wind_v = [[h, v] for h, v in zip(self._h, self._v)]
        return wind_u, wind_v

    def __repr__(self):
        if len(self._h) == 1:
            return ("WindProfile(constant u=%.2f v=%.2f, |v|=%.2f m/s)"
                    % (self._u[0], self._v[0], math.hypot(self._u[0], self._v[0])))
        return ("WindProfile(%d levels, %.0f-%.0f m MSL)"
                % (len(self._h), self._h[0], self._h[-1]))

"""ISA atmosphere, re-fit to measured pad conditions. PLAN.md §5, eqs (1)-(7a).

Stdlib only. Scalar ISA evaluation is `exp`, `log` and `pow` -- numpy buys
nothing at one point per call, and staying dependency-free lets
`site-climatology/` and `pad_state` import this without a venv.

Evaluated exactly at every call, with no lookup grid. OpenRocket caches the ISA
on a 500 m table and interpolates; this is a handful of flops and removes the
question.

That table used to be described here as a "~0.6% density error near the
ground". It is 0.036% mid-cell and zero at the nodes -- measured, once
`physics/openrocket.py` implemented the same grid, in
`tests/test_openrocket.py::test_grid_density_error_is_0_04_percent_not_0_6`.
Evaluating exactly is still right; the justification is simplicity, not a
0.6% error that was never there.

The central idea of §5 is the **pad re-fit**: rather than assume the standard
sea-level state, replace the lowest layer with one that passes through the
measured pad temperature and still meets the standard tropopause at 11 km
(eq 7). For any flight below 11 km geopotential -- which is every flight this
tool is for -- that single layer is the entire model, and the standard layer
table is never consulted.
"""

import math

from physics.constants import (
    G0,
    H_TOP,
    H_TROP,
    L0_ISA,
    LAYERS,
    P0,
    RD,
    RE,
    T0,
    T_TROP,
)

# Below this the layer is treated as isothermal, eq (4) rather than eq (3).
# Eq (3) has L in a denominator and in an exponent -g0/(Rd*L), so it does not
# merely lose precision as L -> 0, it divides by zero. The crossover is where
# the two forms agree to better than float precision anyway.
_ISOTHERMAL_EPS = 1e-10


def geopotential(z_msl):
    """Eq (1). Geometric altitude MSL -> geopotential altitude."""
    return RE * z_msl / (RE + z_msl)


def geometric(h):
    """Inverse of eq (1). Geopotential -> geometric altitude MSL."""
    return RE * h / (RE - h)


def _layer_pressure(p_b, T_b, L_b, dH):
    """Eqs (3) and (4). Pressure `dH` geopotential metres above a layer base."""
    if abs(L_b) < _ISOTHERMAL_EPS:
        return p_b * math.exp(-G0 * dH / (RD * T_b))  # eq (4)
    return p_b * (1.0 + L_b * dH / T_b) ** (-G0 / (RD * L_b))  # eq (3)


def p_standard(h):
    """Standard-column pressure at geopotential altitude `h`, from sea level.

    This is eq (7a) when evaluated at pad elevation. Walks the full LAYERS
    table so it stays correct above 11 km, which matters for the
    `p_pad_metar` inversion in pad_state and for tests against the published
    ISA table.
    """
    if h < 0.0:
        # The standard column is defined for h >= 0. Below sea level, continue
        # layer 0 downward rather than refusing -- Badwater is -85 m.
        return P0 * (1.0 + L0_ISA * h / T0) ** (-G0 / (RD * L0_ISA))
    if h > H_TOP:
        raise ValueError(
            "geopotential altitude %.0f m is above the 1976 model ceiling "
            "of %.0f m" % (h, H_TOP)
        )
    p = P0
    for i, (H_b, T_b, L_b) in enumerate(LAYERS):
        H_next = LAYERS[i + 1][0] if i + 1 < len(LAYERS) else H_TOP
        if h <= H_next:
            return _layer_pressure(p, T_b, L_b, h - H_b)
        p = _layer_pressure(p, T_b, L_b, H_next - H_b)
    return p


def T_standard(h):
    """Standard-column temperature at geopotential altitude `h`."""
    if h <= LAYERS[0][0]:
        return T0 + L0_ISA * h
    for i, (H_b, T_b, L_b) in enumerate(LAYERS):
        H_next = LAYERS[i + 1][0] if i + 1 < len(LAYERS) else H_TOP
        if h <= H_next:
            return T_b + L_b * (h - H_b)
    return LAYERS[-1][1] + LAYERS[-1][2] * (H_TOP - LAYERS[-1][0])


def refit_lapse(T_pad, H_pad):
    """Eq (7). Lapse rate through the measurement to the standard tropopause.

    Feeding standard sea-level conditions must return exactly -0.0065; that is
    the free regression test PLAN.md §5 calls out.
    """
    return (T_TROP - T_pad) / (H_TROP - H_pad)


class Atmosphere:
    """The atmosphere for one run. Immutable once constructed.

    Parameters
    ----------
    site_elev : float
        Pad elevation, metres MSL.
    T_pad : float, optional
        Measured pad temperature, K. Defaults to the standard column at site
        elevation. PLAN.md §5 is emphatic that this is the one atmospheric
        input worth an instrument -- it is worth ~7% in density against ~0.4%
        for pressure.
    p_pad : float, optional
        Pad *station* pressure, Pa. Defaults to eq (7a), the standard column at
        site elevation, which is the Phase 1 default and good to ~2%.

        This must be station pressure -- what a barometer at the pad physically
        reads -- never a METAR altimeter setting, which is corrected to sea
        level. Using the setting raw is an 11-18% density error at high desert
        sites and exactly 0% at sea level, so it is invisible in testing and
        worst where these vehicles fly. See `pad_state.p_pad_metar`.

    lapse : float, optional
        Temperature lapse rate over the flight band, **K per metre** and
        negative for a cooling column. Defaults to None, which keeps the eq (7)
        re-fit from `T_pad`. Supply a measured monthly value from
        `site-climatology` to replace the inference with an observation.

    Altitudes passed to `T`, `p`, `rho` and `g` are **geometric AGL**, matching
    the state variable z in PLAN.md §7. Site elevation is added internally.
    """

    __slots__ = ("site_elev", "H_pad", "T_pad", "p_pad", "L0", "_refit",
                 "lapse_measured")

    def __init__(self, site_elev, T_pad=None, p_pad=None, lapse=None):
        self.site_elev = float(site_elev)
        self.H_pad = geopotential(self.site_elev)
        self.T_pad = float(T_pad) if T_pad is not None else T_standard(self.H_pad)
        self.p_pad = float(p_pad) if p_pad is not None else p_standard(self.H_pad)

        if self.T_pad <= 0.0:
            raise ValueError("T_pad must be positive kelvin, got %r" % (T_pad,))
        if self.p_pad <= 0.0:
            raise ValueError("p_pad must be positive pascals, got %r" % (p_pad,))

        # A supplied lapse rate replaces the eq (7) re-fit.
        #
        # The re-fit infers a slope from the pad temperature alone, on the
        # assumption that the column is a standard one shifted to meet it. Over
        # the Mojave that assumption is worth up to 1.4 K/km in July -- the
        # soundings say -7.1 while the re-fit says -8.6 -- so a measured
        # monthly lapse from `site-climatology` is a real improvement and this
        # is the hook for it. None keeps the eq (7) behaviour exactly.
        self.lapse_measured = lapse is not None
        if lapse is None:
            self.L0 = refit_lapse(self.T_pad, self.H_pad)  # eq (7)
        else:
            self.L0 = float(lapse)
            # A positive lapse is a ground inversion, which is real and
            # common at dawn; only a physically absurd magnitude is rejected.
            if not -0.030 < self.L0 < 0.030:
                raise ValueError(
                    "lapse must be in K/m and within +/-0.030 (that is "
                    "+/-30 K/km); got %r -- K/km passed by mistake?" % (lapse,)
                )

        # The re-fit layer spans pad -> 11 km. Above that the re-fit says
        # nothing, so fall back to the standard table. `_refit` records whether
        # the re-fit is a no-op, purely so tests can assert the ISA identity.
        self._refit = abs(self.L0 - L0_ISA) > 1e-12

    # -- profile ------------------------------------------------------------

    def _H(self, z_agl):
        return geopotential(z_agl + self.site_elev)

    def T(self, z_agl):
        """Eq (2). Temperature, K."""
        H = self._H(z_agl)
        if H <= H_TROP:
            return self.T_pad + self.L0 * (H - self.H_pad)
        return T_standard(H)

    def p(self, z_agl):
        """Eqs (3)/(4). Pressure, Pa."""
        H = self._H(z_agl)
        if H <= H_TROP:
            return _layer_pressure(self.p_pad, self.T_pad, self.L0, H - self.H_pad)
        # Continue from the re-fit layer's own value at the tropopause, not
        # from the standard table's, so the profile stays continuous at 11 km.
        p_trop = _layer_pressure(
            self.p_pad, self.T_pad, self.L0, H_TROP - self.H_pad
        )
        p = p_trop
        for i, (H_b, T_b, L_b) in enumerate(LAYERS):
            if H_b < H_TROP:
                continue
            H_next = LAYERS[i + 1][0] if i + 1 < len(LAYERS) else H_TOP
            if h_le(H, H_next):
                return _layer_pressure(p, T_b, L_b, H - H_b)
            p = _layer_pressure(p, T_b, L_b, H_next - H_b)
        return p

    def rho(self, z_agl):
        """Eq (5). Density, kg/m^3, dry air.

        Moist air is *less* dense, since H2O at 18 g/mol is lighter than the
        28.96 g/mol it displaces. The correction is 1 - 0.378 e/p: 1.6% at
        30 C saturated, under 0.5% typically. Twenty times smaller than the
        Cx band, so PLAN.md §5 defers it.
        """
        return self.p(z_agl) / (RD * self.T(z_agl))

    def g(self, z_agl):
        """Eq (6). Local gravity, m/s^2. Inverse-square; 0.09% at 3 km."""
        z_msl = z_agl + self.site_elev
        return G0 * (RE / (RE + z_msl)) ** 2

    def rho_g(self, z_agl):
        """Density and gravity in one pass. Returns (rho, g).

        The RHS (eq 17) needs both at every step and is evaluated ~1700 times
        per run; calling `rho` and `g` separately recomputes the geopotential
        conversion three times over. Same equations, one traversal -- this is
        an evaluation-order optimisation, not a second implementation.
        """
        z_msl = z_agl + self.site_elev
        H = RE * z_msl / (RE + z_msl)  # eq (1)

        if H <= H_TROP:
            dH = H - self.H_pad
            T = self.T_pad + self.L0 * dH  # eq (2)
            if abs(self.L0) < _ISOTHERMAL_EPS:
                p = self.p_pad * math.exp(-G0 * dH / (RD * self.T_pad))  # eq (4)
            else:
                p = self.p_pad * (1.0 + self.L0 * dH / self.T_pad) ** (
                    -G0 / (RD * self.L0)
                )  # eq (3)
        else:
            T = self.T(z_agl)
            p = self.p(z_agl)

        return p / (RD * T), G0 * (RE / (RE + z_msl)) ** 2

    def __repr__(self):
        return (
            "Atmosphere(site_elev=%.1f, T_pad=%.2f, p_pad=%.1f, "
            "L0=%.6f K/m%s)"
            % (
                self.site_elev,
                self.T_pad,
                self.p_pad,
                self.L0,
                "" if self._refit else ", = ISA",
            )
        )


def h_le(a, b):
    """`a <= b` with a float-noise guard, for layer boundary comparisons."""
    return a <= b + 1e-9

"""Equation of motion. PLAN.md §7, eqs (16)-(18).

Deliberately thin. `deriv` is called ~1700 times per run by the RK45 stepper,
so it allocates nothing and calls nothing it does not need.
"""

from physics.devices import CdS_total


def make_deriv(devices, states, m, CdS_body, atm):
    """Build the RHS closure for one segment.

    State y = [z, v] with z geometric AGL and v positive up, so descent has
    v < 0 (§1.1).
    """

    rho_g = atm.rho_g

    def deriv(t, y):
        z, v = y[0], y[1]
        # Eq (17). The |v|v form makes drag oppose motion in either direction
        # without a sign test; with v < 0 the drag term is positive (upward),
        # as it must be.
        CdS = CdS_total(devices, states, t, CdS_body)
        rho, g = rho_g(z)
        return (v, -g - rho * CdS / (2.0 * m) * abs(v) * v)

    return deriv


def v_terminal(m, g, rho, CdS):
    """Eq (18). Terminal velocity magnitude, m/s.

    For validation and quick estimates. Note it takes CdS_total -- including
    the airframe and every deployed device -- not the main canopy alone.
    """
    return (2.0 * m * g / (rho * CdS)) ** 0.5


def v_terminal_at(m, atm, z_agl, CdS):
    """Eq (18) evaluated against an Atmosphere at altitude `z_agl`."""
    return v_terminal(m, atm.g(z_agl), atm.rho(z_agl), CdS)

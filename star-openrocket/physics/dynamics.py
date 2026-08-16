"""Equation of motion. PLAN.md §7, eqs (16)-(18).

Deliberately thin. `deriv` is called ~1700 times per run by the RK45 stepper,
so it allocates nothing and calls nothing it does not need.
"""

from physics.devices import CdS_total


def make_deriv(devices, states, m, CdS_body, atm, wind):
    """Build the RHS closure for one segment.

    State y = [z, vz, x, vx, y, vy]: z geometric AGL (vz positive up, so descent
    has vz < 0, §1.1), and the horizontal ground position/velocity (x east, y
    north). A parachute trails the *resultant* airflow, so drag is
    `0.5·rho·CdS·|v_rel|·v_rel` opposing the air-relative velocity
    `v_rel = (vx - u_wind, vy - v_wind, vz)`, using the SAME CdS the descent uses.

    At calm wind and zero horizontal velocity `|v_rel| = |vz|`, the horizontal
    derivatives vanish, and the vertical row is exactly eq (17) -- i.e. this
    reduces to the 1-D vertical descent.
    """

    rho_g = atm.rho_g

    def deriv(t, y):
        z, vz, _x, vx, _y, vy = y
        CdS = CdS_total(devices, states, t, CdS_body)
        rho, g = rho_g(z)
        # Air-relative velocity (wind is horizontal: u east, v north).
        arx = vx - wind.u(z)
        ary = vy - wind.v(z)
        # |v_rel| couples horizontal and vertical: a big sideways speed raises the
        # total drag on both. k already folds in the resultant speed.
        k = rho * CdS / (2.0 * m) * (arx * arx + ary * ary + vz * vz) ** 0.5
        # Vertical: eq (17) with |v_rel| in place of |vz| (identical when arx=ary=0).
        return (vz, -g - k * vz, vx, -k * arx, vy, -k * ary)

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

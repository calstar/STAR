"""Vertical point-mass flight: apogee of a thrust curve, and the impulse a target apogee needs.

  dv/dt = (F(t) + (p_ref - p(z)) A_e - 1/2 rho(z) v|v| Cd(M) A) / m - g,   dm/dt = -mdot(t)

integrated through the burn and the coast to v = 0, in the 1976 ISA from the pad elevation, with
the same Cd(M) the RocketPy flight uses (engine/pipeline/vehicle_drag). With Cd = 0, constant
mdot and constant exhaust velocity it is Sutton & Biblarz's vertical flight without drag (ch. 4):
u_p = c ln R - g t_p, h_p = c t_p [1 - ln R / (R - 1)] - g t_p^2 / 2, apogee h_p + u_p^2 / 2g.

The required impulse keeps the propellant mass, the burn time and the shape of the mass flow and
scales the thrust (the effective exhaust velocity) until the apogee is the target: I = c m_p. It
is the check Layer 2 makes on a pressure schedule, cheap enough to sit inside its objective.
Fixed-step RK4 (10 ms burn, 50 ms coast) with the apogee interpolated in the last step.
"""

from __future__ import annotations

from typing import Optional, Sequence

import numpy as np
from scipy.optimize import brentq

from engine.pipeline.vehicle_drag import DragCurves, isa_troposphere

G0 = 9.80665


def vertical_apogee_agl(
    time_s: Sequence[float],
    thrust_n: Sequence[float],
    mdot_kg_s: Sequence[float],
    m0_kg: float,
    *,
    area_m2: float = 0.0,
    drag: Optional[DragCurves] = None,
    elevation_m: float = 0.0,
    reference_pressure_pa: Optional[float] = None,
    nozzle_exit_area_m2: float = 0.0,
    dt_burn: float = 0.01,
    dt_coast: float = 0.05,
) -> float:
    """Apogee above the pad [m] of a vertical flight on this thrust and mass-flow history."""
    t_arr = np.asarray(time_s, dtype=float) - float(time_s[0])
    F_arr = np.asarray(thrust_n, dtype=float)
    md_arr = np.asarray(mdot_kg_s, dtype=float)
    t_b = float(t_arr[-1])
    if drag is not None:
        mach_tab = np.asarray(drag.mach)
        cd_on, cd_off = np.asarray(drag.cd_power_on), np.asarray(drag.cd_power_off)
    p_ref = reference_pressure_pa
    air = (drag is not None and area_m2 > 0.0) or (p_ref is not None and nozzle_exit_area_m2 > 0.0)

    def rhs(t: float, z: float, v: float, m: float, burning: bool):
        F = float(np.interp(t, t_arr, F_arr)) if burning else 0.0
        md = float(np.interp(t, t_arr, md_arr)) if burning else 0.0
        D = 0.0
        if air:
            _, p, rho, a, _ = isa_troposphere(elevation_m + max(z, 0.0))
            if burning and p_ref is not None:
                F += (p_ref - p) * nozzle_exit_area_m2
            if drag is not None:
                cd = float(np.interp(abs(v) / a, mach_tab, cd_on if burning else cd_off))
                D = 0.5 * rho * v * abs(v) * cd * area_m2
        acc = (F - D) / m - G0
        if z <= 0.0 and v <= 0.0 and acc < 0.0:
            acc = 0.0  # on the pad until thrust exceeds weight
        return v, acc, -md

    t, z, v, m = 0.0, 0.0, 0.0, float(m0_kg)
    while True:
        burning = t < t_b  # a step never straddles burnout, so each stage sees one phase
        dt = min(dt_burn, t_b - t) if burning else dt_coast
        k1 = rhs(t, z, v, m, burning)
        k2 = rhs(t + dt / 2, z + dt / 2 * k1[0], v + dt / 2 * k1[1], m + dt / 2 * k1[2], burning)
        k3 = rhs(t + dt / 2, z + dt / 2 * k2[0], v + dt / 2 * k2[1], m + dt / 2 * k2[2], burning)
        k4 = rhs(t + dt, z + dt * k3[0], v + dt * k3[1], m + dt * k3[2], burning)
        z1 = z + dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
        v1 = v + dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
        m1 = m + dt / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])
        if v1 <= 0.0 < v:
            # constant deceleration across the step: v reaches 0 at s*dt, having climbed v*s*dt/2
            s = v / (v - v1)
            return float(z + 0.5 * v * s * dt)
        if not burning and v1 <= 0.0 and z1 <= 0.0:
            return 0.0  # never left the pad
        t, z, v, m = (t + dt if not burning or t + dt < t_b else t_b), z1, v1, m1
        if t > 600.0:
            raise RuntimeError("vertical_apogee_agl: no apogee within 600 s")


def required_impulse(
    target_apogee_agl_m: float,
    m_dry_kg: float,
    m_prop_kg: float,
    burn_time_s: float,
    *,
    time_s: Optional[Sequence[float]] = None,
    mdot_kg_s: Optional[Sequence[float]] = None,
    thrust_n: Optional[Sequence[float]] = None,
    **flight: object,
) -> float:
    """Total impulse [N s] that puts this vehicle at the target apogee, holding m_prop, the burn
    time and the mass-flow shape, and scaling the thrust shape (flat mdot and constant exhaust
    velocity when no history is given). ``flight`` goes to vertical_apogee_agl (drag, area, pad)."""
    if time_s is None:
        time_s = np.linspace(0.0, burn_time_s, 201)
    t = np.asarray(time_s, dtype=float) - float(time_s[0])
    md = np.full_like(t, 1.0) if mdot_kg_s is None else np.asarray(mdot_kg_s, dtype=float)
    md = md * (m_prop_kg / float(np.trapezoid(md, t)))
    F_shape = md if thrust_n is None else np.asarray(thrust_n, dtype=float)
    I_shape = float(np.trapezoid(F_shape, t))
    m0 = float(m_dry_kg) + float(m_prop_kg)

    def miss(k: float) -> float:
        return vertical_apogee_agl(t, k * F_shape, md, m0, **flight) - target_apogee_agl_m

    k_lo = 1.02 * m0 * G0 / max(float(np.max(F_shape)), 1e-12)  # peak thrust just lifts it
    k_hi = 1.5 * k_lo
    while miss(k_hi) < 0.0:
        k_hi *= 1.5
        if k_hi > 1e3 * k_lo:
            raise ValueError("required_impulse: target apogee is out of reach of this vehicle")
    k = brentq(miss, k_lo, k_hi, xtol=1e-6 * k_hi, rtol=1e-8)
    return k * I_shape


"""Loads. PLAN.md §8, eqs (19)-(37), and §9 landing metrics eqs (38)-(39).

Three load estimates per device, and the tool reports all three -- not just the
one that sizes the hardware (§8.7):

    F_inf     eq (23)  infinite-mass bound, X1 = 1. What §8.6 sizes to.
    F_pflanz  eq (28)  finite-mass expected value, = F_inf * X1.
    Cx*max F_T eq (21a) numerical peak, with gravity and airframe drag.

F_pflanz can never govern eq (36), since X1 <= 1 by construction. That is
exactly why it must be reported separately: 1/X1 is the conservatism the
design is carrying, and it is the only number that says whether the bound is
costing you 5% or 240%.
"""

import math

from physics.constants import G0

SF_DEFAULT = 1.5


# --- Pflanz finite-mass credit, eqs (24)-(29) -----------------------------


def ballistic_parameter(m, rho_s, CdS, s_f):
    """Eq (24). Dimensionless mass ratio: vehicle mass over the air mass the
    canopy processes during inflation. Large A -> infinite-mass behaviour.

    Note it contains no v_s. That is eq (44): with s_f fixed, A is independent
    of deployment speed, so F is exactly proportional to v_s^2.
    """
    return 2.0 * m / (rho_s * CdS * s_f)


def X1_of(A, j=2):
    """Eqs (26)/(27), with the closed form (29) for j = 2.

    The force reduction factor, <= 1. Purely kinematic: the vehicle sheds
    speed while the canopy is still growing, so peak force is lower than the
    infinite-mass case.
    """
    if A <= 0.0:
        raise ValueError("ballistic parameter must be positive, got %r" % (A,))

    if j == 2:
        # Eq (29). Worth asserting against the general form -- test_loads does.
        if A < 2.0 / 3.0:
            return (1.5 * A) ** (2.0 / 3.0) / 2.25
        return (1.0 + 1.0 / (3.0 * A)) ** -2.0

    tau_star = tau_star_of(A, j)
    B = 1.0 / (A * (j + 1))
    return tau_star ** j / (1.0 + B * tau_star ** (j + 1)) ** 2


def tau_star_of(A, j=2):
    """Eq (26). Normalised time of peak force, clipped to full inflation."""
    return min(1.0, (j * A * (j + 1) / (j + 2)) ** (1.0 / (j + 1)))


# --- opening load, eqs (22), (23), (28) -----------------------------------


class DeviceLoads:
    """Every load number for one device. §8.7 reports all of them."""

    __slots__ = ("name", "v_s", "z_d", "rho_s", "q_s", "s_f", "t_f", "A",
                 "X1", "tau_star", "F_inf", "F_pflanz", "ratio", "F_snatch",
                 "mu", "v_floor", "bound_valid", "F_T_peak", "fired")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def as_dict(self):
        """Native Python scalars, so the result is JSON-serialisable.

        Most of these fields arrive from numpy: the trajectory is a numpy array
        and anything derived from it carries `numpy.float64` or `numpy.bool`.
        `json` refuses both, and the error names the *Python* type it thinks it
        saw -- numpy 2 calls its boolean `numpy.bool`, so a stray one reports as
        "Object of type bool is not JSON serializable", which reads like an
        impossibility and sends you looking in the wrong place. It broke
        `python -m physics --json` outright, silently, for every config.

        Coerced here rather than at each call site because this method exists to
        be serialised -- that is the only thing it is for.
        """
        out = {}
        for k in self.__slots__:
            v = getattr(self, k)
            if isinstance(v, bool) or v is None or isinstance(v, str):
                out[k] = v
            elif hasattr(v, "item"):        # any numpy scalar
                out[k] = v.item()
            else:
                out[k] = v
        return out


def device_loads(device, state, m, m_b, traj=None):
    """Compute eqs (22)-(28) and (33)/(34) for one device."""
    if not state.stretched:
        return DeviceLoads(name=device.name, fired=False)

    s_f = device.s_f
    q_s = 0.5 * state.rho_s * state.v_s ** 2                     # eq (22)
    F_inf = q_s * device.CdS * device.Cx                         # eq (23)
    A = ballistic_parameter(m, state.rho_s, device.CdS, s_f)     # eq (24)
    X1 = X1_of(A, device.j)                                      # eq (27)/(29)
    tau_star = tau_star_of(A, device.j)                          # eq (26)

    mu = F_snatch = None
    if device.k_eff is not None:
        mu = m_b * device.m_c / (m_b + device.m_c)               # eq (33)
        F_snatch = device.v_rel * math.sqrt(device.k_eff * mu)   # eq (34)

    v_floor = math.sqrt(G0 * s_f)

    F_T_peak = None
    if traj is not None and len(traj.t):
        # The numerical peak *for this device*, over its own inflation window.
        # A global max is dominated by whichever device is largest and says
        # nothing about the others -- see the eq (48)/(49) note below.
        lo, hi = state.t_d, state.t_d + state.t_f
        mask = (traj.t >= lo) & (traj.t <= hi)
        if mask.any():
            F_T_peak = float(traj.F_T[mask].max())

    return DeviceLoads(
        name=device.name, fired=True, v_s=state.v_s, z_d=state.z_d,
        rho_s=state.rho_s, q_s=q_s, s_f=s_f, t_f=state.t_f, A=A, X1=X1,
        tau_star=tau_star, F_inf=F_inf, F_pflanz=F_inf * X1, ratio=1.0 / X1,
        F_snatch=F_snatch, mu=mu, v_floor=v_floor,
        # §8.2 validity note: the bound assumes the vehicle neither gains nor
        # loses speed during inflation. Pflanz has no gravity, so at low v_s
        # the filling time grows, gravity has longer to act, and the speed at
        # the peak can exceed v_s -- at which point F_inf is an UNDERestimate.
        bound_valid=state.v_s >= v_floor,
        F_T_peak=F_T_peak,
    )


# --- design load, eqs (36)/(37) -------------------------------------------


class DesignLoad:
    __slots__ = ("F_design", "governing_value", "governing_device",
                 "governing_candidate", "safety_factor", "F_allow",
                 "governing_link", "passes")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


def design_load(per_device, F_T_max_global, Cx_max, hardware=None):
    """Eq (36). SF * max(snatch, F_inf, Cx * max F_T), over all devices.

    Reports **which device and which candidate** governs, not only the number:
    a design limited by drogue snatch and one limited by main opening call for
    different fixes, and the bare maximum cannot tell them apart.
    """
    sf = hardware.safety_factor if hardware is not None else SF_DEFAULT

    candidates = []
    for dl in per_device:
        if not dl.fired:
            continue
        candidates.append((dl.F_inf, dl.name, "F_inf (bound)"))
        if dl.F_snatch is not None:
            candidates.append((dl.F_snatch, dl.name, "snatch"))
    if F_T_max_global is not None:
        candidates.append(
            (Cx_max * F_T_max_global, "-", "Cx * max F_T (numerical)"))

    if not candidates:
        return DesignLoad(F_design=None, safety_factor=sf)

    value, name, candidate = max(candidates, key=lambda c: c[0])
    F_design = sf * value

    F_allow = governing_link = passes = None
    if hardware is not None:
        F_allow = hardware.F_allow
        governing_link = hardware.governing_link
        if F_allow is not None:
            # F_allow already carries the safety factor, so compare it against
            # the unfactored peak rather than double-counting SF.
            passes = value <= F_allow

    return DesignLoad(
        F_design=F_design, governing_value=value, governing_device=name,
        governing_candidate=candidate, safety_factor=sf, F_allow=F_allow,
        governing_link=governing_link, passes=passes,
    )


def v_s_max(F_allow, rho, CdS, Cx):
    """Eq (37). Maximum survivable deployment speed for one device."""
    return math.sqrt(2.0 * F_allow / (rho * CdS * Cx))


def delta_t_max(v_s_max_i, m, rho, CdS_axial, g=G0):
    """Eq (56). Seconds before apogee at which a deployment still survives.

    Uses the **axial** drag area: during coast the vehicle is flying
    nose-first, not in the tumbling attitude assumed for descent. This is the
    one place in the model where the §6.4 band does not apply, because the
    attitude is known.
    """
    v_c = math.sqrt(2.0 * m * g / (rho * CdS_axial))
    return v_c / g * math.atan(v_s_max_i / v_c), v_c


def coast_ceiling(m, rho, CdS_axial, g=G0):
    """The arctan saturation ceiling of eq (56): v_c*pi/(2g).

    Beyond this no deployment survives at any hardware strength. It is set by
    coast dynamics, not by what you build -- and it scales with the airframe,
    so it is not transferable between vehicles.
    """
    v_c = math.sqrt(2.0 * m * g / (rho * CdS_axial))
    return v_c * math.pi / (2.0 * g)


# --- landing, eqs (38)/(39) -----------------------------------------------


def impact_energy(m, v_impact):
    """Eq (38). Joules."""
    return 0.5 * m * v_impact ** 2


def equivalent_height(v_impact):
    """Eq (39). The intuitive form: what height a free fall to this speed is."""
    return v_impact ** 2 / (2.0 * G0)

"""Component drag buildup: OpenRocket's model with its long-rocket shortcuts replaced.

``drag_openrocket`` is the reference; this model keeps every OpenRocket term except
the ones below, each replaced by a cited handbook correlation:

* **Reynolds number per part.** OpenRocket rates every component's skin friction at
  the Reynolds number of the whole rocket's length. A boundary layer's friction
  depends on the length *it* has run: here the body uses the body length, each fin
  set its mean aerodynamic chord, a faired protuberance its own length.
* **Roughness by regime.** OpenRocket takes ``max(smooth, fully rough)`` whenever the
  rough value is larger. Nikuradse's sand-grain regimes (Schlichting,
  *Boundary-Layer Theory*, ch. on rough plates) say a surface is hydraulically
  smooth below a roughness Reynolds number ``k+ = u_tau k / nu`` of 5 and fully rough
  above 70; between them we blend log-linearly in ``k+`` (an interpolation choice,
  stated as such). ``u_tau = V sqrt(Cf_smooth / 2)``. The fully rough value is
  OpenRocket's own ``0.032 (k/L)^0.2``, at each part's own ``L``.
* **Form factors.** Body: ``1 + 1.5 (d/l)^1.5 + 7 (d/l)^3`` (Hoerner,
  *Fluid-Dynamic Drag*, 1965, ch. VI, streamline bodies), against OpenRocket's
  ``1 + r/(2 l)``. Fins: ``1 + 2 (t/c) + 60 (t/c)^4`` (Hoerner ch. VI, sections),
  against ``1 + 2 t/MAC``.
* **Base drag.** Subsonic, Hoerner's base pressure follows the boundary layer the
  forebody hands it: ``C_D,base = 0.029 (d_b/d)^3 / sqrt(C_D,forebody)`` on the
  maximum frontal area (Hoerner ch. III, base drag), with the forebody's drag on the
  same area. OpenRocket's ``(0.12 + 0.13 M^2)`` on the base area does not see the
  forebody, and on a long rocket reads about four times higher. Above Mach 0.6 the
  correlation is not supported; we blend linearly to OpenRocket's value at Mach 1 and
  use OpenRocket's above.
* **Power on.** While the motor burns, the exhaust fills the nozzle exit; the base
  drag acts on the annulus around it only (``DragGeometry.nozzle_radius``; the motor
  case radius stands in when the exit is not known, and the result says so).

Everything else -- nose and transition pressure drag, fin leading- and trailing-edge
drag, wave drag, bluff protuberances, compressibility of Cf -- is OpenRocket's term,
from ``drag_openrocket``. Fin-body junction interference is not added: Hoerner's
junction correlation goes to zero for fins thinner than about 8 % of their chord,
which every fin we fly is.
"""

from __future__ import annotations

import math

from . import drag_openrocket as orc
from .drag_geometry import DragGeometry, FinSetDrag

#: Nikuradse's regime bounds on k+ (Schlichting): hydraulically smooth below, fully rough above.
K_PLUS_SMOOTH = 5.0
K_PLUS_ROUGH = 70.0
#: Hoerner's subsonic base-drag correlation holds to about here; OpenRocket's above Mach 1.
BASE_HOERNER_MAX_MACH = 0.6
BASE_OPENROCKET_MACH = 1.0


def smooth_cf(re: float, mach: float) -> float:
    """Turbulent flat plate, OpenRocket's form and compressibility factor."""
    return orc.friction_coefficient(re, mach)


def part_cf(v_nu: float, length: float, roughness: float, mach: float) -> tuple[float, float]:
    """(Cf, k+) for a surface of running length ``length`` and sand-grain ``roughness``."""
    re = v_nu * max(length, 1e-6)
    cf_s = smooth_cf(re, mach)
    k_plus = v_nu * math.sqrt(cf_s / 2) * roughness
    cf_r = orc.roughness_limited_cf(roughness, length, mach)
    if cf_r <= cf_s or k_plus <= K_PLUS_SMOOTH:
        return cf_s, k_plus
    if k_plus >= K_PLUS_ROUGH:
        return cf_r, k_plus
    w = math.log(k_plus / K_PLUS_SMOOTH) / math.log(K_PLUS_ROUGH / K_PLUS_SMOOTH)
    return cf_s + w * (cf_r - cf_s), k_plus


def body_form_factor(length: float, diameter: float) -> float:
    q = diameter / length
    return 1 + 1.5 * q**1.5 + 7 * q**3


#: Hoerner's section form factor is fitted to t/c up to about a quarter; past it the
#: quartic term runs away (a bolt head at t/c 1.5 read 300). Held at its edge.
FIN_FF_MAX_TC = 0.25


def fin_form_factor(thickness: float, chord: float) -> float:
    tc = min(thickness / chord, FIN_FF_MAX_TC) if chord > 0 else 0.0
    return 1 + 2 * tc + 60 * tc**4


def fin_friction_cd(fin: FinSetDrag, v_nu: float, mach: float, ref_area: float) -> float:
    if fin.area <= 0 or fin.mac <= 0:
        return 0.0
    cf, _ = part_cf(v_nu, fin.mac, fin.roughness, mach)
    return cf * fin_form_factor(fin.thickness, fin.mac) * 2 * fin.area / ref_area


def hoerner_base_cd(base_radius: float, ref_radius: float, forebody_cd: float) -> float:
    """``0.029 (d_b/d)^3 / sqrt(C_D,forebody)``, on the maximum frontal area."""
    if base_radius <= 0 or forebody_cd <= 0:
        return 0.0
    return 0.029 * (base_radius / ref_radius) ** 3 / math.sqrt(forebody_cd)


def drag(geom: DragGeometry, mach: float, v_nu: float, *, power_on: bool = False) -> orc.DragBreakdown:
    a_ref = geom.ref_area
    body_len = geom.length
    t: dict[str, float] = {}

    body = 0.0
    for s in geom.segments:
        cf, _ = part_cf(v_nu, body_len, s.roughness, mach)
        body += cf * s.wet_area
    t["friction: body"] = body_form_factor(body_len, 2 * geom.max_radius) * body / a_ref

    fins = list(geom.fins) + [orc.faired_as_fin(p) for p in geom.protuberances if p.kind == "faired"]
    t["friction: fins"] = sum(f.count * fin_friction_cd(f, v_nu, mach, a_ref) for f in fins)
    t["pressure: fins"] = sum(f.count * orc.fin_pressure_cd(f, mach, a_ref) for f in fins)

    nose = other = stag = 0.0
    prev_r = 0.0
    for s in geom.segments:
        cd = orc.segment_pressure_cd(s, mach, a_ref, orc._NOSE_CACHE)
        if s.kind == "nose":
            nose += cd
        else:
            other += cd
        if prev_r < s.r_fore:
            stag += orc.stagnation_cd(mach) * math.pi * (s.r_fore**2 - prev_r**2) / a_ref
        prev_r = s.r_aft
    t["pressure: nose"] = nose
    t["pressure: transitions"] = other
    if stag:
        t["pressure: forward steps"] = stag
    t["protuberances"] = sum(p.count * orc.bluff_protuberance_cd(p, mach, v_nu, a_ref)
                             for p in geom.protuberances if p.kind == "bluff")

    # Base: Hoerner subsonic, on the forebody drag assembled above.
    r_b = geom.base_radius
    forebody = sum(t.values())
    hoerner = hoerner_base_cd(r_b, geom.ref_radius, forebody)
    openrocket = orc.base_cd(mach) * math.pi * r_b**2 / a_ref
    if mach <= BASE_HOERNER_MAX_MACH:
        base = hoerner
    elif mach >= BASE_OPENROCKET_MACH:
        base = openrocket
    else:
        w = (mach - BASE_HOERNER_MAX_MACH) / (BASE_OPENROCKET_MACH - BASE_HOERNER_MAX_MACH)
        base = hoerner + w * (openrocket - hoerner)
    if power_on and r_b > 0:
        r_n = min(geom.nozzle_radius or 0.0, r_b)
        base *= 1 - (r_n / r_b) ** 2
    t["base"] = base
    return orc.DragBreakdown(cd=float(sum(t.values())), terms=t)

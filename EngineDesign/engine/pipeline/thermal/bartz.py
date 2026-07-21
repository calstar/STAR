"""Bartz gas-side film coefficient (Huzel & Huang eq. 4-13).

    h_g = [ 0.026/D_t^0.2 * (mu^0.2 cp / Pr^0.6) * ((Pc)ns g / c*)^0.8
            * (D_t/R)^0.1 ] * (A_t/A)^0.9 * sigma

PROVENANCE. Every equation and constant here is transcribed from Huzel & Huang,
"Design of Liquid Propellant Rocket Engines" (NASA SP-125), chapter IV. Nothing
is inferred, fitted, or carried over from another correlation:

    eq. (4-13)  p. 100  the correlation above
    eq. (4-14)  p. 101  sigma, in closed form -- see bartz_sigma()
    fig. 4-24   p. 101  sigma tabulated "as computed by Bartz"
    Sample Calculation (4-3), pp. 102-103, works the A-1 stage engine end to
                end and PRINTS every intermediate group, which is what
                tests/test_bartz_correlation.py asserts against, term by term.

The sample calculation is the reason this module can be trusted rather than
merely believed: its four bracketed groups (0.01366, 0.046, 4.02, 1.078), their
product (0.0027), and the three station values of h_g (0.00185 at the chamber,
0.0027 at the throat, 0.000507 at eps = 5) are all reproduced. A unit slip or a
mistyped exponent cannot survive that.

WHY THIS AND NOT DITTUS-BOELTER. The gas side used plain Dittus-Boelter,
0.023 Re^0.8 Pr^0.4 on chamber diameter. That is a correlation for turbulent
flow in a smooth pipe at MODERATE wall-to-bulk temperature difference, with
properties at bulk temperature. A thrust chamber violates every one of those:
Twg/(Tc)ns runs about 0.35, the flow accelerates through a throat, and the
cross-section is not constant. Bartz exists precisely because of that -- it
keeps Dittus-Boelter's skeleton but adds the sigma property-variation
correction, expresses mass flux as (Pc)ns*g/c* instead of a local Reynolds
number, and carries the (A_t/A)^0.9 and (D_t/R)^0.1 geometry terms.

Huzel presents the two as ALTERNATIVES, not as a derivation chain -- eq. 4-12
is "credited to Colburn", then "or as Bartz has shown" introduces 4-13. That
matters for one specific trap:

    DO NOT "correct" the Prandtl exponent to eq. 4-12's Pr^0.34.

4-12 is Colburn's form and is not the one implemented here. Writing eq. 4-13's
Nusselt group out with k = mu*cp/Pr gives h ~ mu^0.2 cp Pr^(n-1), so Bartz's
Pr^-0.6 IS n = 0.4. The 0.026 coefficient, the Pr^-0.6, and sigma are one
calibrated package: Sample Calculation 4-3 applies sigma from figure 4-24 on
top of the 0.026/Pr^-0.6 form, so there is no double-counting to undo and no
freedom to mix in another correlation's exponent.

UNITS. Eqs. 4-12/4-13 are entirely in inch-pound with an explicit g, and the
group (Pc)ns*g/c* is a mass flux in lb/(in^2 s) only when Pc is psia, g is
32.174 lbm-ft/(lbf-s^2) and c* is ft/sec. Rather than fold conversion factors
into the correlation and hope, the core is implemented in Huzel's own units --
so it can be checked term-by-term against his printed arithmetic -- and the SI
wrapper converts at the boundary.
"""

from __future__ import annotations

import math
from typing import Dict

# --- unit conversions, all derived from exact base definitions -------------
_M_PER_IN = 0.0254                      # exact by definition
_M2_PER_IN2 = _M_PER_IN ** 2            # 6.4516e-4
_M_PER_FT = 0.3048                      # exact by definition
_PA_PER_PSI = 6894.757293168361
_J_PER_BTU = 1055.05585262              # International Table
_K_PER_DEGF = 5.0 / 9.0
_J_KG_K_PER_BTU_LB_F = 4186.8           # International Table

#: Btu/(in^2 s degF) -> W/(m^2 K). About 2.9436e6.
BTU_IN2_S_F_TO_W_M2_K = _J_PER_BTU / (_M2_PER_IN2 * _K_PER_DEGF)

#: Pa.s -> lb/(in s). Matches constants.LB_PER_IN_S_TO_PA_S (17.8579673).
_PA_S_PER_LB_IN_S = 17.857967302549516

#: lbm-ft/(lbf-s^2). The `g` printed in eq. 4-13; Sample Calc 4-3 uses 32.2.
G_C_LBM_FT_PER_LBF_S2 = 32.174049

BARTZ_COEFFICIENT = 0.026
BARTZ_DT_EXPONENT = 0.2
BARTZ_MU_EXPONENT = 0.2
BARTZ_PR_EXPONENT = 0.6      # negative power; n = 1 - 0.6 = 0.4. See module docstring.
BARTZ_MASS_FLUX_EXPONENT = 0.8
BARTZ_CURVATURE_EXPONENT = 0.1
BARTZ_AREA_EXPONENT = 0.9


def bartz_sigma(
    wall_to_stagnation_temp_ratio: float,
    gamma: float,
    mach: float,
) -> float:
    """Property-variation correction sigma -- Huzel & Huang eq. (4-14) verbatim.

        sigma = 1 / { [0.5*(Twg/(Tc)ns)*(1+((g-1)/2)M^2) + 0.5]^0.68
                      * [1+((g-1)/2)M^2]^0.12 }

    This is the term that makes Bartz applicable to a rocket at all. Dittus-
    Boelter assumes a near-isothermal boundary layer; a thrust chamber runs
    Twg/(Tc)ns around 0.35, so gas properties vary strongly across the film.
    Bartz evaluates properties at stagnation and puts the whole variation here.

    Note the direction: for a COLD wall sigma exceeds 1, i.e. it RAISES h_g. A
    cold wall thins the boundary layer. It is easy to assume a "correction
    factor" must be a knockdown; this one is not.

    SOURCE: this is eq. (4-14) as printed on p. 101, transcribed directly --
    both 0.5 factors, both exponents, same bracket structure. It is NOT a
    reconstruction from figure 4-24 and not a formula taken from a secondary
    source. test_matches_huzel_equation_4_14_literally re-transcribes it
    independently and requires agreement to 1e-12 over a grid of temperature
    ratio, gamma and Mach, so a later "simplification" -- dropping a 0.5,
    merging the brackets, swapping 0.68 and 0.12 -- fails loudly instead of
    quietly shifting every heat flux.

    Huzel prints the equation AND tabulates it as figure 4-24 "as computed by
    Bartz". The equation is the authority; the figure is a reading aid. Both
    are on the same page, so if this ever needs re-checking, p. 101 has
    everything.

    Cross-checked against the three sigma values Sample Calculation 4-3 takes
    off figure 4-24 at Twg/(Tc)ns = 0.8, gamma ~ 1.2 (pp. 102-103):

        station        M        figure 4-24     eq. 4-14
        chamber        0.4046   1.05            1.067
        throat         1.0      1.0             1.031
        exit, eps=5    2.7850   0.8             0.820

    All three sit 1.6-3.1 percent ABOVE the chart values. The consistent sign
    is expected: the figure is a small log-scale plot read to two significant
    digits (the printed "1.0" at the throat is plainly a chart read), so the
    residual is his reading precision, not a discrepancy in the equation. The
    Mach numbers are not Huzel's -- his chart is indexed by area ratio, so they
    were solved from the isentropic area-Mach relation at gamma = 1.2.
    """
    if not (gamma > 1.0 and math.isfinite(gamma)):
        raise ValueError(f"bartz_sigma: gamma must exceed 1, got {gamma!r}")
    if not (wall_to_stagnation_temp_ratio > 0.0
            and math.isfinite(wall_to_stagnation_temp_ratio)):
        raise ValueError(f"bartz_sigma: temperature ratio must be finite and "
                         f"positive, got {wall_to_stagnation_temp_ratio!r}")
    if not (mach >= 0.0 and math.isfinite(mach)):
        raise ValueError(f"bartz_sigma: mach must be finite and non-negative, "
                         f"got {mach!r}")

    stagnation_ratio = 1.0 + 0.5 * (gamma - 1.0) * mach * mach
    wall_term = 0.5 * wall_to_stagnation_temp_ratio * stagnation_ratio + 0.5
    return 1.0 / (wall_term ** 0.68 * stagnation_ratio ** 0.12)


def bartz_groups_imperial(
    D_throat_in: float,
    Pc_psia: float,
    cstar_ft_s: float,
    throat_curvature_radius_in: float,
    mu_lb_in_s: float,
    cp_btu_lb_f: float,
    Pr: float,
) -> Dict[str, float]:
    """The four bracketed groups of eq. 4-13, in Huzel's units.

    Returned separately rather than pre-multiplied so a failing validation
    localises to one group instead of to "the correlation". Sample Calculation
    4-3 prints exactly these four numbers, which is what they are checked
    against:

        0.01366   coefficient / D_t^0.2
        0.046     mu^0.2 cp / Pr^0.6
        4.02      (Pc g / c*)^0.8        <- mass flux, lb/(in^2 s), to the 0.8
        1.078     (D_t / R)^0.1

    Excludes (A_t/A)^0.9 and sigma, which are per-station rather than
    per-engine. Their product is Huzel's 0.0027 Btu/(in^2 s degF).
    """
    for name, value in (("D_throat_in", D_throat_in), ("Pc_psia", Pc_psia),
                        ("cstar_ft_s", cstar_ft_s),
                        ("throat_curvature_radius_in", throat_curvature_radius_in),
                        ("mu_lb_in_s", mu_lb_in_s), ("cp_btu_lb_f", cp_btu_lb_f),
                        ("Pr", Pr)):
        if not (value > 0.0 and math.isfinite(value)):
            raise ValueError(f"bartz: {name} must be finite and positive, got {value!r}")

    diameter = BARTZ_COEFFICIENT / D_throat_in ** BARTZ_DT_EXPONENT
    transport = (mu_lb_in_s ** BARTZ_MU_EXPONENT * cp_btu_lb_f
                 / Pr ** BARTZ_PR_EXPONENT)
    # (Pc)ns * g / c* is a mass flux, lb/(in^2 s) -- NOT a pressure term.
    mass_flux = Pc_psia * G_C_LBM_FT_PER_LBF_S2 / cstar_ft_s
    mass_flux_group = mass_flux ** BARTZ_MASS_FLUX_EXPONENT
    # R is the radius of curvature of the NOZZLE CONTOUR AT THE THROAT, not any
    # chamber dimension. Sample Calc 4-3 takes the mean of the two contour
    # radii, (18.68 + 4.75)/2 = 11.71 in, against D_t = 24.9 in.
    curvature = (D_throat_in / throat_curvature_radius_in) ** BARTZ_CURVATURE_EXPONENT

    return {
        "diameter": diameter,
        "transport": transport,
        "mass_flux": mass_flux,
        "mass_flux_group": mass_flux_group,
        "curvature": curvature,
        "product": diameter * transport * mass_flux_group * curvature,
    }


def bartz_h_g_imperial(
    D_throat_in: float,
    Pc_psia: float,
    cstar_ft_s: float,
    throat_curvature_radius_in: float,
    mu_lb_in_s: float,
    cp_btu_lb_f: float,
    Pr: float,
    area_ratio_At_over_A: float = 1.0,
    sigma: float = 1.0,
) -> float:
    """Eq. 4-13 complete, in Btu/(in^2 s degF).

    area_ratio_At_over_A : A_t/A at the station of interest -- 1.0 at the
        throat, less than 1 everywhere else, so h_g peaks at the throat.
    sigma : property-variation correction (eq. 4-14 / figure 4-24). Defaults to
        1.0 so the rest of the correlation can be validated on its own.
    """
    if not (area_ratio_At_over_A > 0.0 and math.isfinite(area_ratio_At_over_A)):
        raise ValueError(f"bartz: area ratio must be finite and positive, got "
                         f"{area_ratio_At_over_A!r}")
    if not (sigma > 0.0 and math.isfinite(sigma)):
        raise ValueError(f"bartz: sigma must be finite and positive, got {sigma!r}")

    groups = bartz_groups_imperial(
        D_throat_in, Pc_psia, cstar_ft_s, throat_curvature_radius_in,
        mu_lb_in_s, cp_btu_lb_f, Pr,
    )
    return (groups["product"]
            * area_ratio_At_over_A ** BARTZ_AREA_EXPONENT
            * sigma)


def bartz_h_g(
    D_throat_m: float,
    Pc_pa: float,
    cstar_m_s: float,
    throat_curvature_radius_m: float,
    mu_pa_s: float,
    cp_j_kg_k: float,
    Pr: float,
    area_ratio_At_over_A: float = 1.0,
    sigma: float = 1.0,
) -> float:
    """Eq. 4-13 in SI: gas-side film coefficient in W/(m^2 K).

    Converts to Huzel's inch-pound units, evaluates, and converts back. The
    correlation itself never sees an SI quantity, so there is exactly one place
    a unit error can hide and it is this function.

    Transport properties should come from gas_transport.hot_gas_transport at
    the STAGNATION temperature. Bartz evaluates properties there and lets sigma
    carry the boundary-layer variation -- that division of labour is the whole
    point of the correlation, so do not pre-adjust them to a film temperature.
    Sample Calculation 4-3 evaluates mu at the design (Tc)ns, i.e. after the
    combustion-efficiency correction, not at the theoretical value.
    """
    h_imperial = bartz_h_g_imperial(
        D_throat_in=D_throat_m / _M_PER_IN,
        Pc_psia=Pc_pa / _PA_PER_PSI,
        cstar_ft_s=cstar_m_s / _M_PER_FT,
        throat_curvature_radius_in=throat_curvature_radius_m / _M_PER_IN,
        mu_lb_in_s=mu_pa_s / _PA_S_PER_LB_IN_S,
        cp_btu_lb_f=cp_j_kg_k / _J_KG_K_PER_BTU_LB_F,
        Pr=Pr,
        area_ratio_At_over_A=area_ratio_At_over_A,
        sigma=sigma,
    )
    return h_imperial * BTU_IN2_S_F_TO_W_M2_K

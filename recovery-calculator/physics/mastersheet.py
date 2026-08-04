"""The recovery mastersheets' model, transcribed.

**This is not our physics.** It is a port of the Google Sheets Named Functions in
`reference/mastersheets/`, kept so the Cross-check tab can put their numbers next
to ours on the same config. Nothing in `physics/` may import this to produce a
design number.

Stdlib only, like `atmosphere.py` and `pad_state.py`: it is arithmetic on scalars
and staying dependency-free keeps `tests/test_imports.py`'s tier boundary intact.

Provenance
----------
The math lives in Google Sheets **Named Functions**, not Apps Script. Apps Script
is bound to the document and does not survive an `.xlsx` export; Named Functions
do, as `<definedName>` LAMBDA entries in `xl/workbook.xml`. Both workbooks carry
an identical copy, so the eight functions below are transcribed rather than
fitted -- there are no reverse-engineered constants here. See
`reference/mastersheets/README.md` for how to re-read them from the archive.

The functions are written in the sheet's own units -- feet, slugs, square feet,
pounds -- and NOT converted to SI, deliberately. That is what lets
`tests/test_mastersheet.py` assert them directly against the workbook cells; a
transcription you cannot check against the original is worth very little. The
SI boundary is `evaluate` at the bottom of this file, and nowhere else.

What the model is
-----------------
Terminal velocity everywhere, instantaneous deployment, one point load per
canopy. Three consequences worth naming, because they are the whole reason the
comparison is interesting:

  * a canopy's deployment speed is the *terminal* speed under the previous
    canopy, so the model assumes the vehicle settled -- which
    `tests/test_no_terminal_assumption.py` exists to show is not generally true;
  * `SHOCK_LOAD` is exactly our eq (23) infinite-mass bound times a **hand
    entered** reduction factor X, where we compute Pflanz (eq 28). The sheet
    itself notes "Pflanz method to be added later";
  * there is no filling time, no snatch load and no airframe drag.

Their errors are reproduced, not corrected. A fixed-up version would not tell
anyone what their sheet actually told them. The two that bite are documented at
`descent_time` and `DESCENT_TIME` below.
"""

import math

from physics.constants import (
    FT_TO_M,
    G0,
    LBF_TO_N,
    M_TO_FT,
    N_TO_LBF,
    SQFT_TO_SQM,
)

# --- the sheet's own constants ---------------------------------------------
#
# g/R expressed in K/ft: 9.80665 / 287.053 = 0.0341632 K/m, times 0.3048.
# The sheet hard-codes it to five figures and it appears in every descent
# integral, so it is reproduced at the sheet's precision rather than recomputed.
G_OVER_R = 0.010413

# g/(R*L) - 1 and g/(R*L) + 1 for the tropospheric lapse rate below. Also
# hard-coded in the sheet; 0.010413 / 0.0019812 = 5.25590, so these are
# 4.2559 and 6.2559 and the sheet rounds both down. Kept as written.
K_MINUS = 4.2558
K_PLUS = 6.2558

L_TROP = 0.0019812   # K/ft, positive and SUBTRACTED (positive = cooling)
T_SL = 288.15        # K
RHO_SL = 0.002377    # slug/ft^3
SLUG_PER_LB = 32.174 # lbm per slug, the sheet's g_c

# The sheet's pi. Not math.pi: DIAMIN_AREAFT(30) is 4.908734375 in the workbook
# and 4.9087385 with a real pi. 1 part in 10^6 -- irrelevant physically, but a
# transcription that does not reproduce the cell exactly cannot be tested
# against it.
PI = 3.14159


# ===========================================================================
# The eight Named Functions, verbatim. Do not "improve" these.
# ===========================================================================


def POUND_SLUG(cell):
    """`LAMBDA(cell, (cell/32.174))`. Pounds mass to slugs."""
    return cell / SLUG_PER_LB


def DIAMIN_AREAFT(cell):
    """`LAMBDA(cell, (((cell/24)^2)*3.14159))`.

    Diameter in inches to area in square feet -- `(d/24)^2 * pi` is
    `pi*(d/12)^2/4` rearranged to avoid a division.
    """
    return ((cell / 24.0) ** 2) * PI


def TROP_DENSITY(cell):
    """`LAMBDA(cell, (0.002377*(((288.15-(cell*0.0019812))/288.15)^4.2558)))`.

    Standard-troposphere density in slug/ft^3 at a geometric altitude in feet.

    Note what is absent: there is no measured pad temperature or pressure
    anywhere in it. Where PLAN.md §5 re-fits the lowest layer through an
    observation (eq 7), this is the textbook column and nothing else, so it
    carries the full ~7% density error §5 attributes to an assumed T_pad.
    """
    return RHO_SL * (((T_SL - (cell * L_TROP)) / T_SL) ** K_MINUS)


def SHOCK_LOAD(density, velocity, area, cd, cx, x):
    """`LAMBDA(density, velocity, area, cd, cx, x, (0.5*density*(velocity^2)*area*Cd*Cx*X))`.

    Opening force in lbf. This is our eq (23) infinite-mass bound with an extra
    factor: `x` is a **hand-entered** shock reduction factor (the sheets use 0.5
    to 0.8), not a computed one. `x = 1` is what the workbooks label "Shock Load
    at Inf. Mass" and is the only column directly comparable to our eq (23).

    `area` and `cd` only ever appear as a product, here and in every other
    function in this file, which is what lets `evaluate` pass our atomic `CdS`
    straight in with `cd = 1` and never need a projected diameter.
    """
    return 0.5 * density * (velocity ** 2) * area * cd * cx * x


def TROP_DESCENT_TIME(area, drag, weight, top, bottom, lapse, ref_dens, ref_temp):
    """Single-layer troposphere descent time, seconds. Verbatim:

        SQRT((AREA*DRAG)/(2*WEIGHT)) * ((SQRT(REF_DENS)*2*
          (((REF_TEMP-(BOTTOM*LAPSE))^(0.5*6.2558))
           -(REF_TEMP-(TOP*LAPSE))^(0.5*6.2558)))
          / (6.2558*LAPSE*(REF_TEMP^(0.5*4.2558))))

    This is the function the shockloading sheets actually call, and it is
    algebraically `DESCENT_WITH_LAPSE` with `ref_alt = 0`: the exponent
    `0.5*6.2558` is `g/(2*R*L) + 0.5` and the denominator `6.2558*lapse` is
    `lapse + g/R`. The two agree to 2e-6 rather than to machine precision,
    because the sheet rounds `6.2558` and `0.010413` independently -- 6.2558*L
    is 0.01239271 where L + 0.010413 is 0.01239420. `tests/test_mastersheet.py`
    asserts the identity at that tolerance, which is what pins down that they
    really are the same derivation and not two different ones.

    **It therefore has no reference-altitude parameter**, and the sheets pass it
    AGL altitudes while passing `TROP_DENSITY` AMSL ones. Descent time is
    integrated through air the vehicle never flies -- 4600 ft of it at Camelot's
    field.

    The error is 7.4% on the drogue leg of the Camelot case, and it runs
    **high**: the real descent happens higher up in thinner air, so the vehicle
    is faster and gets down sooner than the sheet says. Drift, computed from
    this time, is overstated with it -- conservative for picking a recovery
    area, wrong for predicting where the vehicle lands.
    """
    return math.sqrt((area * drag) / (2.0 * weight)) * (
        (math.sqrt(ref_dens) * 2.0
         * (((ref_temp - (bottom * lapse)) ** (0.5 * K_PLUS))
            - (ref_temp - (top * lapse)) ** (0.5 * K_PLUS)))
        / (K_PLUS * lapse * (ref_temp ** (0.5 * K_MINUS)))
    )


def DESCENT_WITH_LAPSE(area, drag, weight, lapse, ref_temp, ref_dens, ref_alt,
                       top, bottom):
    """Descent time through one lapsing layer, seconds. Verbatim:

        (SQRT((area*drag)/(2*weight)))*((2*(ref_temp^((lapse-0.010413)/(2*lapse)))
          *((((lapse*ref_alt)+ref_temp-(bottom*lapse))^((0.010413/(2*lapse))+0.5))
           -(((lapse*ref_alt)+ref_temp-(top*lapse))^((0.010413/(2*lapse))+0.5)))
          *(SQRT(ref_dens)))/(lapse+0.010413))

    Positive `lapse` is a cooling layer. `ref_alt` is the layer base, which is
    what `TROP_DESCENT_TIME` lacks.
    """
    return (math.sqrt((area * drag) / (2.0 * weight))) * (
        (2.0 * (ref_temp ** ((lapse - G_OVER_R) / (2.0 * lapse)))
         * ((((lapse * ref_alt) + ref_temp - (bottom * lapse))
             ** ((G_OVER_R / (2.0 * lapse)) + 0.5))
            - (((lapse * ref_alt) + ref_temp - (top * lapse))
               ** ((G_OVER_R / (2.0 * lapse)) + 0.5)))
         * (math.sqrt(ref_dens)))
        / (lapse + G_OVER_R)
    )


def DESCENT_0_LAPSE(area, drag, weight, ref_temp, ref_dens, ref_alt, top, bottom):
    """Descent time through one isothermal layer, seconds. Verbatim:

        SQRT((area*drag)/(2*weight))*((2*ref_temp*(exp((top*0.5*0.010413)/ref_temp)
          -exp((bottom*0.010413)/(2*ref_temp)))*exp((-0.010413*ref_alt)/(2*ref_temp))
          *SQRT(ref_dens))/(0.010413))

    The two exponentials are written asymmetrically in the sheet but are the
    same form: `top*0.5*c/T` and `bottom*c/(2T)` are both `alt*c/(2T)`.
    """
    return math.sqrt((area * drag) / (2.0 * weight)) * (
        (2.0 * ref_temp
         * (math.exp((top * 0.5 * G_OVER_R) / ref_temp)
            - math.exp((bottom * G_OVER_R) / (2.0 * ref_temp)))
         * math.exp((-G_OVER_R * ref_alt) / (2.0 * ref_temp))
         * math.sqrt(ref_dens))
        / G_OVER_R
    )


# The 1976 standard atmosphere in the sheet's units, transcribed term by term
# from the DESCENT_TIME body in its order:
#
#   (layer base ft, lapse K/ft or None if isothermal, base temperature K,
#    base density slug/ft^3, the MIN cap on `top`, whether the term is guarded)
#
# Two details that are easy to lose and were both wrong on the first pass:
# the topmost term has no MIN cap (its `top` is `max_alt` unclamped), and the
# tropospheric term at the bottom has **no IF guard** -- see DESCENT_TIME.
_DESCENT_LAYERS = (
    (232940.0, 0.0006096, 214.65, 1.2459e-7, None, True),
    (167323.0, 0.00085344, 270.65, 1.6718e-6, 232940.0, True),
    (154199.0, None, 270.65, 2.7699e-6, 167323.0, True),
    (104987.0, -0.00085344, 228.65, 2.5661e-5, 154199.0, True),
    (65617.0, -0.0003048, 216.65, 1.7082e-4, 104987.0, True),
    (36089.0, None, 216.65, 7.0612e-4, 65617.0, True),
    (0.0, 0.0019812, 288.15, 2.3769e-3, 36089.0, False),
)


def DESCENT_TIME(area, drag, weight, max_alt, min_alt):
    """Descent time through the full 7-layer standard atmosphere, seconds.

    **Defined in both workbooks and never called.** Somebody built the correct
    multi-layer version, with a proper reference altitude per layer, and the
    shockloading sheets use the single-layer sea-level-anchored
    `TROP_DESCENT_TIME` instead. Ported so the Cross-check tab can report what
    their own unused function would have said.

    Faithful to the original including its edge case: the final tropospheric
    term carries no `IF` guard, so for a descent that ends **above** 36089 ft
    its `bottom` exceeds its `top` and it contributes a negative time. That
    cannot happen for any flight this tool is for -- 36089 ft is 11 km, and
    every descent here ends at the ground -- and it is left alone rather than
    silently repaired. `tests/test_mastersheet.py` pins the behaviour so that
    "tidying" it later is a deliberate act.
    """
    total = 0.0
    for base, lapse, ref_temp, ref_dens, cap, guarded in _DESCENT_LAYERS:
        if guarded and not max_alt > base:
            continue
        top = max_alt if cap is None else min(max_alt, cap)
        bottom = max(base, min_alt)
        if lapse is None:
            total += DESCENT_0_LAPSE(area, drag, weight, ref_temp, ref_dens,
                                     base, top, bottom)
        else:
            total += DESCENT_WITH_LAPSE(area, drag, weight, lapse, ref_temp,
                                        ref_dens, base, top, bottom)
    return total


def terminal_velocity(weight, density, area, cd):
    """`SQRT((2*W)/(rho*S*Cd))`, ft/s.

    Not a Named Function -- the sheets write it inline in every cell (`E8`,
    `G2`, `I2` and their copies). Factored out here because it appears eleven
    times per workbook and a transcription error in one of them would be
    invisible.
    """
    return math.sqrt((2.0 * weight) / (density * area * cd))


# ===========================================================================
# The phase chain, and the SI boundary
# ===========================================================================


class Phase:
    """One canopy's leg of the descent.

    The stored fields carry the **sheet's** units and say so in their names,
    because that is what the functions above compute in and what
    `tests/test_mastersheet.py` compares against the workbook. The unsuffixed
    properties are SI, and are what everything outside this module should read
    -- `evaluate` promises SI out, and a `Phase` escaping in lbf would break
    that promise silently, which it did once already.
    """

    __slots__ = ("name", "CdS_ft2", "Cx", "X", "z_deploy_ft", "z_end_ft",
                 "rho_deploy_slugft3", "v_deploy_fts", "F_inf_lbf",
                 "F_reduced_lbf", "v_terminal_fts", "t_descent",
                 "weight_lbf", "ground_ft")

    def __init__(self, name, CdS_ft2, Cx, X, z_deploy_ft, z_end_ft):
        self.name = name
        self.CdS_ft2 = CdS_ft2
        self.Cx = Cx
        self.X = X
        self.z_deploy_ft = z_deploy_ft
        self.z_end_ft = z_end_ft
        self.rho_deploy_slugft3 = None
        self.v_deploy_fts = None
        self.F_inf_lbf = None
        self.F_reduced_lbf = None
        self.v_terminal_fts = None
        self.t_descent = None  # already seconds; no conversion either way
        # Carried so `sample` can re-enter the sheet's own functions without
        # the caller having to hand them back.
        self.weight_lbf = None
        self.ground_ft = None

    def sample(self, n=48):
        """The trajectory implied by their descent-time function. SI out.

        Returns `[(t_offset_s, z_m_agl, v_ms)]`, `t_offset` from this phase's
        start, and satisfying `dz/dt = -v` exactly.

        **The velocity varies along the leg, and that is theirs, not an
        embellishment.** `TROP_DESCENT_TIME` integrates `dz / v_t(z)` with
        `v_t` going as `1/sqrt(rho)`. Hold `v_t` at its deployment value and
        Camelot's drogue leg comes out at 108.9 s against the 125.7 s they
        report -- 13% adrift. Their number is only reproducible *because* the
        speed changes with altitude. They simply never display it.

        **Which density, though, is where the sheet contradicts itself.** The
        velocity cells (`E8`, `G2`, `I2`) use `TROP_DENSITY(AGL + ground)`,
        while `TROP_DESCENT_TIME` is fed bare AGL and has no field elevation at
        all. Those are two different velocity profiles and they differ by 7.1%
        at Camelot's pad.

        This method follows the **descent-time** one, because the time axis it
        is plotted against is that integral. The consequence is deliberate and
        visible: the reported velocity cells do not land on this curve, and the
        gap between a dot and the line is the inconsistency itself. Chasing the
        other convention instead would put `int dz/v` 6.9% away from the
        descent time in the table, which is the same error hidden where nobody
        would see it.

        Sampled in altitude rather than time because that is the direction the
        closed form runs: `t` is a function of `z`, and inverting it would need
        a solve for no benefit.
        """
        out = []
        span = self.z_end_ft - self.z_deploy_ft
        for i in range(n + 1):
            z_ft = self.z_deploy_ft + span * (i / n)
            t = TROP_DESCENT_TIME(self.CdS_ft2, 1.0, self.weight_lbf,
                                  self.z_deploy_ft, z_ft,
                                  L_TROP, RHO_SL, T_SL)
            # Bare AGL, matching the integral above. NOT `+ ground_ft`.
            v = terminal_velocity(self.weight_lbf, TROP_DENSITY(z_ft),
                                  self.CdS_ft2, 1.0)
            out.append((t, z_ft * FT_TO_M, v * FT_TO_M))
        return out

    # -- SI view ------------------------------------------------------------

    @property
    def CdS(self):
        """Drag area, m^2."""
        return self.CdS_ft2 * SQFT_TO_SQM

    @property
    def z_deploy(self):
        """Deployment altitude, m AGL."""
        return self.z_deploy_ft * FT_TO_M

    @property
    def z_end(self):
        """Altitude this leg ends at, m AGL."""
        return self.z_end_ft * FT_TO_M

    @property
    def v_deploy(self):
        """Speed at deployment, m/s."""
        return self.v_deploy_fts * FT_TO_M

    @property
    def v_terminal(self):
        """Terminal speed under this canopy at its deployment density, m/s."""
        return self.v_terminal_fts * FT_TO_M

    @property
    def F_inf(self):
        """Opening load at X = 1, N. The column comparable to our eq (23)."""
        return self.F_inf_lbf * LBF_TO_N

    @property
    def F_reduced(self):
        """Opening load with the sheet's hand-entered reduction factor, N."""
        return self.F_reduced_lbf * LBF_TO_N


class Result:
    """One mastersheet evaluation. SI throughout -- see `evaluate`."""

    __slots__ = ("phases", "descent_time", "descent_time_layered",
                 "impact_velocity", "impact_ke", "drift", "F_peak",
                 "governing_device", "warnings", "ground_elev_ft", "weight_lbf")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


def _phase_chain(phases, weight_lbf, ground_ft, v_first_fts, wind_fts):
    """Walk the canopies in deployment order, as the shockloading sheets do.

    The sheet's chain, cell for cell:

      * the first canopy's opening speed is a velocity **pasted in from
        OpenRocket** plus the wind speed (`SHOCK_LOAD(C6, (E2 + C9), ...)`) --
        a scalar wind added to a vertical speed;
      * every later canopy opens at the *terminal* speed under the previous one,
        evaluated at the later canopy's own deployment density
        (`G2 = SQRT(2*C5/(C7*E4*E5))`, where C7 is the main's density and E4/E5
        are the drogue's area and Cd);
      * density is always `TROP_DENSITY(AGL + ground AMSL)`.

    `v_first_fts` is therefore an input, not something this model derives. The
    Cross-check tab feeds it the OpenRocket port's speed at that instant, which
    is what the sheet's own author did by hand.

    **This is the 2-canopy sheet's rule, generalised to N.** Camelot's whole
    workbook and LE3's drogue and main 1 follow it exactly. LE3's
    `2) 3 Parachute Shockloading` does NOT: it is a partially-edited copy of
    the 2-canopy template and three of its cells did not get updated -- main
    1's load is evaluated at main 2's density, the landing speed uses main 1's
    canopy though main 2 deploys last, and the descent time omits main 2
    entirely. Those are pinned as arithmetic in
    `tests/test_mastersheet.py::test_le3_three_canopy_columns_are_not_a_consistent_chain`
    and are deliberately not reproduced here -- there is no rule to reproduce,
    only three unrelated slips.
    """
    previous = None
    for ph in phases:
        ph.rho_deploy_slugft3 = TROP_DENSITY(ph.z_deploy_ft + ground_ft)
        if previous is None:
            ph.v_deploy_fts = v_first_fts + wind_fts
        else:
            # Terminal under the PREVIOUS canopy, at THIS canopy's density.
            ph.v_deploy_fts = terminal_velocity(
                weight_lbf, ph.rho_deploy_slugft3, previous.CdS_ft2, 1.0)
        ph.F_inf_lbf = SHOCK_LOAD(ph.rho_deploy_slugft3, ph.v_deploy_fts,
                                  ph.CdS_ft2, 1.0, ph.Cx, 1.0)
        ph.F_reduced_lbf = SHOCK_LOAD(ph.rho_deploy_slugft3, ph.v_deploy_fts,
                                      ph.CdS_ft2, 1.0, ph.Cx, ph.X)
        ph.t_descent = TROP_DESCENT_TIME(
            ph.CdS_ft2, 1.0, weight_lbf, ph.z_deploy_ft, ph.z_end_ft,
            L_TROP, RHO_SL, T_SL)
        ph.v_terminal_fts = terminal_velocity(
            weight_lbf, ph.rho_deploy_slugft3, ph.CdS_ft2, 1.0)
        previous = ph

    # Landing speed is terminal under the last canopy at ground density.
    return terminal_velocity(weight_lbf, TROP_DENSITY(ground_ft),
                             phases[-1].CdS_ft2, 1.0)


def evaluate(phases_si, m_kg, ground_elev_m, v_first_ms, wind_ms=0.0):
    """Run the mastersheet model. **SI in, SI out** -- the only boundary.

    Parameters
    ----------
    phases_si : list of (name, CdS_m2, Cx, X, z_deploy_m_agl, z_end_m_agl)
        One entry per canopy, in deployment order. `CdS` is our atomic drag
        area and goes in as the sheet's `area * cd` product with `cd = 1`; the
        sheet never uses the two separately, so no projected diameter is needed.
        `X` is the hand-entered shock reduction factor -- pass 1.0 for the
        infinite-mass column, which is the one comparable to our eq (23).
    m_kg : float
        Descending mass. The sheet calls this "Stage Dry Weight (lbs)" and uses
        it as a *weight* in lbf throughout, so it is converted as a force.
    ground_elev_m : float
        Pad elevation MSL, used only for density -- never for descent time,
        which is the inconsistency documented on `TROP_DESCENT_TIME`.
    v_first_ms : float
        Speed at the first canopy's deployment. The sheet pastes this in from
        OpenRocket; see `_phase_chain`.
    wind_ms : float
        Added scalar-wise to `v_first_ms` and used for drift. Zero means the
        drift row reads zero, which is honest: our model has no wind either.
    """
    if not phases_si:
        raise ValueError("the mastersheet model needs at least one canopy")

    weight_lbf = m_kg * G0 * N_TO_LBF
    ground_ft = ground_elev_m * M_TO_FT
    wind_fts = wind_ms * M_TO_FT

    phases = []
    for name, CdS, Cx, X, z_deploy, z_end in phases_si:
        phase = Phase(name, CdS / SQFT_TO_SQM, Cx, X,
                      z_deploy * M_TO_FT, z_end * M_TO_FT)
        phase.weight_lbf = weight_lbf
        phase.ground_ft = ground_ft
        phases.append(phase)

    v_impact_fts = _phase_chain(phases, weight_lbf, ground_ft,
                                v_first_ms * M_TO_FT, wind_fts)

    descent_time = sum(ph.t_descent for ph in phases)

    # The same descent, through their unused DESCENT_TIME instead. Summed over
    # the same legs so the two differ only in the atmosphere, not the phasing.
    layered = sum(
        DESCENT_TIME(ph.CdS_ft2, 1.0, weight_lbf,
                     ph.z_deploy_ft + ground_ft, ph.z_end_ft + ground_ft)
        for ph in phases
    )

    governing = max(phases, key=lambda ph: ph.F_inf_lbf)
    v_impact = v_impact_fts * FT_TO_M

    warnings = [
        "Its descent time ignores field elevation — the altitudes go in AGL "
        "while density uses %.0f m AMSL, so it integrates through denser air "
        "than the vehicle ever flies through. Runs high: %.1f s against the "
        "%.1f s its own unused layered function gives."
        % (ground_elev_m, descent_time, layered),
        "Every canopy after the first opens at the terminal speed under the "
        "previous one. Nothing checks whether the vehicle had time to settle.",
    ]
    if wind_ms == 0.0:
        warnings.append(
            "Wind is zero, so drift is zero and the first canopy's opening "
            "speed carries no gust allowance.")

    return Result(
        phases=phases,
        descent_time=descent_time,
        descent_time_layered=layered,
        impact_velocity=v_impact,
        impact_ke=0.5 * m_kg * v_impact ** 2,
        drift=descent_time * wind_ms,
        F_peak=governing.F_inf,
        governing_device=governing.name,
        warnings=warnings,
        ground_elev_ft=ground_ft,
        weight_lbf=weight_lbf,
    )

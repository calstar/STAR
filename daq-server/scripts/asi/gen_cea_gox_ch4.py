"""Generate the ASI's GOx / GCH4 chamber-equilibrium table as TypeScript.

    python gen_cea_gox_ch4.py > ../../diablo_server/frontend/lib/asi/cea-gox-ch4.ts

Needs Cantera (`pip install cantera`; on Windows-on-ARM use an x86-64 Python,
there is no ARM wheel). Uses GRI-Mech 3.0 (gri30.yaml), HP equilibrium at the
chamber pressure with both reactants gaseous at 298.15 K -- the ASI burns gas,
not the LOX/CH4 of the main engine's CEA cache.

c* is CEA's equilibrium c*: the products expand isentropically with shifting
equilibrium (SP) from the chamber, the throat is where the mass flux rho*u peaks,
and c* = Pc / (rho u)_max. (The frozen-gamma shortcut sqrt(R Tc)/Gamma runs ~2 %
low for this pair.) Check: O/F 2.5 at ~110 psia gives Tc ~3110 K, c* ~1875 m/s,
against the ASI design point's CEA 3107 K / 1878 m/s
(asi_gox_gch4_17gs_100psia_2026-10-07.yaml). The twin multiplies by a c*
efficiency the operator sets.

GRI-3.0 has no solid carbon, so the very fuel-rich end (O/F below ~1.3, which is
also past CH4's upper flammability limit in O2) is a gas-phase answer only --
the ASI pages mark that region as non-igniting rather than trusting it.
"""

import json
import warnings
import math

import cantera as ct
import numpy as np

PSI = 6894.757
PC_PSIA = [25, 50, 100, 200, 400]
OF = [round(float(x), 2) for x in np.arange(0.5, 8.01, 0.25)]


def equilibrium_cstar(gas: ct.Solution) -> float:
    """c* = Pc / max(rho u) along a shifting-equilibrium isentropic expansion."""
    p0, h0, s0 = gas.P, gas.enthalpy_mass, gas.entropy_mass
    y0 = gas.Y

    def flux(r: float) -> float:
        gas.SPY = s0, p0 * r, y0
        gas.equilibrate("SP")
        dh = h0 - gas.enthalpy_mass
        return gas.density * math.sqrt(2 * dh) if dh > 0 else 0.0

    # rho*u is unimodal in Pt/Pc; the throat sits near 0.56 for gamma ~1.2.
    # Golden-section to 1e-5 in the ratio (~25 equilibria).
    a, b = 0.40, 0.80
    k = (math.sqrt(5) - 1) / 2
    c, d = b - k * (b - a), a + k * (b - a)
    fc, fd = flux(c), flux(d)
    while b - a > 1e-5:
        if fc > fd:
            b, d, fd = d, c, fc
            c = b - k * (b - a)
            fc = flux(c)
        else:
            a, c, fc = c, d, fd
            d = a + k * (b - a)
            fd = flux(d)
    return p0 / max(fc, fd)


def main() -> None:
    # GRI-3.0 thermo fits end at 3000 K; the hottest points sit ~100-300 K past it
    # (extrapolated, as the 2026-10-07 design point itself is at 3107 K).
    warnings.filterwarnings("ignore", message=".*outside valid range.*")
    gas = ct.Solution("gri30.yaml")
    tc, gam, mw, cstar = [], [], [], []
    for pc in PC_PSIA:
        row_t, row_g, row_m, row_c = [], [], [], []
        for of in OF:
            gas.TPY = 298.15, pc * PSI, {"O2": of / (1 + of), "CH4": 1 / (1 + of)}
            gas.equilibrate("HP")
            g = gas.cp_mass / gas.cv_mass
            m = gas.mean_molecular_weight
            row_t.append(round(gas.T, 1))
            row_g.append(round(g, 4))
            row_m.append(round(m, 3))
            row_c.append(round(equilibrium_cstar(gas), 1))
        tc.append(row_t)
        gam.append(row_g)
        mw.append(row_m)
        cstar.append(row_c)

    feed = {}
    for sp in ("O2", "CH4"):
        gas.TPX = 293.15, ct.one_atm, {sp: 1}
        feed[sp] = {
            "gamma": round(gas.cp_mass / gas.cv_mass, 4),
            "mw": round(gas.mean_molecular_weight, 3),
        }

    source = (
        f"Cantera {ct.__version__}, gri30.yaml, HP equilibrium, GOx + GCH4 at 298.15 K; "
        "equilibrium c* (shifting, throat at max rho*u) (daq-server/scripts/asi/gen_cea_gox_ch4.py)"
    )
    j = lambda v: json.dumps(v, separators=(",", ":"))  # noqa: E731
    print("/**")
    print(" * GOx / GCH4 chamber equilibrium -- GENERATED, do not edit by hand.")
    print(" * Regenerate: daq-server/scripts/asi/gen_cea_gox_ch4.py")
    print(" */")
    print(f"export const CEA_SOURCE = {j(source)};")
    print(f"/** Chamber pressures of the rows, psia. */\nexport const CEA_PC_PSIA = {j(PC_PSIA)};")
    print(f"/** Mixture ratios of the columns (mass O2 / mass CH4). */\nexport const CEA_OF = {j(OF)};")
    print(f"/** Adiabatic flame temperature, K. [pc][of] */\nexport const CEA_TC_K = {j(tc)};")
    print(f"/** Frozen chamber cp/cv. [pc][of] */\nexport const CEA_GAMMA = {j(gam)};")
    print(f"/** Chamber mean molecular weight, kg/kmol. [pc][of] */\nexport const CEA_MW = {j(mw)};")
    print(f"/** Ideal characteristic velocity, m/s. [pc][of] */\nexport const CEA_CSTAR_MS = {j(cstar)};")
    print(
        "/** Feed gases at 293.15 K, 1 atm (ideal gas). */\n"
        f"export const FEED_GAS = {j(feed)} as const;"
    )


if __name__ == "__main__":
    main()

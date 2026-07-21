"""Single source of hot-gas transport properties for the gas-side heat transfer.

Bartz (Huzel & Huang eq. 4-13) needs four properties of the combustion
products: viscosity, specific heat, thermal conductivity and Prandtl number.
They were previously computed in three separate places, which had drifted into
contradicting each other:

    regen_cooling.estimate_hot_wall_heat_flux  k from config, Pr DERIVED as mu*cp/k
    ablative_cooling.compute_..._profile       Pr hardcoded 0.75, k DERIVED as mu*cp/Pr
    chamber_solver (ablative block)            a near-verbatim copy of the first

For the same gas at the same operating point those disagreed by 3x in both k
and Pr, in opposite directions, and the first produced Pr = 2.25 -- impossible
for a gas. All three also derived cp as gamma*R/(gamma-1). That identity holds
for a calorically perfect gas, but CEA's GAMMAs is the isentropic exponent of a
dissociating mixture, not cp/cv; the derived value overshoots by ~40%.

Reference values, NASA CEA for LOX/CH4 at Pc = 20 bar, MR 2.8, FROZEN
reactions (Tc = 3261 K, M = 19.50, gamma = 1.1397):

    mu = 1.030e-4 Pa.s      cp = 2463 J/(kg.K)
    k  = 0.394 W/(m.K)      Pr = 0.644

Frozen rather than equilibrium is deliberate. Equilibrium transport bundles the
energy of radical recombination into an inflated effective conductivity (k is
3.3x higher, cp 2.4x), which would raise the Bartz transport group by ~2.95x.
Bartz's correlation was calibrated against frozen-type properties -- eq. (4-16)
is literally a diatomic-air fit with no reaction contribution -- so pairing it
with equilibrium properties double-counts rather than improving accuracy.
Note that frozen is NOT the conservative choice: it predicts a lower heat load.
Add margin explicitly rather than by selecting equilibrium properties.

KNOWN LIMITATION: the four values are not mutually consistent, because the
viscosity comes from the Huzel correlation (~35% below CEA for these products,
being an air fit) while cp/k/Pr come from config. mu*cp/k therefore does not
reproduce Pr exactly. The fix is to source all four from CEA's TRANSPORT
PROPERTIES block, which is self-consistent by construction and is already
present in the text cea_cache.py fetches -- it is simply never parsed.
"""

from __future__ import annotations

import warnings
from typing import Dict, Optional

from engine.pipeline.constants import (
    DEFAULT_GAS_EMISSIVITY_ND,
    DEFAULT_HOT_GAS_CP_J_KG_K,
    DEFAULT_HOT_GAS_PRANDTL_ND,
    DEFAULT_HOT_GAS_THERMAL_COND_W_M_K,
    DEFAULT_HOT_GAS_VISC_PA_S,
)
from engine.pipeline.thermal.regen_cooling import calculate_gas_viscosity_huzel


def hot_gas_transport(
    temperature: float,
    molecular_weight: Optional[float],
    config=None,
) -> Dict[str, float]:
    """Transport properties of the combustion products at the gas-side wall.

    Parameters
    ----------
    temperature : float
        Gas temperature [K] at which viscosity is evaluated.
    molecular_weight : float or None
        Product molecular weight [kg/kmol] from CEA. When absent, viscosity
        falls back to the configured constant.
    config : RegenCoolingConfig or None
        Supplies measured/assumed properties. None is a valid caller state
        (time_varying_solver passes no regen config), in which case the
        CEA-anchored defaults are used.

    Returns
    -------
    dict with 'mu' [Pa.s], 'cp' [J/(kg.K)], 'k' [W/(m.K)], 'Pr' [-]

    None of the four is derived from the others -- deriving is what allowed the
    three former copies to disagree by 3x while each looking locally sensible.
    """
    def _cfg(name: str, default: float) -> float:
        if config is None:
            return default
        value = getattr(config, name, None)
        return float(value) if value is not None and value > 0 else default

    if molecular_weight is not None and molecular_weight > 0 and temperature > 0:
        mu = calculate_gas_viscosity_huzel(temperature, molecular_weight)
    else:
        mu = _cfg("hot_gas_viscosity", DEFAULT_HOT_GAS_VISC_PA_S)

    return {
        "mu": float(mu),
        "cp": _cfg("hot_gas_cp", DEFAULT_HOT_GAS_CP_J_KG_K),
        "k": _cfg("hot_gas_thermal_conductivity", DEFAULT_HOT_GAS_THERMAL_COND_W_M_K),
        "Pr": _cfg("hot_gas_prandtl", DEFAULT_HOT_GAS_PRANDTL_ND),
        # Emissivity of the GAS for the gas -> wall radiation term. Carried here
        # so the lumped and axial paths cannot diverge, and so it is impossible
        # to reach for a wall surface emissivity by mistake -- which is exactly
        # what compute_ablative_heat_flux_profile used to do.
        "eps_gas": _cfg("radiation_emissivity_hot", DEFAULT_GAS_EMISSIVITY_ND),
    }


# Fuels whose combustion products lay down a tenacious carbon deposit on the
# chamber wall. Kerosene-class only: the deposit is driven by soot kinetics
# (aromatics and long-chain alkanes), not by equilibrium carbon.
#
# Deliberately NOT listed:
#   * CH4  -- no C-C bond, so the acetylene -> PAH -> soot chain is kinetically
#             slow. Practically soot-free.
#   * Ethanol -- oxygenated (the OH group partly self-oxidises), and CEA puts
#             its equilibrium carbon at zero by MR 0.8, where CH4 and RP-1 are
#             both still producing it. Historically clean (V-2, Redstone).
_CARBON_DEPOSITING_FUELS = {
    "RP-1", "RP1", "RP_1", "KEROSENE", "JETA", "JET-A", "JP-4", "JP-5", "JP-8",
}

_warned_fuels: set[str] = set()


def warn_if_carbon_depositing(config) -> Optional[str]:
    """Warn once per fuel that the gas-side model is wrong for kerosene-class fuels.

    Huzel & Huang eqs. (4-17)/(4-18) model the LO2/RP-1 carbon deposit as a
    thermal resistance R_d in SERIES with the gas film, and fig. 4-25 puts
    R_d at 1100-2100 in^2.sec.degF/Btu against a film resistance 1/h_g of
    roughly 370 -- so the deposit dominates and cuts gas-side conductance by
    about 5x. We do not model it, because the published data is a single curve
    at one propellant, one chamber pressure and one mixture ratio; extrapolating
    it would be inventing precision we do not have.

    The consequence is one-directional and worth stating loudly: heat load is
    OVER-predicted, so liners come out oversized rather than undersized. Safe,
    but badly so -- a 5x error is not a margin.

    Returns the message when one is emitted, else None (so tests can assert on
    it without capturing warnings).
    """
    if config is None:
        return None
    cea = getattr(getattr(config, "combustion", None), "cea", None)
    fuel = str(getattr(cea, "fuel_name", "") or "").strip()
    if fuel.upper().replace(" ", "") not in _CARBON_DEPOSITING_FUELS:
        return None

    # Only relevant if a wall heat-transfer model will actually run.
    def _on(name: str) -> bool:
        return bool(getattr(getattr(config, name, None), "enabled", False))

    if not (_on("ablative_cooling") or _on("regen_cooling") or _on("graphite_insert")):
        return None

    if fuel in _warned_fuels:
        return None
    _warned_fuels.add(fuel)

    msg = (
        f"Propellant fuel '{fuel}' is kerosene-class and deposits carbon on the "
        f"chamber wall. That deposit is an insulating thermal resistance in series "
        f"with the gas film (Huzel & Huang eq. 4-17/4-18) and is NOT modelled here. "
        f"Gas-side heat load is therefore over-predicted -- by roughly 5x at "
        f"Huzel's fig. 4-25 conditions. Liner thicknesses will be oversized; treat "
        f"absolute heat flux, wall temperature and recession as unreliable for this "
        f"propellant."
    )
    warnings.warn(msg, stacklevel=2)
    return msg

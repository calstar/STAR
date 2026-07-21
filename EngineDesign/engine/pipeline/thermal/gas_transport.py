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

from typing import Dict, Optional

from engine.pipeline.constants import (
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
    }

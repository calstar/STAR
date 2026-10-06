"""Temperature-dependent properties of the graphite throat insert, as named models.

The specific heat of graphite nearly triples between room temperature and the throat's running
temperature (0.71 kJ/(kg K) at 300 K, 2.0 at 2000 K). A constant room-temperature value heats the
surface too fast and so runs the surface chemistry early. Unlike conductivity, density or ash
content, the specific heat is a property of the carbon lattice and is the same for every
polygranular grade to within a few percent, so a published correlation stands for any insert.

Conductivity has no such model here: it depends on the grade (grain, porosity, graphitisation),
and a datasheet gives it at room temperature only.
"""

from __future__ import annotations

from typing import Callable, Dict, Optional

import numpy as np

CAL = 4184.0  # J/kcal


def cp_butland_maddison(T: np.ndarray) -> np.ndarray:
    """Specific heat of graphite [J/(kg K)], Butland & Maddison, J. Nucl. Mater. 49 (1973) 45-56.

    cp = 0.54212 - 2.42667e-6 T - 90.2725/T - 43449.3/T^2 + 1.59309e7/T^3 - 1.43688e9/T^4
    in cal/(g K), T in K, fitted 200-3500 K. Outside that range it is held at the ends.
    """
    T = np.clip(np.asarray(T, dtype=float), 200.0, 3500.0)
    c = 0.54212 - 2.42667e-6 * T - 90.2725 / T - 43449.3 / T**2 + 1.59309e7 / T**3 - 1.43688e9 / T**4
    return c * CAL


#: ``graphite_insert.specific_heat_model`` -> cp(T) [J/(kg K)]; ``None`` uses ``specific_heat``.
SPECIFIC_HEAT_MODELS: Dict[str, Optional[Callable[[np.ndarray], np.ndarray]]] = {
    "constant": None,
    "butland_maddison_1973": cp_butland_maddison,
}

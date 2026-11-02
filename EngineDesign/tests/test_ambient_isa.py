"""The site ambient is the 1976 standard atmosphere, as its docstring always said it was.

``compute_ambient_pressure_from_elevation`` was an isothermal exponential with T held at 288.15 K:
94 069.7 Pa at the LE4 site's 626.67 m against ISA's 94 020.4 Pa, 1.25 % high at 3 km.
"""

from __future__ import annotations

import pytest

from engine.core.runner import compute_ambient_pressure_from_elevation as ambient

R0 = 6356766.0  # m, the 1976 standard's Earth radius for geopotential altitude


def _isa_troposphere_by_hand(h: float) -> float:
    """p = p0 (T/T0)^(g0 M0 / (R* L)): U.S. Standard Atmosphere 1976, eq. 33a, lowest layer."""
    H = R0 * h / (R0 + h)  # geopotential altitude
    T0, L, g0, M0, Rs = 288.15, -0.0065, 9.80665, 0.0289644, 8.31432
    return 101325.0 * ((T0 + L * H) / T0) ** (-g0 * M0 / (Rs * L))


@pytest.mark.parametrize("h", [0.0, 626.67, 1400.0, 3000.0, 10000.0])
def test_matches_the_1976_standard_by_hand(h):
    assert ambient(h) == pytest.approx(_isa_troposphere_by_hand(h), rel=1e-6)


def test_the_le4_site():
    assert ambient(626.67) == pytest.approx(94020.4, abs=0.1)


def test_layer1_designs_at_the_solvers_ambient():
    """Layer 1 runs every evaluation at, and targets as its exit pressure, the site ambient.

    It kept its own isothermal exponential after the solver moved to the standard: 94 069.7 Pa at
    the LE4 site against the 94 020.4 Pa forward mode, the Time-Series tab and Layer X evaluate at.
    """
    from types import SimpleNamespace

    from engine.optimizer.layers.layer1_static_optimization import _layer1_site_ambient_pa

    def cfg(elevation):
        return SimpleNamespace(environment=SimpleNamespace(elevation=elevation))

    assert _layer1_site_ambient_pa(cfg(626.67)) == ambient(626.67)
    assert _layer1_site_ambient_pa(cfg(3000.0)) == ambient(3000.0)
    # no site: sea level, as the runner falls back
    assert _layer1_site_ambient_pa(cfg(None)) == 101325.0
    assert _layer1_site_ambient_pa(SimpleNamespace(environment=None)) == 101325.0


def test_there_is_one_site_atmosphere():
    """No module computes a second barometric formula beside the solver's: the isothermal one Layer 1
    and the optimizer carried (dry air's molar mass, 0.0289644 kg/mol, in code) is how they drifted."""
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    found = []
    for sub in ("engine", "backend", "ui", "copv"):
        for path in (root / sub).rglob("*.py"):
            for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if re.search(r"0\.0289644\b", line.split("#", 1)[0]):
                    found.append(f"{path.relative_to(root)}:{n}")
    assert not found, f"a second site-atmosphere formula: {found}; call compute_ambient_pressure_from_elevation"


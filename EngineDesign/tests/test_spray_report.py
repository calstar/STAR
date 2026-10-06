"""The spray and mixing report (engine/core/injectors/spray_report.py) against the solve it reads
and against hand numbers for the checks it makes itself."""
import copy
import math

import pytest

PSI = 6894.757
CFG = "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"


@pytest.fixture(scope="module")
def solved():
    from engine.pipeline.io import load_config
    from engine.core.injectors.spray_report import _solve
    cfg = load_config(CFG)
    return cfg, _solve(cfg)


def _rows(rep):
    return {r["label"]: r for s in rep["sections"] for r in s["rows"]}


def test_rows_are_the_solvers_numbers(solved):
    from engine.core.injectors.spray_report import spray_mixing_report
    cfg, r = solved
    rows = _rows(spray_mixing_report(cfg, r, with_sensitivity=False))
    d = r["diagnostics"]
    ce = d["cstar_efficiency"]
    assert rows["fuel D32"]["value"] == pytest.approx(d["D32_F"] * 1e6, rel=1e-12)
    assert rows["Rupe M"]["value"] == d["rupe_M"]
    assert rows["η mixing"]["value"] == ce["eta_mixing"]
    assert rows["fuel 95 % vaporized, from the face"]["value"] == pytest.approx(
        (ce["x_vap95_F"] + ce["x_drop_formation"]) * 1000, rel=1e-12)


def test_intact_core_and_lean_by_hand(solved):
    """Core: 7 d sqrt(rho_l/rho_g) (Chehroudi et al. 1985, low C). Lean: the momentum resultant
    of the two jets, LOX inner and aiming outward (as scripts/design_handcheck.py)."""
    from engine.core.injectors.spray_report import spray_mixing_report
    cfg, r = solved
    rows = _rows(spray_mixing_report(cfg, r, with_sensitivity=False))
    d = r["diagnostics"]
    rho_g = d["rho_gas_breakup"]
    assert rows["LOX intact core (low bound)"]["value"] == pytest.approx(7.0 * math.sqrt(1140.0 / rho_g), rel=1e-12)
    g = cfg.injector.geometry
    vO = r["mdot_O"] / (1140.0 * 24 * math.pi * g.oxidizer.d_jet ** 2 / 4)
    vF = r["mdot_F"] / (789.0 * 24 * math.pi * g.fuel.d_jet ** 2 / 4)
    pO, pF = r["mdot_O"] * vO, r["mdot_F"] * vF
    s35, s48 = math.radians(35.0), math.radians(48.0)
    lean = math.degrees(math.atan2(pO * math.sin(s35) - pF * math.sin(s48), pO * math.cos(s35) + pF * math.cos(s48)))
    assert rows["spray lean"]["value"] == pytest.approx(lean, rel=1e-6)
    assert rows["LOX jet velocity"]["value"] == pytest.approx(vO, rel=1e-9)


def test_every_sensitivity_case_is_honoured_and_moves_what_it_should(solved):
    from engine.core.injectors.spray_report import sensitivity
    cfg, r = solved
    cases = {c["case"]: c for c in sensitivity(cfg, r)}
    assert all(c["applied"] and "error" not in c for c in cases.values())
    base = cases["as configured"]
    # E_m moves mixing and leaves vaporization alone; the SMD transfer does the reverse.
    lo, hi = cases["Rupe E_m opt 0.70"], cases["Rupe E_m opt 0.85"]
    assert lo["eta_mix"] < base["eta_mix"] < hi["eta_mix"] and lo["F"] < base["F"] < hi["F"]
    dj = cases["SMD transfer: Dombrowski & Johns"]
    assert dj["eta_vap"] > base["eta_vap"] and dj["eta_mix"] == pytest.approx(base["eta_mix"], abs=2e-3)
    # the config itself is untouched by the sweep
    assert cfg.combustion.efficiency.rupe_Em_opt == 0.80 and cfg.spray.smd.smd_property_transfer == "tn4087"

"""Forward mode's report (engine/pipeline/forward_report.py): each quantity once, graded here."""
import copy

import pytest

PSI = 6894.757
CFG = "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"


@pytest.fixture(scope="module")
def rep():
    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.forward_report import forward_report
    cfg = load_config(CFG)
    P = cfg.lox_tank.initial_pressure_psi * PSI
    r = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(P, P, silent=True, rich_stability=True)
    return r, forward_report(cfg, r)


def test_one_value_per_quantity(rep):
    """A key that appears in more than one place (Pc in the headline and Chamber, theta_c in
    Chamber and Stability) carries one value everywhere."""
    _, R = rep
    seen = {}
    for q in R["headline"] + [q for s in R["sections"] for q in s["quantities"]]:
        if q["key"] in seen:
            assert q["value"] == pytest.approx(seen[q["key"]], rel=1e-12), q["key"]
        seen[q["key"]] = q["value"]
    for s in R["sections"]:
        keys = [q["key"] for q in s["quantities"]]
        assert len(keys) == len(set(keys)), s["key"]
        assert set(s["summary"]) <= set(keys)


def test_headline_is_the_solve(rep):
    r, R = rep
    h = {q["key"]: q["value"] for q in R["headline"]}
    assert h["F"] == pytest.approx(r["F"] / 1000)
    assert h["Pc"] == pytest.approx(r["Pc"] / PSI)
    assert h["OF"] == pytest.approx(r["MR"])


def test_verdicts_are_graded_against_their_thresholds(rep):
    r, R = rep
    v = {x["key"]: x for x in R["verdicts"]}
    assert v["chug"]["value"] == pytest.approx(r["stability_rich"]["chug"]["margin"])
    assert v["chug"]["status"] == "ok"                  # 1.42 against 1.05
    assert v["stiffness"]["status"] == "ok"             # 33.7 % against 15 %
    assert all(x["status"] in ("ok", "warn", "bad", "unknown") for x in R["verdicts"])


def test_every_mark_names_a_known_input(rep):
    from engine.pipeline.forward_report import CALIBRATION
    _, R = rep
    for q in R["headline"] + R["verdicts"] + [q for s in R["sections"] for q in s["quantities"]]:
        assert set(q["assumed"]) <= set(CALIBRATION), q["key"]
        assert set(q["assumed"]) <= set(R["calibration"]), q["key"]


def test_residence_time_is_rho_v_over_mdot(rep):
    r, R = rep
    ch = next(s for s in R["sections"] if s["key"] == "chamber")
    th = next(q for q in ch["quantities"] if q["key"] == "theta_c")
    assert th["value"] == pytest.approx(r["chamber_intrinsics"]["residence_time"] * 1000)
    # shown once: the chug model's own theta_c (nozzle-stagnation form, 0.4 % lower) is not a second row
    keys = [q["key"] for s in R["sections"] for q in s["quantities"]]
    assert keys.count("theta_c") == 1


def test_thrust_and_cstar_close_by_hand_from_the_page(rep):
    """F = Cf · Pc_ns · At and c* = Pc_ns · At / ṁ from the numbers the report shows.

    The bases said Pc where the nozzle uses Pc_ns = Pc / κ, and Pc_ns was not on the page: on the
    LE4 (3) stand Cf · Pc · At came to 6898 N against the 6870 N shown (+0.41 %), and Pc · At / ṁ to
    1574 m/s against c* 1568. Nothing from the page closed.
    """
    _, R = rep
    q = {x["key"]: x for s in R["sections"] for x in s["quantities"]}
    h = {x["key"]: x for x in R["headline"]}
    pc_ns = q["Pc_ns"]["value"] * PSI
    At = q["At"]["value"] * 1e-6
    assert "Pc_ns" in h["F"]["basis"] and "Pc_ns" in q["Cf"]["basis"] and "Pc_ns" in q["cstar"]["basis"]
    assert h["F"]["value"] * 1000.0 == pytest.approx(q["Cf"]["value"] * pc_ns * At, rel=2e-4)
    assert q["cstar"]["value"] == pytest.approx(pc_ns * At / h["mdot"]["value"], rel=2e-4)
    assert q["Pc"]["value"] / q["Pc_ns"]["value"] == pytest.approx(q["kappa"]["value"], rel=1e-9)
    assert q["kappa"]["value"] > 1.0, "no Rayleigh loss: the case no longer tells Pc from Pc_ns"

"""Forward mode's independent check runs where rocketcea is not installed.

The API image leaves rocketcea out on purpose (it builds CEA from Fortran; requirements-base.txt),
and handcheck imported it first thing: POST /api/evaluate on the LE4 (3) stand came back with
``handcheck = {"rows": [], "error": "ModuleNotFoundError: No module named 'rocketcea'"}`` and the
page said only "Independent check: unavailable". Nothing tested handcheck at all.

Without rocketcea the textbook rows (mass balance, F = Cf Pc_ns At, Isp, the injector's Sutton 8-1,
Rupe M, stay time) need no CEA and must run; c* is checked against the committed wide CEA table;
the rows that need live CEA say so, and ``note`` says why.
"""

from __future__ import annotations

import copy
import sys

import pytest

PSI = 6894.757
CFG = "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"


@pytest.fixture(scope="module")
def solved():
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config

    cfg = load_config(CFG)
    P = 578.0 * PSI
    r = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(P, P, silent=True)
    return cfg, r, P


@pytest.fixture
def no_rocketcea(monkeypatch):
    """Make ``import rocketcea`` fail here even where it is installed."""
    monkeypatch.setitem(sys.modules, "rocketcea", None)
    monkeypatch.setitem(sys.modules, "rocketcea.cea_obj", None)


def _rows(hc):
    return {row["quantity"]: row for row in hc["rows"]}


def test_the_check_runs_and_says_what_it_could_not_check(solved, no_rocketcea):
    from engine.pipeline.handcheck import handcheck

    cfg, r, P = solved
    hc = handcheck(cfg, r, P, P)
    assert "error" not in hc
    assert "rocketcea" in hc["note"]
    rows = _rows(hc)
    for q in ("mdot = Pc_ns At / c*", "F = Cf Pc_ns At", "Isp = F / (mdot g0)", "Rupe M"):
        assert rows[q]["kind"] == "compare" and rows[q]["ok"], rows[q]
    for q in ("Tc ideal", "gamma chamber", "exit pressure", "Cf (zeta_n on vacuum Cf)"):
        assert rows[q]["kind"] == "info" and rows[q]["hand"] == "needs rocketcea", rows[q]


def test_c_star_is_checked_against_the_committed_wide_table(solved, no_rocketcea):
    from engine.pipeline.handcheck import handcheck

    cfg, r, P = solved
    rows = _rows(handcheck(cfg, r, P, P))
    c = rows["c* ideal"]
    assert c["kind"] == "compare" and c["ok"] and "wide" in c["source"], c
    assert rows["eta c*"]["ok"], rows["eta c*"]


def test_a_clamped_mixture_ratio_shows_up_as_a_c_star_disagreement(solved, no_rocketcea):
    """The wide table spans O/F 0.1-20 where the design's cache stops at 2.5: past the edge the
    model's c* is the edge's, the table's is the point's, and the row says so."""
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.handcheck import handcheck

    cfg, _, _ = solved
    PO, PF = 578.0 * PSI, 300.0 * PSI
    r = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(PO, PF, silent=True)
    assert r["MR"] > 2.5
    c = _rows(handcheck(cfg, r, PO, PF))["c* ideal"]
    assert c["kind"] == "compare" and not c["ok"], c

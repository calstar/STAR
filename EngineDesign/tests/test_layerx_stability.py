"""Layer X chug margin on the drawing's basis (engine/layerx/diag/stability.py; audit D7, 9.4).

What these check, and against what:

* **The config basis is today's replay, exactly.** The diagnostic re-solves EngineDesign's
  chamber at the replay's own points and geometry; its gate must equal the replay's
  ``chug_margin`` to the last bit, or it is not the same model and "other basis" comparisons mean
  nothing. Checked on a short real replay here, and on the LE4 golden burn (1.398) when
  ``LAYERX_GOLDEN=1``.
* **The drawing basis takes the drawing's numbers and nothing else.** Its inertance is checked
  against sum(L)/A by hand from the shipped helium drawing (0.14 m and 0.9644 m of 10.92 mm tube);
  its resistance against 2 (line drop + dump) / mdot by hand at the same point. A drawing and a
  run that declare nothing for it change nothing.

Slow cases (one LE4 helium burn, or two for the time-step check) run only with ``LAYERX_GOLDEN=1``.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import math
import os
from pathlib import Path
from typing import Any, Dict

import pytest

feedtwin = pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx.prepare import PSI  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "docs" / "layerx" / "baseline-2026-10-03d.json"
HE = "copv_study_he"
SLOW = os.environ.get("LAYERX_GOLDEN") == "1"

#: 1/2 in. x 0.035 in. Swagelok tube, the drawing's bore on every propellant line [m].
BORE = 10.92e-3
AREA = math.pi * BORE ** 2 / 4.0


def _script():
    spec = importlib.util.spec_from_file_location("layerx_baseline", ROOT / "scripts" / "layerx_baseline.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def le4():
    script = _script()
    config, _ = script.load_engine_config(BASELINE)
    return script, config


@pytest.fixture(scope="module")
def prep(le4):
    """LE4 on the helium hot-fire drawing, prepared (no burn)."""
    from engine.core.runner import PintleEngineRunner
    from engine.layerx import LayerXSettings, prepare

    script, config = le4
    drawing = script.find_drawing(HE)
    cfg = copy.deepcopy(config)
    p = prepare(cfg, PintleEngineRunner(cfg), drawing, LayerXSettings(drawing_id=drawing.id), [])
    assert p.ok, [c for c in p.checks if c.status == "fail"]
    return p


def _series(prep, n_fire: int = 5, dt: float = 0.05) -> Dict[str, Any]:
    """A short steady firing at the LE4 helium burn's first-step state (t = 0.05 s of the golden
    run): line exits 557.0 / 541.5 psia, tank outlets 574.9 / 574.7 psia."""
    t = [round(k * dt, 10) for k in range(n_fire + 1)]
    fire = [False] + [True] * n_fire

    def side(inlet: float, outlet: float, mdot: float, T: float) -> Dict[str, Any]:
        return {"inlet_psia": [inlet] * len(t), "outlet_psia": [outlet] * len(t), "tank_psia": [outlet - 0.4] * len(t),
                "mdot": [0.0] + [mdot] * n_fire, "liquid_K": [T] * len(t)}

    return {"t": t, "firing": fire, "dt": [dt] * len(t),
            "ox": side(556.9864, 574.8921, 1.8517, 90.0),
            "fuel": side(541.5243, 574.7475, 1.2149, 293.15),
            "chamber": {"pc_psia": [14.7] + [390.47] * n_fire}}


@pytest.fixture(scope="module")
def short(prep):
    """A real EngineDesign erosion replay of the short firing: ``{"series", "replay"}``."""
    from engine.layerx import replay as rpl

    series = _series(prep)
    rp = rpl.replay(prep, series, n=4)
    assert rp.get("available"), rp
    return {"series": series, "replay": rp}


# ------------------------------------------------------------------ 1. the drawing's basis


def test_drawing_inertance_is_sum_L_over_A_by_hand(prep):
    """Sum of L/A over the drawn lines tank -> injector, each on its own bore. Hand: LOX
    l_ox1 + l_ox2 = 0.07 + 0.07 m, fuel l_fu1 + l_fu2 = 0.9144 + 0.05 m, all 10.92 mm tube
    (audit 9.4 section 2: 1495 and 10297 1/m)."""
    from engine.layerx.diag.stability import drawing_feed

    fp = drawing_feed(prep)
    assert [ln["id"] for ln in fp["oxidiser"]["lines"]] == ["l_ox1", "l_ox2"]
    assert [ln["id"] for ln in fp["fuel"]["lines"]] == ["l_fu1", "l_fu2"]
    assert fp["oxidiser"]["inertance"] == pytest.approx(0.14 / AREA, rel=1e-9)
    assert fp["fuel"]["inertance"] == pytest.approx(0.9644 / AREA, rel=1e-9)
    assert round(fp["oxidiser"]["inertance"]) == 1495 and round(fp["fuel"]["inertance"]) == 10297
    # The ball valves have a bore and no length: said, not guessed.
    assert any("MV-OX" in f and "inertance is not counted" in f for f in fp["oxidiser"]["flags"])
    assert all("estimated" in ln["length_provenance"] for ln in fp["fuel"]["lines"])


def test_config_basis_reproduces_the_replay_exactly(prep, short):
    """The config basis is the replay's own chug gate, re-evaluated: equal to the last bit."""
    from engine.layerx.diag.stability import stability_block

    blk = stability_block(prep, short, basis="config")
    assert blk["available"], blk
    ref = short["replay"]["chug_margin"]
    replay_pts = [m for m, rp in zip(blk["margin"], blk["replay_point"]) if rp]
    assert replay_pts == ref
    assert blk["check"] == {"against": "replay.chug_margin (config basis)", "points": len(ref), "max_abs_diff": 0.0}


def test_drawing_basis_streams_by_hand(prep, short):
    """At one point, the drawing basis's streams carry the drawing's inertance and
    R = 2 (tank outlet - line exit + exit dump) / mdot, every other input unchanged."""
    from engine.layerx.diag import stability as S

    series, rp = short["series"], short["replay"]
    runner = prep.link.sampler.runner
    i = rp["index"][0]
    Pc, diag = S._solve_point(runner, S._with_geometry(runner.config, None),
                              rp["inlet_O_psia"][0] * PSI, rp["inlet_F_psia"][0] * PSI)
    fd, notes = S._drawing_feed_at(S.drawing_feed(prep), series, i, diag)
    assert not notes
    inp_c = S._inputs(runner.config, Pc, diag)
    inp_d = S._inputs(runner.config, Pc, diag, feed=fd)
    assert inp_c["feed_basis"] == "config" and inp_d["feed_basis"] == "caller"
    for key, skey, L in (("O", "ox", 0.14), ("F", "fuel", 0.9644)):
        sc = next(s for s in inp_c["streams"] if s.name == key)
        sd = next(s for s in inp_d["streams"] if s.name == key)
        line = (series[skey]["outlet_psia"][i] - series[skey]["inlet_psia"][i]) * PSI
        dump = diag[f"delta_p_feed_{key}"]
        assert sd.inertance() == pytest.approx(L / AREA, rel=1e-9)
        assert sd.resistance() == pytest.approx(2.0 * (line + dump) / sd.mdot, rel=1e-12)
        # nothing else moves
        for attr in ("mdot", "eta_inj", "Pc", "tau_conv"):
            assert getattr(sd, attr) == getattr(sc, attr)
    assert inp_d["chamber"] == inp_c["chamber"]


def test_drawing_basis_on_a_drawing_that_declares_nothing_changes_nothing(prep, short):
    """No line on the path and no outlet pressures: the drawing basis is the config basis."""
    from engine.layerx.diag import stability as S

    series = copy.deepcopy(short["series"])
    for s in ("ox", "fuel"):
        series[s].pop("outlet_psia")
    empty = {"oxidiser": {"inertance": None}, "fuel": {"inertance": None}}
    real = S.drawing_feed
    S.drawing_feed = lambda prep: empty
    try:
        blk = S.stability_block(prep, {"series": series, "replay": short["replay"]}, basis="drawing")
    finally:
        S.drawing_feed = real
    assert blk["available"], blk
    assert [m for m, r in zip(blk["margin"], blk["replay_point"]) if r] == short["replay"]["chug_margin"]
    assert blk["margin_other"] == blk["margin"]


def test_feed_override_is_opt_in_and_validated(prep, short):
    """``build_stability_inputs(feed=None)`` is the old call; a bad value is refused, not clipped."""
    from engine.layerx.diag import stability as S

    runner = prep.link.sampler.runner
    rp = short["replay"]
    Pc, diag = S._solve_point(runner, S._with_geometry(runner.config, None),
                              rp["inlet_O_psia"][0] * PSI, rp["inlet_F_psia"][0] * PSI)
    a = S._inputs(runner.config, Pc, diag)
    b = S._inputs(runner.config, Pc, diag, feed={})
    assert [(s.feed_length, s.dP_feed) for s in a["streams"]] == [(s.feed_length, s.dP_feed) for s in b["streams"]]
    with pytest.raises(ValueError):
        S._inputs(runner.config, Pc, diag, feed={"fuel": {"inertance": -1.0}})


# ------------------------------------------------------------------ 2. the eroded geometry


def test_eroded_reproduces_the_solvers_own_eroded_chug(prep, short):
    """``eroded=True`` is the coupled solver's ``chug_eroded_geometry=True``, re-evaluated: the
    replay run with that flag and this diagnostic agree to the last bit, so the geometry the
    diagnostic rebuilds from the replay's columns is the geometry the solver had."""
    from engine.layerx import replay as rpl
    from engine.layerx.diag.stability import stability_block

    rp = rpl.replay(prep, short["series"], n=4, chug_eroded_geometry=True)
    assert rp.get("available") and rp["chug_eroded_geometry"] is True
    blk = stability_block(prep, {"series": short["series"], "replay": rp}, basis="config", eroded=True)
    assert blk["eroded"] is True
    assert blk["check"]["max_abs_diff"] == 0.0
    assert [m for m, r in zip(blk["margin"], blk["replay_point"]) if r] == rp["chug_margin"]


def test_eroded_on_an_uneroded_chamber_changes_nothing(prep, short):
    """Turned on against a chamber that has not eroded (the replay's geometry set to the design's),
    ``eroded=True`` gives exactly the design-point answer."""
    from engine.layerx.diag.stability import stability_block
    from engine.pipeline.config_schemas import ensure_chamber_geometry

    cg = ensure_chamber_geometry(copy.deepcopy(prep.link.sampler.runner.config))
    rp = copy.deepcopy(short["replay"])
    n = len(rp["t"])
    rp.update(A_throat_m2=[cg.A_throat] * n, V_chamber_m3=[cg.volume] * n, A_exit_m2=[cg.A_exit] * n,
              D_chamber_mm=[cg.chamber_diameter * 1e3] * n)
    res = {"series": short["series"], "replay": rp}
    on = stability_block(prep, res, basis="drawing", eroded=True)
    off = stability_block(prep, res, basis="drawing", eroded=False)
    assert on["margin"] == off["margin"] and on["margin_other"] == off["margin_other"]


def test_eroded_throat_raises_the_margin_by_the_chamber_gain(prep, short):
    """A larger throat lowers the chamber gain K_c = c*/A_t and shortens theta_c = L* c*/(R T), and
    the loop gain falls: +4 % of throat area must raise the margin. At the same point the eroded
    chamber gain is the design's times A_t0/A_t, by hand."""
    from engine.layerx.diag import stability as S
    from engine.pipeline.config_schemas import ensure_chamber_geometry

    runner = prep.link.sampler.runner
    base = runner.config
    cg = ensure_chamber_geometry(copy.deepcopy(base))
    grown = {"A_throat": cg.A_throat * 1.04, "volume": cg.volume, "A_exit": cg.A_exit,
             "chamber_diameter": cg.chamber_diameter}
    rp = short["replay"]
    cfg_now = S._with_geometry(base, grown)
    Pc, diag = S._solve_point(runner, cfg_now, rp["inlet_O_psia"][0] * PSI, rp["inlet_F_psia"][0] * PSI)
    frozen = S._inputs(base, Pc, diag)
    eroded = S._inputs(cfg_now, Pc, diag)
    assert eroded["chamber"].K_c() == pytest.approx(frozen["chamber"].K_c() / 1.04, rel=1e-12)
    assert eroded["chamber"].Lstar == pytest.approx(frozen["chamber"].Lstar / 1.04, rel=1e-12)
    assert S._gate(eroded)["gate"] > S._gate(frozen)["gate"]


# ------------------------------------------------------------------ 3. the start window


def _ramp_series(dt: float, horizon: float = 0.5) -> Dict[str, Any]:
    """One continuous start sampled at ``dt``: both mains open linearly over 50 ms (the drawing's
    travel), the line exits climbing from 45 % to full with the valve, then a slow rise of
    10 psi/s, as the helium burn's do. The same function of time at every ``dt``."""
    n = int(round(horizon / dt))
    t = [round(-dt + k * dt, 10) for k in range(n + 2)]
    fire = [tt > 1e-12 for tt in t]

    def p(full: float, tt: float) -> float:
        x = min(max(tt / 0.05, 0.0), 1.0)
        return full * (0.45 + 0.55 * x) + 10.0 * max(tt - 0.05, 0.0)

    def side(inlet: float, outlet: float, mdot: float, T: float) -> Dict[str, Any]:
        return {"inlet_psia": [p(inlet, tt) for tt in t], "outlet_psia": [outlet + 10.0 * max(tt - 0.05, 0.0) for tt in t],
                "mdot": [mdot * min(max(tt / 0.05, 0.0), 1.0) for tt in t], "liquid_K": [T] * len(t)}

    return {"t": t, "firing": fire, "dt": [dt] * len(t),
            "ox": side(556.9864, 574.8921, 1.8517, 90.0),
            "fuel": side(541.5243, 574.7475, 1.2149, 293.15),
            "chamber": {"pc_psia": [390.47 * min(max(tt / 0.05, 0.0), 1.0) for tt in t]}}


def test_start_window_by_hand(prep, short):
    """Window = the mains' travel (the drawing's 0.05 s) + 3 line time constants, the longest of
    tau = (sum L/A) mdot / (2 (tank outlet - Pc)) by hand: the fuel's, ~4.9 ms (audit 9.5)."""
    from engine.layerx.diag.stability import drawing_feed, start_window_of

    fp = drawing_feed(prep)
    w = start_window_of(prep, short, fp)
    s = short["series"]
    tau_f = (0.9644 / AREA) * 1.2149 / (2.0 * (574.7475 - 390.47) * PSI)
    tau_o = (0.14 / AREA) * 1.8517 / (2.0 * (574.8921 - 390.47) * PSI)
    assert w["t_open"] == pytest.approx(0.05) and w["valve_travel"]["MVO"]["value"] == 0.05
    assert w["tau_line_s"]["fuel"] == pytest.approx(tau_f, rel=1e-9)
    assert w["tau_line_s"]["oxidiser"] == pytest.approx(tau_o, rel=1e-9)
    assert 4.5e-3 < tau_f < 5.5e-3
    assert w["start_window_s"] == pytest.approx(0.05 + 3.0 * tau_f, rel=1e-12)
    assert start_window_of(prep, short, fp, 0.2)["start_window_s"] == 0.2
    assert s["firing"][1]


def test_start_window_from_the_recorded_valve_state(prep, short):
    """With ``result.network`` (DATA-CONTRACT 2) the mains' recorded opening sets t_open: the first
    step both are open after one was seen short of open. feedtwin's trace reads a valve with no
    signal as fully open (``network_trace._opening``), so a recording that is open from its first
    step proves nothing and the drawing's travel rule is kept -- never a window that starts
    before Fire."""
    from engine.layerx.diag.stability import drawing_feed, start_window_of

    fp = drawing_feed(prep)
    s = short["series"]
    travel = start_window_of(prep, short, fp)

    def with_states(ox, fu):
        return {"series": s, "network": {"branches": {"MVO": {"state": ox}, "MVF": {"state": fu}}}}

    w = start_window_of(prep, with_states([0.0, 0.5, 1.0, 1.0, 1.0, 1.0], [0.0, 1.0, 1.0, 1.0, 1.0, 1.0]), fp)
    assert w["t_open_basis"] == "recorded valve state" and w["t_open"] == s["t"][2]
    tau = max(v for v in w["tau_line_s"].values() if v)
    assert w["start_window_s"] == pytest.approx(s["t"][2] + 3.0 * tau, rel=1e-12)
    # a main that never quite reaches open until step 4; None is read as shut
    w = start_window_of(prep, with_states([None, 0.5, 0.9, 0.99, 0.9995, 1.0], [0.0] + [1.0] * 5), fp)
    assert w["t_open"] == s["t"][4]
    w = start_window_of(prep, with_states([None] + [1.0] * 5, [None] + [1.0] * 5), fp)
    assert w["t_open_basis"] == "recorded valve state" and w["t_open"] == s["t"][1]
    # open from the first recorded step (no signal): no evidence of the opening, the travel rule holds
    w = start_window_of(prep, with_states([1.0] * 6, [1.0] * 6), fp)
    assert w["t_open_basis"] == travel["t_open_basis"] and w["t_open"] == travel["t_open"]
    assert w["start_window_s"] == travel["start_window_s"]


def test_gate_frequency_follows_the_nominal_when_it_sets_the_gate(prep, short):
    """chug_band's minimum includes the nominal point, but its ``at_min_fraction`` is the band
    grid's argmin. When the nominal lag is lower than every band sample (here: a band that ends
    short of the nominal fraction, on a margin that falls with the lag), the gate *is* the nominal
    and its frequency is the nominal's -- not the frequency at the band's lowest sample."""
    from engine.layerx.diag import stability as S

    inp = dict(_inputs_at(prep, short, short["replay"]["t"][0]))
    f0 = inp["mixing_lag_fraction"]
    inp["chug_band"] = (0.0, f0 - 0.1)
    g = S._gate(inp)
    assert g["gate"] == g["gm_nominal"] < min(g["band"]["gain_margins"])
    assert g["gate_fraction"] == f0 and g["f_gate_hz"] == g["f_nominal_hz"]
    # and the ordinary case still reads the band's own argmin
    g1 = S._gate(_inputs_at(prep, short, short["replay"]["t"][0]))
    assert g1["gate_fraction"] == g1["band"]["at_min_fraction"] == 1.0 and g1["f_gate_hz"] != g1["f_nominal_hz"]


def test_start_window_removes_the_dt_dependence(prep):
    """The same start sampled at 5 and 50 ms: the minimum over every step (the start included)
    moves with where the samples fall in the valve ramp; the graded minimum does not."""
    from engine.layerx.diag.stability import stability_block

    fine = stability_block(prep, {"series": _ramp_series(0.005)}, basis="config")
    coarse = stability_block(prep, {"series": _ramp_series(0.05)}, basis="config")
    assert fine["available"] and coarse["available"], (fine, coarse)
    assert fine["worst"]["t"] < 0.05 and fine["worst"]["margin"] < coarse["worst"]["margin"] - 0.05
    assert abs(fine["settled_min"]["margin"] - coarse["settled_min"]["margin"]) < 0.01
    assert fine["settled_min"]["t"] >= fine["start_window_s"] - 1e-9
    assert any(fine["in_start"]) and not any(i for i, t in zip(fine["in_start"], fine["t"]) if t >= fine["start_window_s"])


# ------------------------------------------------------------------ 4. Nyquist and the lag sweep


def _inputs_at(prep, short, t, basis="config"):
    """The stability inputs the block used at replay time ``t``, rebuilt."""
    from engine.layerx.diag import stability as S
    from engine.pipeline.config_schemas import ensure_chamber_geometry

    runner = prep.link.sampler.runner
    rp = short["replay"]
    k = rp["t"].index(t)
    geo = S._replay_geometry(rp, ensure_chamber_geometry(copy.deepcopy(runner.config)))
    Pc, diag = S._solve_point(runner, S._with_geometry(runner.config, S._geometry_at(geo, t, k)),
                              rp["inlet_O_psia"][k] * PSI, rp["inlet_F_psia"][k] * PSI)
    if basis == "config":
        return S._inputs(runner.config, Pc, diag)
    fd, _ = S._drawing_feed_at(S.drawing_feed(prep), short["series"], rp["index"][k], diag)
    return S._inputs(runner.config, Pc, diag, feed=fd)


def test_nyquist_is_the_models_open_loop_by_hand(prep, short):
    """L(iw) = K_c/(theta iw + 1) * sum exp(-iw tau_k)/(I_k iw + R_k + 2 eta_k Pc/mdot_k), written
    out from each stream's numbers (regulator not modelled), at the lag that sets the gate. Where
    it crosses the negative real axis, |L| = 1/gate and the frequency is the gate's."""
    import numpy as np
    from engine.layerx.diag.stability import stability_block

    blk = stability_block(prep, short, basis="drawing")
    ny = blk["nyquist"]
    inp = _inputs_at(prep, short, ny["t"], "drawing")
    ch = inp["chamber"]
    dtau = (ny["lag_fraction"] - inp["mixing_lag_fraction"]) * inp["tau_mix_basis"]
    s = 1j * np.asarray(ny["omega"])
    acc = 0.0
    for st in inp["streams"]:
        Z = (st.feed_length / st.feed_area) * s + 2.0 * st.dP_feed / st.mdot + 2.0 * st.eta_inj * st.Pc / st.mdot
        acc = acc + np.exp(-s * max(st.tau_conv + dtau, 0.0)) / Z
    theta = ch.Lstar * ch.cstar / (ch.R_gas * ch.T_c)
    L = (ch.cstar / ch.A_t) / (theta * s + 1.0) * acc
    assert np.allclose(ny["re"], L.real, rtol=1e-9, atol=1e-12)
    assert np.allclose(ny["im"], L.imag, rtol=1e-9, atol=1e-12)
    im, re = np.asarray(ny["im"]), np.asarray(ny["re"])
    k = [j for j in range(len(im) - 1) if im[j] * im[j + 1] < 0 and re[j] < 0]
    mags = []
    for j in k:
        x = im[j] / (im[j] - im[j + 1])
        mags.append((-(re[j] + x * (re[j + 1] - re[j])), ny["omega"][j] + x * (ny["omega"][j + 1] - ny["omega"][j])))
    mag, w = max(mags)
    assert 1.0 / mag == pytest.approx(ny["gain_margin"], rel=2e-3)
    assert w / (2 * math.pi) == pytest.approx(ny["f_cross_hz"], rel=1e-2)
    assert 15.0 < ny["f_cross_hz"] < 30.0       # the gate's ~22 Hz, not the nominal lag's ~35 Hz


def test_tau_sweep_contains_the_gate_and_the_nominal(prep, short):
    """The sweep is the band, densely: at the band's own five fractions it equals chug_band's
    gain margins exactly, at the nominal fraction the nominal margin, and its minimum is at most
    the gate."""
    from engine.layerx.diag import stability as S

    blk = S.stability_block(prep, short, basis="config")
    ts = blk["tau_sweep"]
    inp = _inputs_at(prep, short, ts["t"])
    g = S._gate(inp)
    band = g["band"]
    for f, gm in zip(band["fractions"], band["gain_margins"]):
        assert ts["margin"][ts["fraction"].index(f)] == gm
    f0 = inp["mixing_lag_fraction"]
    assert ts["margin"][ts["fraction"].index(f0)] == g["gm_nominal"]
    assert ts["min"]["margin"] <= g["gate"] + 1e-15
    assert ts["tau_ms"][ts["fraction"].index(f0)] == pytest.approx(ts["nominal_ms"], rel=1e-12)
    assert ts["stream"] == "F"          # ethanol's vaporisation paces LE4 (audit 9.4: 12 vs 3.6 ms)


# ------------------------------------------------------------------ 5. feed-line acoustics


def test_coolprop_liquid_sound_speeds():
    """LOX at 90 K / 555 psia and ethanol at 293.15 K / 540 psia, straight from CoolProp (audit
    9.4 section 4: 1150.2 kg/m3, 923 m/s; 792.6 kg/m3, 1182 m/s)."""
    import CoolProp.CoolProp as CP
    from engine.layerx.diag.stability import _coolprop_liquid

    for fluid, T, p, rho, a in (("oxygen", 90.0, 555.0, 1150.2, 923.4), ("ethanol", 293.15, 540.0, 792.6, 1182.3)):
        r, c, name = _coolprop_liquid(fluid, T, p * PSI)
        assert r == CP.PropsSI("D", "T", T, "P", p * PSI, name) and c == CP.PropsSI("A", "T", T, "P", p * PSI, name)
        assert r == pytest.approx(rho, abs=0.1) and c == pytest.approx(a, abs=0.5)


def test_korteweg_by_hand():
    """a = a0 / sqrt(1 + rho a0^2 D / (E e)): LOX in 1/2 x 0.035 in. 316 tube, 0.981 GPa liquid,
    10.92 mm bore, 0.889 mm wall, 193 GPa -> factor 1.031, 896 m/s (audit 9.4 section 4)."""
    from engine.layerx.diag.stability import korteweg

    a0, rho, D, e, E = 923.4, 1150.2, 10.92e-3, 0.889e-3, 193e9
    K = rho * a0 ** 2
    assert korteweg(a0, rho, D, e, E) == pytest.approx(a0 / math.sqrt(1.0 + K * D / (E * e)), rel=1e-15)
    assert a0 / korteweg(a0, rho, D, e, E) == pytest.approx(1.031, abs=5e-4)
    assert korteweg(a0, rho, D, e, E) == pytest.approx(896.0, abs=0.5)
    assert korteweg(a0, rho, D, 0.0, E) == a0                      # no wall stated: rigid, an upper bound
    # a stiffer tube is faster, a thicker wall is faster
    assert korteweg(a0, rho, D, e, 2 * E) > korteweg(a0, rho, D, e, E)
    assert korteweg(a0, rho, D, 2 * e, E) > korteweg(a0, rho, D, e, E)


def test_line_acoustics_on_the_helium_drawing(prep, short):
    """The fuel path (0.9644 m) quarter-wave sits at ~296 Hz and LOX's (0.14 m) at ~1600 Hz,
    8-70x above chug: not near it. Put the chug band at the fuel's quarter-wave and it is flagged.
    The drawing's copied wall thickness is flagged."""
    from engine.layerx.diag import stability as S

    fp = S.drawing_feed(prep)
    series = short["series"]
    ac = S.acoustics(prep, series, fp, 1, [21.8, 23.2])
    path = {r["side"]: r for r in ac["lines"] if "whole path" in r["line"]}
    rho, a0, _ = S._coolprop_liquid("ethanol", 293.15, 0.5 * (574.7475 + 541.5243) * PSI)
    a = S.korteweg(a0, rho, BORE, 0.889e-3, S.TUBE_MODULUS_PA)
    assert path["fuel"]["f_quarter_hz"] == pytest.approx(a / (4 * 0.9644), rel=1e-12)
    assert path["fuel"]["f_half_hz"] == pytest.approx(a / (2 * 0.9644), rel=1e-12)
    assert path["fuel"]["f_quarter_hz"] == pytest.approx(296.0, abs=3.0)
    assert path["oxidiser"]["f_quarter_hz"] == pytest.approx(1600.0, abs=15.0)
    assert not any(r["near_chug"] for r in ac["lines"])
    assert 0.0 < path["fuel"]["lumped_error"] < 0.02
    near = S.acoustics(prep, series, fp, 1, [path["fuel"]["f_quarter_hz"] * 1.1])
    # the path and its long run (l_fu1, 0.9144 m: 313 Hz) are near; the 5 cm stub and LOX are not
    assert {r["line"] for r in near["lines"] if r["near_chug"]} == {path["fuel"]["line"], "l_fu1"}
    assert any("copied line to line" in f for f in ac["flags"])


def test_acoustics_failure_does_not_take_the_margin(prep, short, monkeypatch):
    """A propellant CoolProp cannot state loses that side's line rows and says so; the chug margin
    (the block's reason to exist) is unchanged."""
    from engine.layerx.diag import stability as S

    ref = S.stability_block(prep, short, basis="drawing")

    def no_state(fluid, T, p):
        raise ValueError(f"no fluid {fluid!r}")

    monkeypatch.setattr(S, "_coolprop_liquid", no_state)
    blk = S.stability_block(prep, short, basis="drawing")
    assert blk["available"], blk
    assert blk["margin"] == ref["margin"] and blk["settled_min"] == ref["settled_min"]
    assert blk["acoustic"] == [] and sum("acoustics skipped" in f for f in blk["acoustic_flags"]) == 2


# ------------------------------------------------------------------ 6. the chug loop with line inertance


def _closed_form(K_c: float, theta: float, tau: float, Z: float, I: float):
    """One stream, regulator off: L(iw) = K_c e^(-iw tau) / ((1 + iw theta)(Z + iw I)). Phase and
    magnitude both fall monotonically with w, so the worst negative-axis crossing is the first:
    w tau + atan(w theta) + atan(w I/Z) = pi, and GM = sqrt(1 + (w theta)^2) sqrt(Z^2 + (w I)^2) / K_c.
    (The constant-lag chug loop with the line's inertia: Summerfield, J. ARS 21(5), 1951.)"""
    from scipy.optimize import brentq

    w = brentq(lambda w: w * tau + math.atan(w * theta) + math.atan(w * I / Z) - math.pi, 1e-6, 2 * math.pi * 1e5,
               xtol=1e-14, rtol=1e-15)
    return math.sqrt(1 + (w * theta) ** 2) * math.sqrt(Z * Z + (w * I) ** 2) / K_c, w / (2 * math.pi)


def _one_stream(I: float, tau: float):
    from engine.pipeline.stability import chug

    st = chug.ChugStream("F", mdot=1.21, eta_inj=0.35, Pc=2.69e6, dP_feed=1.0e5, feed_length=I * AREA,
                         feed_area=AREA, tau_conv=tau, regulator=chug.Regulator(enabled=False))
    ch = chug.ChugChamber(cstar=1567.0, A_t=1.795e-3, Lstar=1.359, gamma=1.13, R_gas=372.0, T_c=3205.0)
    return st, ch


@pytest.mark.parametrize("I", [0.0, 1495.0, 10297.0, 30000.0])
def test_chug_with_line_inertance_against_the_closed_form(I):
    """The gate's own solver (EngineDesign's ``_chug_fast``: the compiled kernel when it is on, and
    the Python ``chug_margin_fast``) on LE4's fuel side with the line's inertance, against the
    closed form: GM within 0.5 % (the 200-point grid's interpolation), frequency within 1 %. At
    LE4's 10297 1/m the inertance moves GM by +25 %, so a dropped I*s term cannot pass."""
    from engine.pipeline.stability import chug
    from engine.pipeline.stability.analysis import _chug_fast

    st, ch = _one_stream(I, 17.0e-3)
    Z = st.resistance() + 1.0 / st.G_inj()
    gm, f = _closed_form(ch.K_c(), ch.theta_c(), st.tau_conv, Z, I)
    for res in (_chug_fast([st], ch), chug.chug_margin_fast([st], ch)):
        assert res["gain_margin"] == pytest.approx(gm, rel=5e-3)
        assert res["f_chug_hz"] == pytest.approx(f, rel=1e-2)
    if I == 10297.0:
        gm0, _ = _closed_form(ch.K_c(), ch.theta_c(), st.tau_conv, Z, 0.0)
        assert gm / gm0 > 1.2


@pytest.mark.parametrize("f0", [15.0, 25.0, 40.0])
def test_chug_on_the_closed_form_boundary_reads_neutral(f0):
    """Put the loop exactly on its stability boundary at f0 (tau* and K_c* from the closed form,
    LE4's fuel inertance): the code must read GM = 1 at f0."""
    from engine.pipeline.stability import chug
    from engine.pipeline.stability.analysis import _chug_fast

    I, w0 = 10297.0, 2 * math.pi * f0
    st, ch = _one_stream(I, 0.0)
    Z = st.resistance() + 1.0 / st.G_inj()
    th = ch.theta_c()
    st = chug.ChugStream(**{**st.__dict__, "tau_conv": (math.pi - math.atan(w0 * th) - math.atan(w0 * I / Z)) / w0})
    K = math.sqrt(1 + (w0 * th) ** 2) * math.sqrt(Z * Z + (w0 * I) ** 2)
    k = K * ch.A_t / ch.cstar          # c* and T scaled together: K_c -> K, theta unchanged
    chb = chug.ChugChamber(cstar=ch.cstar * k, A_t=ch.A_t, Lstar=ch.Lstar, gamma=ch.gamma, R_gas=ch.R_gas, T_c=ch.T_c * k)
    assert chb.theta_c() == pytest.approx(th, rel=1e-12) and chb.K_c() == pytest.approx(K, rel=1e-12)
    res = _chug_fast([st], chb)
    assert res["gain_margin"] == pytest.approx(1.0, abs=5e-3)
    assert res["f_chug_hz"] == pytest.approx(f0, rel=1e-2)


# ------------------------------------------------------------------ the contract


def test_block_follows_the_data_contract(prep, short):
    """DATA-CONTRACT section 3 ``stability``: the keys, plain JSON (no NaN), a ``model`` block whose
    every input says where it came from, and a failure that is reported, never raised."""
    from engine.layerx.diag.stability import stability_block

    blk = stability_block(prep, short, basis="drawing", eroded=True)
    json.dumps(blk, allow_nan=False)
    assert blk["basis"] == "drawing"
    n = len(blk["t"])
    assert all(len(blk[k]) == n for k in ("margin", "frequency_hz", "index", "in_start", "margin_other"))
    assert set(blk["worst"]) >= {"t", "margin", "frequency_hz"} and set(blk["settled_min"]) >= {"t", "margin"}
    assert isinstance(blk["start_window_s"], float)
    assert set(blk["nyquist"]) >= {"t", "omega", "re", "im"} and len(blk["nyquist"]["re"]) == len(blk["nyquist"]["omega"])
    assert set(blk["tau_sweep"]) >= {"tau_ms", "margin", "nominal_ms"}
    assert blk["acoustic"] and all(set(r) >= {"line", "side", "length_m", "f_quarter_hz", "f_half_hz", "near_chug"}
                                   for r in blk["acoustic"])
    assert set(blk["other_basis"]) >= {"basis", "margin_min", "t"} and blk["other_basis"]["basis"] == "config"
    m = blk["model"]
    assert set(m) == {"name", "source", "assumptions", "inputs"} and m["assumptions"]
    assert all(set(v) >= {"value", "unit", "provenance"} and v["provenance"] for v in m["inputs"].values())
    assert "drawing" in m["inputs"]["inertance_F"]["provenance"]
    assert {u["name"] for u in blk["unmeasured"]} >= {"stability.mixing_lag_fraction", "l_fu1.length"}
    bad = stability_block(prep, short, basis="nonsense")
    assert bad["available"] is False and "basis" in bad["error"]


# ------------------------------------------------------------------ slow: the LE4 golden burn


@pytest.fixture(scope="module")
def golden(le4):
    if not SLOW:
        pytest.skip("slow LE4 burn: set LAYERX_GOLDEN=1")
    from engine.core.runner import PintleEngineRunner
    from engine.layerx import LayerXSettings, prepare, run_prepared

    script, config = le4
    drawing = script.find_drawing(HE)
    cfg = copy.deepcopy(config)
    runner = PintleEngineRunner(cfg)
    p = prepare(cfg, runner, drawing, LayerXSettings(drawing_id=drawing.id), [])
    result = run_prepared(p, runner=runner, replay=True, config=cfg, progress=lambda *a: None)
    return p, result, json.loads(BASELINE.read_text())["cases"]["he_pad"]["metrics"]


def test_golden_config_basis_is_the_baseline(golden):
    from engine.layerx.diag.stability import stability_block

    p, result, base = golden
    # The replay now runs the chug on the eroded engine (D7, the default since 2026-10-03): compare
    # like with like.
    blk = stability_block(p, result, basis="config", eroded=True)
    assert blk["check"]["max_abs_diff"] == 0.0
    at_replay = [(m, t) for m, t, r in zip(blk["margin"], blk["t"], blk["replay_point"]) if r]
    low = min(at_replay)
    assert low[0] == pytest.approx(base["chug_margin_min"], rel=1e-9)   # 1.398, the replay's own minimum
    assert low[1] == pytest.approx(base["chug_margin_min_t_s"], abs=1e-9)


def test_golden_drawing_basis_moves_the_minimum(golden):
    """Audit 9.4 section 2: drawing I + R gives 1.468 on the [doc] He burn. The drawing basis does
    not read the config's lengths, so LE4's YAML (config basis 1.398) lands on the same ~1.468:
    +0.07 here, +0.10 on [doc], whose config lines are shorter."""
    from engine.layerx.diag.stability import stability_block

    p, result, _ = golden
    blk = stability_block(p, result, basis="drawing")
    assert blk["settled_min"]["margin"] == pytest.approx(1.468, abs=0.005)
    assert blk["other_basis"]["margin_min"] == pytest.approx(1.398, abs=1e-3)
    assert 0.05 < blk["settled_min"]["margin"] - blk["other_basis"]["margin_min"] < 0.12


def test_golden_eroded_raises_burnout(golden):
    """Audit 9.4 section 3: unfreezing A_t and L* adds ~+0.004 at the minimum and +0.08 at burnout
    on [doc] (5.7 % throat growth). LE4's YAML grows the throat 4.0 %, so burnout rises ~+0.06."""
    from engine.layerx.diag.stability import stability_block

    p, result, _ = golden
    off = stability_block(p, result, basis="config", eroded=False)
    on = stability_block(p, result, basis="config", eroded=True)
    assert 0.04 < on["margin"][-1] - off["margin"][-1] < 0.10
    assert 0.0 <= on["worst"]["margin"] - off["worst"]["margin"] < 0.01


def test_golden_start_window_removes_the_dt_dependence(golden, le4):
    """The audit's measurement (5.1): the replay's minimum reads 1.367 / 1.161 at 50 / 5 ms on
    [doc] (1.398 / 1.191 on the YAML). Graded from the first fully-open step, a 5 ms burn and the
    50 ms burn agree within 0.01."""
    from engine.core.runner import PintleEngineRunner
    from engine.layerx import LayerXSettings, prepare, run_prepared
    from engine.layerx.diag.stability import stability_block

    p50, r50, _ = golden
    script, config = le4
    drawing = script.find_drawing(HE)
    cfg = copy.deepcopy(config)
    runner = PintleEngineRunner(cfg)
    p5 = prepare(cfg, runner, drawing, LayerXSettings(drawing_id=drawing.id, dt=0.005), [])
    r5 = run_prepared(p5, runner=runner, replay=True, config=cfg, progress=lambda *a: None)
    for basis in ("config", "drawing"):
        a = stability_block(p50, r50, basis=basis)
        b = stability_block(p5, r5, basis=basis)
        assert abs(a["settled_min"]["margin"] - b["settled_min"]["margin"]) < 0.01, basis
    # ...while the ungraded minimum still carries the ramp sample
    assert stability_block(p5, r5, basis="config")["worst"]["margin"] < 1.25

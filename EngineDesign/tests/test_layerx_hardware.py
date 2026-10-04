"""Layer X hardware read-outs: what the erosion replay keeps, and the hardware geometry built on it.

What these check, and against what:

* The replay keeps the per-step arrays the coupled solver computes (audit 5.2) without touching the
  keys it had. The new arrays are checked against identities that do not go through the code under
  test: the throat diameter against its area, the c* efficiency against its own breakdown, the
  throat station's recession against the old throat-recession key, the net load against its parts.
* An eroding engine is replayed on the coupled solver only (audit 5.3): a graphite-only engine,
  which used to replay through the legacy loop at zero erosion, now erodes; the legacy path refuses.

The replay here runs on LE4 (``configs/ethalox_6800N.yaml``) at synthetic line-exit pressures
through a minimal stand-in for ``Prepared``: the replay reads only the runner, the as-built
throat, the step and the ambient from it, and a twin burn would cost a minute per test.
"""

from __future__ import annotations

import copy
import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from engine.core.runner import PintleEngineRunner
from engine.layerx import replay as rpl
from engine.layerx.card import line_exit_config
from engine.pipeline.io import load_config

ROOT = Path(__file__).resolve().parents[1]
LE4 = ROOT / "configs" / "ethalox_6800N.yaml"
PSI = 6894.757293168361
AMBIENT = 94070.0  # Pa; a site value, not the default, so a dropped ambient shows

pytestmark = pytest.mark.skipif(not LE4.is_file(), reason="LE4 config (configs/ethalox_6800N.yaml) not in this checkout")

#: The replay's keys before 2026-10-02 (engine/layerx/replay.py): kept, unchanged.
OLD_KEYS = (
    "available", "t", "index", "inlet_O_psia", "inlet_F_psia", "pc_psia", "thrust_N", "mdot_O", "mdot_F",
    "mr", "isp_s", "cstar", "eta_cstar", "gamma", "A_throat_m2", "throat_area_ratio", "recession_throat_mm",
    "recession_chamber_mm", "eps", "p_exit_psia", "t_exit_K", "gamma_exit", "tc_K", "Lstar_m",
    "heat_flux_throat_MW_m2", "heat_flux_chamber_MW_m2", "T_graphite_surface_K", "T_liner_surface_K",
    "char_depth_peak_mm", "chug_margin", "throat_ablation", "liner_ablation",
)


def fake_prep(config, dt: float = 0.05, ambient: float = AMBIENT):
    """What ``replay`` reads of a ``Prepared``: the line-exit runner, the as-built throat, dt, ambient."""
    runner = PintleEngineRunner(line_exit_config(config))
    link = SimpleNamespace(sampler=SimpleNamespace(runner=runner, config=runner.config),
                           design=SimpleNamespace(throat_area=float(runner.config.chamber_geometry.A_throat)))
    return SimpleNamespace(link=link, plan=SimpleNamespace(dt=dt), ambient_pa=ambient)


def series(n: int = 69, dt: float = 0.05, po=(560.0, 600.0), pf=(565.0, 605.0)):
    """A burn's line-exit pressures as the twin reports them: rising with the regulator's SPE."""
    t = [dt * (k + 1) for k in range(n)]
    return {"t": t, "firing": [True] * n, "dt": [dt] * n,
            "ox": {"inlet_psia": list(np.linspace(*po, n))}, "fuel": {"inlet_psia": list(np.linspace(*pf, n))}}


@pytest.fixture(scope="module")
def config():
    return load_config(str(LE4))


@pytest.fixture(scope="module")
def prep(config):
    return fake_prep(config)


@pytest.fixture(scope="module")
def burn():
    return series()


@pytest.fixture(scope="module")
def replayed(prep, burn):
    side = {}
    rp = rpl.replay(prep, burn, sidecars=side, soak=True)
    assert rp["available"], rp.get("error")
    return rp, side


# ------------------------------------------------------------------ 1. the replay keeps its arrays


def test_the_replay_keeps_its_old_keys(replayed):
    rp, _ = replayed
    missing = [k for k in OLD_KEYS if k not in rp]
    assert not missing
    n = len(rp["t"])
    assert n == rpl.REPLAY_POINTS
    for k in OLD_KEYS:
        if isinstance(rp[k], list):
            assert len(rp[k]) == n, k


def test_every_kept_array_is_one_value_per_replay_point(replayed):
    rp, _ = replayed
    n = len(rp["t"])
    for key in list(rpl.RESULT_COLUMNS) + list(rpl.DIAGNOSTIC_COLUMNS):
        col = rp[key]
        assert isinstance(col, list) and len(col) == n, key
        # LE4's doublet computes every one of them: a None here is a dropped path, not a gap.
        assert all(v is not None and math.isfinite(v) for v in col), key


def test_throat_diameter_is_its_area(replayed):
    rp, _ = replayed
    for d_mm, a in zip(rp["D_throat_mm"], rp["A_throat_m2"]):
        assert d_mm == pytest.approx(math.sqrt(4.0 * a / math.pi) * 1e3, rel=1e-12)


def test_cstar_efficiency_is_its_breakdown(replayed):
    """eta_c* = eta_vap * eta_mix * eta_HL (engine/pipeline/combustion_eff.py): the breakdown the
    replay keeps must multiply back to the efficiency the chamber solve used."""
    rp, _ = replayed
    for eta, v, m, h in zip(rp["eta_cstar"], rp["eta_vap"], rp["eta_mix"], rp["eta_heat_loss"]):
        assert v * m * h == pytest.approx(eta, rel=1e-9)
    # and c* = eta c*_ideal
    for c, eta, ci in zip(rp["cstar"], rp["eta_cstar"], rp["cstar_ideal"]):
        assert c == pytest.approx(eta * ci, rel=1e-12)


def test_injector_drop_is_line_exit_less_the_dump_and_chamber(replayed):
    """dp_injector is below line exit - Pc by exactly the Borda dump EngineDesign keeps at the line
    exit: positive, and a few percent of the drop (the 6.8 kN LOX dump is ~26 psi at ~140 psi)."""
    rp, _ = replayed
    for p_in, pc, dp in zip(rp["inlet_O_psia"], rp["pc_psia"], rp["dp_injector_O_psi"]):
        dump = p_in - pc - dp
        assert 0.0 < dump < 0.5 * (p_in - pc)


def test_stations_carry_recession_temperatures_and_load(replayed, config):
    rp, _ = replayed
    st = rp["stations"]
    assert set(st) == {"liner0", "liner1", "liner2", "liner3", "throat"}
    thr = st["throat"]
    assert thr["kind"] == "graphite" and thr["x_mm"] == 0.0
    # The throat station is what the old throat-recession key reported.
    assert thr["recession_mm"] == pytest.approx(rp["recession_throat_mm"], rel=1e-12)
    # Remaining is the first layer less what receded (6 mm graphite, 12.7 mm liner on LE4).
    t_gr = config.graphite_insert.initial_thickness * 1e3
    for rec, rem in zip(thr["recession_mm"], thr["remaining_mm"]):
        assert rem == pytest.approx(t_gr - rec, abs=1e-9)
    t_ab = config.ablative_cooling.initial_thickness * 1e3
    for rec, rem in zip(st["liner0"]["recession_mm"], st["liner0"]["remaining_mm"]):
        assert rem == pytest.approx(t_ab - rec, abs=1e-9)
    # The barrel station is the old chamber-recession key.
    assert st["liner0"]["recession_mm"] == pytest.approx(rp["recession_chamber_mm"], rel=1e-12)
    # Net load = convection + radiation - the carbon reactions' heat (graphite only).
    for name, s in st.items():
        for qn, qc, qr, qh in zip(s["q_net_MW_m2"], s["q_conv_MW_m2"], s["q_rad_MW_m2"], s["q_chem_MW_m2"]):
            assert qn == pytest.approx(qc + qr - qh, rel=1e-9, abs=1e-12), name
    # LE4 declares its 304 case (2026-10-03): the station's back face is the case's outer face, the
    # old T_graphite_back key, and the insert's own back face is its first interface.
    assert thr["T_back_K"] == pytest.approx(rp["T_graphite_back_K"], rel=1e-12)
    assert config.stainless_steel_case is not None and config.stainless_steel_case.thickness == pytest.approx(0.00635)
    assert [lay["name"] for lay in rp["wall_layers"]["throat"]["layers"]] == ["graphite", "backing", "case"]


def test_station_loads_are_the_solvers_own_barrel_and_throat_loads(replayed):
    """The station read-out (``_station_report``) against the barrel and throat loads the solver
    already reported through its own path (``_wall_report``: q_conv/q_rad/q_chem_throat,
    q_conv/q_rad_chamber). The throat is the same quantity both ways. At the barrel the station's
    convection is the *blown* one the liner takes, the old key the unblown Bartz value: their ratio
    is the pyrolysis-blowing reduction, a little under 1 (0.9931 at t = 0.05 s in audit 9.2)."""
    rp, _ = replayed
    thr, bar = rp["stations"]["throat"], rp["stations"]["liner0"]
    assert thr["q_conv_MW_m2"] == pytest.approx(rp["q_conv_throat_MW_m2"], rel=1e-9)
    assert thr["q_rad_MW_m2"] == pytest.approx(rp["q_rad_throat_MW_m2"], rel=1e-9)
    assert thr["q_chem_MW_m2"] == pytest.approx(rp["q_chem_throat_MW_m2"], rel=1e-9)
    assert bar["q_rad_MW_m2"] == pytest.approx(rp["q_rad_chamber_MW_m2"], rel=1e-9)
    for blown, bare in zip(bar["q_conv_MW_m2"], rp["q_conv_chamber_MW_m2"]):
        assert 0.9 < blown / bare <= 1.0


def test_axial_sidecar_is_rows_of_t_by_columns_of_x(replayed):
    rp, side = replayed
    ax = side["axial"]
    assert ax["t"] == rp["t"]
    nx = len(ax["x_mm"])
    assert ax["x_mm"] == sorted(ax["x_mm"])
    for key in ("q_MW_m2", "T_wall_K", "recession_mm", "T_back_K"):
        assert len(ax[key]) == len(rp["t"]) and all(len(row) == nx for row in ax[key]), key
    # Columns are the stations in x order: the throat (x = 0) is the last.
    j = ax["station"].index("throat")
    assert [row[j] for row in ax["recession_mm"]] == rp["stations"]["throat"]["recession_mm"]
    prof = ax["profile"]
    assert len(prof["q_MW_m2"]) == len(rp["t"]) and all(len(r) == len(prof["x_mm"]) for r in prof["q_MW_m2"])
    # The whole-contour profile spans face to exit.
    assert prof["x_mm"][0] < ax["x_mm"][0] and prof["x_mm"][-1] > 0.0


# ------------------------------------------------------------------ 2. no silent zero-erosion


def test_erodes_names_the_engines_with_a_receding_wall(config):
    assert rpl.erodes(config)
    c = config.model_copy(deep=True)
    c.ablative_cooling.enabled = False
    assert rpl.erodes(c)  # graphite only
    c.graphite_insert.enabled = False
    assert not rpl.erodes(c)


def test_a_graphite_only_engine_now_erodes(config, burn):
    """Liner off, graphite on: the replay used to pass ``track_ablative_geometry=None``, which the
    runner read from the liner alone, and replayed this engine at 0.000 % throat growth."""
    c = config.model_copy(deep=True)
    c.ablative_cooling.enabled = False
    rp = rpl.replay(fake_prep(c), burn)
    assert rp["available"], rp.get("error")
    assert rp["coupled_solver"]
    assert rp["throat_area_ratio"][-1] > 1.01
    assert all(v is not None for v in rp["T_graphite_surface_K"])


def test_an_untracked_liner_still_erodes(config, burn):
    c = config.model_copy(deep=True)
    c.ablative_cooling.track_geometry_evolution = False
    rp = rpl.replay(fake_prep(c), burn)
    assert rp["available"] and rp["coupled_solver"]
    assert rp["recession_chamber_mm"][-1] > 0.5


def test_the_legacy_path_refuses_an_eroding_engine(config):
    # Its own runner: a call resets the runner's last coupled solver, which the soak-back reads.
    runner = fake_prep(config).link.sampler.runner
    with pytest.raises(ValueError, match="strict_erosion"):
        runner.evaluate_arrays_with_time(np.array([0.0, 1.0]), np.full(2, 560 * PSI), np.full(2, 565 * PSI),
                                         track_ablative_geometry=True, use_coupled_solver=False,
                                         strict_erosion=True)


# ------------------------------------------------------------------ 3. soak-back after the burn


def _slab_solver(L=0.01, k=0.5, rho=1500.0, cp=1200.0, T0=400.0, dT=100.0):
    """A coupled solver reduced to one wall station: a single constant-property slab whose
    temperature is the first Fourier mode of an insulated slab, T0 + dT cos(pi y / L)."""
    from engine.pipeline.thermal.wall_conduction import Layer, WallModel
    from engine.pipeline.time_varying_solver import TimeVaryingCoupledSolver

    m = WallModel([Layer(L, k, rho, cp, "slab")], T0)
    m.T = T0 + dT * np.cos(np.pi * m.y / L)
    solver = object.__new__(TimeVaryingCoupledSolver)
    solver._walls = {"slab": {"x": 0.0, "kind": "liner", "model": m}}
    return solver, m


def test_soak_window_is_three_conduction_times_of_the_slowest_layer(replayed, config):
    """3 L^2/alpha, alpha = k/(rho cp), L the liner left at the station that receded least
    (LE4's 12.7 mm phenolic liner is ~900 s; the 6 mm graphite ~0.4 s)."""
    rp, _ = replayed
    abl = config.ablative_cooling
    left = min(rp["stations"][f"liner{i}"]["recession_mm"][-1] for i in range(4))
    L = abl.initial_thickness - left * 1e-3
    per = abl.material_density * abl.specific_heat / abl.thermal_conductivity
    tau = L * L * per
    # With the 304 case declared, the insert is backed by the phenolic out to the case: that slab,
    # (D_c/2 + t_liner) - (D_t/2 + t_graphite) thick, is now the slowest layer.
    cg, gr = config.chamber_geometry, config.graphite_insert
    gap = 0.5 * cg.chamber_diameter + abl.initial_thickness - (math.sqrt(4.0 * cg.A_throat / math.pi) / 2.0 + gr.initial_thickness)
    tau = max(tau, gap * gap * per)
    soak = rp["soak"]
    assert soak["available"]
    assert soak["duration_s"] == pytest.approx(3.0 * tau, rel=1e-9)
    assert soak["model"]["inputs"]["slowest_L2_over_alpha"]["value"] == pytest.approx(tau, rel=1e-9)


def test_insulated_slab_soaks_to_its_stored_heat_on_the_fourier_clock():
    """Insulated slab, first mode only: T(L, t) = T0 - dT exp(-pi^2 alpha t / L^2) (Carslaw &
    Jaeger 1959, ch. III). The back face rises from T0 - dT to T0, reaching 95 % of the rise at
    t = ln(20) L^2 / (pi^2 alpha); energy is conserved, so the peak is the capacity-weighted mean."""
    L, k, rho, cp, T0, dT = 0.01, 0.5, 1500.0, 1200.0, 400.0, 100.0
    solver, m = _slab_solver(L, k, rho, cp, T0, dT)
    T_eq = float(np.sum(m._C * m.T) / np.sum(m._C))  # the discrete stored heat, exactly conserved
    alpha = k / (rho * cp)
    res = solver.soak_back_history(factor=3.0)
    assert res["duration_s"] == pytest.approx(3.0 * L * L / alpha, rel=1e-12)
    s = res["stations"]["slab"]
    assert s["T_back_start"] == pytest.approx(T0 - dT, abs=1e-9)
    assert s["T_back_peak"] == pytest.approx(T_eq, abs=0.01)
    assert T_eq == pytest.approx(T0, abs=0.5)  # the mode carries no net heat, to the grid's resolution
    t95 = math.log(20.0) * L * L / (math.pi ** 2 * alpha)
    # Backward Euler at the default step count runs the slowest mode ~1 % slow (lambda h = 0.025).
    assert s["t_back_95_s"] == pytest.approx(t95, rel=0.02)


def test_soak_dates_a_plateau_when_it_is_reached():
    solver, _ = _slab_solver(L=0.002, k=90.0, rho=1800.0, cp=700.0)  # a thin, fast insert
    res = solver.soak_back_history(duration=600.0)
    s = res["stations"]["slab"]
    assert s["t_back_peak_s"] < 0.05 * res["duration_s"]


def test_soak_on_le4_is_an_adiabatic_upper_bound(replayed):
    rp, _ = replayed
    soak = rp["soak"]
    # The station's back face is the 304 case's outer face, adiabatic to the room: still an upper bound.
    assert soak["back_basis"] == "case outer face, adiabatic (upper bound)"
    assert {r["station"] for r in soak["stations"]} == set(rp["stations"])
    insert = next(r for r in soak["stations"] if r["station"] == "throat")
    # The throat station's back face is the case's outer face, behind ~46 mm of phenolic: the
    # insert's heat reaches it only slowly (L^2/alpha of the backing ~15,000 s), so it rises long
    # after burnout, and the insert's own back face (the first interface) is hot from the start.
    assert insert["T_back_peak_K"] >= insert["T_back_start_K"]
    assert insert["t_back_95_s"] > 60.0
    assert insert["T_interface_peak_K"] > insert["T_back_peak_K"]
    for r in soak["stations"]:
        assert r["T_back_peak_K"] >= r["T_back_start_K"] - 1e-9
    m = soak["model"]
    assert m["name"] and m["source"] and m["assumptions"] and m["inputs"]
    assert all({"value", "unit", "provenance"} <= set(v) for v in m["inputs"].values())


def test_soak_refuses_another_replays_walls(config):
    """The runner keeps only its last coupled solve. The soak-back runs on it only when it is the
    replay asked about: same end time and same end throat; a replay that ended elsewhere, or at the
    same time on another throat (another pass of the same burn), is refused, not soaked."""
    p = fake_prep(config)
    rp = rpl.replay(p, series(n=8, dt=0.4))
    assert rp["available"], rp.get("error")
    assert rpl.soak_back(p, rp)["available"]  # its own replay soaks
    later = dict(rp, t=list(rp["t"][:-1]) + [rp["t"][-1] + 1.0])
    out = rpl.soak_back(p, later)
    assert out["available"] is False and "not this replay" in out["error"]
    other_throat = dict(rp, A_throat_m2=list(rp["A_throat_m2"][:-1]) + [rp["A_throat_m2"][-1] * 1.001])
    out = rpl.soak_back(p, other_throat)
    assert out["available"] is False and "not this replay" in out["error"]


# ------------------------------------------------------------------ 5. eroded geometry in the chug loop


def _solve_capturing(config, monkeypatch, **kw):
    """Run the coupled solver on a short burn and record the geometry each stability call saw."""
    import engine.pipeline.stability.analysis as stab
    from engine.pipeline.time_varying_solver import TimeVaryingCoupledSolver

    real = stab.comprehensive_stability_analysis
    seen = []

    def spy(config, *a, **k):
        cg = config.chamber_geometry
        seen.append((float(cg.A_throat), float(cg.volume)))
        return real(config, *a, **k)

    monkeypatch.setattr(stab, "comprehensive_stability_analysis", spy)
    runner = PintleEngineRunner(line_exit_config(config))
    solver = TimeVaryingCoupledSolver(runner.config, runner.cea_cache, P_ambient=AMBIENT, **kw)
    t = np.linspace(0.0, 3.4, 7)
    solver.solve_time_series(t, np.linspace(560.0, 600.0, 7) * PSI, np.linspace(565.0, 605.0, 7) * PSI)
    return solver, seen


def test_chug_sees_the_design_point_by_default(config, monkeypatch):
    """Default off: every step's chug analysis runs on the as-built throat and volume, as it did
    before the flag existed (time_varying_solver.py passed self.config)."""
    solver, seen = _solve_capturing(config, monkeypatch)
    assert solver.chug_eroded_geometry is False
    a0, v0 = solver.A_throat_initial, solver.V_chamber_initial
    assert len(seen) == len(solver.state_history)
    assert all(a == a0 and v == v0 for a, v in seen)
    # while the chamber it describes has eroded
    assert solver.state_history[-1].A_throat > 1.02 * a0


def test_chug_sees_the_eroded_chamber_when_asked(config, monkeypatch):
    """On: each step's chug loop sees that step's A_t and V, so its L* = V/A_t is the eroded one."""
    on, seen_on = _solve_capturing(config, monkeypatch, chug_eroded_geometry=True)
    for (a, v), s in zip(seen_on, on.state_history):
        assert a == pytest.approx(s.A_throat, rel=1e-12)
        assert v == pytest.approx(s.V_chamber, rel=1e-12)
        assert v / a == pytest.approx(s.Lstar, rel=1e-12)
    off, _ = _solve_capturing(config, monkeypatch)
    m_on = [s.chugging_stability_margin for s in on.state_history]
    m_off = [s.chugging_stability_margin for s in off.state_history]
    # Same chamber at the first step (nothing has eroded yet; the copy's A_t is rebuilt from its
    # diameter, one ulp off), a different chug margin by burnout.
    assert m_on[0] == pytest.approx(m_off[0], rel=1e-12)
    assert abs(m_on[-1] / m_off[-1] - 1.0) > 1e-3
    # and the burn itself is untouched: the flag changes only what the chug analysis reads.
    for a, b in zip(on.state_history, off.state_history):
        assert a.Pc == b.Pc and a.A_throat == b.A_throat


# ------------------------------------------------------------------ 4. diag/hardware.py


@pytest.fixture(scope="module")
def hardware(prep, replayed, burn):
    from engine.layerx.diag.hardware import hardware_block

    rp, _ = replayed
    dv = rpl.delivered(rp, burn, 0.05)
    dv["ambient_psia"] = [AMBIENT / PSI] * len(dv["t"])
    hb = hardware_block(prep, rp, dv, burn)
    assert hb["available"], hb.get("error")
    return hb


def test_hardware_follows_the_replay_points(hardware, replayed):
    rp, _ = replayed
    assert hardware["t"] == rp["t"] and hardware["index"] == rp["index"]
    for key in ("throat_d_mm", "At_ratio", "eps", "Lstar_m", "contraction", "liner_min_mm", "insert_back_K"):
        assert len(hardware[key]) == len(rp["t"]), key


def test_eps_lstar_and_contraction_from_the_areas_by_hand(hardware, replayed, config):
    rp, _ = replayed
    cg = config.chamber_geometry
    for k in range(len(rp["t"])):
        a_t = rp["A_throat_m2"][k]
        # eps = A_e/A_t(t), A_e fixed at the design's (LE4's nozzle does not ablate)
        assert rp["A_exit_m2"][k] == pytest.approx(cg.A_exit, rel=1e-12)
        assert hardware["eps"][k] == pytest.approx(cg.A_exit / a_t, rel=1e-6)
        # L* = V(t)/A_t(t)
        assert hardware["Lstar_m"][k] == pytest.approx(rp["V_chamber_m3"][k] / a_t, rel=1e-6)
        # contraction = (D_c/D_t)^2, the solver's pi (D_c/2)^2 / A_t
        assert hardware["contraction"][k] == pytest.approx(rp["contraction_ratio"][k], rel=1e-6)
    # As built at the first point but for the first step's erosion (a few hundredths of a percent).
    assert hardware["eps"][0] == pytest.approx(cg.A_exit / cg.A_throat, rel=1e-3)
    assert hardware["Lstar_m"][0] == pytest.approx(cg.volume / cg.A_throat, rel=1e-3)
    # The throat opens, so eps falls and L* is the volume's race against the throat.
    assert hardware["eps"][-1] < hardware["eps"][0]


def test_liner_left_and_insert_back_face(hardware, replayed, config):
    rp, _ = replayed
    st = rp["stations"]
    t_l = config.ablative_cooling.initial_thickness * 1e3
    for k in range(len(rp["t"])):
        want = min(t_l - st[f"liner{i}"]["recession_mm"][k] for i in range(4))
        assert hardware["liner_min_mm"][k] == pytest.approx(want, abs=1e-4)
    # With the case declared the insert's back face is its first interface (graphite/phenolic).
    assert hardware["insert_back_K"] == pytest.approx(st["throat"]["T_interface_K"], abs=1e-3)
    assert hardware["insert_back_basis"].startswith("insert back face")
    assert any("upper bound" in a for a in hardware["model"]["assumptions"])


def test_summary_first_point_is_against_as_built(hardware, replayed):
    """The first replay point has already eroded (the walls start at Fire): its A_t over as built is
    the replay's own throat_area_ratio[0], a little above 1 (audit 9.2: 0.027 % on the He burn)."""
    rp, _ = replayed
    r0 = hardware["summary"]["first_point_area_ratio"]
    assert r0 == pytest.approx(rp["throat_area_ratio"][0], rel=1e-12)
    assert 1.0 < r0 < 1.002


def test_insert_back_face_with_a_declared_case_is_the_bondline(config):
    """With a case behind the insert the station's back face is the case's outer face; the insert's
    own back face is the graphite/case interface. LE4 declares none, where the two are the same node."""
    from engine.layerx.diag.hardware import hardware_block
    from engine.pipeline.config_schemas import StainlessSteelCaseConfig

    c = config.model_copy(deep=True)
    c.stainless_steel_case = StainlessSteelCaseConfig(thickness=0.00635)
    p = fake_prep(c)
    burn = series(n=8, dt=0.4)
    rp = rpl.replay(p, burn)
    assert rp["available"], rp.get("error")
    thr = rp["stations"]["throat"]
    # LE4's liner is on, so the phenolic backs the insert out to the case.
    assert [lay["name"] for lay in rp["wall_layers"]["throat"]["layers"]] == ["graphite", "backing", "case"]
    hb = hardware_block(p, rp, None, burn)
    assert hb["available"], hb.get("error")
    assert hb["insert_back_K"] == pytest.approx(thr["T_interface_K"], abs=1e-3)
    # the case's outer face lags the bondline while the insert heats
    assert thr["T_back_K"][-1] < thr["T_interface_K"][-1] - 1.0
    assert hb["insert_back_basis"].startswith("insert back face")


def test_contour_as_built_and_eroded(hardware, replayed, config):
    rp, _ = replayed
    c = hardware["contour"]
    x, r0 = np.array(c["x_mm"]), np.array(c["r0_mm"])
    cg = config.chamber_geometry
    R_t = math.sqrt(cg.A_throat / math.pi) * 1e3
    R_c = cg.chamber_diameter / 2.0 * 1e3
    j0 = int(np.argmin(np.abs(x)))
    assert x[j0] == pytest.approx(0.0, abs=1e-6) and r0[j0] == pytest.approx(R_t, rel=1e-4)
    assert r0[0] == pytest.approx(R_c, rel=1e-9)
    # LE4: face-to-throat 224.4 mm (the config's own comment; audit 9.2 section 4)
    assert c["x_face_mm"] == pytest.approx(-224.4, abs=0.1)
    st = rp["stations"]
    for k, r in enumerate(c["frames"]["r_mm"]):
        r = np.array(r)
        # throat: the replay's eroded throat radius, D_t(t)/2
        assert r[j0] == pytest.approx(rp["D_throat_mm"][k] / 2.0, abs=1e-3)
        # barrel: the first liner station's recession
        assert r[0] - r0[0] == pytest.approx(st["liner0"]["recession_mm"][k], abs=1e-3)
        # the insert recedes over its whole length (its narrowest point is the solver's throat);
        # the nozzle downstream of the insert does not recede in the model
        x_end = c["x_insert_mm"][1] if c.get("x_insert_mm") else 0.0
        assert r.min() == pytest.approx(rp["D_throat_mm"][k] / 2.0, abs=1e-3)
        assert np.allclose(r[x > x_end + 1e-6], r0[x > x_end + 1e-6], atol=1e-9)
        # the liner end: the last liner station's recession (insert upstream edge)
        je = int(np.argmin(np.abs(x - c["x_liner_end_mm"])))
        if abs(x[je] - c["x_liner_end_mm"]) < 1e-6:
            assert r[je] - r0[je] == pytest.approx(st["liner3"]["recession_mm"][k], abs=1e-3)
    assert c["liner_r_mm"][0] == pytest.approx(r0[0] + config.ablative_cooling.initial_thickness * 1e3, abs=1e-3)
    assert c["insert_r_mm"][j0] == pytest.approx(r0[j0] + config.graphite_insert.initial_thickness * 1e3, abs=1e-3)


def test_summerfield_and_schmucker_by_hand():
    from engine.layerx.diag.hardware import separation

    pa = 101325.0
    # M_e 2.7: (1.88 * 2.7 - 1)^-0.64 = 4.076^-0.64 = 0.40686
    crit = (1.88 * 2.7 - 1.0) ** -0.64
    assert crit == pytest.approx(0.40686, abs=1e-5)
    pe = [0.45 * pa, 0.405 * pa, 0.35 * pa, 1.1 * pa]
    out = separation([0.0, 1.0, 2.0, 3.0], pe, [pa] * 4, [2.7] * 4)
    assert out["summerfield"] == [False, False, True, False]
    assert out["schmucker"] == [False, True, True, False]
    assert out["flag"] is True
    assert out["min_ratio"] == pytest.approx(0.35) and out["t_min"] == 2.0
    # the ambient above which Schmucker separates this exit: p_e/crit; the exit pressure below which
    # it separates at this ambient: p_a crit
    assert out["schmucker_pa_crit_psia"][3] == pytest.approx(1.1 * pa / crit / PSI, rel=1e-5)
    assert out["schmucker_pe_sep_psia"][0] == pytest.approx(pa * crit / PSI, rel=1e-5)
    full = separation([0.0], [1.05 * pa], [pa], [2.7])
    assert full["flag"] is False and full["margin"] == pytest.approx(1.05 / 0.4, rel=1e-6)


def test_le4_runs_full_on_the_pad(hardware):
    """Pad, He: p_e/p_a ~1.0-1.1 against Summerfield's 0.4 and Schmucker's ~0.41 (audit 9.2 s5)."""
    sep = hardware["separation"]
    assert sep["flag"] is False
    assert 0.95 < sep["min_ratio"] < 1.2
    assert all(0.39 < c < 0.43 for c in sep["schmucker_ratio"])
    assert sep["pe_pa"][0] == pytest.approx(sep["pe_psia"][0] * PSI, rel=1e-6)
    m = sep["model"]
    assert "Summerfield" in m["source"] and "Schmucker" in m["source"]


def test_isp_waterfall_closes_and_its_terms_are_the_thrust_identities(hardware, replayed, prep):
    rp, _ = replayed
    isp = hardware["isp"]
    cea = prep.link.sampler.runner.cea_cache
    for k in range(len(rp["t"])):
        ideal, cl, nl, dl = isp["ideal_s"][k], isp["cstar_loss_s"][k], isp["nozzle_loss_s"][k], isp["delivered_s"][k]
        assert ideal - cl - nl == pytest.approx(dl, abs=1e-5)
        assert dl == pytest.approx(rp["isp_s"][k], abs=1e-6)
        eta = rp["eta_cstar"][k]
        assert cl == pytest.approx((1.0 - eta) * ideal, abs=1e-5)
        # the stagnation part by its closed form, with kappa from the chamber solve
        Pc, MR, e, ka = rp["pc_psia"][k] * PSI, rp["mr"][k], rp["eps"][k], rp["kappa"][k]
        cf_pc, cf_p0 = cea.eval_cf_vac(MR, Pc, e), cea.eval_cf_vac(MR, Pc / ka, e)
        stag = eta * rp["cstar_ideal"][k] * (cf_pc - cf_p0 + (ka - 1.0) * AMBIENT * e / Pc) / 9.80665
        assert isp["stagnation_loss_s"][k] == pytest.approx(stag, abs=2e-4)
        z = isp["zeta_n"]
        assert isp["zeta_n_loss_s"][k] == pytest.approx(eta * rp["cstar_ideal"][k] * (1 - z) * cf_p0 / 9.80665, abs=2e-4)
    assert "D16" in isp["model"]["inputs"]["nozzle_efficiency"]["provenance"]


def test_isp_ideal_is_cea_by_hand(hardware, replayed, prep):
    """The ideal is CEA's shifting-equilibrium Isp: checked against rocketcea itself at two points
    (vacuum Isp and c* from CEA, less the ambient term p_a eps c*/(Pc g0)), not through the table."""
    cea_obj = pytest.importorskip("rocketcea.cea_obj")
    rp, _ = replayed
    cache = prep.link.sampler.runner.cea_cache
    C = cea_obj.CEA_Obj(oxName=cache.config.ox_name, fuelName=cache.config.fuel_name)
    for k in (0, len(rp["t"]) - 1):
        pc_psia, MR, e = rp["pc_psia"][k], rp["mr"][k], rp["eps"][k]
        isp_vac = C.get_Isp(Pc=pc_psia, MR=MR, eps=e)
        cstar = C.get_Cstar(Pc=pc_psia, MR=MR) * 0.3048
        hand = isp_vac - AMBIENT * e * cstar / (pc_psia * PSI * 9.80665)
        assert hardware["isp"]["ideal_s"][k] == pytest.approx(hand, rel=3e-3)


def test_hardware_never_raises(prep):
    from engine.layerx.diag.hardware import hardware_block

    assert hardware_block(prep, {"available": False, "error": "x"})["available"] is False
    assert hardware_block(prep, None)["available"] is False
    bad = hardware_block(prep, {"available": True, "t": [0.1], "stations": {}, "A_throat_m2": ["?"]})
    assert bad["available"] is False and bad["error"]


# ------------------------------------------------------------------ 6. the engine card


def test_line_exit_drops_the_supply_share_with_k0(config):
    """supply_K is the supply's share of K0. The line exit zeroes K0, so the drop left is the exit
    dump alone and holds no supply share; left in, the chug loop subtracted a supply drop from the
    dump (audit D7: gate 1.330 -> 1.248 after a feed-fit write, nothing physical changed)."""
    from engine.pipeline.stability.analysis import _chug_feed_drop

    c = config.model_copy(deep=True)
    for side in c.feed_system.values():
        side.supply_K = 0.6
    out = line_exit_config(c)
    assert all(side.supply_K == 0.0 for side in out.feed_system.values())
    assert all(side.supply_K == 0.6 for side in c.feed_system.values())  # a copy; the design keeps it
    # The chug loop's resistance on the line-exit copy: the dump drop, untouched.
    dump = 1.79e5  # Pa, ~26 psi: the 6.8 kN LOX exit dump
    assert _chug_feed_drop(out, "oxidizer", dump, 1.87, 1140.0) == dump
    # and without the fix the same call would have subtracted the supply's share
    assert _chug_feed_drop(c, "oxidizer", dump, 1.87, 1140.0) < dump


def test_line_exit_is_unchanged_for_le4(config):
    """LE4 carries supply_K 0, so the D7 fix leaves its line-exit copy (and the baseline) as it was."""
    assert all(side.supply_K == 0.0 for side in config.feed_system.values())
    a = line_exit_config(config)
    b = copy.deepcopy(config)
    for side in b.feed_system.values():
        side.K0, side.K1, side.phi_type, side.fittings, side.roughness_m = 0.0, 0.0, "none", [], None
    assert a.model_dump() == b.model_dump()


def test_a_line_exit_replay_ignores_supply_k(config, burn):
    """End to end: the replay's chug margin on a design that carries supply_K is the one on the same
    design without it (both through the line-exit copy)."""
    c = config.model_copy(deep=True)
    for side in c.feed_system.values():
        side.supply_K = 0.6
    short = series(n=8, dt=0.4)
    a = rpl.replay(fake_prep(c), short)
    b = rpl.replay(fake_prep(config), short)
    assert a["available"] and b["available"]
    assert a["chug_margin"] == b["chug_margin"]


@pytest.fixture(scope="module")
def card(config):
    from engine.layerx.card import build_card

    return build_card(config, center_pa=575.0 * PSI, ambient_pa=AMBIENT)


def test_expansion_chamber_is_the_card_at_the_as_built_throat(card, prep):
    from engine.layerx.card import expansion_chamber

    plain = card.chamber_model(ambient_pressure=AMBIENT)
    ex = expansion_chamber(card, prep.link.sampler.runner.cea_cache, ambient_pressure=AMBIENT)
    for mo, mf in ((1.80, 1.20), (1.87, 1.29), (1.95, 1.25), (0.0, 0.0)):
        assert ex.evaluate(mo, mf) == plain.evaluate(mo, mf)
    assert ex.expansion_scale(1.5, 2.7e6) == 1.0
    m = ex.model_block()
    assert m["name"] and m["source"] and m["assumptions"]
    assert m["inputs"]["eps0"]["value"] == pytest.approx(card.exit_area / card.throat_area, rel=1e-12)
    # LE4's table has an eps axis, so the option can act (a 2-D table would hold the scale at 1)
    assert m["inputs"]["cea_eps_axis"]["value"] is True


def test_expansion_chamber_scales_vacuum_velocity_by_cf_vac(card, prep):
    """Throat 4 % larger in area, exit fixed: v_vac x Cf_vac(eps0/1.04)/Cf_vac(eps0), from the table;
    chamber pressure and flows untouched."""
    from engine.layerx.card import expansion_chamber

    cea = prep.link.sampler.runner.cea_cache
    plain = card.chamber_model(ambient_pressure=AMBIENT)
    ex = expansion_chamber(card, cea, ambient_pressure=AMBIENT)
    plain.throat_area = ex.throat_area = card.throat_area * 1.04
    mo, mf = 1.90, 1.27
    a, b = plain.evaluate(mo, mf), ex.evaluate(mo, mf)
    assert b.pressure == a.pressure and b.mdot_total == a.mdot_total
    eps0 = card.exit_area / card.throat_area
    ratio = cea.eval_cf_vac(a.mixture_ratio, a.pressure, eps0 / 1.04) / cea.eval_cf_vac(a.mixture_ratio, a.pressure, eps0)
    assert ratio < 1.0  # less expansion, less vacuum thrust coefficient
    assert (b.thrust + AMBIENT * card.exit_area) / (a.thrust + AMBIENT * card.exit_area) == pytest.approx(ratio, rel=1e-12)
    assert b.specific_impulse == pytest.approx(b.thrust / (b.mdot_total * 9.80665), rel=1e-12)


def test_expansion_chamber_follows_enginedesign_at_the_eroded_throat(card, prep, replayed):
    """At the replay's eroded throat and EngineDesign's own flows, the plain card's thrust runs high
    (it keeps the as-built eps); the expansion-scaled card closes most of it (audit D4-B)."""
    from engine.layerx.card import expansion_chamber

    rp, _ = replayed
    plain = card.chamber_model(ambient_pressure=AMBIENT)
    ex = expansion_chamber(card, prep.link.sampler.runner.cea_cache, ambient_pressure=AMBIENT)
    k = len(rp["t"]) - 1
    plain.throat_area = ex.throat_area = rp["A_throat_m2"][k]
    F = rp["thrust_N"][k]
    e_plain = plain.evaluate(rp["mdot_O"][k], rp["mdot_F"][k]).thrust / F - 1.0
    e_ex = ex.evaluate(rp["mdot_O"][k], rp["mdot_F"][k]).thrust / F - 1.0
    assert e_plain > 2e-3  # +0.4 % on this burn
    assert abs(e_ex) < 0.4 * abs(e_plain)
    assert ex.eps_clamped == 0


def test_drawn_throat_is_the_solvers_throat():
    """The narrowest drawn wall must be D_t0 + 2 s_throat, the solver's throat: with the insert's
    downstream half left as built, the drawing kept the as-built throat while the run reported the
    throat area growing (2026-10-03)."""
    import numpy as np

    from engine.layerx.diag.hardware import eroded_radius

    x = np.linspace(-60.0, 40.0, 401)
    r_t0 = 23.9
    r0 = r_t0 + 0.004 * x ** 2          # a throat at x = 0, opening both ways
    stations = {"throat": {"kind": "graphite", "recession_mm": [0.0, 0.47]}}
    for k, s in enumerate((0.0, 0.47)):
        wall = eroded_radius(x, r0, stations, k, x_liner_end=-12.0, x_insert_end=12.0)
        assert 2 * wall.min() == pytest.approx(2 * (r_t0 + s), abs=1e-9)
    # Downstream of the insert nothing moves.
    wall = eroded_radius(x, r0, stations, 1, x_liner_end=-12.0, x_insert_end=12.0)
    assert np.allclose(wall[x > 12.0 + 1e-9], r0[x > 12.0 + 1e-9])


def test_the_phenolic_backing_cools_the_insert_and_shields_the_case(config):
    """LE4's insert sits in the liner's phenolic out to the 304 case (~46 mm). Over a burn:

    * the case stays at ambient: the phenolic's penetration depth sqrt(alpha t) is ~0.7 mm;
    * the phenolic still draws ~k dT / sqrt(pi alpha t) ~0.4 MW/m2 from a ~2000 K insert, which a 6 mm
      graphite slab (rho c t ~7.7 kJ/m2K) feels as ~100-200 K over 3 s: the insert runs cooler and its
      throat erodes less than the adiabatic upper bound (no case declared, nothing behind the insert).
    """
    c_case = config.model_copy(deep=True)
    c_none = config.model_copy(deep=True)
    c_none.stainless_steel_case = None
    burn = series(n=8, dt=0.4)
    with_case = rpl.replay(fake_prep(c_case), burn)
    without = rpl.replay(fake_prep(c_none), burn)
    assert with_case["available"] and without["available"]
    thr_c, thr_n = with_case["stations"]["throat"], without["stations"]["throat"]
    assert max(abs(v - 300.0) for v in thr_c["T_back_K"]) < 1.0            # the steel never warms
    assert thr_c["T_interface_K"][-1] < thr_n["T_back_K"][-1] - 50.0       # the insert loses heat to it
    g_case = with_case["throat_area_ratio"][-1] - 1.0
    g_none = without["throat_area_ratio"][-1] - 1.0
    assert 0.0 < g_case < g_none                                           # below the adiabatic bound

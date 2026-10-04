"""Exports of a Layer X run (engine/layerx/export.py): CSV, Parquet and the FEA bundle.

What these check:

* **Round trip, bit for bit.** Every per-step signal of a run (series, delivered, replay, network,
  diagnostics) is written and read back to the same float, with its unit in the header.
* **Nothing is interpolated.** A replay-point value sits on its own step and nowhere else; a block on
  a clock that is not the twin's is left out and reported, not resampled.
* **Every series leaf is there.** The test enumerates the series by its own walk and asserts each
  numeric column appears, on a hand-built run and on the user's saved runs (read only).
* **FEA bundle**: the files the contract names, the peak loads equal the maxima of the histories they
  come from, the heat-flux table has one row per (t, x), and the zip is byte-identical run to run.
"""

from __future__ import annotations

import copy
import glob
import io
import json
import zipfile
from pathlib import Path

import pytest

from engine.layerx.export import columns, fea_bundle, read_csv, to_csv, to_parquet, unit_of

RUNS = Path(__file__).resolve().parents[1] / ".userdata" / "local" / "engine" / "layerx" / "runs"
PSI = 6894.757293168361


def _run():
    t = [-0.1, -0.05, 0.0, 0.05, 0.1, 0.15, 0.2, 0.25]
    n = len(t)
    fire = [False, False, False, True, True, True, True, True]
    ramp = lambda a, b: [a + (b - a) * k / (n - 1) for k in range(n)]  # noqa: E731
    side = lambda p: {"tank_psia": ramp(p, p + 3.0), "stiffness": [0.0] * 3 + [0.31, 0.32, 0.33, 0.34, 0.35],  # noqa: E731
                      "mdot": [0.0] * 3 + [1.9] * 5, "liquid_K": [90.1] * n, "fill_fraction": ramp(0.95, 0.9)}
    series = {"t": t, "dt": [0.05] * n, "firing": fire, "converged": [True] * n, "copv_psia": ramp(4500.0, 4300.0),
              "copv_mass_kg": ramp(0.2, 0.19), "copv_wall_K": [293.15] * n,
              "regulators": {"PR_D": {"label": "PR-DOME", "outlet_psia": ramp(578.0, 580.0)}},
              "instruments": {"PT_OXU": {"tag": "PT-OX-UP", "type": "PT", "unit": "psia", "values": ramp(578.0, 579.0)},
                              "TC_OXD": {"tag": "TC-OX-DN", "type": "TC", "unit": "K", "values": [90.0] * n}},
              "ox": side(578.0), "fuel": side(578.1),
              "chamber": {"pc_psia": [0.0] * 3 + [395.0, 396.0, 397.0, 398.0, 399.0], "thrust_N": [0.0] * 3 + [6900.0] * 5,
                          "extrapolated": [0.0] * n}}
    fire_t = [t[i] for i in range(n) if fire[i]]
    return {
        "series": series,
        "delivered": {"t": fire_t, "pc_psia": [394.0, 396.5, 397.0, 397.5, 401.25], "thrust_N": [6800.0, 6950.0, 7000.0, 7100.0, 7250.5],
                      "chug_margin": [1.3, 1.31, 1.32, 1.33, 1.34], "summary": {"chug_margin_min": 1.3}},
        "replay": {"available": True, "t": [0.05, 0.15, 0.25], "index": [3, 5, 7], "eta_cstar": [0.91, 0.912, 0.913],
                   "A_throat_m2": [1.79e-3, 1.80e-3, 1.81e-3]},
        "network": {"t": t, "nodes": {"MF2": {"label": "press manifold", "kind": "manifold", "side": "gas",
                                              "p_psia": ramp(580.0, 582.0), "T_K": ramp(280.0, 270.0)}},
                    "branches": {"l_ox1": {"kind": "line", "from": "OXT", "to": "MVO", "side": "ox",
                                           "mdot": [0.0] * 3 + [1.9] * 5, "dp_psi": [0.0] * 3 + [4.0] * 5},
                                 "MVO": {"kind": "valve", "from": "MVO.in", "to": "MVO.out", "side": "ox",
                                         "mdot": [0.0] * 3 + [1.9] * 5, "dp_psi": [0.0] * 3 + [1.2] * 5,
                                         "state": [0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0], "cv": 26.1}}},
        "diagnostics": {
            "regulator": {"t": t, "inlet_psia": ramp(4500.0, 4300.0), "wide_open": [False] * n, "cv": 0.8,
                          "model": {"name": "x", "inputs": {"a": {"value": 1.0}}}},
            "ladder": {"t": t, "ox": {"elements": [{"id": "MVO", "label": "LOX main", "kind": "valve",
                                                    "dp_psi": [0.0] * 3 + [1.2] * 5, "share": [0.0] * 3 + [0.01] * 5}],
                                      "total_psi": [0.0] * 3 + [180.0] * 5}},
            "stability": {"basis": "config", "t": [0.05, 0.15, 0.25], "index": [3, 5, 7], "margin": [1.3, 1.35, 1.4],
                          "worst": {"t": 0.05, "margin": 1.3},
                          "nyquist": {"t": 0.05, "omega": [1.0, 2.0, 3.0], "re": [0.1, 0.2, 0.3], "im": [0.0, 0.1, 0.2]}},
            "hardware": {"t": [0.05, 0.25], "throat_d_mm": [47.81, 48.72],
                         "separation": {"ratio": [1.1, 1.05], "summerfield": [False, False]},
                         "contour": {"x_mm": [0.0, 1.0, 2.0], "frames": {"t": [0.05], "r_mm": [[1.0, 2.0, 3.0]]}}},
            "start": {"t": [0.0, 0.001, 0.002], "pc_psia": [14.7, 50.0, 120.0]},
            "vv": {"mass": {"ox": {"error_pct": 0.0}}},
        },
        "provenance": {"config_sha256": "abc", "drawing": {"name": "copv_study_he", "sha256": "def"}},
        "converged": True,
    }


def _series_leaves(series):
    """The series' numeric columns, by an independent walk: (dotted name, values)."""
    out = []
    n = len(series["t"])
    for key, v in series.items():
        if key == "instruments":
            for iid, inst in v.items():
                out.append((f"instruments.{iid}.{inst['tag']}", inst["values"]))
        elif key == "regulators":
            for rid, reg in v.items():
                out.extend((f"regulators.{rid}.{k}", c) for k, c in reg.items() if isinstance(c, list))
        elif isinstance(v, dict):
            out.extend((f"{key}.{k}", c) for k, c in v.items() if isinstance(c, list) and len(c) == n)
        elif isinstance(v, list) and len(v) == n:
            out.append((key, v))
    return out


def _num(v):
    return None if v is None else float(v)


def test_every_signal_round_trips_through_csv_exactly():
    r = _run()
    back = read_csv(to_csv(r))
    n = len(r["series"]["t"])
    for name, values in _series_leaves(r["series"]):
        assert name in back, f"{name} missing from the CSV"
        assert back[name][1] == [_num(v) for v in values], name
    assert all(len(v[1]) == n for v in back.values())
    assert back["ox.tank_psia"][0] == "psia" and back["ox.stiffness"][0] == "1" and back["ox.mdot"][0] == "kg/s"
    assert back["instruments.TC_OXD.TC-OX-DN"][0] == "K"
    assert back["firing"][1] == [0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0]


def test_replay_points_sit_on_their_own_steps_and_nowhere_else():
    back = read_csv(to_csv(_run()))
    assert back["replay.eta_cstar"][1] == [None, None, None, 0.91, None, 0.912, None, 0.913]
    assert back["delivered.pc_psia"][1] == [None, None, None, 394.0, 396.5, 397.0, 397.5, 401.25]
    assert back["diagnostics.stability.margin"][1] == [None, None, None, 1.3, None, 1.35, None, 1.4]
    assert back["diagnostics.hardware.throat_d_mm"][1] == [None, None, None, 47.81, None, None, None, 48.72]
    assert back["diagnostics.hardware.separation.ratio"][1][3] == 1.1 and back["diagnostics.hardware.separation.ratio"][0] == "1"


def test_network_and_series_clock_diagnostics_are_written():
    back = read_csv(to_csv(_run()))
    assert back["network.nodes.MF2.p_psia"][0] == "psia" and back["network.nodes.MF2.T_K"][0] == "K"
    assert back["network.branches.MVO.state"][1][3] == 1.0
    assert back["network.branches.l_ox1.mdot"][0] == "kg/s" and back["network.branches.l_ox1.dp_psi"][0] == "psi"
    assert back["diagnostics.regulator.inlet_psia"][1][0] == 4500.0
    assert back["diagnostics.regulator.wide_open"][0] == "bool"
    assert back["diagnostics.ladder.ox.elements.MVO.dp_psi"][1][-1] == 1.2
    assert back["diagnostics.ladder.ox.total_psi"][0] == "psi"


def test_what_is_not_on_the_twins_clock_is_left_out_and_reported():
    r = _run()
    r["timeseries"] = {"data": {"time": [0.0, 0.05], "Pc_psi": [380.0, 395.0]}, "source": "layerx"}
    cols, skipped = columns(r)
    names = {c[0] for c in cols}
    # A block the table does not carry is named, never dropped silently.
    assert "timeseries" in skipped and not any(n.startswith("timeseries") for n in names)
    assert "diagnostics.start" in skipped and not any(n.startswith("diagnostics.start.") for n in names)
    assert not any("nyquist" in n or "contour" in n or ".model" in n or n.startswith("diagnostics.vv") for n in names)
    assert "diagnostics.regulator.cv" not in names


def test_headers_are_stable_whatever_the_dict_order():
    a = _run()
    b = copy.deepcopy(a)
    b["series"]["ox"] = dict(reversed(list(b["series"]["ox"].items())))
    b["network"]["branches"] = dict(reversed(list(b["network"]["branches"].items())))
    assert to_csv(a).splitlines()[0] == to_csv(b).splitlines()[0]


def test_units_follow_the_naming_convention():
    assert unit_of("ox.tank_psia") == "psia" and unit_of("ox.dump_psi") == "psi"
    assert unit_of("heat_flux_throat_MW_m2") == "MW/m^2" and unit_of("A_throat_m2") == "m^2"
    assert unit_of("v_exit_m_s") == "m/s" and unit_of("isp_s") == "s" and unit_of("Lstar_m") == "m"
    assert unit_of("chamber.cstar") == "m/s" and unit_of("mr") == "1" and unit_of("eps") == "1"
    # Keys the replay writes (engine/layerx/replay.py): a recession rate is mm/s, not s, and the
    # ideal c* (~1724 m/s on LE4) carries no suffix but is a velocity.
    assert unit_of("replay.graphite_recession_rate_mm_s") == "mm/s"
    assert unit_of("replay.liner_recession_rate_mm_s") == "mm/s"
    assert unit_of("replay.cstar_ideal") == "m/s"


def test_parquet_carries_the_same_table_with_units():
    pq = pytest.importorskip("pyarrow.parquet")
    r = _run()
    table = pq.read_table(io.BytesIO(to_parquet(r)))
    back = read_csv(to_csv(r))
    assert table.column_names == list(back)
    for name in table.column_names:
        assert table.column(name).to_pylist() == back[name][1], name
        assert table.schema.field(name).metadata[b"unit"].decode() == back[name][0]
    meta = table.schema.metadata
    assert meta[b"config_sha256"] == b"abc"
    assert "diagnostics.start" in json.loads(meta[b"columns_skipped"])


def _sidecar():
    return {"x_mm": [0.0, 40.0, 80.0], "t": [0.05, 0.25],
            "q_MW_m2": [[1.0, 8.0, 3.0], [1.5, 9.5, 2.0]], "T_wall_K": [[600.0, 1800.0, 900.0], [800.0, 2300.0, 950.0]],
            "basis": "test stations",
            "profile": {"x_mm": [0.0, 50.0], "q_MW_m2": [[1.0, 2.0], [1.1, 2.1]]}}


def test_the_fea_bundle_carries_the_named_files_and_its_peaks_are_the_histories_maxima():
    r = _run()
    blob = fea_bundle(r, _sidecar())
    z = zipfile.ZipFile(io.BytesIO(blob))
    assert {"pc_t.csv", "thrust_t.csv", "heatflux_xt.csv", "loads.json", "README.txt"} <= set(z.namelist())
    pc = read_csv(z.read("pc_t.csv").decode())
    assert pc["pc_psia"][0] == "psia" and pc["pc_psia"][1] == r["delivered"]["pc_psia"]
    assert pc["t"][1] == r["delivered"]["t"]
    assert pc["pc_Pa"][0] == "Pa" and pc["pc_Pa"][1][-1] == pytest.approx(401.25 * PSI, rel=1e-15)
    thrust = read_csv(z.read("thrust_t.csv").decode())
    assert thrust["thrust_N"][1] == r["delivered"]["thrust_N"]
    loads = json.loads(z.read("loads.json"))
    assert loads["chamber_pressure"]["peak"] == {"value": 401.25, "t": 0.25, "value_Pa": 401.25 * PSI}
    assert loads["thrust"]["peak"]["value"] == 7250.5 and "erosion replay" in loads["thrust"]["source"]
    assert loads["tank_pressure"]["ox"]["value"] == max(r["series"]["ox"]["tank_psia"])
    assert loads["bottle_pressure"]["value"] == 4500.0
    assert loads["heat_flux"]["peak"] == {"value": 9.5, "t": 0.25, "x_mm": 40.0}
    assert loads["wall_temperature"]["peak"]["value"] == 2300.0
    heat = read_csv(z.read("heatflux_xt.csv").decode())
    assert len(heat["t"][1]) == 2 * 3
    assert heat["q_MW_m2"][1] == [1.0, 8.0, 3.0, 1.5, 9.5, 2.0] and heat["x_mm"][0] == "mm"
    assert heat["T_wall_K"][1][4] == 2300.0 and heat["t"][1] == [0.05] * 3 + [0.25] * 3
    assert "heatflux_profile_xt.csv" in z.namelist()
    readme = z.read("README.txt").decode()
    assert "psia" in readme and "MW/m^2" in readme and "from the Fire command" in readme
    assert blob == fea_bundle(r, _sidecar()), "the same run must zip to the same bytes"


def test_without_a_replay_or_a_sidecar_the_bundle_says_where_its_numbers_came_from():
    r = _run()
    del r["delivered"]
    z = zipfile.ZipFile(io.BytesIO(fea_bundle(r)))
    assert "heatflux_xt.csv" not in z.namelist()
    loads = json.loads(z.read("loads.json"))
    assert loads["heat_flux"]["available"] is False
    assert "as-built throat" in loads["chamber_pressure"]["source"]
    assert loads["chamber_pressure"]["peak"]["value"] == 399.0


SAVED = [f for f in sorted(glob.glob(str(RUNS / "*.json")))]


@pytest.mark.skipif(not SAVED, reason="no saved Layer X runs in .userdata (the user's runs)")
def test_saved_runs_export_every_series_column_and_round_trip():
    done = 0
    for f in SAVED:
        d = json.loads(Path(f).read_text())
        r = d.get("result") or {}
        if d.get("kind") != "run" or not r.get("series"):
            continue
        back = read_csv(to_csv(r))
        for name, values in _series_leaves(r["series"]):
            assert name in back, f"{Path(f).name}: {name}"
            assert back[name][1] == [_num(v) for v in values], f"{Path(f).name}: {name}"
        if r.get("delivered"):
            fire = [i for i, x in enumerate(r["series"]["firing"]) if x]
            col = back["delivered.thrust_N"][1]
            assert [col[i] for i in fire] == [_num(v) for v in r["delivered"]["thrust_N"]]
        json.loads(zipfile.ZipFile(io.BytesIO(fea_bundle(r))).read("loads.json"))
        done += 1
    assert done

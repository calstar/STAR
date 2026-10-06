"""What a user gets from a NEW design: session start, Doublet, Ethalox (DEF-01..12 defaults).

The UI builds a new design through the backend's own sequence: a fresh session loads
configs/default.yaml, each dropdown is POST /api/config/switch (config_to_dict -> switch_config ->
PintleEngineConfig), and the Layer 1 "Run" on a pintle design switches to impinging the same way.
These tests build the design exactly so, and check it against numbers that do not come from this
codebase: CEA (rocketcea) and CoolProp, quoted with the conditions they were read at.
"""
from __future__ import annotations

import copy
from pathlib import Path

import pytest
import yaml

from engine.pipeline.config_schemas import DesignRequirementsConfig, PintleEngineConfig
from engine.pipeline.config_switch import (
    design_staleness,
    infer_preset_from_fluids,
    load_canonical_config,
    switch_config,
)
from engine.pipeline.io import load_config

REPO = Path(__file__).resolve().parents[1]

# CEA (rocketcea 1.2, equilibrium), LOX/Ethanol, O/F 1.5, Pc 430 psia: Tc 3225.45 K, M 22.25.
CEA_ETHALOX_OF15_430_TC = 3225.45
CEA_ETHALOX_OF15_430_R = 373.71
# CoolProp Oxygen at 90 K: rho*a^2 = 0.938e9 Pa at 0.15 MPa and 0.983e9 at 4 MPa;
# cp 1698.6 J/(kg K); viscosity 1.957e-4 (0.15 MPa) .. 2.034e-4 (4 MPa) Pa s.
COOLPROP_LOX_K = (0.938e9, 0.983e9)
COOLPROP_LOX_CP = 1698.6
COOLPROP_LOX_MU = (1.957e-4, 2.034e-4)


def _dump(path) -> dict:
    return load_config(str(path)).model_dump(mode="json")


def _ui_switch(cfg: dict, **body) -> dict:
    """POST /api/config/switch as the router runs it."""
    return PintleEngineConfig(**switch_config(cfg, **body)).model_dump(mode="json")


def _new_ethalox_doublet() -> dict:
    d = _dump(REPO / "configs" / "default.yaml")              # fresh session
    d = _ui_switch(d, injector_type="impinging")              # Injector: Doublet
    return _ui_switch(d, propellant_preset="ethalox")         # Propellant: Ethalox


# ---------------------------------------------------------------- propellant switch (DEF-06, DEF-11)

def test_new_ethalox_doublet_gets_the_ethalox_design_point():
    d = _new_ethalox_doublet()
    assert d["propellant_preset"] == "ethalox"
    assert d["fluids"]["fuel"]["name"] == "Ethanol"
    assert d["combustion"]["cea"]["fuel_name"] == "Ethanol"
    assert d["combustion"]["cea"]["MR_range"] == [1.0, 2.5]
    # methalox's 2.8 is past ethanol's stoichiometric 96/46.07 = 2.08
    assert d["design_requirements"]["optimal_of_ratio"] == pytest.approx(1.5)
    assert d["chamber_geometry"]["design_MR"] == pytest.approx(1.5)


def test_chamber_gas_follows_the_o_f_target_from_cea():
    d = _new_ethalox_doublet()
    smd = d["spray"]["smd"]
    assert smd["chamber_gas_T"] == pytest.approx(CEA_ETHALOX_OF15_430_TC, rel=0.01)
    assert smd["chamber_gas_R"] == pytest.approx(CEA_ETHALOX_OF15_430_R, rel=0.01)


@pytest.mark.parametrize("preset", ["ethalox", "methalox", "kerolox"])
def test_preset_lox_properties_are_coolprop_oxygen(preset):
    p = yaml.safe_load((REPO / "configs" / "propellants" / f"{preset}.yaml").read_text())
    lox = p["fluids"]["oxidizer"]
    lo, hi = COOLPROP_LOX_K
    assert 0.95 * lo <= lox["bulk_modulus_pa"] <= 1.05 * hi
    assert lox["specific_heat"] == pytest.approx(COOLPROP_LOX_CP, rel=0.01)
    assert COOLPROP_LOX_MU[0] * 0.98 <= lox["viscosity"] <= COOLPROP_LOX_MU[1] * 1.02


def test_new_design_lox_is_the_presets():
    lox = _new_ethalox_doublet()["fluids"]["oxidizer"]
    assert lox["bulk_modulus_pa"] == pytest.approx(0.94e9)
    assert lox["specific_heat"] == pytest.approx(1700.0)
    assert lox["viscosity"] == pytest.approx(2.0e-4)


def test_session_start_config_names_its_propellant_and_the_switch_flags_the_seed():
    d = _dump(REPO / "configs" / "default.yaml")
    assert d["propellant_preset"] == "methalox"
    s = switch_config(d, propellant_preset="ethalox")
    assert "methalox -> ethalox" in (design_staleness(s) or "")


def test_a_preset_less_config_is_recognised_from_its_fluids():
    d = _dump(REPO / "configs" / "default.yaml")
    d["propellant_preset"] = None
    assert infer_preset_from_fluids(d) == "methalox"
    s = switch_config(d, propellant_preset="ethalox")
    assert design_staleness(s) is not None
    assert s["design_requirements"]["optimal_of_ratio"] == pytest.approx(1.5)


def test_reselecting_the_live_propellant_keeps_the_users_o_f():
    d = _new_ethalox_doublet()
    d["design_requirements"]["optimal_of_ratio"] = 1.35
    s = switch_config(d, propellant_preset="ethalox")
    assert s["design_requirements"]["optimal_of_ratio"] == pytest.approx(1.35)


# ---------------------------------------------------------------- injector switch (DEF-02, DEF-01)

def test_doublet_keeps_the_chosen_propellant_and_the_users_requirements():
    start = load_canonical_config("pintle")                   # ethalox, 7000 N, O/F 1.4
    out = _ui_switch(start, injector_type="impinging")
    assert out["injector"]["type"] == "impinging"
    assert out["propellant_preset"] == "ethalox"
    assert out["fluids"]["fuel"]["name"] == "Ethanol"
    assert out["combustion"]["cea"]["fuel_name"] == "Ethanol"
    req = out["design_requirements"]
    assert req["optimal_of_ratio"] == pytest.approx(start["design_requirements"]["optimal_of_ratio"])
    assert req["target_thrust"] == pytest.approx(start["design_requirements"]["target_thrust"])
    assert req["target_burn_time"] == pytest.approx(start["design_requirements"]["target_burn_time"])
    # the impinging seed was solved for methalox: say so
    assert "methalox -> ethalox" in (design_staleness(out) or "")
    # and the doublet gets drilled-hole Cd, not the pintle's 0.40 / 0.65
    assert out["discharge"]["oxidizer"]["use_geometry_cd"] is True
    assert out["spray"]["smd"]["model"] == "ingebo"


def test_ethalox_round_trip_through_pintle_stays_ethalox():
    d = _dump(REPO / "configs" / "ethalox_6500N.yaml")
    d = _ui_switch(d, injector_type="pintle")
    d = _ui_switch(d, injector_type="impinging")
    assert d["propellant_preset"] == "ethalox"
    assert d["fluids"]["fuel"]["name"] == "Ethanol"
    assert d["design_requirements"]["target_thrust"] == pytest.approx(6500.0)


def test_custom_propellant_survives_an_injector_swap():
    d = _dump(REPO / "configs" / "ethalox_6500N.yaml")
    d["propellant_preset"] = "custom"
    d["fluids"]["fuel"]["density"] = 801.0                    # the user's own ethanol blend
    out = _ui_switch(d, injector_type="pintle")
    assert out["propellant_preset"] == "custom"
    assert out["fluids"]["fuel"]["density"] == pytest.approx(801.0)


# ---------------------------------------------------------------- measured Cd survives (DEF-04)

def test_a_measured_cd_survives_propellant_switches():
    d = _dump(REPO / "configs" / "ethalox_6500N.yaml")
    for side, cd in (("oxidizer", 0.72), ("fuel", 0.68)):
        d["discharge"][side].update(Cd_inf=cd, a_Re=0.05, Cd_min=0.5, use_geometry_cd=False,
                                    inlet_geometry=None)
    d = _ui_switch(d, propellant_preset="kerolox")
    d = _ui_switch(d, propellant_preset="ethalox")
    for side, cd in (("oxidizer", 0.72), ("fuel", 0.68)):
        assert d["discharge"][side]["Cd_inf"] == pytest.approx(cd)
        assert d["discharge"][side]["a_Re"] == pytest.approx(0.05)
        assert d["discharge"][side]["Cd_min"] == pytest.approx(0.5)


# ---------------------------------------------------------------- one set of defaults (DEF-05, DEF-08)

GUARDS = (
    "layer1_injector_spray_radius_frac", "layer1_injector_spray_radius_tol",
    "layer1_injector_plate_thickness_m", "layer1_injector_min_web_m",
    "layer1_injector_wall_clearance_m", "layer1_injector_min_face_incidence_deg",
    "layer1_injector_counterbore_dia_m", "layer1_impinging_jet_angle_min_deg",
    "layer1_max_element_pitch_m",
)


def _blank_via_canonical() -> dict:
    return _ui_switch(load_canonical_config("impinging"), propellant_preset="ethalox")


@pytest.mark.parametrize("build", [_new_ethalox_doublet, _blank_via_canonical])
def test_new_doublet_has_the_injector_face_guards(build):
    from engine.core.injectors.layout import PLATE_THICKNESS_DEFAULT
    d = build()
    req = d["design_requirements"]
    for k in GUARDS:
        assert req[k] is not None and req[k] > 0, k
    assert req["layer1_resultant_tilt_from_reach"] is True
    # the plate the optimizer checks is the plate the drawing draws
    assert req["layer1_injector_plate_thickness_m"] == pytest.approx(PLATE_THICKNESS_DEFAULT)
    assert d["injector"]["plate"]["back"] == "channels"
    assert d["injector"]["igniter"]["thread"] == "1/2 NPT"
    # equal-area radius of the bore
    assert req["layer1_injector_spray_radius_frac"] == pytest.approx(2 ** -0.5, abs=1e-4)
    # the 6500 N design needs 24 elements
    assert req["layer1_impinging_n_doublets_max"] >= 24


def test_momentum_weight_is_the_code_default_not_a_ban():
    for f in ("configs/default.yaml", "configs/canonical/impinging.yaml"):
        req = yaml.safe_load((REPO / f).read_text())["design_requirements"]
        assert req["W_MOM"] == pytest.approx(75.0), f


def test_session_start_and_canonical_doublet_agree_on_the_objective():
    a = yaml.safe_load((REPO / "configs/default.yaml").read_text())["design_requirements"]
    b = yaml.safe_load((REPO / "configs/canonical/impinging.yaml").read_text())["design_requirements"]
    for k in ("W_MOM", "W_SMD", "layer1_W_OF", "layer1_W_THRUST", "impinging_momentum_R_min",
              "impinging_momentum_R_max", "layer1_stagnation_pressure_frac_min",
              "layer1_stagnation_pressure_frac_max", "layer1_impinging_angle_deg_max",
              "layer1_impinging_n_doublets_max", "injector_dp_ratio_O_min", "injector_dp_ratio_O_max",
              "injector_dp_ratio_F_min", "injector_dp_ratio_F_max") + GUARDS:
        assert a[k] == b[k], k


def test_included_angle_band_stays_inside_the_face_heating_limit():
    from engine.core.injectors.layout import FACE_HEATING_INCLUDED_DEG
    for f in ("configs/default.yaml", "configs/canonical/impinging.yaml"):
        req = yaml.safe_load((REPO / f).read_text())["design_requirements"]
        assert req["layer1_impinging_angle_deg_max"] <= FACE_HEATING_INCLUDED_DEG, f


def test_shipped_dp_band_is_written_as_used():
    """DEF-10: the loader no longer has to rewrite default.yaml's band to make it the one used."""
    raw = yaml.safe_load((REPO / "configs/default.yaml").read_text())["design_requirements"]
    cfg = load_config(str(REPO / "configs/default.yaml")).design_requirements
    for k in ("injector_dp_ratio_O_min", "injector_dp_ratio_O_max",
              "injector_dp_ratio_F_min", "injector_dp_ratio_F_max"):
        assert getattr(cfg, k) == pytest.approx(raw[k]), k


# ---------------------------------------------------------------- the schema says what the code does

@pytest.mark.parametrize("field, code_default", [
    ("layer1_stagnation_pressure_frac_min", "0.35"),
    ("layer1_stagnation_pressure_frac_max", "1.0"),
    ("layer1_momentum_log_deadband_rel", "0.0"),
    ("W_MOM", "75"),
])
def test_schema_description_states_the_code_fallback(field, code_default):
    desc = DesignRequirementsConfig.model_fields[field].description
    assert f"unset: {code_default}" in desc or f"is {code_default} when unset" in desc, desc


def test_every_new_requirement_field_is_documented():
    """Fields added tonight by the flight and Layer 1 owners must say what they do."""
    for k in ("layer1_W_ISP", "layer1_W_MASS", "max_apogee_m", "max_apogee_datum",
              "min_rail_exit_velocity_m_s", "min_static_margin_cal", "max_static_margin_cal",
              "regulator_supply_pressure_effect", "regulator_supply_pressure_effect_source",
              "regulator_min_differential_psi", "layer1_injector_min_back_web_m"):
        desc = DesignRequirementsConfig.model_fields[k].description or ""
        assert len(desc) > 40, k


def test_legacy_dp_band_rewrite_is_not_silent(caplog):
    """DEF-10 (partial): until the schema and optimizer rewrites are removed together, the rewrite
    of a typed 0.15-0.35 band must at least be reported."""
    import logging
    with caplog.at_level(logging.WARNING, logger="engine.pipeline.config_schemas"):
        DesignRequirementsConfig(injector_dp_ratio_O_min=0.15, injector_dp_ratio_O_max=0.35)
    assert any("0.15-0.35" in r.getMessage() for r in caplog.records)


def test_chamber_gas_derivation_never_opens_a_table_it_would_rebuild(monkeypatch):
    """CEACache deletes and rebuilds a table whose grid differs from the request; a dropdown
    toggle must not trigger that (minutes of CEA, and the shipped table gone)."""
    import engine.pipeline.cea_cache as cc
    from engine.pipeline.config_switch import derive_chamber_gas
    opened = []

    class _Spy:
        def __init__(self, *a, **k):
            opened.append(a)
            raise RuntimeError("would have opened the table")

    d = _new_ethalox_doublet()
    monkeypatch.setattr(cc, "CEACache", _Spy)
    d["combustion"]["cea"]["n_points"] = 20                   # not the grid on disk (34)
    before = dict(d["spray"]["smd"])
    out = derive_chamber_gas(d)
    assert opened == []
    assert out["spray"]["smd"]["chamber_gas_T"] == before["chamber_gas_T"]
    d["combustion"]["cea"]["n_points"] = 34                   # the table on disk: it is read
    derive_chamber_gas(d)
    assert len(opened) == 1

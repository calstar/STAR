"""Layer X flight: the drawing's pressurant flies, the coast carries no thrust, a held vehicle
reads one g, and the vehicle's stability comes back with the flight.

docs/layerx/AUDIT.md 5.1 (in-flight head row), 5.2 (He drawing cannot be flown), 9.3;
docs/layerx/DATA-CONTRACT.md 4 (``result.flight.stability``).

Every check is against something other than the code under test: CoolProp's densities, RocketPy's
own kinematics, the 1976 standard atmosphere, or the formula the flight used before the change.
"""

from __future__ import annotations

import contextlib
import io
import math
from pathlib import Path

import numpy as np
import pytest

from engine.layerx import flight as flt

G0 = 9.80665
PSI = 6894.757293168
LE4 = Path(__file__).resolve().parents[1] / "configs" / "ethalox_6800N.yaml"
#: The site's ambient as Layer X burns it (FAR, 626.67 m, ISA): what the thrust curve is computed at.
SITE_PA = 94069.72225005485

#: LE4's delivered curve, (t [s], thrust [kN], mdot_O [kg/s], mdot_F [kg/s]) on the burn's clock,
#: as Layer X flew it: run 20261002-231658-7e47d1 (copv_study_gn2, 50 ms steps, eroded throat),
#: the run AUDIT 9.3 re-flew (E1, E4). Rounded to 6 decimals.
LE4_SCHEDULE = [
    (0, 6.972301, 1.917587, 1.251566), (0.05, 6.972301, 1.917587, 1.251566), (0.1, 6.927351, 1.906825, 1.245252),
    (0.15, 6.882402, 1.896063, 1.238938), (0.2, 6.837452, 1.885301, 1.232625), (0.25, 6.819932, 1.879127, 1.231964),
    (0.3, 6.802411, 1.872952, 1.231303), (0.35, 6.795583, 1.869783, 1.231821), (0.4, 6.788755, 1.866614, 1.232339),
    (0.45, 6.781927, 1.863445, 1.232857), (0.5, 6.780529, 1.861768, 1.233808), (0.55, 6.779131, 1.860091, 1.234759),
    (0.6, 6.781210, 1.859660, 1.235894), (0.65, 6.783289, 1.859228, 1.237028), (0.7, 6.785368, 1.858797, 1.238163),
    (0.75, 6.789630, 1.859217, 1.239412), (0.8, 6.793892, 1.859637, 1.240661), (0.85, 6.799634, 1.860632, 1.241996),
    (0.9, 6.805376, 1.861626, 1.243331), (0.95, 6.811118, 1.862621, 1.244666), (1, 6.818007, 1.864031, 1.246074),
    (1.05, 6.824896, 1.865441, 1.247483), (1.1, 6.832595, 1.867150, 1.248954), (1.15, 6.840294, 1.868859, 1.250426),
    (1.2, 6.847994, 1.870568, 1.251898), (1.25, 6.856368, 1.872529, 1.253432), (1.3, 6.864742, 1.874491, 1.254967),
    (1.35, 6.873116, 1.876453, 1.256501), (1.4, 6.881859, 1.878559, 1.258073), (1.45, 6.890601, 1.880665, 1.259645),
    (1.5, 6.899553, 1.882863, 1.261237), (1.55, 6.908505, 1.885062, 1.262830), (1.6, 6.917457, 1.887261, 1.264422),
    (1.65, 6.926531, 1.889520, 1.266029), (1.7, 6.935604, 1.891779, 1.267636), (1.75, 6.944710, 1.894070, 1.269244),
    (1.8, 6.953816, 1.896362, 1.270853), (1.85, 6.962922, 1.898653, 1.272461), (1.9, 6.972011, 1.900959, 1.274067),
    (1.95, 6.981100, 1.903265, 1.275673), (2, 6.990123, 1.905570, 1.277269), (2.05, 6.999145, 1.907875, 1.278865),
    (2.1, 7.008168, 1.910180, 1.280461), (2.15, 7.017106, 1.912470, 1.282042), (2.2, 7.026043, 1.914761, 1.283622),
    (2.25, 7.034854, 1.917036, 1.285188), (2.3, 7.043664, 1.919312, 1.286753), (2.35, 7.052475, 1.921587, 1.288318),
    (2.4, 7.061127, 1.923831, 1.289859), (2.45, 7.069779, 1.926075, 1.291399), (2.5, 7.078431, 1.928319, 1.292940),
    (2.55, 7.086927, 1.930535, 1.294459), (2.6, 7.095422, 1.932751, 1.295979), (2.65, 7.103661, 1.934933, 1.297475),
    (2.7, 7.111901, 1.937115, 1.298971), (2.75, 7.120140, 1.939297, 1.300467), (2.8, 7.128213, 1.941444, 1.301938),
    (2.85, 7.136287, 1.943592, 1.303409), (2.9, 7.144188, 1.945702, 1.304854), (2.95, 7.152089, 1.947812, 1.306299),
    (3, 7.159990, 1.949923, 1.307744), (3.05, 7.167719, 1.951993, 1.309163), (3.1, 7.175447, 1.954062, 1.310582),
    (3.15, 7.182995, 1.956094, 1.311974), (3.2, 7.190543, 1.958126, 1.313367), (3.25, 7.198090, 1.960158, 1.314760),
    (3.3, 7.205426, 1.962141, 1.316122), (3.35, 7.212762, 1.964123, 1.317485), (3.4, 7.219837, 1.966055, 1.318798),
    (3.45, 7.226912, 1.967988, 1.320111), (3.4663, 7.229216, 1.968617, 1.320539),
]


def le4_arrays():
    """(t, thrust [N], mdot_O, mdot_F) of the saved LE4 curve."""
    rows = np.asarray(LE4_SCHEDULE, dtype=float)
    return rows[:, 0], rows[:, 1] * 1e3, rows[:, 2], rows[:, 3]


def le4_payload():
    t, F, mO, mF = le4_arrays()
    return {"data": {"time": t.tolist(), "thrust_kN": (F / 1e3).tolist(),
                     "mdot_O_kg_s": mO.tolist(), "mdot_F_kg_s": mF.tolist()}}


def le4_loads():
    """What the curve burns, plus a gram: the flight caps each load to its tank as it would."""
    t, _, mO, mF = le4_arrays()
    return {"oxidiser": float(np.trapezoid(mO, t)) + 1e-3, "fuel": float(np.trapezoid(mF, t)) + 1e-3}


def le4_config():
    from engine.pipeline.io import load_config

    return load_config(str(LE4))


def he_bottle(copv_psia: float, volume_L: float) -> float:
    """The He drawing's bottle at T-0, CoolProp at 293.15 K (room temperature, the audit's hand check)."""
    import CoolProp.CoolProp as CP

    return float(CP.PropsSI("D", "P", copv_psia * PSI, "T", 293.15, "Helium")) * volume_L * 1e-3


def built_flight(config, payload, loads, **kw):
    """What ``flight.fly`` builds, keeping RocketPy's Flight: ``(flight config, setup_flight result)``."""
    from scipy.interpolate import interp1d
    from ui.flight_sim import setup_flight

    notes = []
    cfg = flt._flight_config(config, payload, loads, SITE_PA, kw.get("pressurant_kg"), kw.get("copv_volume_L"),
                             notes, pressurant_gas=kw.get("pressurant_gas"))
    data = payload["data"]
    t = np.asarray(data["time"], dtype=float)

    def f(key, scale=1.0):
        return interp1d(t - t[0], np.asarray(data[key], dtype=float) * scale, bounds_error=False, fill_value=0.0)

    with contextlib.redirect_stdout(io.StringIO()):
        res = setup_flight(cfg, f("thrust_kN", 1e3), f("mdot_O_kg_s"), f("mdot_F_kg_s"))
    return cfg, res


# ---------------------------------------------------------------------- fixtures


@pytest.fixture(scope="module")
def config():
    return le4_config()


@pytest.fixture(scope="module")
def he_derived(config):
    """The hot-fire drawing as Layer X reads it: its pressurant species and its bottle."""
    pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")
    from engine.layerx import DrawingStore, LayerXSettings, prepare
    from engine.layerx.sources import shipped_drawings_dir

    if not (shipped_drawings_dir() / "copv_study_he.json").is_file():
        pytest.skip("feed-twin's shipped drawings are not next to this checkout")
    drawing = {d.name: d for d in DrawingStore(None).list()}["copv_study_he"]
    prep = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, flight=True))
    return prep.derived


@pytest.fixture(scope="module")
def he_kw(he_derived):
    return {"pressurant_kg": he_bottle(he_derived["copv_psia"], he_derived["copv_volume_L"]),
            "copv_volume_L": he_derived["copv_volume_L"], "pressurant_gas": he_derived["pressurant_gas"]}


@pytest.fixture(scope="module")
def he_flown(config, he_kw):
    return flt.fly(config, le4_payload(), le4_loads(), SITE_PA, **he_kw)


@pytest.fixture(scope="module")
def he_built(config, he_kw):
    return built_flight(config, le4_payload(), le4_loads(), **he_kw)


# ---------------------------------------------------------------------- 1. the drawing's pressurant


def test_the_helium_drawing_flies_and_its_budget_is_helium(he_derived, he_kw, he_flown):
    """AUDIT 5.2: the He drawing's bottle (0.209 kg) was priced as the config's nitrogen, needed
    0.52 kg and was refused. Flown as the drawing's gas it flies, and says which gas it flew."""
    assert he_derived["pressurant_gas"].lower() == "helium"
    assert he_kw["pressurant_kg"] == pytest.approx(0.209, abs=1e-3)   # AUDIT 9.3 7.1 hand check
    assert he_flown["ok"], he_flown.get("error")
    budget = he_flown["mass_budget"]
    assert budget["pressurant_gas"] == "Helium" and he_flown["pressurant_gas"] == "Helium"
    assert budget["pressurant_kg"] == pytest.approx(he_kw["pressurant_kg"], rel=1e-12)
    assert any("flown as Helium" in n for n in he_flown["notes"])


def test_the_refill_and_the_ullage_are_priced_as_helium(config, he_built):
    """The COPV's loss is the gas that fills the volume the liquid leaves, at tank pressure and the
    ullage temperature: sum of rho_He(p, T) / rho_liquid x liquid burned (CoolProp), and nothing
    else. Priced as nitrogen it would be ~7x larger."""
    import CoolProp.CoolProp as CP

    cfg, res = he_built
    rocket = res["flight"].rocket
    tb = float(rocket.motor.burn_out_time)
    tanks = {p["tank"].name: p["tank"] for p in rocket.motor.positioned_tanks}
    copv = tanks["Pressurant (He) Tank"]
    hand = {"Helium": 0.0, "Nitrogen": 0.0}
    for name, section, rho_liq in (("LOX Tank", cfg.lox_tank, cfg.fluids["oxidizer"].density),
                                   ("Fuel Tank", cfg.fuel_tank, cfg.fluids["fuel"].density)):
        burned = float(tanks[name].liquid_mass(0.0) - tanks[name].liquid_mass(tb))
        for gas in hand:
            rho_g = CP.PropsSI("D", "P", section.initial_pressure_psi * PSI, "T", section.ullage_gas_temperature_K, gas)
            hand[gas] += rho_g / float(rho_liq) * burned
    refill = float(copv.fluid_mass(0.0) - copv.fluid_mass(tb))
    assert refill == pytest.approx(hand["Helium"], rel=2e-3)
    assert hand["Nitrogen"] > 5.0 * hand["Helium"]
    assert res["flight_report"]["copv_refill_kg"] == pytest.approx(refill, rel=2e-3)
    # The T-0 ullage too: helium at tank pressure, not nitrogen.
    assert res["mass_budget"]["ullage_gas_kg"] < 0.02


def test_without_the_species_the_helium_bottle_is_refused_as_before(config, he_kw):
    """``pressurant_gas=None`` is the previous behaviour exactly: the config's nitrogen prices the
    refill and the 0.209 kg helium bottle cannot hold it (AUDIT 9.3 7.1: 'needs 0.521 kg')."""
    kw = dict(he_kw, pressurant_gas=None)
    out = flt.fly(config, le4_payload(), le4_loads(), SITE_PA, **kw)
    assert not out["ok"]
    assert "needs 0.5" in out["error"] and "COPV holds 0.209 kg" in out["error"]


def test_the_configs_own_gas_changes_nothing(config):
    """Turned on with the gas the config already says, nothing moves: same config, same flight,
    bit for bit (the GN2 drawing's flights are unchanged by this fix)."""
    loads, payload = le4_loads(), le4_payload()
    notes_a, notes_b = [], []
    a = flt._flight_config(config, payload, loads, SITE_PA, None, None, notes_a)
    b = flt._flight_config(config, payload, loads, SITE_PA, None, None, notes_b, pressurant_gas="nitrogen")
    assert a.model_dump() == b.model_dump() and notes_a == notes_b == []
    plain = flt.fly(config, payload, loads, SITE_PA)
    named = flt.fly(config, payload, loads, SITE_PA, pressurant_gas="N2")
    assert plain["ok"] and named["ok"]
    assert named["schedule"] == plain["schedule"]
    assert named["apogee_agl_m"] == plain["apogee_agl_m"]
    assert named["mass_budget"] == plain["mass_budget"] and plain["mass_budget"]["pressurant_gas"] == "Nitrogen"


def test_liftoff_mass_books_the_vehicle_as_the_flight_does(config, he_kw, he_flown):
    """The mass the inline ascent starts from, without building RocketPy: the same booking as the
    flight's own (RocketPy's total_mass(0)), helium bottle and all; a weighed vehicle wins."""
    mass = flt.liftoff_mass(config, le4_loads(), ambient_pa=SITE_PA, **he_kw)
    assert mass["value"] == pytest.approx(he_flown["liftoff_mass_kg"], abs=1e-3)
    assert mass["parts"]["pressurant_gas"] == "Helium"
    assert mass["parts"]["ullage_gas_kg"] == pytest.approx(he_flown["mass_budget"]["ullage_gas_kg"], rel=1e-3)
    given = flt.liftoff_mass(config, le4_loads(), ambient_pa=SITE_PA, ullage_gas_kg=0.05, **he_kw)
    assert given["value"] - mass["value"] == pytest.approx(0.05 - mass["parts"]["ullage_gas_kg"], abs=1e-9)
    assert flt.liftoff_mass(config, le4_loads(), weighed_kg=86.18)["value"] == 86.18


def test_coolprop_names():
    assert flt.coolprop_gas("helium") == "Helium"
    assert flt.coolprop_gas("N2") == "Nitrogen"
    assert flt.coolprop_gas(None) is None and flt.coolprop_gas("") is None


# ---------------------------------------------------------------------- 2. no thrust in the coast


def _ungated(flight, t):
    """``axial_acceleration`` as it was before the gate (flight.py at the start of 2026-10-02)."""
    motor = flight.rocket.motor
    area = math.pi * float(motor.nozzle_radius) ** 2
    reference = float(getattr(motor, "reference_pressure", None) or 0.0)
    pressure = float(flight.env.pressure(flight.z(t))) if reference else 0.0
    thrust = float(motor.thrust(t)) + (reference - pressure) * area if reference else float(motor.thrust(t))
    return (thrust + float(flight.R3(t))) / float(flight.rocket.total_mass(t))


def test_the_coast_reads_drag_only(he_built):
    """After burnout the motor gives nothing: the specific force is the drag over the mass, which
    is RocketPy's own vertical acceleration plus gravity (no wind, vertical rail: the axis stays
    vertical), and zero at apogee where the vehicle stops. Before the gate it read +0.40 g there."""
    _, res = he_built
    fl = res["flight"]
    tb = float(fl.rocket.motor.burn_out_time)
    for t in (tb + 0.2, 10.0, 20.0, float(fl.apogee_time)):
        kinematic = float(fl.az(t)) + float(fl.env.gravity(fl.z(t)))
        assert flt.axial_acceleration(fl, t) == pytest.approx(kinematic, abs=1e-3 * G0), t
    assert abs(flt.axial_acceleration(fl, float(fl.apogee_time))) < 1e-4 * G0
    assert _ungated(fl, float(fl.apogee_time)) > 0.3 * G0   # what the gate removes


def test_the_burn_reads_exactly_as_before(he_built):
    """The gate must not touch the burn: every firing instant, both ends included, is the old
    formula bit for bit (the burn uses these through Setup.body_acceleration)."""
    _, res = he_built
    fl = res["flight"]
    tb = float(fl.rocket.motor.burn_out_time)
    t, *_ = le4_arrays()
    burning = [float(x) for x in t if x <= tb] + [tb]
    assert len(burning) == len(t)   # the last sample sits 1.2 ms after RocketPy's cutoff
    for x in burning:
        assert flt.axial_acceleration(fl, x) == _ungated(fl, x), x


def test_the_fly_trajectory_coast_is_drag_only(he_flown):
    traj = he_flown["trajectory"]
    assert abs(traj["accel_axial_g"][-1]) < 1e-3          # apogee
    assert all(a < 1e-3 for a, t in zip(traj["accel_axial_g"], traj["t"]) if t > 3.5)   # drag decelerates


def test_a_vehicle_held_on_the_rail_reads_one_g(config):
    """A curve whose thrust dips below the weight before the vehicle leaves the rail: RocketPy holds
    it (u_dot_rail1 clamps the axial acceleration to zero), the rail carries the difference, and
    the liquid columns feel g0 sin(90 deg) = g0, the pad's value, not T/m. Once thrust exceeds the
    weight again it reads T/m as before."""
    t = [0.0, 0.04, 0.05, 0.25, 0.26, 3.0]
    F = [1000.0, 1000.0, 400.0, 400.0, 6500.0, 6500.0]
    payload = {"data": {"time": t, "thrust_kN": [f / 1e3 for f in F], "mdot_O_kg_s": [1.8] * len(t),
                        "mdot_F_kg_s": [1.2] * len(t)}}
    out = flt.fly(config, payload, {"oxidiser": 6.0, "fuel": 4.0}, SITE_PA)
    assert out["ok"], out.get("error")
    assert out["rail_exit_time_s"] > 0.26
    a = dict(zip(out["schedule"]["t"], out["schedule"]["accel_m_s2"]))
    m0 = out["liftoff_mass_kg"]
    assert 400.0 / m0 < 0.6 * G0                     # what it read before: T/m, half a g
    assert a[0.05] == G0 and a[0.25] == G0           # held: exactly the pad's g0
    assert a[0.0] == pytest.approx(1000.0 / m0, rel=1e-3) and a[0.0] > G0
    assert a[0.26] > 7.0 * G0


# ---------------------------------------------------------------------- 3. vehicle stability


def test_stability_has_the_contract_shape(he_flown):
    s = he_flown["stability"]
    assert s["available"] is True
    n = len(LE4_SCHEDULE)
    assert s["t"] == [row[0] for row in LE4_SCHEDULE]
    for key in ("static_margin_cal", "cg_m", "cp_m"):
        assert len(s[key]) == n and all(math.isfinite(v) for v in s[key]), key
    for key in ("max_q_pa", "max_q_t", "rail_exit_m_s"):
        assert math.isfinite(s[key]), key
    # flight_report's scalars, which the Flight tab reads, are still there.
    assert {"static_margin_liftoff_cal", "static_margin_burnout_cal", "min_stability_margin_cal"} <= set(s)
    model = s["model"]
    assert model["name"] and "Barrowman" in model["source"] and model["assumptions"]
    for name, row in model["inputs"].items():
        assert set(row) == {"value", "unit", "provenance"} and row["provenance"], name
    # Unmeasured vehicle numbers say they are schema defaults (AUDIT 9.3 3).
    assert "schema default" in model["inputs"]["rail_length_m"]["provenance"]


def test_static_margin_is_cg_less_cp_over_the_diameter(he_flown):
    """Positions from the tail: CG ahead of CP is stable, margin = (CG - CP) / D. As the LOX tank
    (aft of the fuel) drains the CG moves forward and the margin grows (AUDIT 9.3 3: 7.7 -> 8.7
    cal on the GN2 run)."""
    s = he_flown["stability"]
    d = s["diameter_m"]
    for cg, cp, sm in zip(s["cg_m"], s["cp_m"], s["static_margin_cal"]):
        assert sm == pytest.approx((cg - cp) / d, abs=1e-4)
    assert s["cg_m"][-1] > s["cg_m"][0] and s["static_margin_cal"][-1] > s["static_margin_cal"][0]
    assert s["min_static_margin_cal"] == min(s["static_margin_cal"]) == s["liftoff_static_margin_cal"]
    assert s["min_static_margin_cal"] > 1.5   # FAR-OUT's floor, AUDIT 9.3 4


def test_cp_is_barrowmans_by_hand(he_built, he_flown):
    """The CP the block reports, by hand from the flown layout (Barrowman 1967, Mach 0, slender
    body): nose normal-force slope 2 at X_N = L - V/A_base from its tip, V integrated here from the
    von Karman (Haack C = 0) shape rather than taken as 0.5 L; fins
    CN = (1 + r/(s + r)) 4N (s/d)^2 / (1 + sqrt(1 + (2 l_m/(Cr + Ct))^2)), l_m the mid-chord line, at
    X = m (Cr + 2Ct)/(3(Cr + Ct)) + (Cr + Ct - Cr Ct/(Cr + Ct))/6 aft of the root's leading edge
    (sweep m = Cr - Ct, RocketPy's default: a square trailing edge). Positions from the tail. A fin
    set placed by its trailing edge instead of its leading edge, or a nose CP off by 1 cm, fails."""
    from engine.pipeline.vehicle_drag import built_stack

    cfg, _ = he_built
    s = he_flown["stability"]
    r = float(cfg.rocket.radius)
    d = 2.0 * r
    fins = cfg.rocket.fins
    cr, ct, span, n = float(fins.root_chord), float(fins.tip_chord), float(fins.fin_span), int(fins.no_fins)
    sweep = cr - ct
    l_mid = math.hypot(span, sweep + ct / 2 - cr / 2)
    cn_f = (1 + r / (span + r)) * 4 * n * (span / d) ** 2 / (1 + math.sqrt(1 + (2 * l_mid / (cr + ct)) ** 2))
    x_f = float(fins.fin_position) - (sweep * (cr + 2 * ct) / (3 * (cr + ct)) + (cr + ct - cr * ct / (cr + ct)) / 6)
    stack = built_stack(cfg)
    length, tip = float(stack["nose_length"]), float(stack["nose_tip"])
    assert str(cfg.rocket.nose_kind).lower().replace(" ", "") == "vonkarman"
    theta = np.linspace(0.0, math.pi, 200001)
    x = length / 2 * (1 - np.cos(theta))
    y = r / math.sqrt(math.pi) * np.sqrt(theta - np.sin(2 * theta) / 2)
    volume = float(np.trapezoid(math.pi * y * y, x))
    x_n = tip - (length - volume / (math.pi * r * r))
    cp = (2.0 * x_n + cn_f * x_f) / (2.0 + cn_f)
    assert s["cp_m"][0] == pytest.approx(cp, abs=1e-4)
    assert s["liftoff_static_margin_cal"] == pytest.approx((s["cg_m"][0] - cp) / d, abs=1e-3)


def test_max_q_is_half_rho_v_squared_at_its_time(config, he_flown):
    """Hand check: q = 1/2 rho v^2 with rho from the 1976 standard atmosphere at the reported
    altitude and the reported speed (no wind: the free stream is the vehicle's speed). Max-Q comes
    at burnout on LE4 (fastest, still low)."""
    from engine.pipeline.vehicle_drag import isa_troposphere

    s = he_flown["stability"]
    _, _, rho, _, _ = isa_troposphere(config.environment.elevation + s["max_q_altitude_agl_m"])
    assert s["max_q_pa"] == pytest.approx(0.5 * rho * s["max_q_speed_m_s"] ** 2, rel=1e-3)
    assert s["max_q_t"] == pytest.approx(he_flown["truncation"]["cutoff_time"], abs=0.01)
    # And it is the maximum: no point of the flown trajectory has more.
    traj = he_flown["trajectory"]
    for z, v in zip(traj["altitude_m"], traj["velocity_m_s"]):
        _, _, rho_z, _, _ = isa_troposphere(config.environment.elevation + z)
        assert 0.5 * rho_z * v * v <= s["max_q_pa"] * (1 + 1e-3)


def test_rail_exit_against_an_independent_ascent(config, he_flown):
    """The 1-DOF ascent (not RocketPy) on the same curve, mass and drag reaches the rail's length
    at the speed RocketPy reports at rail exit (no rail buttons declared: the full rail is flown)."""
    s = he_flown["stability"]
    t, F, mO, mF = le4_arrays()
    fine = np.linspace(0.0, 0.5, 501)
    ascent = flt.inline_specific_force(config, np.interp(fine, t, F), np.interp(fine, t, mO + mF), fine,
                                       he_flown["liftoff_mass_kg"], SITE_PA, dt_max=1e-3)
    z, v = np.asarray(ascent["altitude_m"]), np.asarray(ascent["velocity_m_s"])
    rail = config.environment.rail_length_m
    assert s["rail_exit_m_s"] == pytest.approx(float(np.interp(rail, z, v)), rel=2e-3)
    assert s["rail_exit_t"] == pytest.approx(float(np.interp(rail, z, fine)), abs=2e-3)
    assert s["rail_exit_m_s"] == he_flown["rail_exit_velocity_m_s"]


def test_a_stability_block_that_cannot_be_made_says_why():
    class Broken:
        rocket = None

    out = flt._stability_or_failure(Broken(), None, [0.0, 1.0], {"static_margin_liftoff_cal": 7.0})
    assert out["available"] is False and out["error"] and out["static_margin_liftoff_cal"] == 7.0

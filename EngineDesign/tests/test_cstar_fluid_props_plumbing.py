"""The c* vaporization march gets the config's own liquid properties, for BOTH propellants.

The chamber solver used to pass only four fuel keys with RP-1 fallbacks (boiling point 489 K,
latent heat 300 kJ/kg, MW 170) and no oxidizer properties at all, so the march took LOX as
vaporized at the face and the fuel's cp and injection temperature as assumed values.
"""
import pytest



def _solver():
    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner
    cfg = load_config("configs/ethalox_6500N.yaml")
    return cfg, PintleEngineRunner(cfg)


def test_both_streams_get_the_configs_liquid_properties():
    cfg, runner = _solver()
    solver = runner.solver
    fuel, ox = solver._get_fuel_props(), solver._get_ox_props()
    assert fuel["boiling_point"] == pytest.approx(cfg.fluids["fuel"].boiling_point)
    assert fuel["latent_heat"] == pytest.approx(cfg.fluids["fuel"].latent_heat)
    assert fuel["specific_heat"] == pytest.approx(cfg.fluids["fuel"].specific_heat)
    assert ox["boiling_point"] == pytest.approx(cfg.fluids["oxidizer"].boiling_point)
    assert ox["molecular_weight"] == pytest.approx(cfg.fluids["oxidizer"].molecular_weight)


def test_no_vaporization_property_is_assumed_on_the_6500N(monkeypatch):
    monkeypatch.setenv("ED_ACCEL", "off")
    _, runner = _solver()
    r = runner.evaluate(584.27 * 6894.757, 584.27 * 6894.757, P_ambient=94070.0, silent=True)
    ce = r["diagnostics"]["cstar_efficiency"]
    assumed = [a for a in (ce.get("assumptions") or [])
               if "vaporization" in str(a.get("name", a) if isinstance(a, dict) else a)]
    assert assumed == []
    assert ce["T_surface_O"] < 154.6            # LOX drops evaporate below its critical temperature

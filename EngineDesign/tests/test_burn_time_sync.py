"""Tests for burn time field synchronization."""

from types import SimpleNamespace

from engine.pipeline.burn_time_sync import canonical_burn_time_s, sync_burn_time_fields


def test_canonical_prefers_design_requirements():
    config = SimpleNamespace(
        design_requirements=SimpleNamespace(target_burn_time=6.8),
        thrust=SimpleNamespace(burn_time=10.0),
        pressure_curves=SimpleNamespace(target_burn_time_s=6.0),
    )
    assert canonical_burn_time_s(config) == 6.8


def test_sync_aligns_all_sections():
    config = SimpleNamespace(
        design_requirements=SimpleNamespace(target_burn_time=7.5),
        thrust=SimpleNamespace(burn_time=10.0),
        pressure_curves=SimpleNamespace(target_burn_time_s=6.0),
    )
    sync_burn_time_fields(config)
    assert config.thrust.burn_time == 7.5
    assert config.pressure_curves.target_burn_time_s == 7.5
    assert config.design_requirements.target_burn_time == 7.5

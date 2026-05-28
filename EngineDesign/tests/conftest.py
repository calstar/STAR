# tests/conftest.py
import pytest
import yaml
from pathlib import Path
from engine.pipeline.config_schemas import PintleEngineConfig

@pytest.fixture(scope="session")
def diablo_config() -> PintleEngineConfig:
    """Load diablo_config.yaml as a PintleEngineConfig for integration tests."""
    p = Path(__file__).parent.parent / "configs" / "diablo_config.yaml"
    return PintleEngineConfig(**yaml.safe_load(p.read_text()))

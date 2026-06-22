"""Configuration loading and result saving"""

from __future__ import annotations

import logging
import yaml
from pathlib import Path
from typing import Any, Dict, List, Union
from .config_schemas import PintleEngineConfig

_log = logging.getLogger(__name__)

# Project root (…/EngineDesign); io.py lives at engine/pipeline/io.py
_PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _preset_search_dirs(config_dir: Path) -> List[Path]:
    """Preset lookup order: next to the config file first, then the repo's configs/propellants."""
    return [config_dir / "propellants", _PROJECT_ROOT / "configs" / "propellants"]


def _available_presets(config_dir: Path) -> List[str]:
    names: List[str] = []
    for d in _preset_search_dirs(config_dir):
        if d.is_dir():
            names.extend(sorted(p.stem for p in d.glob("*.yaml")))
    return sorted(set(names))


def _deep_merge_preset(preset: Any, override: Any, path: str = "") -> Any:
    """Recursive merge: ``override`` (explicit config) wins on every leaf; overridden preset leaves
    are logged so silently-differing values stay visible (UNIFICATION_PLAN Phase 2a)."""
    if isinstance(preset, dict) and isinstance(override, dict):
        merged = dict(preset)
        for key, o_val in override.items():
            if key in preset:
                merged[key] = _deep_merge_preset(preset[key], o_val, f"{path}.{key}" if path else key)
            else:
                merged[key] = o_val
        return merged
    if preset is not None and override is not None and preset != override:
        _log.info("propellant preset override: %s = %r (preset had %r)", path, override, preset)
    return override if override is not None else preset


def _check_preset_coherence(name: str, preset: Dict[str, Any], merged: Dict[str, Any]) -> None:
    """Hard-fail when explicit config fields contradict the preset's PROPELLANT IDENTITY.

    Explicit-wins is fine for property tweaks (density, viscosity, …), but a stale explicit CEA
    section or fluid *name* from a previous propellant produces physically-wrong results that look
    plausible (the hardcoded-Cd bug class). Identity mismatches are errors, not overrides.
    """
    identity_paths = [
        ("combustion", "cea", "ox_name"), ("combustion", "cea", "fuel_name"),
        ("fluids", "fuel", "name"), ("fluids", "oxidizer", "name"),
    ]
    for path in identity_paths:
        p_val, m_val = preset, merged
        for key in path:
            p_val = p_val.get(key) if isinstance(p_val, dict) else None
            m_val = m_val.get(key) if isinstance(m_val, dict) else None
        if p_val is not None and m_val is not None and str(m_val) != str(p_val):
            raise ValueError(
                f"propellant_preset '{name}' conflicts with explicit config: "
                f"{'.'.join(path)} = {m_val!r} but the preset defines {p_val!r}. "
                f"Delete the stale explicit section (it likely belongs to a previous propellant) "
                f"or use propellant_preset: custom."
            )


def _apply_propellant_preset(data: Dict[str, Any], config_dir: Path) -> Dict[str, Any]:
    """If ``propellant_preset`` is set, merge the preset under explicit-YAML-wins semantics."""
    name = data.get("propellant_preset")
    if not name or str(name).strip().lower() == "custom":
        return data
    name = str(name).strip().lower()
    for d in _preset_search_dirs(config_dir):
        candidate = d / f"{name}.yaml"
        if candidate.exists():
            with open(candidate, "r", encoding="utf-8") as f:
                preset = yaml.safe_load(f) or {}
            _log.info("applying propellant preset '%s' from %s", name, candidate)
            merged = _deep_merge_preset(preset, data)
            merged["propellant_preset"] = name
            _check_preset_coherence(name, preset, merged)
            return merged
    raise FileNotFoundError(
        f"Unknown propellant_preset '{name}'. Available presets: {_available_presets(config_dir)} "
        f"(searched: {[str(d) for d in _preset_search_dirs(config_dir)]})"
    )


def load_config(config_path: Union[str, Path]) -> PintleEngineConfig:
    """
    Load engine configuration from YAML file.

    If the YAML carries ``propellant_preset: <name>`` (e.g. methalox, ethalox, kerolox), the file
    ``configs/propellants/<name>.yaml`` is deep-merged in BEFORE validation: the preset supplies the
    propellant baseline (fluids, CEA setup) and any field given explicitly in the config wins (each
    such override is logged). ``custom`` or absent = no preset (legacy behavior, unchanged).

    Parameters:
    -----------
    config_path : str | Path
        Path to YAML configuration file

    Returns:
    --------
    config : PintleEngineConfig
        Validated configuration object
    """
    path = Path(config_path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)

    data = _apply_propellant_preset(data, path.resolve().parent)

    # Re-stamp spray/discharge bindings for the declared injector type (fixes stale pintle-era
    # lefebvre SMD + fixed Cd left on impinging YAMLs — bogus ~1 µm D32 and supply-starved Pc).
    inj_type = (data.get("injector") or {}).get("type")
    if inj_type:
        try:
            from engine.pipeline.config_switch import apply_injector_type
            data = apply_injector_type(data, inj_type)
        except ValueError:
            pass

    # Validate and parse using Pydantic
    config = PintleEngineConfig(**data)

    # Injector-physics binding coherence (warn-only; UNIFICATION Phase 2b, engine/core/dispatch.py)
    try:
        from engine.core.dispatch import validate_config_bindings
        for w in validate_config_bindings(config):
            _log.warning("config binding: %s", w)
    except ImportError:
        pass

    return config


def save_results(results: Dict[str, Any], output_path: Union[str, Path]) -> None:
    """
    Save pipeline results to file (JSON or CSV).
    
    Parameters:
    -----------
    results : Dict[str, Any]
        Results dictionary from pipeline
    output_path : str | Path
        Output file path
    """
    import json
    
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    
    # Convert numpy types to native Python types for JSON serialization
    def convert_types(obj):
        if isinstance(obj, dict):
            return {k: convert_types(v) for k, v in obj.items()}
        elif isinstance(obj, (list, tuple)):
            return [convert_types(item) for item in obj]
        elif hasattr(obj, 'item'):  # numpy scalar
            return obj.item()
        elif hasattr(obj, 'tolist'):  # numpy array
            return obj.tolist()
        else:
            return obj
    
    results_serializable = convert_types(results)
    
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(results_serializable, f, indent=2)

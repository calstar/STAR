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



# Fluid names as they appear in ``fluids.*.name`` vs ``combustion.cea.*_name``. The two fields
# come from different worlds -- one is a human label, one is a rocketcea card -- so they are
# spelled differently for the same substance.
_FLUID_ALIASES = {
    "lox": {"lox", "o2(l)", "oxygen", "loxygen", "lo2"},
    "methane": {"methane", "ch4", "lch4", "ch4(l)"},
    "ethanol": {"ethanol", "c2h5oh", "etoh", "c2h5oh(l)"},
    "rp1": {"rp1", "rp-1", "kerosene", "jet-a", "jeta"},
    "nitrousoxide": {"n2o", "nitrousoxide", "nitrous oxide"},
    "ipa": {"ipa", "isopropanol", "isopropyl alcohol", "c3h8o"},
}


def _canon_fluid(name) -> str:
    """Canonical key for a fluid name, or the lowercased name when unrecognised."""
    if not name:
        return ""
    n = str(name).strip().lower().replace("_", "").replace(" ", "").replace("-", "")
    for canon, aliases in _FLUID_ALIASES.items():
        if n in {a.replace(" ", "").replace("-", "").replace("_", "") for a in aliases}:
            return canon
    return n


def _check_fluid_cea_coherence(data: Dict[str, Any]) -> None:
    """Fail when ``fluids`` and ``combustion.cea`` describe DIFFERENT propellants.

    This used to live inside _check_preset_coherence, which only runs when a config names a
    ``propellant_preset``. Leave the preset unset -- which is exactly what the UI does when no
    propellant is picked -- and the guard was skipped entirely: a config could carry methane
    fluid properties while the chemistry came from the LOX/Ethanol CEA table, and it loaded
    without a word. The injector would flow one propellant's density and the chamber would burn
    another's thermochemistry, and every number downstream would look completely plausible.

    The physics does not care whether a preset was named, so neither does this check.
    """
    fluids = (data.get("fluids") or {})
    cea = ((data.get("combustion") or {}).get("cea") or {})
    if not fluids or not cea:
        return
    pairs = (
        ("fuel", (fluids.get("fuel") or {}).get("name"), cea.get("fuel_name")),
        ("oxidizer", (fluids.get("oxidizer") or {}).get("name"), cea.get("ox_name")),
    )
    for side, fluid_name, cea_name in pairs:
        if not fluid_name or not cea_name:
            continue
        a, b = _canon_fluid(fluid_name), _canon_fluid(cea_name)
        if a and b and a != b:
            raise ValueError(
                f"Propellant mismatch on the {side} side: fluids.{side}.name = {fluid_name!r} "
                f"but combustion.cea.{'fuel_name' if side == 'fuel' else 'ox_name'} = "
                f"{cea_name!r}. The injector would flow one propellant while the chamber burns "
                f"another's chemistry. Fix the config, or set propellant_preset to a preset that "
                f"defines both consistently."
            )
    # The CEA cache file is named after the propellants it was built for; a stale one is the
    # same failure wearing a different hat.
    cache = str(cea.get("cache_file") or "")
    if cache:
        stem = cache.rsplit("/", 1)[-1].lower()
        for side, _fl, cea_name in pairs:
            c = _canon_fluid(cea_name)
            if not c:
                continue
            known = {"lox": "lox", "methane": "ch4", "ethanol": "ethanol", "rp1": "rp1"}
            tag = known.get(c)
            if tag and tag not in stem.replace("-", "_").replace(".", "_"):
                _log.warning(
                    "CEA cache %r does not mention the %s propellant %r — check it is not stale.",
                    cache, side, cea_name,
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

    # ALWAYS, not just when a preset is named -- see _check_fluid_cea_coherence.
    _check_fluid_cea_coherence(data)

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

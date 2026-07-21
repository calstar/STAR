"""Configuration loading and result saving"""

from __future__ import annotations

import copy
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


def _apply_material_preset(data: Dict[str, Any], config_dir: Path) -> Dict[str, Any]:
    """If ``material_preset`` is set, merge ``configs/materials/<name>.yaml`` under the same
    explicit-YAML-wins semantics as the propellant preset.

    Material properties (heat of ablation, densities, oxidation kinetics, ...) are constants of the
    SUBSTANCE, not of an engine -- but they were duplicated verbatim in every config, 61 identical
    fields across the two canonical files alone, with nothing keeping them in sync. Sharing them
    means one authoritative value; the deep merge still lets a config override any leaf, and every
    override is logged, so a per-engine deviation is possible but never silent.

    No coherence check here (unlike propellants): a material has no "identity" field that a stale
    explicit block could contradict into a plausible-but-wrong result.
    """
    name = data.get("material_preset")
    if not name or str(name).strip().lower() == "custom":
        return data
    name = str(name).strip().lower()
    for d in _material_preset_search_dirs(config_dir):
        candidate = d / f"{name}.yaml"
        if candidate.exists():
            with open(candidate, "r", encoding="utf-8") as f:
                preset = yaml.safe_load(f) or {}
            _log.info("applying material preset '%s' from %s", name, candidate)
            merged = _deep_merge_preset(preset, data)
            merged["material_preset"] = name
            return merged
    raise FileNotFoundError(
        f"Unknown material_preset '{name}'. Available: "
        f"{sorted({p.stem for d in _material_preset_search_dirs(config_dir) if d.is_dir() for p in d.glob('*.yaml')})} "
        f"(searched: {[str(d) for d in _material_preset_search_dirs(config_dir)]})"
    )


def _material_preset_search_dirs(config_dir: Path) -> List[Path]:
    """Material lookup order: next to the config file first, then the repo's configs/materials."""
    return [config_dir / "materials", _PROJECT_ROOT / "configs" / "materials"]


# Fields the OPTIMIZER writes back, verified by grepping for assignments (not schema declarations):
# chamber_geometry A_throat/A_exit/... come from the chamber+nozzle sizing, Cf from
# layer1_static_optimization:5442, injector.geometry jet sizing from Layer 1, tank start pressures
# from Layer 1, pressure_curves from Layer 2. ``chamber_geometry.design_*`` and ``nozzle_efficiency``
# are NOT here: nothing assigns them, so they are hand-typed intent.
_GENERATED_FIELDS: Dict[str, Any] = {
    "chamber_geometry": ["A_throat", "A_exit", "volume", "Lstar", "chamber_diameter",
                         "exit_diameter", "expansion_ratio", "length", "length_cylindrical",
                         "length_contraction", "Cf"],
    "injector": ["geometry"],
    "lox_tank": ["initial_pressure_psi"],
    "fuel_tank": ["initial_pressure_psi"],
    "combustion": {"cea": ["expansion_ratio"]},
    "pressure_curves": None,   # whole block
}


def split_generated(data: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """Partition a resolved config into (hand-authored intent, optimizer-generated) halves.

    The split is by AUTHORSHIP -- what a human types vs what the code writes back -- which is
    checkable against the source rather than a matter of taste. Used when saving so a round trip
    through the API cannot collapse a split config back into one file.
    """
    intent = copy.deepcopy(data)
    generated: Dict[str, Any] = {}

    def take(src: Dict[str, Any], dst: Dict[str, Any], spec: Any) -> None:
        if spec is None:
            return
        if isinstance(spec, list):
            for key in spec:
                if key in src:
                    dst[key] = src.pop(key)
            return
        for key, sub in spec.items():
            if isinstance(src.get(key), dict):
                bucket: Dict[str, Any] = {}
                take(src[key], bucket, sub)
                if bucket:
                    dst[key] = bucket

    for block, spec in _GENERATED_FIELDS.items():
        if spec is None:
            if block in intent:
                generated[block] = intent.pop(block)
        elif isinstance(intent.get(block), dict):
            bucket = {}
            take(intent[block], bucket, spec)
            if bucket:
                generated[block] = bucket
    return intent, generated


def save_config(data: Dict[str, Any], path: Union[str, Path]) -> None:
    """Write a config, preserving the intent/generated split when a sidecar is in use.

    Without this, any save through the API would write the MERGED config into the intent file; the
    sidecar would then collide with it and every subsequent load would raise. Splitting on save is
    what makes the split survive a round trip.
    """
    path = Path(path)
    sidecar = path.with_suffix("")
    sidecar = sidecar.with_name(sidecar.name + ".design.yaml")

    if not sidecar.exists():
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)
        return

    intent, generated = split_generated(data)
    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(intent, f, default_flow_style=False, sort_keys=False)
    with open(sidecar, "r", encoding="utf-8") as f:
        header = "".join(ln for ln in f if ln.startswith("#") or not ln.strip())
    with open(sidecar, "w", encoding="utf-8") as f:
        f.write(header)
        yaml.dump(generated, f, default_flow_style=False, sort_keys=False)


def _deep_overlay(base: Dict[str, Any], overlay: Dict[str, Any], path: str = "") -> List[str]:
    """Recursively overlay ``overlay`` onto ``base`` IN PLACE. Returns the paths that collided.

    A collision means a field owned by the generated sidecar was ALSO written by hand in the intent
    file -- the one situation the split exists to make impossible-to-miss, so it is reported rather
    than silently resolved either way.
    """
    collisions: List[str] = []
    for key, val in overlay.items():
        here = f"{path}.{key}" if path else key
        if isinstance(val, dict) and isinstance(base.get(key), dict):
            collisions.extend(_deep_overlay(base[key], val, here))
        else:
            if key in base and base[key] is not None:
                collisions.append(here)
            base[key] = val
    return collisions


def _apply_design_sidecar(data: Dict[str, Any], path: Path) -> Dict[str, Any]:
    """Overlay ``<stem>.design.yaml`` -- the optimizer-GENERATED half of a split config.

    Configs mix two kinds of content: what a human types (requirements, hardware choices, model
    selections) and what the code writes back (chamber geometry, injector jet sizing, tank
    pressures, pressure curves). Keeping both in one file is why staleness was invisible -- nothing
    marked which half the optimizer owns, so a hand-edited requirement and a generated geometry
    solved for a DIFFERENT requirement looked identical on disk.

    Split on disk, merged here, so the pydantic schema and every downstream consumer are unchanged.
    Absent sidecar = single-file config, legacy behaviour, unchanged.
    """
    sidecar = path.with_suffix("")
    sidecar = sidecar.with_name(sidecar.name + ".design.yaml")
    if not sidecar.exists():
        return data

    with open(sidecar, "r", encoding="utf-8") as f:
        generated = yaml.safe_load(f) or {}
    _log.info("applying design sidecar %s", sidecar)

    collisions = _deep_overlay(data, generated)
    if collisions:
        raise ValueError(
            f"{path.name} hand-sets fields owned by {sidecar.name}: {sorted(collisions)}. "
            f"Generated values belong in the .design.yaml only -- editing them in the intent file "
            f"means the next optimizer run silently discards your edit. Remove them, or move the "
            f"field out of the sidecar if it is genuinely hand-authored."
        )
    return data


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
    data = _apply_material_preset(data, path.resolve().parent)
    data = _apply_design_sidecar(data, path.resolve())

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

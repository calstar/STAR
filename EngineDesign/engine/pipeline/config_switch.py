"""Live config switching for injector type & propellant (UNIFICATION_PLAN Phase 6 — UI exposure).

The goal: injector type and propellant are FIRST-CLASS toggles in the UI, not buried in YAML. When the
user flips either, the config must auto-reconcile to the RIGHT physics:
  * injector type -> LOAD THE CANONICAL CONFIG for that type WHOLESALE (configs/canonical/<type>.yaml).
    The two canonical configs are independent, proven starting guesses that deliberately do NOT stay
    in sync — pintle carries fixed Cd 0.40/0.65 (main physics), impinging carries geometry-Cd 0.60
    (fork physics). Switching types means "load a whole new config with different values for
    everything", which is the point: the Cd that converges for a pintle annulus is nonsense for a
    doublet jet, so each type owns its own coherent block. (apply_injector_type below is the legacy
    in-place patcher, kept for same-type reconciliation and back-compat.)
  * propellant    -> overlay the preset's fluids + CEA identity (preset WINS here — this is a switch,
    not a load-time merge, so stale fluid/CEA values are replaced, not preserved). Cheaper than an
    injector switch: it just autofills propellant identity onto the current geometry.

When a switch leaves the chamber geometry seeded for a different injector/propellant than is now live,
we STAMP design_valid_for and forward mode warns ("needs re-optimization") rather than silently
trusting a stale chamber (design_staleness).

Operates on plain dicts so it composes with the config router's merge/validate flow.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

from engine.core.dispatch import bindings_for, default_geometry_for, default_discharge_for

_log = logging.getLogger(__name__)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_CANONICAL_DIR = _PROJECT_ROOT / "configs" / "canonical"


def canonical_config_path(injector_type: str) -> Path:
    """Path to the canonical starting config for an injector type (validates the type)."""
    bindings_for(injector_type)
    return _CANONICAL_DIR / f"{injector_type}.yaml"


def load_canonical_config(injector_type: str) -> Dict[str, Any]:
    """Load the canonical starting config for ``injector_type`` as a fully-resolved dict.

    Uses the real loader (io.load_config) so the propellant preset is merged exactly as a normal
    load would — fluids/CEA identity included — then stamps design_valid_for to this config's own
    {injector, propellant} so a fresh canonical load is NOT flagged stale (it is internally coherent).
    Lazy import of io avoids an import cycle (io has no dependency on this module).
    """
    path = canonical_config_path(injector_type)
    if not path.exists():
        raise FileNotFoundError(
            f"No canonical config for injector '{injector_type}' at {path}. "
            f"Expected configs/canonical/{injector_type}.yaml")
    from engine.pipeline.io import load_config
    model = load_config(str(path))
    cfg = model.model_dump(mode="json")
    cfg["design_valid_for"] = {
        "injector": injector_type,
        "propellant": cfg.get("propellant_preset"),
    }
    return cfg


def available_injectors() -> list:
    from engine.core.dispatch import INJECTOR_GEOMETRY_TEMPLATES
    return sorted(INJECTOR_GEOMETRY_TEMPLATES)


def available_propellants() -> list:
    d = _PROJECT_ROOT / "configs" / "propellants"
    return sorted(p.stem for p in d.glob("*.yaml")) if d.is_dir() else []


def apply_injector_type(config: Dict[str, Any], injector_type: str) -> Dict[str, Any]:
    """Switch injector type IN PLACE-ish (returns new dict): replace geometry with the type template
    (preserve existing geometry only if the type is unchanged), then set the physics bindings."""
    b = bindings_for(injector_type)            # validates the type
    cfg = dict(config)
    inj = dict(cfg.get("injector") or {})
    current_type = inj.get("type")
    inj["type"] = injector_type
    if current_type != injector_type or "geometry" not in inj:
        inj["geometry"] = default_geometry_for(injector_type)   # incompatible structure -> replace
    cfg["injector"] = inj

    # SMD model binding: impinging needs an explicit model (ingebo); injectors that hard-bind their
    # own correlation (pintle) get the inert "lefebvre" so the config doesn't carry a misleading model.
    spray = dict(cfg.get("spray") or {})
    smd = dict(spray.get("smd") or {})
    smd["model"] = b.expected_smd_model if b.expected_smd_model is not None else "lefebvre"
    spray["smd"] = smd
    cfg["spray"] = spray

    # Discharge-Cd baseline: stamp the per-injector Cd model (the "different Cd models we originally
    # had for each" — pintle 0.40/0.65 fixed vs impinging 0.60 geometry-Cd). Overwrites the Cd-defining
    # fields; preserves user-tunable correction settings (P_ref/T_ref/a_P/a_T/use_*_correction).
    discharge = dict(cfg.get("discharge") or {})
    baseline = default_discharge_for(injector_type)
    for side in ("oxidizer", "fuel"):
        if side not in discharge or not isinstance(discharge[side], dict):
            continue
        d = dict(discharge[side])
        if baseline.get(side):
            # drop stale geometry-Cd params from the previous injector, then apply this type's baseline
            for stale in ("d_ref_m", "cd_small_hole_exponent", "cd_large_hole_log_gain",
                          "cd_inf_max", "cd_inf_min_geom", "d_min_m"):
                d.pop(stale, None)
            d.update(baseline[side])
        else:
            d["use_geometry_cd"] = b.expected_use_geometry_cd   # fallback if no baseline registered
        discharge[side] = d
    cfg["discharge"] = discharge
    _log.info("switched injector -> %s (smd.model=%s, use_geometry_cd=%s)",
              injector_type, b.expected_smd_model, b.expected_use_geometry_cd)
    return cfg


def apply_propellant(config: Dict[str, Any], preset_name: str) -> Dict[str, Any]:
    """Switch propellant: overlay the preset's fluids + CEA IDENTITY (preset wins — replaces stale
    fluid names / CEA names from the previous propellant). Design-owned CEA fields (expansion_ratio,
    ranges, n_points, cache_file) and everything else are preserved from the current config."""
    name = str(preset_name).strip().lower()
    old_preset = (config or {}).get("propellant_preset")
    inj_type = ((config or {}).get("injector") or {}).get("type")
    if name == "custom":
        cfg = dict(config)
        cfg["propellant_preset"] = "custom"
        _stamp_propellant_change(cfg, old_preset, "custom", inj_type)
        return cfg
    preset_path = _PROJECT_ROOT / "configs" / "propellants" / f"{name}.yaml"
    if not preset_path.exists():
        raise FileNotFoundError(
            f"Unknown propellant '{name}'. Available: {available_propellants()}")
    preset = yaml.safe_load(preset_path.read_text()) or {}
    cfg = dict(config)
    cfg["propellant_preset"] = name

    # fluids: preset wins wholesale (it defines the propellant identity + properties)
    if "fluids" in preset:
        cfg["fluids"] = preset["fluids"]

    # combustion.cea: take preset's propellant-identity fields, keep design-owned fields
    preset_cea = (preset.get("combustion") or {}).get("cea") or {}
    if preset_cea:
        comb = dict(cfg.get("combustion") or {})
        cea = dict(comb.get("cea") or {})
        for identity_key in ("ox_name", "fuel_name", "Pc_range", "MR_range", "eps_range",
                             "n_points", "cache_file"):
            if identity_key in preset_cea:
                cea[identity_key] = preset_cea[identity_key]
        comb["cea"] = cea
        cfg["combustion"] = comb
    _stamp_propellant_change(cfg, old_preset, name, inj_type)
    _log.info("switched propellant -> %s (fluids+CEA identity overlaid)", name)
    return cfg


def _stamp_propellant_change(cfg: Dict[str, Any], old_preset: Optional[str],
                             new_preset: str, inj_type: Optional[str]) -> None:
    """A propellant overlay keeps the EXISTING chamber geometry, which was seeded for the previous
    propellant. If the propellant actually changed, record that prior {injector, propellant} as the
    design's provenance so forward mode flags the chamber as stale (needs re-optimization). Does not
    clobber an existing stamp (the chamber's true provenance is the FIRST mismatch, not the latest)."""
    # NB: design_valid_for is a declared schema field, so it's always a key (value None when unset) —
    # gate on its VALUE, not key presence, or the stamp never fires.
    if old_preset and old_preset != new_preset and not cfg.get("design_valid_for"):
        cfg["design_valid_for"] = {"injector": inj_type, "propellant": old_preset}


def switch_config(config: Dict[str, Any], *, injector_type: Optional[str] = None,
                  propellant_preset: Optional[str] = None) -> Dict[str, Any]:
    """Apply an injector and/or propellant switch to a config dict and return the reconciled dict.
    Caller validates (PintleEngineConfig(**result)) and stores.

    Injector change => LOAD THE CANONICAL config for the new type wholesale (the two configs are
    intentionally independent — see module docstring). A same-type request falls back to the legacy
    in-place reconcile. Propellant change => overlay the preset onto whatever geometry is now live.
    """
    cfg = config
    current_type = ((config or {}).get("injector") or {}).get("type")
    if injector_type is not None and injector_type != current_type:
        cfg = load_canonical_config(injector_type)   # whole new config, different values for everything
    elif injector_type is not None:
        cfg = apply_injector_type(cfg, injector_type)  # same type: just reconcile bindings
    if propellant_preset is not None:
        cfg = apply_propellant(cfg, propellant_preset)
    return cfg


def design_staleness(config: Any) -> Optional[str]:
    """Return a human-readable warning if the live injector/propellant no longer match what the
    chamber geometry was solved/seeded for (design_valid_for stamp), else None. Accepts a dict or a
    PintleEngineConfig. This powers the "Warn + flag for re-solve" forward-mode behaviour."""
    if config is None:
        return None
    if isinstance(config, dict):
        dvf = config.get("design_valid_for")
        cur_inj = ((config.get("injector") or {}) or {}).get("type")
        cur_prop = config.get("propellant_preset")
    else:
        dvf = getattr(config, "design_valid_for", None)
        cur_inj = getattr(getattr(config, "injector", None), "type", None)
        cur_prop = getattr(config, "propellant_preset", None)
    if not dvf:
        return None
    mism = []
    if dvf.get("injector") and dvf["injector"] != cur_inj:
        mism.append(f"injector {dvf['injector']} -> {cur_inj}")
    if dvf.get("propellant") and dvf["propellant"] != cur_prop:
        mism.append(f"propellant {dvf['propellant']} -> {cur_prop}")
    if not mism:
        return None
    return ("Chamber geometry was solved for " + ", ".join(mism) +
            ". It is being used as a seed only — re-run optimization for a valid design.")

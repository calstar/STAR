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

import copy
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


def apply_injector_type(config: Dict[str, Any], injector_type: str, *,
                        keep_declared_cd: bool = False) -> Dict[str, Any]:
    """Switch injector type IN PLACE-ish (returns new dict): replace geometry with the type template
    (preserve existing geometry only if the type is unchanged), then set the physics bindings.

    ``keep_declared_cd``: on a SAME-type call, fill only the discharge keys the config leaves out
    and never overwrite one it declares. The live switch path uses it (DEF-04). The load path
    (io.load_config) still re-stamps, because three shipped methalox configs carry hand-written
    Cd values that have only ever been evaluated after that overwrite."""
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
    #
    # With keep_declared_cd, a same-type call fills the keys the config leaves out and touches
    # nothing it declares: the orifice's Cd belongs to the hardware, so a measured cold-flow value
    # must survive a propellant switch (DEF-04; it used to come back as the 0.60 baseline).
    discharge = dict(cfg.get("discharge") or {})
    baseline = default_discharge_for(injector_type)
    same_type = keep_declared_cd and current_type == injector_type
    for side in ("oxidizer", "fuel"):
        if side not in discharge or not isinstance(discharge[side], dict):
            continue
        d = dict(discharge[side])
        if baseline.get(side) and same_type:
            for k, v in baseline[side].items():
                if d.get(k) is None:
                    d[k] = v
                elif k != "use_geometry_cd" and d[k] != v:
                    _log.info("discharge.%s.%s = %r kept (the %s baseline is %r)",
                              side, k, d[k], injector_type, v)
        elif baseline.get(side):
            # Preserve an explicitly-set use_geometry_cd: a user override of the type default wins,
            # and validate_config_bindings() warns about the mismatch rather than us silently
            # clobbering it. (The derive-default only fills the unset case.)
            user_ugc = d.get("use_geometry_cd", None)
            # drop stale geometry-Cd params from the previous injector, then apply this type's baseline
            for stale in ("d_ref_m", "cd_small_hole_exponent", "cd_large_hole_log_gain",
                          "cd_inf_max", "cd_inf_min_geom", "d_min_m"):
                d.pop(stale, None)
            d.update(baseline[side])
            if user_ugc is not None:
                d["use_geometry_cd"] = bool(user_ugc)
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
    # A config with no preset named (configs/default.yaml, a pasted YAML) still HAS a propellant:
    # read it off the fluids, or the staleness stamp below never fires (DEF-06).
    old_preset = (config or {}).get("propellant_preset") or infer_preset_from_fluids(config)
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

    # spray.smd: the chamber-gas pair (rho_g = Pc/(R*T) for the Ingebo aerodynamic Weber number)
    # is a property of the PROPELLANT, so it must follow the switch. Without this the toggle left
    # every propellant on the SMDConfig defaults (R=360, T=3500) -- one hardcoded chamber applied
    # to all three, which is wrong for each of them at its own mixture ratio.
    # Deliberately narrow: the correlation tuning next to it (model, C_ingebo, C/m/p, we_corr_max)
    # is injector- and design-owned and must NOT be clobbered by a propellant change.
    preset_smd = (preset.get("spray") or {}).get("smd") or {}
    gas_keys = [k for k in ("chamber_gas_R", "chamber_gas_T") if k in preset_smd]
    if gas_keys:
        spray = dict(cfg.get("spray") or {})
        smd = dict(spray.get("smd") or {})
        for k in gas_keys:
            smd[k] = preset_smd[k]
        spray["smd"] = smd
        cfg["spray"] = spray

    # The O/F target belongs to the propellant: methalox's 2.8 is past ethanol's stoichiometric
    # 2.08. On a real change, take the preset's design O/F (its source is in the preset file) and
    # move the chamber's design_MR with it. Re-selecting the live propellant changes nothing.
    if old_preset != name:
        rec_of = ((preset.get("design_requirements") or {}).get("optimal_of_ratio"))
        if rec_of is not None:
            req = dict(cfg.get("design_requirements") or {})
            prev = req.get("optimal_of_ratio")
            req["optimal_of_ratio"] = float(rec_of)
            cfg["design_requirements"] = req
            cg = cfg.get("chamber_geometry")
            if isinstance(cg, dict):
                cfg["chamber_geometry"] = {**cg, "design_MR": float(rec_of)}
            _log.warning("propellant %s -> %s: O/F target %s -> %s (the %s preset's design point)",
                         old_preset, name, prev, rec_of, name)
        cfg = derive_chamber_gas(cfg)

    _stamp_propellant_change(cfg, old_preset, name, inj_type)
    _log.info("switched propellant -> %s (fluids+CEA identity+chamber gas overlaid)", name)
    return cfg


def _preset_fluid_names() -> Dict[str, tuple]:
    """{preset: (canonical oxidizer name, canonical fuel name)} for every shipped preset."""
    from engine.pipeline.io import _canon_fluid
    out = {}
    for name in available_propellants():
        try:
            p = yaml.safe_load((_PROJECT_ROOT / "configs" / "propellants" / f"{name}.yaml").read_text())
        except Exception:
            continue
        fl = (p or {}).get("fluids") or {}
        out[name] = (_canon_fluid((fl.get("oxidizer") or {}).get("name")),
                     _canon_fluid((fl.get("fuel") or {}).get("name")))
    return out


def infer_preset_from_fluids(config: Optional[Dict[str, Any]]) -> Optional[str]:
    """The preset whose oxidizer and fuel a preset-less config carries; "custom" when its fluids
    match no preset; None when it has no fluids at all."""
    fl = (config or {}).get("fluids") or {}
    if not fl:
        return None
    from engine.pipeline.io import _canon_fluid
    pair = (_canon_fluid((fl.get("oxidizer") or {}).get("name")),
            _canon_fluid((fl.get("fuel") or {}).get("name")))
    if not all(pair):
        return None
    for name, names in _preset_fluid_names().items():
        if names == pair:
            return name
    return "custom"


# Chamber pressure at which the chamber gas is read when the design names no target Pc. It is the
# 6500 N ethalox design point; R*T moves 0.15 % between 300 and 600 psia at O/F 1.5 (CEA), so the
# choice barely matters -- Tc is what the evaporation model feels, and it moves 1 % over that span.
CHAMBER_GAS_REFERENCE_PC_PSI = 430.0


def derive_chamber_gas(config: Dict[str, Any]) -> Dict[str, Any]:
    """Set spray.smd.chamber_gas_R/T from the CEA table at the design's O/F and target Pc.

    The Ingebo Weber number and the evaporation model read one representative chamber gas; a
    preset stamps it at the preset's own O/F, which is wrong as soon as the target moves (DEF-11:
    3094 K at O/F 1.35 against 3225 K at 1.5). Leaves the config unchanged -- and says so -- when
    the table is not on disk (never triggers a multi-minute CEA build from a UI toggle) or the
    point lies outside it."""
    import os
    cfg = dict(config)
    cea = dict(((cfg.get("combustion") or {}).get("cea")) or {})
    req = cfg.get("design_requirements") or {}
    of = req.get("optimal_of_ratio")
    pc_psi = req.get("target_chamber_pressure_psi") or CHAMBER_GAS_REFERENCE_PC_PSI
    cache_file = cea.get("cache_file")
    if of is None or not cache_file or not cea.get("MR_range"):
        return cfg
    path = cache_file if os.path.isabs(cache_file) else str(_PROJECT_ROOT / cache_file)
    if not os.path.exists(path):
        _log.warning("chamber gas not derived: no CEA table at %s (keeping the preset's R/T)", path)
        return cfg
    lo, hi = cea["MR_range"]
    if not float(lo) <= float(of) <= float(hi):
        _log.warning("chamber gas not derived: O/F %s outside the CEA table [%s, %s]", of, lo, hi)
        return cfg
    try:
        import json
        from engine.pipeline.config_schemas import CEAConfig
        from engine.pipeline.cea_cache import CEA_TABLE_SCHEMA_VERSION, CEACache, _load_npz_tables
        # CEACache DELETES and rebuilds a table whose identity or grid differs from the request.
        # A UI toggle must never do that: read the table only when it is the one asked for.
        meta = json.loads(_load_npz_tables(path)["meta"].tolist())
        wanted = {"table_schema": CEA_TABLE_SCHEMA_VERSION, "ox_name": cea.get("ox_name"),
                  "fuel_name": cea.get("fuel_name"), "n_points": cea.get("n_points"),
                  "dimensions": 3 if cea.get("eps_range") is not None else 2}
        if any(meta.get(k, 1 if k == "table_schema" else None) != v for k, v in wanted.items()):
            _log.warning("chamber gas not derived: %s is not the table this config asks for", path)
            return cfg
        if cea.get("expansion_ratio") is None:
            cea["expansion_ratio"] = float((cea.get("eps_range") or [5.0])[0])
        cea["cache_file"] = path
        r = CEACache(CEAConfig(**cea)).eval(float(of), float(pc_psi) * 6894.757293168)
        if r.get("extrapolated"):
            _log.warning("chamber gas not derived: (O/F %s, %s psia) outside the CEA table", of, pc_psi)
            return cfg
        T, R = float(r["Tc"]), float(r["R"])
    except Exception as e:  # a derivation failure must not break a propellant switch
        _log.warning("chamber gas not derived (%s); keeping the preset's R/T", e)
        return cfg
    spray = dict(cfg.get("spray") or {})
    smd = dict(spray.get("smd") or {})
    smd["chamber_gas_T"] = round(T, 1)
    smd["chamber_gas_R"] = round(R, 2)
    spray["smd"] = smd
    cfg["spray"] = spray
    _log.info("chamber gas from CEA at O/F %s, %s psia: T %.1f K, R %.2f J/(kg K)", of, pc_psi, T, R)
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


# Requirements that state what the USER asked for, not how the canonical seed was tuned. An
# injector swap reloads the canonical wholesale; these follow the user across it.
_DESIGN_INTENT_KEYS = (
    "target_thrust", "target_burn_time", "target_apogee", "target_chamber_pressure_psi",
    "max_chamber_outer_diameter", "max_nozzle_exit_diameter", "max_engine_length",
    "max_chamber_length_m", "max_lox_tank_pressure_psi", "max_fuel_tank_pressure_psi",
)


def _carry_design_intent(old: Dict[str, Any], cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Copy the user's own requirements (thrust, burn time, envelope, tank caps) from the pre-swap
    config onto the freshly loaded canonical, and keep its burn-time slots in step."""
    old_req = old.get("design_requirements") or {}
    req = dict(cfg.get("design_requirements") or {})
    for k in _DESIGN_INTENT_KEYS:
        if old_req.get(k) is not None:
            req[k] = old_req[k]
    cfg = dict(cfg)
    cfg["design_requirements"] = req
    bt = req.get("target_burn_time")
    if bt is not None:
        if isinstance(cfg.get("thrust"), dict):
            cfg["thrust"] = {**cfg["thrust"], "burn_time": bt}
        if isinstance(cfg.get("pressure_curves"), dict):
            cfg["pressure_curves"] = {**cfg["pressure_curves"], "target_burn_time_s": bt}
    return cfg


def _carry_custom_propellant(old: Dict[str, Any], cfg: Dict[str, Any]) -> Dict[str, Any]:
    """A "custom" propellant has no preset to re-apply: carry its fluids, CEA identity and chamber
    gas verbatim, and stamp the canonical's own propellant so the seed reads as stale."""
    cfg = dict(cfg)
    seeded_for = cfg.get("propellant_preset")
    if old.get("fluids"):
        cfg["fluids"] = copy.deepcopy(old["fluids"])
    old_cea = ((old.get("combustion") or {}).get("cea")) or {}
    comb = dict(cfg.get("combustion") or {})
    cea = dict(comb.get("cea") or {})
    for k in ("ox_name", "fuel_name", "Pc_range", "MR_range", "eps_range", "n_points", "cache_file"):
        if k in old_cea:
            cea[k] = old_cea[k]
    comb["cea"] = cea
    cfg["combustion"] = comb
    old_smd = ((old.get("spray") or {}).get("smd")) or {}
    spray = dict(cfg.get("spray") or {})
    smd = dict(spray.get("smd") or {})
    for k in ("chamber_gas_R", "chamber_gas_T"):
        if old_smd.get(k) is not None:
            smd[k] = old_smd[k]
    spray["smd"] = smd
    cfg["spray"] = spray
    cfg["propellant_preset"] = "custom"
    cfg["design_valid_for"] = {"injector": (cfg.get("injector") or {}).get("type"),
                               "propellant": seeded_for}
    return cfg


def switch_config(config: Dict[str, Any], *, injector_type: Optional[str] = None,
                  propellant_preset: Optional[str] = None) -> Dict[str, Any]:
    """Apply an injector and/or propellant switch to a config dict and return the reconciled dict.
    Caller validates (PintleEngineConfig(**result)) and stores.

    Injector change => LOAD THE CANONICAL config for the new type wholesale (the two configs are
    intentionally independent -- see module docstring), then put back what the user chose: the
    propellant (named, or read off the fluids -- DEF-02: picking Doublet used to turn an ethalox
    design into methalox), the O/F target when it lies inside the new CEA table, and the design
    intent in _DESIGN_INTENT_KEYS. A same-type request re-stamps the bindings without touching a
    declared Cd. Propellant change => overlay the preset onto whatever geometry is now live.
    """
    old = config or {}
    cfg = config
    current_type = (old.get("injector") or {}).get("type")
    keep = propellant_preset or old.get("propellant_preset") or infer_preset_from_fluids(old)
    keep = str(keep).strip().lower() if keep else None
    if injector_type is not None and injector_type != current_type:
        cfg = load_canonical_config(injector_type)   # whole new config, different values for everything
        cfg = _carry_design_intent(old, cfg)
        if keep == "custom":
            cfg = _carry_custom_propellant(old, cfg)
        elif keep and keep != cfg.get("propellant_preset"):
            cfg = apply_propellant(cfg, keep)          # stamps the canonical's propellant -> stale
        # The user's O/F survives the swap when it is still a valid target for this propellant.
        of = (old.get("design_requirements") or {}).get("optimal_of_ratio")
        mr = ((cfg.get("combustion") or {}).get("cea") or {}).get("MR_range")
        same_prop = keep == (old.get("propellant_preset") or infer_preset_from_fluids(old))
        if of is not None and mr and same_prop and float(mr[0]) <= float(of) <= float(mr[1]):
            cfg["design_requirements"] = {**cfg["design_requirements"], "optimal_of_ratio": of}
            if isinstance(cfg.get("chamber_geometry"), dict):
                cfg["chamber_geometry"] = {**cfg["chamber_geometry"], "design_MR": of}
        if keep != "custom":
            cfg = derive_chamber_gas(cfg)
        propellant_preset = None                       # carried above; do not overlay twice
    elif injector_type is not None:
        cfg = apply_injector_type(cfg, injector_type, keep_declared_cd=True)  # same type: bindings only
    if propellant_preset is not None:
        cfg = apply_propellant(cfg, propellant_preset)
    # Re-stamp the injector BINDINGS (SMD model, missing discharge keys) for the live type -- an
    # uploaded impinging config can carry pintle's lefebvre. Never a declared Cd (DEF-04).
    live_type = ((cfg or {}).get("injector") or {}).get("type")
    if live_type:
        cfg = apply_injector_type(cfg, live_type, keep_declared_cd=True)
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

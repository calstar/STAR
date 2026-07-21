"""Config management endpoints."""

from fastapi import APIRouter, UploadFile, File, HTTPException
import os
from pathlib import Path
from pydantic import ValidationError
import yaml

from engine.pipeline.config_schemas import PintleEngineConfig
from backend.state import app_state

router = APIRouter(prefix="/api/config", tags=["config"])


def config_to_dict(config: PintleEngineConfig) -> dict:
    """Convert Pydantic config to JSON-serializable dict."""
    return config.model_dump(mode="json")


@router.post("/upload")
async def upload_config(file: UploadFile = File(...)):
    """Upload a YAML config file and parse it."""
    if not file.filename or not file.filename.endswith((".yaml", ".yml")):
        raise HTTPException(status_code=400, detail="File must be a YAML file (.yaml or .yml)")
    
    try:
        content = await file.read()
        
        # Save uploads outside configs/ — personal exports must not land in the tracked tree.
        from backend.main import project_root
        uploads_dir = project_root / "output" / "user_configs"
        uploads_dir.mkdir(parents=True, exist_ok=True)
        save_path = uploads_dir / file.filename
        
        with open(save_path, "wb") as f:
            f.write(content)
            
        data = yaml.safe_load(content.decode("utf-8"))
        config = PintleEngineConfig(**data)
        app_state.set_config(config, str(save_path))
        return {
            "status": "success",
            "message": f"Config loaded from {file.filename}",
            "config": config_to_dict(config),
        }
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}")
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=f"Config validation error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load config: {e}")


@router.get("")
async def get_config():
    """Get the current config as JSON."""
    if not app_state.has_config():
        raise HTTPException(status_code=404, detail="No config loaded. Upload a config file first.")
    return {"config": config_to_dict(app_state.config)}


@router.get("/options")
async def get_switch_options():
    """Available injector types and propellant presets for the UI selectors (UNIFICATION P6)."""
    from engine.pipeline.config_switch import available_injectors, available_propellants
    current_injector = None
    current_propellant = None
    if app_state.has_config():
        current_injector = getattr(getattr(app_state.config, "injector", None), "type", None)
        current_propellant = getattr(app_state.config, "propellant_preset", None)
    return {
        "injectors": available_injectors(),
        "propellants": available_propellants(),
        "current": {"injector": current_injector, "propellant": current_propellant},
    }


@router.get("/injector_schema")
async def get_injector_schema(injector_type: str | None = None):
    """Per-injector field schema for the UI to render the RIGHT controls (frozen params, geometry)
    instead of hardcoding pintle fields (INJECTOR_PARITY_PLAN W5). Defaults to the loaded config's type.
    """
    from engine.core.dispatch import (
        frozen_param_fields_for, INJECTOR_GEOMETRY_TEMPLATES, bindings_for,
    )
    t = injector_type
    if t is None and app_state.has_config():
        t = getattr(getattr(app_state.config, "injector", None), "type", None)
    t = t or "impinging"
    b = bindings_for(t)
    return {
        "injector_type": t,
        "frozen_param_fields": frozen_param_fields_for(t),
        "geometry_fields": INJECTOR_GEOMETRY_TEMPLATES.get(t, {}),
        "smd_model": b.expected_smd_model or "lefebvre",
        "use_geometry_cd": b.expected_use_geometry_cd,
    }


@router.post("/switch")
async def switch_config_endpoint(body: dict):
    """Switch injector type and/or propellant, auto-reconciling the config to the right physics.

    Body: {"injector_type": "pintle"|"impinging"|null, "propellant_preset": "methalox"|...|null}.
    Injector change LOADS THE CANONICAL config for that type wholesale (configs/canonical/<type>.yaml);
    the two canonical configs are intentionally independent (pintle fixed Cd vs impinging geometry-Cd —
    they must NOT stay in sync). Propellant change overlays the preset identity onto the live geometry.
    Then validates and stores. This is the engine behind the UI's first-class injector/propellant toggles.

    IN-MEMORY ONLY: a quick injector/propellant toggle must NOT overwrite the config file on disk —
    doing so silently clobbered configs/default.yaml when a user flipped the dropdown. The switch
    updates app_state (so it holds for the session); persisting is an explicit Save action, not a
    side effect of toggling.

    A propellant overlay leaves the chamber seeded for the previous propellant; the response carries a
    ``design_warning`` ("needs re-optimization") so the UI can flag the design as a seed, not a solution.
    """
    if not app_state.has_config():
        raise HTTPException(status_code=404, detail="No config loaded. Upload a config file first.")
    from engine.pipeline.config_switch import switch_config, design_staleness
    try:
        current = config_to_dict(app_state.config)
        reconciled = switch_config(
            current,
            injector_type=body.get("injector_type"),
            propellant_preset=body.get("propellant_preset"),
        )
        new_config = PintleEngineConfig(**reconciled)
    except (ValidationError, ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=422, detail=f"Switch failed: {e}")

    # Update in-memory state only; preserve the original config_path WITHOUT writing to it.
    app_state.set_config(new_config, app_state.config_path)

    from engine.core.dispatch import validate_config_bindings
    return {
        "status": "success",
        "config": config_to_dict(new_config),
        "binding_warnings": validate_config_bindings(new_config),
        "design_warning": design_staleness(new_config),
    }


@router.put("")
async def update_config(updates: dict):
    """Update the current config with partial updates.
    
    Accepts a nested dict of updates that will be merged with the current config.
    """
    if not app_state.has_config():
        raise HTTPException(status_code=404, detail="No config loaded. Upload a config file first.")
    
    try:
        # Get current config as dict
        current = config_to_dict(app_state.config)
        
        # Deep merge updates
        def deep_merge(base: dict, updates: dict) -> dict:
            result = base.copy()
            for key, value in updates.items():
                if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                    result[key] = deep_merge(result[key], value)
                else:
                    result[key] = value
            return result
        
        merged = deep_merge(current, updates)
        
        # Validate and create new config
        new_config = PintleEngineConfig(**merged)
        
        # Save to disk if we have a path. MUST go through io.save_config: a split config keeps its
        # optimizer-generated half in <stem>.design.yaml, and dumping the merged model into the
        # intent file would put generated fields where the loader forbids them -- every subsequent
        # load would then raise on the collision.
        if app_state.config_path:
            from engine.pipeline.io import save_config as _save_config
            _save_config(config_to_dict(new_config), app_state.config_path)
                
        app_state.set_config(new_config, app_state.config_path)
        
        return {
            "status": "success",
            "message": "Config updated",
            "config": config_to_dict(new_config),
        }
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=f"Config validation error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update config: {e}")


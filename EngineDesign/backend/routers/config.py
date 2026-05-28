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
        
        # Save to configs directory
        from backend.main import project_root
        configs_dir = project_root / "configs"
        configs_dir.mkdir(exist_ok=True)
        save_path = configs_dir / file.filename
        
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


@router.post("/reload")
async def reload_config():
    """Re-read the active config YAML from disk and replace in-memory state.

    Useful after hand-editing the YAML outside the UI: `GET /api/config` always
    returns the in-memory snapshot, so without this endpoint disk edits are
    invisible until the file is re-uploaded.
    """
    if not app_state.config_path:
        raise HTTPException(
            status_code=404,
            detail="No config path known. Upload a config file first.",
        )
    path = Path(app_state.config_path)
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Config file no longer exists on disk: {path}",
        )
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        new_config = PintleEngineConfig(**data)
        app_state.set_config(new_config, str(path))
        return {
            "status": "success",
            "message": f"Reloaded config from {path.name}",
            "config": config_to_dict(new_config),
        }
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}")
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=f"Config validation error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to reload config: {e}")


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
        
        # Save to disk if we have a path
        if app_state.config_path:
            with open(app_state.config_path, "w", encoding="utf-8") as f:
                # Use clean dict (exclude unset/none if desired, but here we just dump the model)
                yaml.dump(config_to_dict(new_config), f, default_flow_style=False, sort_keys=False)
                
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


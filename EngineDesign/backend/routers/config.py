"""Config management endpoints."""

from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from starlette.concurrency import run_in_threadpool
import os
from pathlib import Path
from pydantic import ValidationError
import yaml

from engine.pipeline.config_schemas import PintleEngineConfig
from backend.session import UserSession, get_session

router = APIRouter(prefix="/api/config", tags=["config"])


def config_to_dict(config: PintleEngineConfig) -> dict:
    """Convert Pydantic config to JSON-serializable dict."""
    return config.model_dump(mode="json")


@router.post("/upload")
async def upload_config(
    file: UploadFile = File(...),
    session: UserSession = Depends(get_session),
):
    """Upload a YAML config file and parse it."""
    if not file.filename or not file.filename.endswith((".yaml", ".yml")):
        raise HTTPException(status_code=400, detail="File must be a YAML file (.yaml or .yml)")

    try:
        content = await file.read()

        # Save uploads outside configs/ — personal exports must not land in the
        # tracked tree — and under the caller's own folder, so two users
        # uploading files with the same name do not overwrite each other.
        from backend.main import project_root
        uploads_dir = project_root / "output" / "user_configs" / session.user
        uploads_dir.mkdir(parents=True, exist_ok=True)
        save_path = uploads_dir / file.filename

        with open(save_path, "wb") as f:
            f.write(content)

        data = yaml.safe_load(content.decode("utf-8"))
        config = PintleEngineConfig(**data)
        # set_config builds/loads the CEA cache (PintleEngineRunner). A cold
        # cache is a multi-minute synchronous build, so run it off the event
        # loop -- inline it would block every other request (health included),
        # which is exactly the "stuck on Connecting…" hang.
        await run_in_threadpool(session.app_state.set_config, config, str(save_path))
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
async def get_config(session: UserSession = Depends(get_session)):
    """Get the current config as JSON."""
    if not session.app_state.has_config():
        raise HTTPException(status_code=404, detail="No config loaded. Upload a config file first.")
    return {"config": config_to_dict(session.app_state.config)}


@router.post("/load")
async def load_config_json(body: dict, session: UserSession = Depends(get_session)):
    """Replace the current config with a full config dict (not a merge).

    The per-user saved-config library (/api/configs) stores a complete config;
    loading it must replace app_state wholesale. PUT deep-merges partial updates,
    which would leave stale keys behind when the saved config is a different
    injector type than the one currently loaded.
    """
    try:
        config = PintleEngineConfig(**body)
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=f"Config validation error: {e}")
    # Off the event loop: a cold CEA cache build here would block every other
    # request. See the note in upload_config.
    await run_in_threadpool(session.app_state.set_config, config, session.app_state.config_path)
    return {"status": "success", "config": config_to_dict(config)}


@router.get("/options")
async def get_switch_options(session: UserSession = Depends(get_session)):
    """Available injector types and propellant presets for the UI selectors (UNIFICATION P6)."""
    from engine.pipeline.config_switch import available_injectors, available_propellants
    current_injector = None
    current_propellant = None
    if session.app_state.has_config():
        current_injector = getattr(getattr(session.app_state.config, "injector", None), "type", None)
        current_propellant = getattr(session.app_state.config, "propellant_preset", None)
    return {
        "injectors": available_injectors(),
        "propellants": available_propellants(),
        "current": {"injector": current_injector, "propellant": current_propellant},
    }


@router.get("/injector_schema")
async def get_injector_schema(
    injector_type: str | None = None,
    session: UserSession = Depends(get_session),
):
    """Per-injector field schema for the UI to render the RIGHT controls (frozen params, geometry)
    instead of hardcoding pintle fields (INJECTOR_PARITY_PLAN W5). Defaults to the loaded config's type.
    """
    from engine.core.dispatch import (
        frozen_param_fields_for, INJECTOR_GEOMETRY_TEMPLATES, bindings_for,
    )
    t = injector_type
    if t is None and session.app_state.has_config():
        t = getattr(getattr(session.app_state.config, "injector", None), "type", None)
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
async def switch_config_endpoint(body: dict, session: UserSession = Depends(get_session)):
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
    if not session.app_state.has_config():
        raise HTTPException(status_code=404, detail="No config loaded. Upload a config file first.")
    from engine.pipeline.config_switch import switch_config, design_staleness
    try:
        current = config_to_dict(session.app_state.config)
        reconciled = switch_config(
            current,
            injector_type=body.get("injector_type"),
            propellant_preset=body.get("propellant_preset"),
        )
        new_config = PintleEngineConfig(**reconciled)
    except (ValidationError, ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=422, detail=f"Switch failed: {e}")

    # Update in-memory state only; preserve the original config_path WITHOUT writing to it.
    # Off the event loop: switching to a propellant whose CEA cache is not yet
    # built triggers a multi-minute synchronous build. See upload_config.
    await run_in_threadpool(session.app_state.set_config, new_config, session.app_state.config_path)

    from engine.core.dispatch import validate_config_bindings
    return {
        "status": "success",
        "config": config_to_dict(new_config),
        "binding_warnings": validate_config_bindings(new_config),
        "design_warning": design_staleness(new_config),
    }


@router.put("")
async def update_config(updates: dict, session: UserSession = Depends(get_session)):
    """Update the current config with partial updates.

    Accepts a nested dict of updates that will be merged with the current config.
    """
    if not session.app_state.has_config():
        raise HTTPException(status_code=404, detail="No config loaded. Upload a config file first.")

    try:
        # Get current config as dict
        current = config_to_dict(session.app_state.config)

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

        # In-memory only. Live edits used to be written back to config_path, but
        # that path is the shared, git-tracked configs/default.yaml -- one user's
        # edit would clobber it for everyone. Durable saves go through the
        # per-user library (POST /api/configs); this working copy stays in memory.
        # Off the event loop: see upload_config (cold CEA build would block).
        await run_in_threadpool(session.app_state.set_config, new_config, session.app_state.config_path)

        return {
            "status": "success",
            "message": "Config updated",
            "config": config_to_dict(new_config),
        }
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=f"Config validation error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update config: {e}")


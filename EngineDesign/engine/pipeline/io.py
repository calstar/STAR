"""Configuration loading and result saving"""

from __future__ import annotations

import yaml
from pathlib import Path
from typing import Any, Dict, Union
from .config_schemas import PintleEngineConfig


def load_config(config_path: Union[str, Path]) -> PintleEngineConfig:
    """
    Load pintle engine configuration from YAML file.
    
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
    
    # Validate and parse using Pydantic
    config = PintleEngineConfig(**data)
    
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

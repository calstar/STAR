"""Print the injector layout (engine/core/injectors/layout.py) for a config, as JSON.

    python3 scripts/injector_layout.py configs/ethalox_8kN_SHIP.yaml

Also regenerates the frontend's drawing fixture:

    python3 scripts/injector_layout.py configs/ethalox_8kN_SHIP.yaml \
        > frontend/src/components/__fixtures__/ship_layout.json
"""
import json
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.core.injectors.layout import layout_from_config  # noqa: E402

if __name__ == "__main__":
    with open(sys.argv[1]) as fh:
        print(json.dumps(layout_from_config(yaml.safe_load(fh)), indent=1, sort_keys=True))

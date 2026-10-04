"""Print the injector layout (engine/core/injectors/layout.py) for a config, as JSON.

    python3 scripts/injector_layout.py configs/ethalox_8kN_SHIP.yaml

The config is evaluated at its tank pressures (lox_tank / fuel_tank ``initial_pressure_psi``) and
the solve's flows go to the layout, so it also reports the channels' velocity head, the orifices'
cavitation margin and the plate's bending at the solved Pc. ``--no-flows`` skips the solve:
geometry only, with the plate checked at ``target_chamber_pressure_psi``.

Regenerate the frontend's drawing fixture (geometry only, so it does not move with the physics):

    python3 scripts/injector_layout.py --no-flows configs/ethalox_6500N.yaml \
        > frontend/src/components/__fixtures__/layout_6500N.json
"""
import copy
import json
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.core.injectors.layout import flows_from_result, layout_from_config  # noqa: E402

PSI = 6894.757


def solved_flows(path: str):
    """The flows of ``path`` evaluated at its tank pressures."""
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config
    c = load_config(path)
    r = PintleEngineRunner(copy.deepcopy(c)).evaluate(
        c.lox_tank.initial_pressure_psi * PSI, c.fuel_tank.initial_pressure_psi * PSI, silent=True)
    return flows_from_result(r, c)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--no-flows"]
    path = args[0]
    flows = None if "--no-flows" in sys.argv[1:] else solved_flows(path)
    with open(path) as fh:
        print(json.dumps(layout_from_config(yaml.safe_load(fh), flows=flows), indent=1, sort_keys=True))

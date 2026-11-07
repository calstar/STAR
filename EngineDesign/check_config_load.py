"""Check that engine config YAMLs load, and say what the loader thinks of them.

    python3 check_config_load.py configs/ethalox_6800N.yaml [more.yaml ...]

Each file goes through the app's own loader (engine.pipeline.io.load_config: propellant preset
merged, identity checked, schema validated), then the injector bindings check and the design
warning forward mode would show (stale chamber seed, fluids off their preset). Any injector type.
Exit status: 0 when every file loads, 1 when one does not, 2 on no arguments.

It used to read one hard-coded path on one laptop and check a pintle-only field.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))


def check(path: str) -> bool:
    from engine.core.dispatch import validate_config_bindings
    from engine.pipeline.config_switch import design_staleness
    from engine.pipeline.io import load_config

    try:
        config = load_config(path)
    except Exception as e:  # the loader's own message is the point
        print(f"FAIL  {path}: {type(e).__name__}: {e}")
        return False
    injector = getattr(getattr(config, "injector", None), "type", None)
    print(f"OK    {path}: injector {injector}, propellant {config.propellant_preset or 'custom'}")
    for w in validate_config_bindings(config):
        print(f"      binding: {w}")
    warning = design_staleness(config)
    if warning:
        print(f"      design: {warning}")
    return True


def main(argv: Optional[List[str]] = None) -> int:
    paths = sys.argv[1:] if argv is None else argv
    if not paths:
        print(__doc__.strip().splitlines()[2].strip())
        return 2
    results = [check(p) for p in paths]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())

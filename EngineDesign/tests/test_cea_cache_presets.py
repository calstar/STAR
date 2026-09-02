"""Every committed propellant preset must ship a matching CEA cache table.

This is the guard that would have caught kerolox shipping with no cache: the UI
exposes every configs/propellants/*.yaml preset, and switching to one whose
cache_file is missing falls through to a live rocketcea build -- minutes of
synchronous work that hangs the UI. Contributors regenerate caches by hand (see
.github/workflows/regenerate-cea-cache.yml), so nothing but this test stops a new
preset, a renamed cache_file, or a schema bump from silently losing its table.

Reads only (np.load + metadata compare) -- no rocketcea, so it runs in the CI
subset exactly like the rest of the gate.
"""

import json
import unittest
from pathlib import Path

import numpy as np
import yaml

from engine.pipeline.cea_cache import CEA_TABLE_SCHEMA_VERSION

ROOT = Path(__file__).resolve().parents[1]
PRESET_DIR = ROOT / "configs" / "propellants"


def _presets():
    return sorted(PRESET_DIR.glob("*.yaml"))


class TestCeaCachePresets(unittest.TestCase):
    def test_preset_dir_is_not_empty(self):
        # A glob that silently matches nothing would make every check below
        # vacuously pass, so assert we actually found presets to check.
        self.assertTrue(_presets(), f"no propellant presets under {PRESET_DIR}")

    def test_every_preset_has_a_matching_cache(self):
        for preset_path in _presets():
            with self.subTest(preset=preset_path.name):
                preset = yaml.safe_load(preset_path.read_text()) or {}
                cea = (preset.get("combustion") or {}).get("cea") or {}
                # A preset with no CEA identity (e.g. a hypothetical "custom")
                # owns no cache -- nothing to enforce.
                if not cea.get("cache_file"):
                    self.skipTest("preset declares no cea.cache_file")

                cache_path = ROOT / cea["cache_file"]
                self.assertTrue(
                    cache_path.exists(),
                    f"{preset_path.name} references {cea['cache_file']} which is "
                    f"not committed -- regenerate it (see regenerate-cea-cache.yml) "
                    f"and commit it, or a live rocketcea build will hang the UI.",
                )

                data = np.load(cache_path, allow_pickle=True)
                self.assertIn("meta", data.files, f"{cache_path.name} has no meta block")
                meta = json.loads(data["meta"].tolist())

                # Schema is the load-bearing one: a stale-schema table is served
                # under the wrong meaning until it is rebuilt.
                self.assertEqual(
                    meta.get("table_schema"), CEA_TABLE_SCHEMA_VERSION,
                    f"{cache_path.name} table_schema={meta.get('table_schema')} "
                    f"but code expects v{CEA_TABLE_SCHEMA_VERSION}",
                )
                # Identity: the cache must be for the propellant the preset names.
                self.assertEqual(meta.get("ox_name"), cea.get("ox_name"), cache_path.name)
                self.assertEqual(meta.get("fuel_name"), cea.get("fuel_name"), cache_path.name)
                self.assertEqual(meta.get("dimensions"), 3, cache_path.name)
                self.assertEqual(meta.get("n_points"), cea.get("n_points"), cache_path.name)
                # Grid extents: an off-grid cache silently extrapolates.
                for key in ("Pc_range", "MR_range", "eps_range"):
                    self.assertEqual(
                        [float(x) for x in (meta.get(key) or [])],
                        [float(x) for x in (cea.get(key) or [])],
                        f"{cache_path.name}: {key} mismatch",
                    )


if __name__ == "__main__":
    unittest.main()

"""A missing/stale CEA cache must FAIL FAST where in-process builds are disabled.

Root cause of a production crash: switching to a propellant whose cache was not
committed (kerolox) made a request handler start a cold CEA build -- ~n_points^3
rocketcea calls whose growing in-process cache took the host to >12 GB. Builds
are an offline job (regenerate-cea-cache.yml); the deployed server disables them
by setting ED_ALLOW_CEA_BUILD=0 (docker-compose.yml) and must instead raise
immediately on a missing cache.

The gate is environment-based (env var), not code-path based, because local dev
runs the same backend over localhost and must keep building on demand. These
tests pin both directions.
"""

import os
import unittest
from pathlib import Path

from engine.pipeline.io import load_config
from engine.pipeline.config_switch import switch_config
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.pipeline import cea_cache
from engine.pipeline.cea_cache import CEACache

ROOT = Path(__file__).resolve().parents[1]
BOGUS_CACHE = "/tmp/__ed_gate_test_should_never_be_written.npz"


class TestCeaBuildGate(unittest.TestCase):
    def setUp(self):
        # A kerolox CEA identity pointed at a cache path that does not exist, so
        # any construction would otherwise fall through to a cold build.
        base = load_config(str(ROOT / "configs" / "default.yaml")).model_dump(mode="json")
        kero = switch_config(base, propellant_preset="kerolox")
        kero["combustion"]["cea"]["cache_file"] = BOGUS_CACHE
        self.cea_cfg = PintleEngineConfig(**kero).combustion.cea
        self._saved_env = os.environ.get("ED_ALLOW_CEA_BUILD")
        Path(BOGUS_CACHE).unlink(missing_ok=True)

    def tearDown(self):
        if self._saved_env is None:
            os.environ.pop("ED_ALLOW_CEA_BUILD", None)
        else:
            os.environ["ED_ALLOW_CEA_BUILD"] = self._saved_env
        Path(BOGUS_CACHE).unlink(missing_ok=True)

    def test_build_gate_reads_env(self):
        # Default (unset) allows building; the server's "0" disallows it; an
        # explicit "1" re-enables (the escape hatch).
        os.environ.pop("ED_ALLOW_CEA_BUILD", None)
        self.assertTrue(cea_cache._cea_build_allowed())
        os.environ["ED_ALLOW_CEA_BUILD"] = "0"
        self.assertFalse(cea_cache._cea_build_allowed())
        os.environ["ED_ALLOW_CEA_BUILD"] = "1"
        self.assertTrue(cea_cache._cea_build_allowed())

    def test_missing_cache_fails_fast_when_builds_disabled(self):
        # Production posture: builds off. A missing cache must raise immediately
        # (not spend hours building and blow up memory), and write nothing.
        os.environ["ED_ALLOW_CEA_BUILD"] = "0"
        with self.assertRaises(RuntimeError) as ctx:
            CEACache(self.cea_cfg)
        msg = str(ctx.exception)
        self.assertIn("RP-1", msg)
        self.assertIn("ED_ALLOW_CEA_BUILD", msg)
        self.assertFalse(
            Path(BOGUS_CACHE).exists(),
            "a disabled build must not write a cache file",
        )


if __name__ == "__main__":
    unittest.main()

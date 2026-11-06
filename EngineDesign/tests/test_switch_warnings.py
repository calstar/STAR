"""POST /api/config/switch says "needs re-optimization" only when the chamber is a seed.

The selector shows ``design_warning`` as "needs re-optimization" (ConfigurationSelector.tsx; the
SwitchResponse contract: null after a clean injector swap, canonical configs being coherent).
3c04b16b folded the fluid-preset drift into design_staleness, so a clean swap to pintle -- whose
canonical config carries the old LOX block -- read "needs re-optimization" for a chamber that is
the right one. The drift now comes back on its own, as ``fluid_warning``.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from starlette.requests import Request

from backend.routers import config as config_router
from backend.session import get_session
from engine.pipeline.io import load_config

REPO = Path(__file__).resolve().parents[1]


def _switch(email: str, start: str, **body) -> dict:
    request = Request({"type": "http", "method": "POST", "path": "/", "query_string": b"",
                       "headers": [(b"x-auth-email", email.encode())]})

    async def main():
        session = get_session(request)
        session.app_state.set_config(load_config(str(REPO / "configs" / start)))
        return await config_router.switch_config_endpoint(body, session=session)

    return asyncio.run(main())


def test_a_clean_injector_swap_is_not_a_seed_but_its_stale_fluids_are_said():
    # ethalox_doublet_7000N carries the preset's LOX; canonical/pintle.yaml the old block
    out = _switch("switch-warn-inj@berkeley.edu", "ethalox_doublet_7000N.yaml", injector_type="pintle")
    assert out["config"]["injector"]["type"] == "pintle"
    assert out["design_warning"] is None, out["design_warning"]
    assert "ethalox preset" in (out["fluid_warning"] or ""), out["fluid_warning"]
    assert "specific_heat 2300 (preset 1700)" in out["fluid_warning"]


def test_a_propellant_overlay_is_a_seed_and_only_that():
    out = _switch("switch-warn-prop@berkeley.edu", "default.yaml", propellant_preset="ethalox")
    assert "methalox -> ethalox" in (out["design_warning"] or "")
    assert "Fluid properties" not in out["design_warning"]
    assert out["fluid_warning"] is None, out["fluid_warning"]

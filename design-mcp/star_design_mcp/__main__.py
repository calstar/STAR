"""``python -m star_design_mcp`` -- serve on DESIGN_MCP_PORT (default 8010)."""

from __future__ import annotations

import logging
import os
import sys

import uvicorn

from . import settings as settings_mod
from .server import build


def main() -> int:
    logging.basicConfig(level=os.environ.get("DESIGN_MCP_LOG_LEVEL", "INFO"), format="%(asctime)s %(name)s %(message)s")
    try:
        settings = settings_mod.load()
    except settings_mod.SettingsError as exc:
        print(f"design-mcp: refusing to start: {exc}", file=sys.stderr)
        return 2
    app = build(settings)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("DESIGN_MCP_PORT", "8010")), proxy_headers=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

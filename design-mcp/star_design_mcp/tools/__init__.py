"""The tools, one module per app, each registering onto the server with ``register``.

Every tool is read-only toward the apps: it reads designs, runs and results, and
may *compute* (export a file, run a simulation) but never saves, shares or deletes
anything in an app. Writing is a later decision, not an accident of a pass-through.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from mcp.server.mcpserver.utilities.types import Image
from mcp.types import ToolAnnotations

from .. import identity
from ..apps import Apps
from ..files import FileStore, StoredFile
from ..jobs import Jobs
from ..plots import render
from ..settings import Settings
from ..tables import TIME, Tables

#: Reads an app; changes nothing anywhere.
READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
#: Computes on the server (an export, a simulation) and caches the result; still
#: changes nothing in any app.
COMPUTE = ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False)


@dataclass
class Ctx:
    settings: Settings
    apps: Apps
    files: FileStore
    tables: Tables
    jobs: Jobs

    def link(self, stored: StoredFile) -> dict[str, Any]:
        return self.files.link(stored, identity.current().email)

    def plot(self, table_id: str, signals: list[str], t0: float | None, t1: float | None, title: str) -> list[Any]:
        table, meta = self.tables.window(table_id, signals, t0, t1)
        t = table.columns[TIME]
        png = render(
            [(n, table.units.get(n, ""), t, table.columns[n]) for n in signals],
            title=title or str(meta["source"].get("label") or table_id),
        )
        return [Image(data=png, format="png"), {"table_id": table_id, "signals": signals, "window_s": [t0, t1]}]


def register_all(server, ctx: Ctx) -> None:
    from . import daq, documents, feedtwin, layerx, meta, openrocket, tables

    for module in (meta, tables, documents, daq, layerx, openrocket, feedtwin):
        module.register(server, ctx)

"""Generic questions of a result table (see tables.py for what a table is)."""

from __future__ import annotations

from typing import Any

from . import COMPUTE, READ, Ctx

MAX_POINTS = 2000


def register(server, ctx: Ctx) -> None:
    @server.tool(annotations=READ, structured_output=False)
    async def table_signals(table_id: str, match: str | None = None) -> dict[str, Any]:
        """A table's signals (name, unit, min, max), optionally only those whose name contains `match`."""
        return ctx.tables.signals(table_id, match)

    @server.tool(annotations=READ, structured_output=False)
    async def table_series(
        table_id: str,
        signals: list[str],
        t0: float | None = None,
        t1: float | None = None,
        max_points: int = 400,
    ) -> dict[str, Any]:
        """Chosen signals of a table between t0 and t1 seconds, downsampled to about max_points in total
        (min/max per bucket, so peaks survive), with min/max/mean over every row in the window."""
        return ctx.tables.series(table_id, signals, t0, t1, max(16, min(max_points, MAX_POINTS)))

    @server.tool(annotations=READ, structured_output=False)
    async def table_plot(
        table_id: str,
        signals: list[str],
        t0: float | None = None,
        t1: float | None = None,
        title: str = "",
    ) -> list[Any]:
        """Draw chosen signals of a table against time as a PNG (one panel per unit, up to 4)."""
        return ctx.plot(table_id, signals, t0, t1, title)

    @server.tool(annotations=COMPUTE, structured_output=False)
    async def table_export(table_id: str, fmt: str = "parquet") -> dict[str, Any]:
        """The whole table as a short-lived download link: fmt 'parquet' (typed, small) or 'csv'
        ('name [unit]' headers)."""
        return ctx.link(ctx.tables.export(table_id, fmt))

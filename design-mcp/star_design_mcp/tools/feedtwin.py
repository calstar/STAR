"""feed-twin: the cockpit's run records (feed-twin/backend/runs.py).

Every burn the cockpit fires is recorded at burnout -- inputs, code version, stand
version, outcome, solver summary -- and these tools read those records and diff
two of them. ``feedtwin_explain_runs`` (re-running both burns to attribute the
change) is not exposed: it is a heavy, single-slot job on the shared twin.
"""

from __future__ import annotations

from typing import Any

from ..data import compact
from . import READ, Ctx


def register(server, ctx: Ctx) -> None:
    @server.tool(annotations=READ, structured_output=False)
    async def feedtwin_list_runs(stand: str | None = None, owner: str | None = None, limit: int = 30) -> dict[str, Any]:
        """Recorded cockpit burns, newest first: yours, or one stand's (with its owner, as the app's run
        list shows them). Each row is a summary; feedtwin_get_run has the full record."""
        rows = await ctx.apps.get_json("feed-twin", "/api/twin/runs", stand=stand, owner=owner)
        rows = rows if isinstance(rows, list) else []
        limit = max(1, min(limit, 200))
        return {"total": len(rows), "runs": compact(rows[:limit], max_list=200)}

    @server.tool(annotations=READ, structured_output=False)
    async def feedtwin_get_run(run_id: str, owner: str | None = None) -> Any:
        """One run record: inputs, code and stand version, outcome, solver summary. Long arrays are
        summarized."""
        return compact(await ctx.apps.get_json("feed-twin", f"/api/twin/runs/{run_id}", owner=owner), max_list=40)

    @server.tool(annotations=READ, structured_output=False)
    async def feedtwin_diff_runs(a: str, b: str, owner_a: str | None = None, owner_b: str | None = None) -> Any:
        """What differs between two runs: every changed input, the code, and the outcome, with deltas.
        Not which input caused the change."""
        return compact(
            await ctx.apps.get_json("feed-twin", "/api/twin/runs/diff", a=a, b=b, owner_a=owner_a, owner_b=owner_b),
            max_list=60,
        )

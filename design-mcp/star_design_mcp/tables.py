"""Results as tables an agent can query without downloading.

A source tool (a Layer X burn, a flight simulation) turns its result into a
*table*: one time column ``t`` plus named signals, each with a unit. The table is
stored once as parquet in the file store, under an id bound to the person it was
made for, and the generic tools ask questions of it:

- ``table_series`` -- chosen signals over a time window, downsampled;
- ``table_plot``   -- the same, drawn as a PNG;
- ``table_export`` -- the whole table as a CSV or parquet link.

Ids are deterministic (person + source), so asking for the same run twice reuses
the table rather than rebuilding it.
"""

from __future__ import annotations

import io
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq
from mcp.server.mcpserver.exceptions import ToolError

from . import identity
from .data import as_list, downsample, stats
from .files import FileStore, StoredFile

TIME = "t"
_HEADER = re.compile(r"^(?P<name>.*) \[(?P<unit>[^\]]*)\]$")


@dataclass
class Table:
    columns: dict[str, np.ndarray]
    units: dict[str, str]

    def __post_init__(self) -> None:
        if TIME not in self.columns:
            raise ValueError("a table needs a time column 't'")
        n = len(self.columns[TIME])
        for name, col in self.columns.items():
            if len(col) != n:
                raise ValueError(f"column {name!r} has {len(col)} rows, t has {n}")


def from_unit_csv(text: str) -> Table:
    """Read a ``name [unit]`` headed CSV (Layer X's export, engine/layerx/export.py)."""
    reader = pacsv.read_csv(io.BytesIO(text.encode()), read_options=pacsv.ReadOptions(autogenerate_column_names=False))
    columns: dict[str, np.ndarray] = {}
    units: dict[str, str] = {}
    for head in reader.column_names:
        m = _HEADER.match(head)
        name, unit = (m.group("name"), m.group("unit")) if m else (head, "")
        col = reader.column(head)
        try:
            values = col.cast(pa.float64()).to_numpy(zero_copy_only=False)
        except (pa.ArrowInvalid, pa.ArrowNotImplementedError):
            continue  # a text column; not a signal
        columns[name] = np.asarray(values, dtype=float)
        units[name] = unit
    return Table(columns=columns, units=units)


def from_records(records: list[dict[str, Any]], units: dict[str, str], time_key: str = TIME) -> Table:
    """Rows of ``{t: ..., signal: ...}`` (a flight simulation's samples)."""
    if not records:
        raise ValueError("no samples")
    names = [k for k in records[0] if isinstance(records[0][k], (int, float, type(None))) and k != time_key]
    columns = {TIME: np.asarray([float(r[time_key]) for r in records])}
    for name in names:
        columns[name] = np.asarray([np.nan if r.get(name) is None else float(r[name]) for r in records], dtype=float)
    return Table(columns=columns, units={TIME: "s", **{n: units.get(n, "") for n in names}})


class Tables:
    def __init__(self, files: FileStore) -> None:
        self._files = files
        self._dir = files.root / "tables"
        self._dir.mkdir(parents=True, exist_ok=True)

    def table_id(self, *source: Any) -> str:
        return "tbl_" + FileStore.memo_key(identity.current().email, "table", *source)[:24]

    def known(self, table_id: str) -> dict[str, Any] | None:
        meta = self._read_meta(table_id)
        if meta is None or meta["owner"] != identity.current().email:
            return None
        if self._files.path_of(StoredFile(**meta["file"])) is None:
            return None
        return self.describe(meta)

    def save(self, table_id: str, table: Table, *, source: dict[str, Any], filename: str) -> dict[str, Any]:
        fields = [pa.field(name, pa.float64(), metadata={"unit": table.units.get(name, "")}) for name in table.columns]
        arrow = pa.Table.from_arrays([pa.array(v) for v in table.columns.values()], schema=pa.schema(fields))
        buf = io.BytesIO()
        pq.write_table(arrow, buf, compression="zstd")
        stored = self._files.put_bytes(buf.getvalue(), filename, "application/vnd.apache.parquet")
        t = table.columns[TIME]
        signals = []
        for name, col in table.columns.items():
            if name == TIME:
                continue
            s = stats(col)
            signals.append({"name": name, "unit": table.units.get(name, ""), "min": s.get("min"), "max": s.get("max")})
        meta = {
            "id": table_id,
            "owner": identity.current().email,
            "source": source,
            "file": stored.__dict__,
            "rows": int(len(t)),
            "t_range": [float(np.nanmin(t)), float(np.nanmax(t))] if len(t) else None,
            "signals": signals,
        }
        (self._dir / f"{table_id}.json").write_text(json.dumps(meta))
        return self.describe(meta)

    @staticmethod
    def describe(meta: dict[str, Any], *, limit: int = 400) -> dict[str, Any]:
        signals = meta["signals"]
        out = {
            "table_id": meta["id"],
            "source": meta["source"],
            "rows": meta["rows"],
            "t_range_s": meta["t_range"],
            "signal_count": len(signals),
            # name, unit, min, max: enough to pick what to plot without fetching any.
            "signals": [[s["name"], s["unit"], s["min"], s["max"]] for s in signals[:limit]],
            "use": "table_series / table_plot with signal names from this list; table_export for the whole table.",
        }
        if len(signals) > limit:
            out["signals_truncated"] = f"{len(signals) - limit} more; pass match= to table_signals to search them."
        return out

    def _read_meta(self, table_id: str) -> dict[str, Any] | None:
        if not re.fullmatch(r"tbl_[0-9a-f]{24}", table_id):
            return None
        try:
            return json.loads((self._dir / f"{table_id}.json").read_text())
        except (OSError, ValueError):
            return None

    def _require(self, table_id: str) -> dict[str, Any]:
        meta = self._read_meta(table_id)
        # Someone else's table answers exactly like a missing one.
        if meta is None or meta["owner"] != identity.current().email:
            raise ToolError(f"No table {table_id!r}. Tables come from the source tools (e.g. layerx_run_table).")
        return meta

    def stored_file(self, table_id: str) -> StoredFile:
        meta = self._require(table_id)
        stored = StoredFile(**meta["file"])
        if self._files.path_of(stored) is None:
            raise ToolError(f"Table {table_id} has been evicted from the cache; call its source tool again.")
        return stored

    def signals(self, table_id: str, match: str | None) -> dict[str, Any]:
        meta = self._require(table_id)
        sigs = meta["signals"]
        if match:
            needle = match.lower()
            sigs = [s for s in sigs if needle in s["name"].lower()]
        return {**self.describe({**meta, "signals": sigs}), "matched": len(sigs)}

    def load(self, table_id: str, names: list[str]) -> tuple[Table, dict[str, Any]]:
        meta = self._require(table_id)
        stored = self.stored_file(table_id)
        path: Path | None = self._files.path_of(stored)
        assert path is not None
        have = {s["name"] for s in meta["signals"]}
        missing = [n for n in names if n not in have]
        if missing:
            close = [s["name"] for s in meta["signals"] if any(m.lower() in s["name"].lower() for m in missing)][:10]
            raise ToolError(f"No signal(s) {missing} in {table_id}." + (f" Close: {close}" if close else ""))
        arrow = pq.read_table(path, columns=[TIME, *names])
        cols = {name: arrow.column(name).to_numpy(zero_copy_only=False).astype(float) for name in arrow.column_names}
        units = {f.name: (f.metadata or {}).get(b"unit", b"").decode() for f in arrow.schema}
        return Table(columns=cols, units=units), meta

    def series(
        self, table_id: str, names: list[str], t0: float | None, t1: float | None, max_points: int
    ) -> dict[str, Any]:
        table, meta = self.window(table_id, names, t0, t1)
        t = table.columns[TIME]
        out = []
        per = max(8, max_points // max(1, len(names)))
        for name in names:
            y = table.columns[name]
            ts, ys = downsample(t, y, per)
            out.append(
                {"name": name, "unit": table.units.get(name, ""), **stats(y), "t": as_list(ts), "y": as_list(ys)}
            )
        return {
            "table_id": table_id,
            "window_s": [t0, t1],
            "rows_in_window": int(len(t)),
            "series": out,
            "downsampling": "min/max per bucket: peaks are kept; stats are over every row in the window.",
        }

    def window(self, table_id: str, names: list[str], t0: float | None, t1: float | None) -> tuple[Table, dict]:
        if not names:
            raise ToolError("Name at least one signal.")
        table, meta = self.load(table_id, names)
        t = table.columns[TIME]
        mask = np.ones(len(t), dtype=bool)
        if t0 is not None:
            mask &= t >= t0
        if t1 is not None:
            mask &= t <= t1
        cols = {k: v[mask] for k, v in table.columns.items()}
        return Table(columns=cols, units=table.units), meta

    def export(self, table_id: str, fmt: str) -> StoredFile:
        stored = self.stored_file(table_id)
        if fmt == "parquet":
            return stored
        if fmt != "csv":
            raise ToolError("fmt is csv or parquet.")
        key = FileStore.memo_key(identity.current().email, "table-csv", stored.sha256)
        hit = self._files.memo_get(key)
        if hit:
            return hit
        path = self._files.path_of(stored)
        assert path is not None
        arrow = pq.read_table(path)
        renamed = arrow.rename_columns(
            [f"{f.name} [{(f.metadata or {}).get(b'unit', b'').decode()}]" for f in arrow.schema]
        )
        f, tmp = self._files.new_temp()
        with f:
            pacsv.write_csv(renamed, f)
        out = self._files.adopt(tmp, stored.filename.rsplit(".", 1)[0] + ".csv", "text/csv")
        self._files.memo_put(key, out)
        return out

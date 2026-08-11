"""Offline motor database: reads (and writes) the thrustcurve.org mirror.

Layout under ``cache/motors/`` (sibling of the per-model dirs and ``browse.json``):

* ``index.json``           -- lightweight, searchable metadata for every motor, plus each
  motor's available simfiles tagged ``{simfileId, format, quality}``.
* ``data/<motorId>.json``  -- the parsed thrust/mass/CG arrays per simfile.

Runtime is fully offline (like ``GeometryStore``): the API endpoints and the stability
computation read this, never the network. Only ``fetch.py`` populates it.
"""

from __future__ import annotations

import json
from pathlib import Path

from .motor import Motor

# Motor dataclass fields persisted per simfile (order-independent).
_MOTOR_FIELDS = (
    "manufacturer", "designation", "diameter", "length", "delays", "motor_type",
    "time", "thrust", "cg_x", "mass", "digest", "quality", "file_format", "comment",
    "common_name", "impulse_class", "motor_id", "simfile_id",
)


def motor_to_dict(motor: Motor) -> dict:
    return {f: getattr(motor, f) for f in _MOTOR_FIELDS}


def motor_from_dict(data: dict) -> Motor:
    return Motor(**{f: data[f] for f in _MOTOR_FIELDS if f in data})


class MotorDB:
    """Cache-backed motor catalog. Index is loaded once; arrays are loaded on demand."""

    def __init__(self, motors_dir: Path) -> None:
        self.dir = motors_dir
        self._index: dict | None = None

    @property
    def index_path(self) -> Path:
        return self.dir / "index.json"

    def _data_path(self, motor_id: str) -> Path:
        return self.dir / "data" / f"{motor_id}.json"

    def exists(self) -> bool:
        return self.index_path.exists()

    def _load_index(self) -> dict:
        if self._index is None:
            if not self.exists():
                self._index = {"motors": []}
            else:
                self._index = json.loads(self.index_path.read_text())
        return self._index

    @property
    def fetched_at(self) -> str | None:
        return self._load_index().get("fetchedAt")

    def all_meta(self) -> list[dict]:
        return self._load_index().get("motors", [])

    def search(self, query: str = "", limit: int = 50) -> list[dict]:
        """Substring match over manufacturer / designation / common name / impulse class."""
        motors = self.all_meta()
        q = query.strip().lower()
        if not q:
            hits = motors
        else:
            terms = q.split()

            def matches(m: dict) -> bool:
                hay = " ".join(
                    str(m.get(k, ""))
                    for k in ("manufacturer", "manufacturerAbbrev", "designation",
                              "commonName", "impulseClass")
                ).lower()
                return all(t in hay for t in terms)

            hits = [m for m in motors if matches(m)]
        return hits[:limit]

    def get_meta(self, motor_id: str) -> dict | None:
        for m in self.all_meta():
            if m.get("motorId") == motor_id:
                return m
        return None

    def get_simfiles(self, motor_id: str) -> list[Motor]:
        path = self._data_path(motor_id)
        if not path.exists():
            return []
        data = json.loads(path.read_text())
        return [motor_from_dict(s) for s in data.get("simfiles", [])]

    def get_motor(self, motor_id: str, simfile_id: str | None = None) -> Motor | None:
        """Resolve one simfile. Default preference: an exact simfile id, else a RockSim
        ("Full model") file, else the first available.

        The Full/Basic distinction the UI shows is by file format (RockSim vs RASP): the
        thrustcurve.org API serves both with mid-casing CG, so the internal ``quality``
        flag rarely differs -- format is what the user actually chooses between.
        """
        simfiles = self.get_simfiles(motor_id)
        if not simfiles:
            return None
        if simfile_id is not None:
            for s in simfiles:
                if s.simfile_id == simfile_id:
                    return s
            return None
        rocksim = [s for s in simfiles if s.file_format == "RockSim"]
        return rocksim[0] if rocksim else simfiles[0]

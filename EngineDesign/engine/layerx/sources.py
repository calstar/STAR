"""Where Layer X's drawings, state machines and combustion tables come from.

A drawing is the hardware record (ADR-0002): topology, line geometry, tank and
bottle volumes, the regulator. Layer X never edits one. It reads drawings from
three places and treats them identically once read, because what identifies a
drawing is its **bytes**:

* the feed-twin set shipped in ``feed-twin/backend/diagrams`` (the stand and the
  two COPV-study drawings);
* drawings uploaded to Layer X, kept per user;
* pid-designer documents, pulled by the router (it owns the HTTP) and stored
  here like an upload, with where they came from recorded.

Every record carries the sha256 of its bytes. A run quotes it, so "which drawing
was this" is answerable without trusting a name.
"""

from __future__ import annotations

import hashlib
import json
import re
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

_ENGINE_ROOT = Path(__file__).resolve().parents[2]
_STAR_ROOT = _ENGINE_ROOT.parent


def feedtwin_root() -> Path:
    """The feed-twin app checkout, whose shipped drawings and DAQ tables Layer X reads."""
    return Path(os.environ.get("FEEDTWIN_ROOT") or (_STAR_ROOT / "feed-twin"))


def shipped_drawings_dir() -> Path:
    return Path(os.environ.get("LAYERX_DRAWINGS") or (feedtwin_root() / "backend" / "diagrams"))


def feedtwin_library_dir() -> Path:
    """The feed twin's own library: every drawing its cockpit can open (the shipped ones and what it
    pulled from pid-designer), as ``manifest.json`` plus ``blobs/``."""
    return Path(os.environ.get("LAYERX_FEEDTWIN_LIBRARY") or (feedtwin_root() / "backend" / "library"))


def machines_dir() -> Path:
    """The DAQ's state-machine tables, as feed-twin ships them (see NEEDS-REPAIR.md there)."""
    return Path(os.environ.get("LAYERX_STATEMACHINES") or (feedtwin_root() / "backend" / "statemachines"))


def cea_table_path(config: Any) -> Optional[Path]:
    """The engine's own CEA cache, resolved the way EngineDesign's CEACache resolves it."""
    try:
        name = config.combustion.cea.cache_file
    except AttributeError:
        return None
    if not name:
        return None
    path = Path(name)
    candidates = [path] if path.is_absolute() else [Path.cwd() / path, _ENGINE_ROOT / path]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


# ------------------------------------------------------------------ drawings


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def drawing_id(data: bytes) -> str:
    """Short content address. Sixteen hex characters: a collision needs ~2^32 drawings."""
    return sha256(data)[:16]


def normalise(payload: Mapping[str, Any]) -> bytes:
    """A pid-designer document reduced to what feed-twin reads, as stable bytes."""
    return json.dumps(
        {"nodes": payload.get("nodes") or [], "edges": payload.get("edges") or []},
        indent=1,
    ).encode("utf-8")


def summarize(payload: Mapping[str, Any], name: str = "") -> Dict[str, Any]:
    """What a person choosing a drawing needs to see, without building a network.

    Read through feedtwin's own reader so a drawing it cannot read says so here,
    not halfway into a run.
    """
    from feedtwin.pid import DiagramError, read_diagram

    try:
        diagram = read_diagram(payload, name=name or "drawing")
    except DiagramError as exc:
        return {"readable": False, "error": str(exc)}

    def param(node: Any, key: str, unit: str) -> Optional[float]:
        p = node.params.get(key)
        if p is None:
            return None
        try:
            return float(p.si if unit == "si" else p.value)
        except Exception:  # noqa: BLE001 - a summary never fails a listing
            return None

    tanks, bottles, regulators, engines, valves = [], [], [], [], []
    for node in diagram.nodes:
        if node.type == "TANK":
            volume = node.params.get("volume")
            tanks.append({
                "id": node.id, "label": node.label, "fluid": node.fluid,
                "volume_L": (volume.si * 1e3) if volume is not None else None,
                "mawp_psi": param(node, "MAWP", "value"),
            })
        elif node.type == "KBOTTLE":
            volume = node.params.get("volume")
            bottles.append({
                "id": node.id, "label": node.label, "fluid": node.fluid,
                "volume_L": (volume.si * 1e3) if volume is not None else None,
                "pressure_psi": param(node, "pressure", "value"),
                "mawp_psi": param(node, "MAWP", "value"),
            })
        elif node.type == "PR":
            regulators.append({
                "id": node.id, "label": node.label,
                "dome_loaded": node.options.get("domeLoaded") == "yes",
                "setpoint_psi": param(node, "setpoint", "value"),
                "dome_bias_psi": param(node, "dome_bias", "value"),
                "supply_coefficient": param(node, "supply_coefficient", "value"),
                "flow_droop_psi": param(node, "flow_droop", "value"),
            })
        elif node.type in ("ENGINE", "INJECTOR"):
            engines.append({"id": node.id, "label": node.label})
        elif node.is_inline and node.type in ("SOL", "MAN", "ROT", "MOV", "BV", "AV"):
            valves.append({"id": node.id, "label": node.label, "type": node.type})
    return {
        "readable": True,
        "symbols": len(diagram.nodes),
        "lines": len(diagram.edges),
        "tanks": tanks,
        "bottles": bottles,
        "regulators": regulators,
        "engines": engines,
        "valves": len(valves),
    }


@dataclass
class Drawing:
    """One drawing, read and addressed by content."""

    id: str
    name: str
    source: str
    """``shipped:<file>``, ``upload``, or ``pid-designer:<owner>/<id>@<release|working copy>``."""
    sha256: str
    payload: Dict[str, Any] = field(repr=False)
    added: float = 0.0

    def summary(self) -> Dict[str, Any]:
        return summarize(self.payload, self.name)

    def listing(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "source": self.source,
            "sha256": self.sha256,
            "added": self.added,
            "summary": self.summary(),
        }


def _read(path: Path) -> Optional[bytes]:
    try:
        return path.read_bytes()
    except OSError:
        return None


#: Shipped drawings, by (path, mtime, size): parsed and hashed once per version.
_SHIPPED_CACHE: Dict[Any, Any] = {}


class DrawingStore:
    """The shipped set plus one user's own drawings.

    Uploads and pulls live in ``<user dir>/layerx/drawings`` as ``<id>.json`` with
    a ``<id>.meta.json`` beside them. Shipped drawings are read in place and
    never copied.
    """

    def __init__(self, user_dir: Optional[Path]) -> None:
        self.dir = (user_dir / "layerx" / "drawings") if user_dir is not None else None

    def _shipped(self) -> List[Drawing]:
        out: List[Drawing] = []
        base = shipped_drawings_dir()
        if not base.is_dir():
            return out
        for path in sorted(base.glob("*.json")):
            try:
                st = path.stat()
            except OSError:
                continue
            # Read, parsed and hashed once per file version, not on every lookup.
            stamp = (str(path), st.st_mtime_ns, st.st_size)
            hit = _SHIPPED_CACHE.get(stamp)
            if hit is None:
                raw = _read(path)
                if raw is None:
                    continue
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                hit = Drawing(id=drawing_id(raw), name=path.stem, source=f"shipped:{path.name}",
                              sha256=sha256(raw), payload=payload, added=st.st_mtime)
                _SHIPPED_CACHE[stamp] = hit
            out.append(hit)
        return out

    def _feedtwin_library(self) -> List[Drawing]:
        """The drawings in the feed twin's library, read in place: Layer X burns the feed system
        the twin holds (2026-10-03, "pull from it and trust it"), including what the twin pulled
        from pid-designer, not only the files feed-twin ships."""
        out: List[Drawing] = []
        base = feedtwin_library_dir()
        manifest_path = base / "manifest.json"
        try:
            st = manifest_path.stat()
        except OSError:
            return out
        stamp = (str(manifest_path), st.st_mtime_ns, st.st_size)
        hit = _SHIPPED_CACHE.get(stamp)
        if hit is not None:
            return list(hit)
        try:
            manifest = json.loads(manifest_path.read_text("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return out
        for entry in manifest if isinstance(manifest, list) else []:
            if not isinstance(entry, Mapping) or entry.get("kind") != "diagram" or not entry.get("filename"):
                continue
            raw = _read(base / "blobs" / str(entry["filename"]))
            if raw is None:
                continue
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not summarize(payload, str(entry.get("name") or "")).get("readable"):
                continue
            imported = str(entry.get("imported_at") or "")
            out.append(Drawing(id=drawing_id(raw), name=str(entry.get("name") or entry["filename"]),
                               source=f"feed-twin library: {entry.get('source') or 'library'}",
                               sha256=sha256(raw), payload=payload,
                               added=time.mktime(time.strptime(imported[:19], "%Y-%m-%dT%H:%M:%S")) if imported else 0.0))
        _SHIPPED_CACHE[stamp] = tuple(out)
        return out

    def _own_one(self, path: Path) -> List[Drawing]:
        raw = _read(path)
        if raw is None:
            return []
        meta: Dict[str, Any] = {}
        meta_raw = _read(path.with_suffix(".meta.json"))
        if meta_raw:
            try:
                meta = json.loads(meta_raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                meta = {}
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return []
        return [Drawing(
            id=drawing_id(raw), name=str(meta.get("name") or path.stem),
            source=str(meta.get("source") or "upload"), sha256=sha256(raw),
            payload=payload, added=float(meta.get("added") or path.stat().st_mtime),
        )]

    def _own(self) -> List[Drawing]:
        out: List[Drawing] = []
        if self.dir is None or not self.dir.is_dir():
            return out
        for path in sorted(self.dir.glob("*.json")):
            if path.name.endswith(".meta.json"):
                continue
            out.extend(self._own_one(path))
        return out

    def list(self) -> List[Drawing]:
        seen: Dict[str, Drawing] = {}
        # The same bytes are one drawing, under the first name met: the shipped file, then the
        # feed twin's library copy, then this user's own.
        for drawing in self._shipped() + self._feedtwin_library() + self._own():
            seen.setdefault(drawing.id, drawing)
        out = list(seen.values())
        # Two versions under one name (an older study, a re-import from pid-designer) are told apart
        # by when they arrived; the first of a name keeps it plain.
        from collections import Counter
        from dataclasses import replace

        count = Counter(d.name for d in out)
        named: Dict[str, int] = {}
        for k, d in enumerate(out):
            if count[d.name] > 1:
                named[d.name] = named.get(d.name, 0) + 1
                if named[d.name] > 1 and d.added:
                    out[k] = replace(d, name=f"{d.name} ({time.strftime('%b %d %H:%M', time.localtime(d.added))})")
        return out

    def get(self, drawing_id_: str) -> Optional[Drawing]:
        # An upload is stored under its id: open that one file rather than read every drawing.
        if self.dir is not None and re.fullmatch(r"[0-9a-zA-Z_-]{1,80}", drawing_id_ or ""):
            path = self.dir / f"{drawing_id_}.json"
            if path.is_file():
                for drawing in self._own_one(path):
                    if drawing.id == drawing_id_:
                        return drawing
        for drawing in self._shipped() + self._feedtwin_library():
            if drawing.id == drawing_id_:
                return drawing
        for drawing in self._own():
            if drawing.id == drawing_id_:
                return drawing
        return None

    def add(self, payload: Mapping[str, Any], *, name: str, source: str) -> Drawing:
        """Store a drawing. Same bytes, same id: adding twice is a no-op that
        updates nothing but the name a person sees."""
        if self.dir is None:
            raise RuntimeError("no user directory to store drawings in")
        raw = normalise(payload)
        summary = summarize(json.loads(raw), name)
        if not summary.get("readable"):
            raise ValueError(f"feed-twin cannot read that drawing: {summary.get('error')}")
        self.dir.mkdir(parents=True, exist_ok=True)
        ident = drawing_id(raw)
        (self.dir / f"{ident}.json").write_bytes(raw)
        meta = {"name": name, "source": source, "added": time.time()}
        (self.dir / f"{ident}.meta.json").write_text(json.dumps(meta))
        return Drawing(id=ident, name=name, source=source, sha256=sha256(raw),
                       payload=json.loads(raw), added=meta["added"])

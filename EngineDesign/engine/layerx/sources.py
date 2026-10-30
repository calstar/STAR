"""Where Layer X's drawings, state machines and combustion tables come from.

A drawing is the hardware record (ADR-0002): topology, line geometry, tank and
bottle volumes, the regulator. Layer X never edits one. It reads drawings from
these places and treats them identically once read, because what identifies a
drawing is its **bytes**:

* the feed-twin set shipped in ``feed-twin/backend/diagrams`` (the stand and the
  two COPV-study drawings), listed as benchmarks;
* the feed twin's own library, and the sample set it bundles in
  ``feed-twin/backend/sample`` (the team's current stand, which is *featured*:
  a browser with no drawing of its own opens on it);
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


def sample_dir() -> Path:
    """The sample set feed-twin bundles (the team's current stand drawing and engine): the drawing
    in it is the featured one, the stand a fresh browser opens on."""
    return Path(os.environ.get("LAYERX_SAMPLE") or (feedtwin_root() / "backend" / "sample"))


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
            if unit == "psig":  # an absolute pressure, as a gauge reads it
                return (float(p.si) - 101325.0) / 6894.757293168361
            if unit == "psi":  # a difference
                return float(p.si) / 6894.757293168361
            return float(p.si if unit == "si" else p.value)
        except Exception:  # noqa: BLE001 - a summary never fails a listing
            return None

    from engine.layerx.vehicle import vehicle_ids

    # Tanks and bottles on the vehicle only; a GSE page's transfer tank and cart bottles are listed
    # apart, as ground support (engine.layerx.vehicle).
    vehicle = vehicle_ids(diagram)
    ground: List[Dict[str, Any]] = []
    tanks, bottles, regulators, engines, valves = [], [], [], [], []
    for node in diagram.nodes:
        if node.type in ("TANK", "KBOTTLE", "DEWAR") and vehicle is not None and node.id not in vehicle:
            volume = node.params.get("volume")
            ground.append({"id": node.id, "label": node.label, "fluid": node.fluid, "type": node.type,
                           "volume_L": (volume.si * 1e3) if volume is not None else None})
            continue
        if node.type == "TANK":
            volume = node.params.get("volume")
            tanks.append({
                "id": node.id, "label": node.label, "fluid": node.fluid,
                "volume_L": (volume.si * 1e3) if volume is not None else None,
                "mawp_psi": param(node, "MAWP", "psig"),
            })
        elif node.type == "KBOTTLE":
            volume = node.params.get("volume")
            bottles.append({
                "id": node.id, "label": node.label, "fluid": node.fluid,
                "volume_L": (volume.si * 1e3) if volume is not None else None,
                "pressure_psi": param(node, "pressure", "psig"),
                "mawp_psi": param(node, "MAWP", "psig"),
            })
        elif node.type == "PR":
            regulators.append({
                "id": node.id, "label": node.label,
                "dome_loaded": node.options.get("domeLoaded") == "yes",
                "setpoint_psi": param(node, "setpoint", "psig"),
                "dome_bias_psi": param(node, "dome_bias", "psi"),
                "supply_coefficient": param(node, "supply_coefficient", "value"),
                "flow_droop_psi": param(node, "flow_droop", "psi"),
            })
        elif node.type in ("ENGINE", "INJECTOR"):
            engines.append({"id": node.id, "label": node.label})
        elif node.is_inline and node.type in ("SOL", "MAN", "ROT", "BV", "AV"):
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
        "ground_support": ground,
    }


#: Words for the tokens of a file stem, so a menu reads "COPV study, helium", not "copv_study_he".
_STEM_WORDS = {"copv": "COPV", "gn2": "GN2", "he": "helium", "n2": "N2", "ln2": "LN2", "lox": "LOX", "le4": "LE4"}
_GAS_WORDS = {"GN2", "helium", "N2", "LN2"}


def display_name(name: str) -> str:
    """A drawing's name as a person reads it. A file stem (``copv_study_he``, what a shipped drawing
    is named by) comes back in words (``COPV study, helium``); any other name, which a person chose,
    comes back as it is."""
    if not re.fullmatch(r"[a-z0-9]+(?:_[a-z0-9]+)+", name or ""):
        return name
    words = [_STEM_WORDS.get(w, w) for w in name.split("_")]
    if len(words) > 2 and words[-1] in _GAS_WORDS:
        text = " ".join(words[:-1]) + ", " + words[-1]
    else:
        text = " ".join(words)
    return text[:1].upper() + text[1:]


def origin_words(source: str) -> str:
    """Where a drawing came from, in words, for the menu's second line (the raw ``source`` stays in
    the run record)."""
    if source.startswith("shipped:"):
        return "benchmark, shipped with the code"
    if source.startswith("sample:"):
        return "Hotbench sample stand"
    if source.startswith("feed-twin library"):
        rest = source.split(":", 1)[1].strip() if ":" in source else ""
        return "Feed Twin library, from pid-designer" if rest.startswith("pid-designer") else "Feed Twin library"
    if source.startswith("pid-designer:"):
        return "pid-designer, " + ("working copy" if source.endswith("working copy") else "release")
    if source == "upload":
        return "uploaded here"
    return source


@dataclass
class Drawing:
    """One drawing, read and addressed by content."""

    id: str
    name: str
    source: str
    """``shipped:<file>``, ``sample:<file>``, ``feed-twin library: <its source>``, ``upload``, or
    ``pid-designer:<owner>/<id>@<release|working copy>``."""
    sha256: str
    payload: Dict[str, Any] = field(repr=False)
    added: float = 0.0
    featured: bool = False
    """The team's current stand: the sample feed-twin bundles, or a library entry marked featured.
    A browser with no drawing of its own opens on it."""

    def summary(self) -> Dict[str, Any]:
        return summarize(self.payload, self.name)

    def listing(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            # What a menu shows: the name in words, where it came from in words, and which shelf it
            # sits on (the team's stands, or the benchmarks shipped with the code).
            "label": display_name(self.name),
            "origin": origin_words(self.source),
            "group": "Benchmarks" if self.source.startswith("shipped:") else "Stands",
            "featured": self.featured,
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
                               added=time.mktime(time.strptime(imported[:19], "%Y-%m-%dT%H:%M:%S")) if imported else 0.0,
                               featured=entry.get("featured") is True))
        _SHIPPED_CACHE[stamp] = tuple(out)
        return out

    def _sample(self) -> List[Drawing]:
        """The drawings in feed-twin's sample set, read in place: featured. A library that already
        holds the same bytes lists it under the library's name (``list`` keeps the first met)."""
        out: List[Drawing] = []
        base = sample_dir()
        if not base.is_dir():
            return out
        for path in sorted(base.glob("*.json")):
            try:
                st = path.stat()
            except OSError:
                continue
            stamp = ("sample", str(path), st.st_mtime_ns, st.st_size)
            hit = _SHIPPED_CACHE.get(stamp)
            if hit is None:
                raw = _read(path)
                if raw is None:
                    continue
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                # The set also carries the engine's card and the like: only a drawing is listed.
                if not isinstance(payload, dict) or not isinstance(payload.get("nodes"), list) \
                        or not summarize(payload, path.stem).get("readable"):
                    _SHIPPED_CACHE[stamp] = False
                    continue
                hit = Drawing(id=drawing_id(raw), name=path.stem, source=f"sample:{path.name}",
                              sha256=sha256(raw), payload=payload, added=st.st_mtime, featured=True)
                _SHIPPED_CACHE[stamp] = hit
            if hit:
                out.append(hit)
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
        from dataclasses import replace

        seen: Dict[str, Drawing] = {}
        # The same bytes are one drawing, under the first name met: the shipped file, then the
        # feed twin's library copy, then the sample set, then this user's own. Featured if any copy
        # of it is: the sample's bytes, or a library entry marked so.
        everything = self._shipped() + self._feedtwin_library() + self._sample() + self._own()
        featured = {d.id for d in everything if d.featured}
        for drawing in everything:
            seen.setdefault(drawing.id, drawing)
        out = [replace(d, featured=True) if d.id in featured and not d.featured else d for d in seen.values()]
        # Two versions under one name (an older study, a re-import from pid-designer) are told apart
        # by when they arrived; the first of a name keeps it plain.
        from collections import Counter

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
        for drawing in self._shipped() + self._feedtwin_library() + self._sample():
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

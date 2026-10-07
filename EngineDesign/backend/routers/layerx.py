"""Layer X endpoints: the feed system and the engine, burned together.

    GET  /api/layerx/status                 feedtwin importable? shipped data found?
    GET  /api/layerx/runs/{id}/eng          a finished burn's thrust curve as an OpenRocket .eng
    GET  /api/layerx/drawings               drawings this user can run
    POST /api/layerx/drawings               upload a pid-designer / feed-twin drawing (JSON)
    GET  /api/layerx/pid-designer           documents pid-designer offers this user
    POST /api/layerx/pid-designer/import    pull one into this user's drawings
    POST /api/layerx/preflight              settings -> checks, derived plan, the engine link
    POST /api/layerx/card                   settings -> the engine card itself (feedtwin JSON)
    POST /api/layerx/engine-card            any engine config (YAML) -> its card, for the feed-twin cockpit
    GET  /api/layerx/drawings/{id}/parameters   every drawing parameter, and this user's restatements
    PUT  /api/layerx/drawings/{id}/measurements this user's restated (measured) parameters
    POST /api/layerx/uncertainty            start an uncertainty sweep (background); returns its id
    POST /api/layerx/setpoint               dome, lockup and fill for a target mean thrust (background)
    POST /api/layerx/hardware               catalogue parts for the components marked free (background)
    GET  /api/layerx/catalog                the parts Hardware mode chooses from (shipped + this user's)
    POST /api/layerx/optimize/variables     legacy: the old compass search's variables, bounds and reasons
    POST /api/layerx/optimize               legacy: the old compass search (background); kept while the
                                            Optimize page still calls it. Set point replaces it.
    POST /api/layerx/reconcile              resize the injector for the drawing's feed (background)
    POST /api/layerx/export-config          the design with an injector what-if written in, as YAML
    POST /api/layerx/runs                   start a burn (background); returns its id
    GET  /api/layerx/runs                   this user's runs, newest first
    GET  /api/layerx/runs/{id}              status, progress and, when done, the result
    GET  /api/layerx/runs/{id}/sidecar/{name}   a finished burn's large side data (``axial``)
    GET  /api/layerx/runs/{id}/export/{fmt}     a finished burn as ``csv``, ``parquet`` or ``fea`` (zip)
    POST /api/layerx/runs/{id}/cancel

Old runs of kinds that can no longer be started (the trade study) or that the rebuilt tools
replace (the compass-search optimiser) stay listed and readable, marked ``legacy``.

A run is a background thread, one at a time per user and at most
``LAYERX_MAX_JOBS`` across the process. It works on a *copy* of the config
taken when it starts, with its own runner, so loading a different design
mid-run neither corrupts the run nor is corrupted by it. Finished runs are
written to the user's data directory, so a reload finds them again.
"""

from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field, field_validator

from backend import userdata
from backend.session import UserSession, get_session

router = APIRouter(prefix="/api/layerx", tags=["layerx"])

MAX_JOBS = int(os.environ.get("LAYERX_MAX_JOBS", "2"))
_JOB_SLOTS = threading.BoundedSemaphore(MAX_JOBS)
#: Finished jobs that could not be saved, kept in memory per process (newest).
UNSAVED_KEPT = 5
#: Runs kept on disk per user. Older ones are pruned when a new one finishes.
KEEP_RUNS = int(os.environ.get("LAYERX_KEEP_RUNS", "25"))
PID_DESIGNER_URL = (os.environ.get("PID_DESIGNER_URL") or "http://127.0.0.1:8001").rstrip("/")
PID_TIMEOUT_S = 8.0
#: The largest drawing accepted, upload or pid-designer import. The shipped stand is ~60 kB.
MAX_UPLOAD_BYTES = 5_000_000


class UploadSizeGuard:
    """ASGI middleware: refuse a drawing upload larger than MAX_UPLOAD_BYTES before its body is read.
    FastAPI parses (and Starlette spools to disk) a multipart file before the route runs, so the
    route's own cap came after the whole body had arrived. The multipart envelope is allowed 64 kB."""

    PATH = "/api/layerx/drawings"

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") == "http" and scope.get("method") == "POST" and scope.get("path") == self.PATH:
            headers = dict(scope.get("headers") or [])
            length = headers.get(b"content-length")
            status, detail = 0, ""
            if length is None:
                status, detail = 411, "A drawing upload needs a Content-Length."
            elif not length.isdigit() or int(length) > MAX_UPLOAD_BYTES + 65536:
                status, detail = 413, f"A drawing is at most {MAX_UPLOAD_BYTES // 1_000_000} MB."
            if status:
                body = json.dumps({"detail": detail}).encode()
                await send({"type": "http.response.start", "status": status,
                            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


# ------------------------------------------------------------------ models


class Settings(BaseModel):
    """Mirror of engine.layerx.LayerXSettings, validated at the edge."""

    drawing_id: str
    tank_pressure_psia: Optional[float] = Field(default=None, gt=14.0, lt=5000.0)
    copv_pressure_psig: Optional[float] = Field(default=None, gt=0.0, lt=12000.0)
    load: str = Field(default="config", pattern="^(config|fill)$")
    fill_fraction: float = Field(default=0.95, gt=0.05, lt=0.99)
    dry_kg: float = Field(default=0.001, ge=0.0005, le=2.0)
    engine_model: str = Field(default="card", pattern="^(card|calibrated|native)$")
    #: The feed twin's thermal models: None runs the twin's own Setup (its cockpit's); a value overrides it.
    ullage_collapse: Optional[bool] = None
    ullage_vapour: Optional[bool] = None
    chilldown: Optional[float] = Field(default=None, ge=0.0, le=5000.0)
    line_walls: Optional[bool] = None
    hold_s: float = Field(default=300.0, ge=0.0, le=36000.0)
    dt: float = Field(default=0.05, ge=0.005, le=0.2)
    horizon_s: float = Field(default=14.0, gt=0.5, le=60.0)
    settle: bool = True
    replay: bool = True
    flight: bool = False
    liftoff_mass_kg: Optional[float] = Field(default=None, gt=1.0, lt=5000.0)
    pressurant: Optional[str] = Field(default=None, pattern="^(nitrogen|helium)$")
    # Opt-in choices (engine/layerx/prepare.py LayerXSettings): None is today's behaviour, exactly.
    chug_basis: Optional[str] = Field(default=None, pattern="^(config|drawing)$")
    chug_eroded: Optional[bool] = None
    card_eroded_nozzle: Optional[bool] = None
    flight_coupling: Optional[str] = Field(default=None, pattern="^(outer|inline)$")
    #: Start diagnostic only: fuel main this long before the LOX main [s]; None: 0 (the DAQ table).
    fuel_lead_s: Optional[float] = Field(default=None, ge=0.0, le=5.0, allow_inf_nan=False)
    #: Start diagnostic only: main-valve opening travel [s]; None: the drawing's travel_time.
    valve_travel_s: Optional[float] = Field(default=None, ge=0.0, le=5.0, allow_inf_nan=False)
    #: Gas-ingestion diagnostic only: tank outlet bore [mm], one for both or [LOX, fuel]; None: the first line's.
    outlet_d_mm: Optional[Union[float, List[Optional[float]]]] = None
    #: Run a nitrogen-over-LOX hot fire anyway (condensation unmodelled); None: preflight refuses it.
    ack_gn2_condensation: Optional[bool] = None
    #: Reserved: only a hot fire is modelled.
    test_mode: Optional[str] = Field(default=None, pattern="^hotfire$")
    #: A what-if on the injector, applied to this run's private copy of the design only:
    #: {"oxidizer"|"fuel": {"d_jet": m, "impingement_angle": deg, "orifice_l_over_d": -}}.
    design_patch: Optional[Dict[str, Dict[str, float]]] = None

    @field_validator("design_patch")
    @classmethod
    def _patch(cls, value: Optional[Dict[str, Dict[str, float]]]) -> Optional[Dict[str, Dict[str, float]]]:
        return check_design_patch(value)

    @field_validator("outlet_d_mm")
    @classmethod
    def _outlet(cls, value: Any) -> Any:
        import math

        if value is None:
            return None
        pair = [value, value] if isinstance(value, (int, float)) else list(value)
        if len(pair) != 2:
            raise ValueError("outlet_d_mm is one bore for both tanks or [LOX, fuel]")
        for v in pair:
            if v is not None and (isinstance(v, bool) or not math.isfinite(float(v)) or not 0.5 <= float(v) <= 500.0):
                raise ValueError(f"outlet_d_mm {v!r} must be a bore in mm, 0.5-500")
        return value


#: What a design patch may set, per side, and its sane range.
PATCH_FIELDS = {"d_jet": (1.0e-4, 0.02), "impingement_angle": (0.0, 80.0), "orifice_l_over_d": (0.5, 50.0)}


def check_design_patch(value: Optional[Dict[str, Dict[str, float]]]) -> Optional[Dict[str, Dict[str, float]]]:
    import math

    if not value:
        return None
    for side, fields in value.items():
        if side not in ("oxidizer", "fuel") or not isinstance(fields, dict):
            raise ValueError(f"design_patch side {side!r} must be 'oxidizer' or 'fuel'")
        for key, v in fields.items():
            if key not in PATCH_FIELDS:
                raise ValueError(f"design_patch.{side}.{key} is not patchable")
            lo, hi = PATCH_FIELDS[key]
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or not lo <= v <= hi:
                raise ValueError(f"design_patch.{side}.{key} = {v!r} is outside {lo:g}-{hi:g}")
    return value


from engine.layerx.patch import apply_design_patch  # noqa: E402,F401 - re-exported for the routes and tests


class PidImport(BaseModel):
    id: str
    owner: str = ""
    release: str = ""
    name: str = ""


# ------------------------------------------------------------------ helpers


def _user_dir(session: UserSession) -> Path:
    return userdata.user_dir(session.user)


def _runs_dir(session: UserSession) -> Path:
    path = _user_dir(session) / "layerx" / "runs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _store(session: UserSession):
    from engine.layerx import DrawingStore

    return DrawingStore(_user_dir(session))


def _config_and_runner(session: UserSession, patch: Optional[Dict[str, Dict[str, float]]] = None):
    """A private copy of the live design (with any what-if written in) and a runner of its own."""
    if not session.app_state.has_config():
        raise HTTPException(status_code=400, detail="No engine loaded. Load a design first.")
    from engine.core.runner import PintleEngineRunner

    config = apply_design_patch(copy.deepcopy(session.app_state.config), patch)
    return config, PintleEngineRunner(config)


def _settings(raw: Settings):
    from engine.layerx import LayerXSettings

    return LayerXSettings.from_dict(raw.model_dump())


def _measurements(session: UserSession):
    from engine.layerx.measurements import MeasurementStore

    return MeasurementStore(_user_dir(session))


def _drawing(session: UserSession, drawing_id: str):
    drawing = _store(session).get(drawing_id)
    if drawing is None:
        raise HTTPException(status_code=404, detail=f"No drawing {drawing_id!r} for this user.")
    return drawing


def _prepare(session: UserSession, settings: Settings):
    from engine.layerx import prepare

    from engine.layerx import Check

    drawing = _drawing(session, settings.drawing_id)
    config, runner = _config_and_runner(session, settings.design_patch)
    overrides, problems, revision = _measurements(session).load(drawing)
    prep = prepare(config, runner, drawing, _settings(settings), overrides)
    if overrides and revision and revision != drawing.sha256:
        prep.checks.append(Check("overrides_revision", "Restatements from an earlier revision", "warn",
                                 f"{len(overrides)} restated parameter(s) were entered against an earlier revision of "
                                 f"'{drawing.name}'. They are applied where the element still exists; check them."))
    for problem in problems:
        prep.checks.append(Check("overrides_unreadable", "Restatements that could not be read", "warn", problem))
    return prep, runner, config


def _json_safe(value: Any) -> Any:
    import math

    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(v) for v in value]
    if hasattr(value, "tolist") and callable(value.tolist):     # numpy arrays and scalars
        try:
            return _json_safe(value.tolist())
        except Exception:  # noqa: BLE001
            return str(value)
    return str(value)


# ------------------------------------------------------------------ jobs


class Job:
    def __init__(self, user: str, settings: Settings, design_name: str, kind: str = "run") -> None:
        # UTC, so ids sort by time across a daylight-saving change (pruning keeps the newest by id).
        self.id = time.strftime("%Y%m%d-%H%M%S-", time.gmtime()) + uuid.uuid4().hex[:6]
        self.kind = kind
        self.user = user
        self.settings = settings
        self.design_name = design_name
        self.status = "queued"
        self.stage = "Queued"
        self.progress = 0.0
        self.error: Optional[str] = None
        self.result: Optional[Dict[str, Any]] = None
        self.started = time.time()
        self.finished: Optional[float] = None
        self.cancel = threading.Event()
        #: Large side data of the result (DATA-CONTRACT 4 sidecars), written beside the run file.
        self.sidecars: Dict[str, Any] = {}

    def view(self, *, with_result: bool = True) -> Dict[str, Any]:
        out = {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "error": self.error,
            "started": self.started,
            "finished": self.finished,
            "design": self.design_name,
            "settings": self.settings.model_dump(),
        }
        if with_result:
            out["result"] = self.result
        elif self.result:
            out["summary"] = _listing_summary(self.result)
            out["drawing"] = (self.result.get("provenance") or {}).get("drawing")
        return out


_JOBS: Dict[str, Job] = {}
_JOBS_LOCK = threading.Lock()


_KIND_RE = re.compile(r'"kind":"([a-z]+)"')
RUN_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")


def _kind_of(path: Path) -> str:
    """A saved job's kind: from its index entry, else from the head of its file."""
    entry = _read_json(_index_path(path.parent, path.stem))
    if entry and isinstance(entry.get("kind"), str):
        return entry["kind"]
    try:
        with path.open("rb") as fh:
            head = fh.read(256).decode("utf-8", "replace")
    except OSError:
        return "run"
    m = _KIND_RE.search(head)
    return m.group(1) if m else "run"


def _index_path(session_dir: Path, run_id: str) -> Path:
    """The run's listing entry (no result): what GET /runs reads, so a poll never parses a burn."""
    return session_dir / "_index" / f"{run_id}.json"


def _meta_path(session_dir: Path, run_id: str) -> Path:
    """What the person said about a run: its name, a note, whether it is pinned."""
    return session_dir / "_meta" / f"{run_id}.json"


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    os.replace(tmp, path)


def _pinned(session_dir: Path, run_id: str) -> bool:
    return bool((_read_json(_meta_path(session_dir, run_id)) or {}).get("pinned"))


#: The sidecars a run may have, by name (DATA-CONTRACT 4).
SIDECARS = ("axial",)


def _sidecar_path(session_dir: Path, run_id: str, name: str) -> Path:
    """A run's sidecar: beside the run file, in its own directory so a listing never reads it."""
    return session_dir / "_sidecar" / f"{run_id}.{name}.json"


def _run_files(session_dir: Path, run_id: str) -> List[Path]:
    """Every file a saved run owns: the run, its index entry, its notes and its sidecars."""
    return ([session_dir / f"{run_id}.json", _index_path(session_dir, run_id), _meta_path(session_dir, run_id)]
            + [_sidecar_path(session_dir, run_id, name) for name in SIDECARS])


def _persist(session_dir: Path, job: Job) -> None:
    for name, data in (job.sidecars or {}).items():
        if name in SIDECARS and isinstance(data, dict):
            _write_json(_sidecar_path(session_dir, job.id, name), _json_safe(data))
    _write_json(session_dir / f"{job.id}.json", job.view())   # never a half-written run file
    _write_json(_index_path(session_dir, job.id), job.view(with_result=False))
    if KEEP_RUNS <= 0:
        return
    # Pruned per kind (a run of quick burns must not delete a sweep, a search or a reconcile), and
    # never a pinned run: the one a reconciled injector was written from stays.
    same = sorted(p for p in session_dir.glob("*.json") if _kind_of(p) == job.kind and not _pinned(session_dir, p.stem))
    for old in same[:-KEEP_RUNS]:
        for path in _run_files(session_dir, old.stem):
            try:
                path.unlink()
            except OSError:
                pass


def _execute(job: Job, work: Callable[[Callable[[str, float], None], Callable[[], bool]], Dict[str, Any]],
             runs_dir: Path) -> None:
    acquired = False
    try:
        # Wait for a process-wide slot, but let a cancel end the wait: a queued job cancelled
        # here would otherwise hold its user's one slot until someone else's job finished.
        while not (acquired := _JOB_SLOTS.acquire(timeout=0.25)):
            job.stage = f"Waiting for a free slot ({MAX_JOBS} Layer X jobs at once)"
            if job.cancel.is_set():
                raise InterruptedError("cancelled while queued")
        if job.cancel.is_set():
            raise InterruptedError("cancelled")
        job.status = "running"

        def progress(stage: str, fraction: float) -> None:
            job.stage = stage
            job.progress = float(fraction)

        out = work(progress, job.cancel.is_set)
        if isinstance(out, dict) and isinstance(out.get("_sidecars"), dict):
            job.sidecars = out.pop("_sidecars")
        job.result = _json_safe(out)
        if job.cancel.is_set():
            # Finished after the cancel arrived: keep what was computed, but say it was cancelled.
            job.status, job.stage = "cancelled", "Cancelled"
        else:
            job.status = "done"
            job.stage = "Done"
            job.progress = 1.0
    except Exception as exc:  # noqa: BLE001 - a failed run is reported, never raised into the thread
        from concurrent.futures.process import BrokenProcessPool

        from engine.layerx.pool import Cancelled

        # The cancel is the job saying so (Cancelled, or the queue wait's InterruptedError), or
        # the worker pool broken by the cancel's own terminate. Anything else that happens to
        # land after a cancel is still a failure: a real error is never filed as "cancelled".
        if isinstance(exc, (Cancelled, InterruptedError)) or (job.cancel.is_set() and isinstance(exc, BrokenProcessPool)):
            job.status, job.stage = "cancelled", "Cancelled"
        else:
            job.status, job.error = "failed", f"{type(exc).__name__}: {exc}"
    finally:
        if acquired:
            _JOB_SLOTS.release()
        job.finished = time.time()
        if job.status in ("done", "failed", "cancelled"):
            try:
                _persist(runs_dir, job)
            except Exception as exc:  # noqa: BLE001 - kept in memory, said so
                job.error = (job.error or "") + f" (not saved: {type(exc).__name__}: {exc})"
                # Kept so the person can still read it, but not for ever: the newest few unsaved.
                with _JOBS_LOCK:
                    unsaved = sorted((j for j in _JOBS.values() if j.finished and "(not saved:" in (j.error or "")),
                                     key=lambda j: j.finished or 0)
                    for old in unsaved[:-UNSAVED_KEPT]:
                        _JOBS.pop(old.id, None)
            else:
                # On disk now; GET /runs/{id} reads it from there. Memory holds live jobs only.
                with _JOBS_LOCK:
                    _JOBS.pop(job.id, None)


# ------------------------------------------------------------------ routes


@router.get("/status")
async def status() -> Dict[str, Any]:
    from engine.layerx.sources import machines_dir, shipped_drawings_dir

    try:
        import feedtwin  # noqa: F401
        from feedtwin import __version__ as version

        available, error = True, None
    except Exception as exc:  # noqa: BLE001
        available, error, version = False, f"{type(exc).__name__}: {exc}", None
    machines = machines_dir()
    return {
        "feedtwin": {"available": available, "version": version, "error": error},
        "shipped_drawings": str(shipped_drawings_dir()) if shipped_drawings_dir().is_dir() else None,
        "state_machines": str(machines) if machines.is_dir() else None,
        "pid_designer_url": PID_DESIGNER_URL,
        "max_jobs": MAX_JOBS,
    }


@router.get("/drawings")
def drawings(session: UserSession = Depends(get_session)) -> List[Dict[str, Any]]:
    return [d.listing() for d in _store(session).list()]


@router.post("/drawings")
def upload_drawing(file: UploadFile = File(...), session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    # A plain def, like every route here that parses or touches disk: run in the thread pool, not
    # on the event loop every other user shares.
    raw = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"A drawing is at most {MAX_UPLOAD_BYTES // 1_000_000} MB.")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Not a JSON drawing: {exc}")
    _check_drawing(payload)
    name = Path(file.filename or "drawing").stem
    try:
        return _store(session).add(payload, name=name, source="upload").listing()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


def _check_drawing(doc: Any) -> None:
    """A drawing Layer X can hold: lists of node and edge objects, at least one symbol. Anything
    else used to be stored and then break the parameter and measurement routes."""
    if not isinstance(doc, dict) or not isinstance(doc.get("nodes"), list) or not isinstance(doc.get("edges", []), list):
        raise HTTPException(status_code=400, detail="Expected a pid-designer drawing: an object with 'nodes' and 'edges' lists.")
    if not all(isinstance(item, dict) for item in doc["nodes"] + list(doc.get("edges") or [])):
        raise HTTPException(status_code=400, detail="Every node and edge must be an object.")
    if not doc["nodes"]:
        raise HTTPException(status_code=422, detail="The drawing has no symbols.")


def _forward(request: Request) -> Dict[str, str]:
    email = request.headers.get("X-Auth-Email")
    return {"X-Auth-Email": email} if email else {}


def _pid_get(path: str, request: Request, params: Optional[Dict[str, str]] = None) -> Any:
    """GET one pid-designer route as JSON. Standard library only: the API image
    installs requirements-base.txt, which carries no HTTP client."""
    import urllib.error
    import urllib.parse
    import urllib.request

    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    req = urllib.request.Request(f"{PID_DESIGNER_URL}{path}{query}", headers=_forward(request))
    with urllib.request.urlopen(req, timeout=PID_TIMEOUT_S) as response:  # noqa: S310 - our own sibling app
        body = response.read(MAX_UPLOAD_BYTES + 1)
    if len(body) > MAX_UPLOAD_BYTES:
        raise ValueError(f"pid-designer returned more than {MAX_UPLOAD_BYTES // 1_000_000} MB")
    return json.loads(body.decode("utf-8"))


@router.get("/pid-designer")
def pid_documents(request: Request) -> Dict[str, Any]:
    """pid-designer's documents this user can open: their own and those shared.
    Sync, so FastAPI runs the two blocking GETs in a worker thread."""
    import urllib.error

    base = "/api/pid/diagrams"
    try:
        mine = _pid_get(base, request)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"reachable": False, "url": PID_DESIGNER_URL, "error": str(exc), "documents": []}
    try:
        others = _pid_get(f"{base}/browse", request)
    except (urllib.error.URLError, OSError, ValueError):
        # Browsing is a convenience; it must not stop somebody importing their own work.
        others = []
    docs = []
    for record in mine if isinstance(mine, list) else []:
        docs.append({"id": record.get("id", ""), "name": record.get("name") or record.get("id", ""),
                     "owner": record.get("owner", ""), "updated_at": record.get("updatedAt") or "", "mine": True})
    for group in others if isinstance(others, list) else []:
        for record in group.get("designs", []):
            docs.append({"id": record.get("id", ""), "name": record.get("name") or record.get("id", ""),
                         "owner": group.get("owner", ""), "updated_at": record.get("updatedAt") or "", "mine": False})
    return {"reachable": True, "url": PID_DESIGNER_URL, "documents": docs}


@router.post("/pid-designer/import")
def pid_import(body: PidImport, request: Request, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    import urllib.error

    from urllib.parse import quote

    path = f"/api/pid/diagrams/{quote(body.id, safe='')}/" + (
        f"release/{quote(body.release, safe='')}" if body.release else "load")
    try:
        payload = _pid_get(path, request, {"owner": body.owner} if body.owner else None)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"pid-designer at {PID_DESIGNER_URL}: {exc}")
    inner = payload.get("data") if isinstance(payload, dict) else None
    body_doc = inner if isinstance(inner, dict) else payload
    if not isinstance(body_doc, dict):
        raise HTTPException(status_code=502, detail=f"pid-designer returned no document for {body.id!r}.")
    _check_drawing(body_doc)
    where = f"{body.owner}/{body.id}" if body.owner else body.id
    stamp = f"release {body.release}" if body.release else "working copy"
    try:
        drawing = _store(session).add(body_doc, name=body.name or body.id,
                                      source=f"pid-designer:{where}@{stamp}")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return drawing.listing()


@router.post("/preflight")
def preflight(body: Settings, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """Everything a run would start from, graded. Sync: FastAPI runs it in a worker
    thread, so its ~3 s (one EngineDesign solve, two assemblies) blocks nobody."""
    prep, _, _ = _prepare(session, body)
    return _json_safe(prep.preflight())


@router.post("/card")
def engine_card(body: Settings, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """The engine card a burn with these settings would use, as feedtwin reads it
    (``feedtwin.engine.EngineCard.from_dict``): for the feed-twin cockpit, or for checking by hand."""
    prep, _, _ = _prepare(session, body.model_copy(update={"engine_model": "card"}))
    if prep.link is None or prep.link.card is None:
        failing = [c.label for c in prep.checks if c.status == "fail"]
        raise HTTPException(status_code=422, detail={"message": "No engine card.", "failing": failing})
    return _json_safe(prep.link.card.to_dict())


class CardRequest(BaseModel):
    yaml: str = Field(..., description="An engine config, as EngineDesign writes it")
    center_psia: Optional[float] = None


@router.post("/engine-card")
def engine_card_for_config(body: CardRequest) -> Dict[str, Any]:
    """The engine card for any engine config, sent as YAML: no session, no drawing. What the
    feed-twin cockpit asks for when it imports an engine, so the stand fires EngineDesign's
    engine rather than feedtwin's simplified one (``engine.layerx.card.card_for_config_text``)."""
    from engine.layerx.card import card_for_config_text

    try:
        return _json_safe(card_for_config_text(body.yaml, center_psia=body.center_psia))
    except Exception as exc:  # noqa: BLE001 - a config that will not build a card is the caller's to fix
        raise HTTPException(status_code=422, detail=f"No engine card for that config: {type(exc).__name__}: {exc}")


@router.post("/runs")
def start_run(body: Settings, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    def build() -> Callable[..., Dict[str, Any]]:
        prep, runner, config = _prepare(session, body)
        if not prep.ok:
            failing = [c.label for c in prep.checks if c.status == "fail"]
            raise HTTPException(status_code=422, detail={"message": "Preflight failed.", "failing": failing,
                                                          "preflight": _json_safe(prep.preflight())})
        from engine.layerx import run_prepared

        snapshot = _design_snapshot(config)

        def work(progress: Callable[[str, float], None], cancelled: Callable[[], bool]) -> Dict[str, Any]:
            # Every run a person starts carries its diagnostics (DATA-CONTRACT 3); they read the burn
            # and change nothing in it. The axial heat-flux grids go beside the run file.
            sidecars: Dict[str, Any] = {}
            result = run_prepared(prep, runner=runner, progress=progress, cancelled=cancelled,
                                  replay=prep.settings.replay, config=config, diagnostics=True, sidecars=sidecars)
            result.setdefault("provenance", {})["reproduce"] = snapshot
            if sidecars:
                result["sidecars"] = sorted(sidecars)
                result["_sidecars"] = sidecars
            return result

        return work

    return _launch(session, body, "run", build)


def _code_version() -> str:
    """``git describe`` of this checkout, with a mark when it has uncommitted changes."""
    import subprocess

    root = Path(__file__).resolve().parents[2]
    try:
        out = subprocess.run(["git", "describe", "--always", "--dirty"], cwd=root, capture_output=True,
                             text=True, timeout=3)
        return out.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def _design_snapshot(config: Any) -> Dict[str, Any]:
    """What it takes to burn this run again: the design as it was (YAML), and the code version.
    The hash alone said whether the design had moved, not what it had been."""
    import yaml

    try:
        text = yaml.safe_dump(config.model_dump(mode="json"), sort_keys=False)
    except Exception as exc:  # noqa: BLE001 - the run stands without its snapshot, and says so
        text = f"# could not snapshot the design: {type(exc).__name__}: {exc}"
    return {"design_yaml": text, "code": _code_version()}


def _design_name(session: UserSession) -> str:
    path = getattr(session.app_state, "config_path", None)
    return (Path(path).stem if path else "") or "live design"


def _reserve(session: UserSession, settings: Settings, kind: str) -> Job:
    """One job per user, claimed atomically: the check and the claim under one lock, before the
    seconds of preparation, so two requests at once cannot both pass the check."""
    with _JOBS_LOCK:
        busy = [j for j in _JOBS.values() if j.user == session.user and j.status in ("queued", "running")]
        if busy:
            raise HTTPException(status_code=409, detail=f"A {busy[0].kind} ({busy[0].id}) is still going. Cancel it or wait.")
        job = Job(session.user, settings, _design_name(session), kind=kind)
        job.stage = "Preparing"
        _JOBS[job.id] = job
    return job


def _release(job: Job) -> None:
    with _JOBS_LOCK:
        _JOBS.pop(job.id, None)


def _launch(session: UserSession, settings: Settings, kind: str,
            build: Callable[[], Callable[..., Dict[str, Any]]]) -> Dict[str, Any]:
    """Claim the user's job slot, prepare (``build`` returns the work, or raises), and start."""
    job = _reserve(session, settings, kind)
    try:
        runs_dir = _runs_dir(session)
        work = build()
        threading.Thread(target=_execute, args=(job, work, runs_dir), name=f"layerx-{job.id}", daemon=True).start()
    except BaseException:
        _release(job)
        raise
    return {"id": job.id, "kind": job.kind, "status": job.status}


@router.post("/uncertainty")
def start_uncertainty(body: Settings, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """One-at-a-time sweep of the unmeasured inputs (engine/layerx/uncertainty.py): the tornado
    and the band. Parallel worker processes; ~30 s on the 6.8 kN stand."""
    def build() -> Callable[..., Dict[str, Any]]:
        prep, _, config = _prepare(session, body)
        if not prep.ok:
            failing = [c.label for c in prep.checks if c.status == "fail"]
            raise HTTPException(status_code=422, detail={"message": "Preflight failed.", "failing": failing})
        from engine.layerx.uncertainty import run_sweep

        drawing, settings, overrides = prep.drawing, prep.settings, prep.measurements
        return lambda progress, cancelled: run_sweep(
            config, drawing, settings, overrides, progress=progress, cancelled=cancelled)

    return _launch(session, body, "uncertainty", build)


#: Hard limits on the optimiser's searched bounds, the same as Settings' (a candidate is built with
#: dataclasses.replace, which does not validate).
OPT_LIMITS = {"lockup_psia": (14.0, 5000.0), "copv_psig": (0.0, 12000.0), "copv_volume_L": (0.05, 500.0)}


class OptimizeBody(BaseModel):
    settings: Settings
    objective: str = Field(default="impulse", pattern="^(impulse|apogee)$")
    variables: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    dropout_margin_psi: float = Field(default=100.0, ge=0.0, le=3000.0)
    stiffness: bool = True
    of_band_rel: Optional[float] = Field(default=None, gt=0.0, lt=0.5)
    max_evaluations: int = Field(default=40, ge=5, le=200)

    @field_validator("variables")
    @classmethod
    def _bounds(cls, value: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        import math

        for key, raw in value.items():
            if key not in OPT_LIMITS:
                raise ValueError(f"unknown variable {key!r}")
            lo_lim, hi_lim = OPT_LIMITS[key]
            for end in ("lo", "hi"):
                if end in raw:
                    v = raw[end]
                    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
                        raise ValueError(f"{key}.{end} must be a finite number")
                    if not lo_lim <= v <= hi_lim:
                        raise ValueError(f"{key}.{end} = {v:g} is outside {lo_lim:g}-{hi_lim:g}")
        return value


@router.post("/optimize/variables")
def optimize_variables(body: Settings, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """The optimiser's decision variables for these settings: bounds, start, and why."""
    from dataclasses import asdict

    from engine.layerx.optimize import default_variables

    prep, _, config = _prepare(session, body)
    if not prep.ok:
        failing = [c.label for c in prep.checks if c.status == "fail"]
        raise HTTPException(status_code=422, detail={"message": "Preflight failed.", "failing": failing})
    return {"variables": [asdict(v) for v in default_variables(prep, config)],
            "stiffness_band": prep.derived.get("stiffness_band"),
            "design_of": getattr(getattr(config, "design_requirements", None), "optimal_of_ratio", None)}


@router.post("/optimize")
def start_optimize(body: OptimizeBody, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """Search the feed hardware (lockup, COPV fill, COPV volume) for the most impulse or apogee from
    the fixed load, every candidate a whole burn (engine/layerx/optimize.py). Minutes."""
    def build() -> Callable[..., Dict[str, Any]]:
        prep, _, config = _prepare(session, body.settings)
        if not prep.ok:
            failing = [c.label for c in prep.checks if c.status == "fail"]
            raise HTTPException(status_code=422, detail={"message": "Preflight failed.", "failing": failing})
        from engine.layerx.optimize import OptimizeRequest, run_optimize

        request = OptimizeRequest.from_dict(body.model_dump(exclude={"settings"}))
        drawing, settings, overrides = prep.drawing, prep.settings, prep.measurements
        return lambda progress, cancelled: run_optimize(
            config, drawing, settings, overrides, request, progress=progress, cancelled=cancelled)

    return _launch(session, body.settings, "optimize", build)


#: Job kinds whose saved runs are listed (``legacy: true``) and readable through GET /runs/{id},
#: read-only; nothing rewrites them. The trade study was removed on 2026-10-02 (docs/layerx/AUDIT.md
#: D6, 9.10): set point and the uncertainty tornado cover it. The compass-search optimiser is
#: replaced by Set point and Hardware (``/setpoint``, ``/hardware``); its endpoint stays while the
#: old Optimise page still calls it, and what it writes is legacy too.
LEGACY_KINDS = frozenset({"trade", "optimize"})


def _check_meop(value: Optional[Dict[str, float]]) -> Optional[Dict[str, float]]:
    import math

    for side, v in (value or {}).items():
        if side not in ("oxidiser", "fuel"):
            raise ValueError(f"meop_psi side {side!r} must be 'oxidiser' or 'fuel'")
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or not 0.0 < v < 20000.0:
            raise ValueError(f"meop_psi.{side} = {v!r} is not a pressure")
    return value


class SetpointBody(BaseModel):
    settings: Settings
    #: None: the design's ``design_requirements.target_thrust``.
    target_thrust_N: Optional[float] = Field(default=None, gt=0.0, lt=1.0e6, allow_inf_nan=False)
    thrust_tol_rel: float = Field(default=1.0e-3, ge=1.0e-5, le=0.05)
    solve_fill: bool = True
    margin_psi: float = Field(default=100.0, ge=0.0, le=3000.0)
    margin_tol_psi: float = Field(default=20.0, gt=0.0, le=500.0)
    #: Per tank side, a maximum expected operating pressure across the wall [psi]: graded as a limit.
    meop_psi: Optional[Dict[str, float]] = None
    design_of: Optional[float] = Field(default=None, gt=0.0, lt=10.0, allow_inf_nan=False)
    max_burns: int = Field(default=10, ge=3, le=24)
    replay: bool = True
    #: With replay off: burn the answer again with the replay, and correct once for the offset.
    verify: bool = True

    @field_validator("meop_psi")
    @classmethod
    def _meop(cls, value: Optional[Dict[str, float]]) -> Optional[Dict[str, float]]:
        return _check_meop(value)


@router.post("/setpoint")
def start_setpoint(body: SetpointBody, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """The dome dial, lockup and bottle fill that give a target mean thrust (engine/layerx/setpoint.py):
    a secant on lockup, then the fill for a bottle margin, every point a whole burn. Minutes."""
    def build() -> Callable[..., Dict[str, Any]]:
        prep, _, config = _prepare(session, body.settings)
        if not prep.ok:
            failing = [c.label for c in prep.checks if c.status == "fail"]
            raise HTTPException(status_code=422, detail={"message": "Preflight failed.", "failing": failing})
        from engine.layerx.setpoint import SetpointRequest, run_setpoint, target_thrust

        request = SetpointRequest.from_dict(body.model_dump(exclude={"settings"}))
        try:
            target_thrust(config, request)          # refused here, before a slot is taken
        except ValueError as exc:
            raise HTTPException(status_code=422, detail={"message": str(exc)}) from exc
        drawing, settings, overrides = prep.drawing, prep.settings, prep.measurements
        return lambda progress, cancelled: run_setpoint(
            config, drawing, settings, overrides, request, progress=progress, cancelled=cancelled)

    return _launch(session, body.settings, "setpoint", build)


class HardwareBody(BaseModel):
    settings: Settings
    #: The components that may change: [{"target": "node:SV_LOX_PRESS" | "edge:l_ox1" |
    #: "design:oxidizer.d_jet", "kind"?: "trim_orifice", "rows"?: [catalog row ids]}].
    components: List[Dict[str, Any]] = Field(min_length=1, max_length=8)
    #: What the set point cannot fix: O/F is the default (one regulator presses both tanks).
    objective: str = Field(default="of_error",
                           pattern="^(target_thrust_error|thrust_flatness|of_error|impulse|bottle_margin)$")
    target_thrust_N: Optional[float] = Field(default=None, gt=0.0, lt=1.0e6, allow_inf_nan=False)
    design_of: Optional[float] = Field(default=None, gt=0.0, lt=10.0, allow_inf_nan=False)
    neighbours: int = Field(default=2, ge=1, le=4)
    combine: bool = False
    max_candidates: int = Field(default=8, ge=1, le=24)
    margin_psi: float = Field(default=100.0, ge=0.0, le=3000.0)
    meop_psi: Optional[Dict[str, float]] = None
    verify: bool = True
    #: A measured discharge coefficient for a trim orifice; None: Reader-Harris/Gallagher (extrapolated).
    trim_C: Optional[float] = Field(default=None, gt=0.1, lt=1.0, allow_inf_nan=False)

    @field_validator("meop_psi")
    @classmethod
    def _meop(cls, value: Optional[Dict[str, float]]) -> Optional[Dict[str, float]]:
        return _check_meop(value)


@router.post("/hardware")
def start_hardware(body: HardwareBody, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """Catalogue parts for the components marked free, each candidate a whole burn on an in-memory
    copy of the drawing, ranked by the objective (engine/layerx/optimize.py run_hardware)."""
    def build() -> Callable[..., Dict[str, Any]]:
        prep, _, config = _prepare(session, body.settings)
        if not prep.ok:
            failing = [c.label for c in prep.checks if c.status == "fail"]
            raise HTTPException(status_code=422, detail={"message": "Preflight failed.", "failing": failing})
        from engine.layerx.catalog import load_catalogs
        from engine.layerx.optimize import HardwareRequest, plan_candidates, run_hardware

        catalogs = load_catalogs(_user_dir(session))
        try:
            request = HardwareRequest.from_dict(body.model_dump(exclude={"settings"}))
            plan_candidates(prep, config, request, catalogs)   # refused here, before a slot is taken
        except ValueError as exc:
            raise HTTPException(status_code=422, detail={"message": str(exc)}) from exc
        drawing, settings, overrides = prep.drawing, prep.settings, prep.measurements
        return lambda progress, cancelled: run_hardware(
            config, drawing, settings, overrides, request, catalogs=catalogs, progress=progress, cancelled=cancelled)

    return _launch(session, body.settings, "hardware", build)


@router.get("/catalog")
def catalog(session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """The parts Hardware mode may choose from (engine/layerx/catalog.py): the shipped catalogues
    with this user's rows over them by id, the drill table, and any user file that did not read
    (``problems``; its shipped rows stand). Read-only: the user adds rows as files."""
    from engine.layerx.catalog import load_catalogs

    return _json_safe(load_catalogs(_user_dir(session)))


class ReconcileBody(BaseModel):
    settings: Settings
    thrust_N: Optional[float] = Field(default=None, gt=0.0, lt=1.0e6, allow_inf_nan=False)
    of: Optional[float] = Field(default=None, gt=0.0, lt=10.0, allow_inf_nan=False)
    hold_spray_direction: bool = True
    max_passes: int = Field(default=4, ge=1, le=8)


@router.post("/reconcile")
def start_reconcile(body: ReconcileBody, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """Resize the injector's holes (and, if asked, its jet angles) so the design point holds under
    the drawing's feed, burning and refitting until they stop moving (engine/layerx/reconcile.py)."""
    def build() -> Callable[..., Dict[str, Any]]:
        prep, _, config = _prepare(session, body.settings)
        if not prep.ok:
            failing = [c.label for c in prep.checks if c.status == "fail"]
            raise HTTPException(status_code=422, detail={"message": "Preflight failed.", "failing": failing})
        from engine.layerx.reconcile import ReconcileRequest, run_reconcile

        request = ReconcileRequest.from_dict(body.model_dump(exclude={"settings"}))
        drawing, settings, overrides = prep.drawing, prep.settings, prep.measurements
        return lambda progress, cancelled: run_reconcile(
            config, drawing, settings, overrides, request, progress=progress, cancelled=cancelled)

    return _launch(session, body.settings, "reconcile", build)


class ExportBody(BaseModel):
    design_patch: Optional[Dict[str, Dict[str, float]]] = None
    #: Per side, the fitted feed to write too (a reconcile's design_update.feed_system).
    feed_system: Optional[Dict[str, Dict[str, Any]]] = None
    name: str = Field(default="design", max_length=80)
    note: str = Field(default="", max_length=400)

    @field_validator("design_patch")
    @classmethod
    def _patch(cls, value: Optional[Dict[str, Dict[str, float]]]) -> Optional[Dict[str, Dict[str, float]]]:
        return check_design_patch(value)


@router.post("/export-config")
def export_config(body: ExportBody, session: UserSession = Depends(get_session)):
    """The live design with an injector what-if (and, if given, the drawing's fitted feed)
    written in, as a YAML file to download. The design itself is not changed."""
    import re as _re

    import yaml
    from fastapi.responses import PlainTextResponse

    from engine.pipeline.config_schemas import PintleEngineConfig

    config, _ = _config_and_runner(session, body.design_patch)
    raw = config.model_dump(mode="json")
    if body.feed_system:
        allowed = {"K0", "supply_K", "K1", "phi_type", "roughness_m", "fittings", "derived_from"}
        for side, upd in body.feed_system.items():
            if side not in ("oxidizer", "fuel") or not isinstance(upd, dict):
                raise HTTPException(status_code=422, detail=f"feed_system side {side!r} must be oxidizer or fuel")
            if not isinstance((raw.get("feed_system") or {}).get(side), dict):
                raise HTTPException(status_code=422, detail=f"The design has no feed_system.{side} to write the fit into.")
            raw["feed_system"][side].update({k: v for k, v in upd.items() if k in allowed})
    try:
        PintleEngineConfig(**raw)
    except Exception as exc:  # noqa: BLE001 - an export that would not load is refused
        raise HTTPException(status_code=422, detail=f"The exported design would not load: {exc}") from exc
    stamp = time.strftime("%Y-%m-%d %H:%M")
    lines = [f"# {body.name}: exported from Layer X, {stamp}."]
    for side, fields in (body.design_patch or {}).items():
        parts = []
        if "d_jet" in fields:
            parts.append(f"holes {fields['d_jet'] * 1e3:.4f} mm")
        if "impingement_angle" in fields:
            parts.append(f"jet angle {fields['impingement_angle']:g} deg")
        if "orifice_l_over_d" in fields:
            parts.append(f"L/d {fields['orifice_l_over_d']:.3f}")
        lines.append(f"# {side}: " + ", ".join(parts))
    for side, upd in (body.feed_system or {}).items():
        if "K0" in upd:
            lines.append(f"# {side} feed: K0 {float(upd['K0']):.4f}, fitted to the drawing's feed")
    if body.note:
        lines += [f"# {ln}" for ln in body.note.splitlines()]
    text = "\n".join(lines) + "\n" + yaml.safe_dump(raw, sort_keys=False, allow_unicode=True)
    fname = _re.sub(r"[^A-Za-z0-9._-]+", "_", body.name).strip("_") or "design"
    return PlainTextResponse(text, media_type="application/x-yaml",
                             headers={"Content-Disposition": f'attachment; filename="{fname}.yaml"'})


@router.get("/drawings/{drawing_id}/parameters")
def drawing_parameters(drawing_id: str, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    from dataclasses import asdict

    from engine.layerx.measurements import parameter_table

    drawing = _drawing(session, drawing_id)
    return {"rows": parameter_table(drawing.payload),
            "overrides": [asdict(o) for o in _measurements(session).get(drawing)]}


@router.get("/drawings/{drawing_id}/document")
def drawing_document(drawing_id: str, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """The drawing itself (nodes with positions, edges with routes), read-only: the schematic is
    drawn from its topology, never from a hand-made layout."""
    drawing = _drawing(session, drawing_id)
    return {"id": drawing.id, "name": drawing.name, "sha256": drawing.sha256, "document": drawing.payload}


# ------------------------------------------------------------------ the stand's DAQ


#: Where the DAQ's channel list lives, overridable for a deployment that keeps it elsewhere.
DAQ_CONFIG = Path(os.environ.get("DAQ_CONFIG") or (Path(__file__).resolve().parents[3] / "daq-server" / "config" / "config_ground_daq.toml"))


@router.get("/daq-channels")
def daq_channels() -> Dict[str, Any]:
    """The stand DAQ's channels (daq-server's ground config): name, what it reads, its range.
    So a drawing's instrument can be paired with the channel that will record it."""
    import tomllib

    if not DAQ_CONFIG.is_file():
        return {"available": False, "path": str(DAQ_CONFIG), "channels": []}
    try:
        data = tomllib.loads(DAQ_CONFIG.read_text())
    except (OSError, tomllib.TOMLDecodeError) as exc:
        return {"available": False, "path": str(DAQ_CONFIG), "error": str(exc), "channels": []}
    channels: Dict[str, Dict[str, Any]] = {}
    for group, kinds in (data.get("sensors") or {}).items():
        if not isinstance(kinds, dict):
            continue
        for kind, table in kinds.items():
            if not isinstance(table, dict):
                continue
            for name, spec in table.items():
                if isinstance(spec, dict):
                    channels.setdefault(name, {"name": name, "kind": kind.split("_")[-1].upper(), "group": group,
                                               "purpose": spec.get("purpose") or "", "max_psi": spec.get("max_psi")})
    return {"available": True, "path": str(DAQ_CONFIG), "channels": sorted(channels.values(), key=lambda c: c["name"])}


class ChannelMap(BaseModel):
    #: Drawing instrument id to the DAQ channel that records it.
    channels: Dict[str, str] = Field(default_factory=dict, max_length=200)

    @field_validator("channels")
    @classmethod
    def _names(cls, value: Dict[str, str]) -> Dict[str, str]:
        for k, v in value.items():
            if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", k) or not re.fullmatch(r"[A-Za-z0-9_.:-]{0,80}", v):
                raise ValueError(f"channel map {k!r} -> {v!r} is not a plain name")
        return {k: v for k, v in value.items() if v}


def _channels_path(session: UserSession, drawing_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-zA-Z_-]{1,80}", drawing_id):
        raise HTTPException(status_code=404, detail="No such drawing.")
    return _user_dir(session) / "layerx" / "channels" / f"{drawing_id}.json"


@router.get("/drawings/{drawing_id}/channels")
def get_channels(drawing_id: str, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """Which DAQ channel records each of this drawing's instruments."""
    return {"channels": (_read_json(_channels_path(session, drawing_id)) or {}).get("channels", {})}


@router.put("/drawings/{drawing_id}/channels")
def put_channels(drawing_id: str, body: ChannelMap, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """Pair the drawing's instruments with DAQ channels. Kept on the server with the drawing."""
    _write_json(_channels_path(session, drawing_id), {"channels": body.channels})
    return {"channels": body.channels}


class MeasurementsBody(BaseModel):
    overrides: List[Dict[str, Any]] = Field(max_length=500)


@router.put("/drawings/{drawing_id}/measurements")
def put_measurements(drawing_id: str, body: MeasurementsBody,
                           session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    from dataclasses import asdict

    from engine.layerx.measurements import Override, apply_overrides

    drawing = _drawing(session, drawing_id)
    try:
        overrides = [Override.from_dict(o) for o in body.overrides]
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    _, _, missing = apply_overrides(drawing.payload, overrides)
    if missing:
        raise HTTPException(status_code=422, detail=f"The drawing has no {', '.join(missing)}.")
    try:
        _measurements(session).put(drawing, overrides)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"overrides": [asdict(o) for o in overrides]}


def _listing_summary(result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A run's summary for the list, with the replay's delivered impulse where there is one, so
    the list and the result's headline say the same number."""
    summary = result.get("summary")
    delivered = ((result.get("delivered") or {}).get("summary") or {}) if isinstance(result, dict) else {}
    if isinstance(summary, dict) and delivered.get("total_impulse_Ns") is not None:
        summary = {**summary, "total_impulse_Ns": delivered["total_impulse_Ns"]}
    flight = result.get("flight") if isinstance(result, dict) else None
    if isinstance(summary, dict) and isinstance(flight, dict) and flight.get("ok"):
        summary = {**summary, "apogee_agl_m": flight.get("apogee_agl_m")}
    trip = result.get("tripped") if isinstance(result, dict) else None
    if isinstance(summary, dict) and isinstance(trip, dict):
        # The list says a run stopped at a vessel trip, so its short impulse is not read as a design's.
        summary = {**summary, "tripped": {k: trip.get(k) for k in ("vessel", "label", "t", "p_psia", "mawp_psia")}}
    return summary


def _load_saved(session: UserSession, run_id: str) -> Optional[Dict[str, Any]]:
    if not RUN_ID_RE.match(run_id):
        return None
    path = _runs_dir(session) / f"{run_id}.json"
    if not path.is_file() or path.parent != _runs_dir(session):
        return None
    try:
        saved = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return saved if isinstance(saved, dict) and "id" in saved else None


@router.get("/runs")
def list_runs(session: UserSession = Depends(get_session)) -> List[Dict[str, Any]]:
    runs_dir = _runs_dir(session)
    out: Dict[str, Dict[str, Any]] = {}
    for path in sorted(runs_dir.glob("*.json")):
        entry = _read_json(_index_path(runs_dir, path.stem))
        if entry is None:
            # Saved before the index existed: read it once, and write its entry.
            saved = _read_json(path)
            if not saved or "id" not in saved:
                continue
            result = saved.pop("result", None) or {}
            saved["summary"] = _listing_summary(result)
            saved["drawing"] = (result.get("provenance") or {}).get("drawing")
            entry = saved
            try:
                _write_json(_index_path(runs_dir, path.stem), entry)
            except OSError:
                pass
        meta = _read_json(_meta_path(runs_dir, path.stem))
        if meta:
            entry = {**entry, "meta": meta}
        if entry.get("kind") in LEGACY_KINDS:
            # Marked at read time: the files are not rewritten, and the mark goes if the kind returns.
            entry = {**entry, "legacy": True}
        out[entry["id"]] = entry
    with _JOBS_LOCK:
        for job in _JOBS.values():
            if job.user == session.user:
                out[job.id] = {**job.view(with_result=False), **({"meta": out[job.id]["meta"]} if job.id in out and "meta" in out[job.id] else {})}
    return sorted(out.values(), key=lambda r: r.get("started") or 0, reverse=True)


class RunMeta(BaseModel):
    name: Optional[str] = Field(default=None, max_length=80)
    note: Optional[str] = Field(default=None, max_length=2000)
    pinned: Optional[bool] = None


@router.patch("/runs/{run_id}")
def annotate_run(run_id: str, body: RunMeta, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """Name, note or pin a saved run. A pinned run is never pruned."""
    runs_dir = _runs_dir(session)
    if not RUN_ID_RE.match(run_id) or not (runs_dir / f"{run_id}.json").is_file():
        raise HTTPException(status_code=404, detail=f"No saved run {run_id!r}.")
    meta = _read_json(_meta_path(runs_dir, run_id)) or {}
    for key, value in body.model_dump(exclude_none=True).items():
        meta[key] = value.strip() if isinstance(value, str) else value
    _write_json(_meta_path(runs_dir, run_id), meta)
    return meta


@router.delete("/runs/{run_id}")
def delete_run(run_id: str, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """Delete a saved run of this user's, with its index entry and notes."""
    runs_dir = _runs_dir(session)
    with _JOBS_LOCK:
        live = _JOBS.get(run_id)
        if live is not None and live.user == session.user and live.status in ("queued", "running"):
            raise HTTPException(status_code=409, detail="Cancel it first.")
    if not RUN_ID_RE.match(run_id) or not (runs_dir / f"{run_id}.json").is_file():
        raise HTTPException(status_code=404, detail=f"No saved run {run_id!r}.")
    for path in _run_files(runs_dir, run_id):
        try:
            path.unlink()
        except OSError:
            pass
    return {"id": run_id, "deleted": True}


@router.get("/runs/{run_id}")
def get_run(run_id: str, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    with _JOBS_LOCK:
        job = _JOBS.get(run_id)
    if job is not None and job.user == session.user:
        return job.view()
    saved = _load_saved(session, run_id)
    if saved is None:
        raise HTTPException(status_code=404, detail=f"No run {run_id!r}.")
    if saved.get("kind") in LEGACY_KINDS:
        saved["legacy"] = True
    return saved


@router.get("/runs/{run_id}/eng")
def export_eng(
    run_id: str,
    diameter_mm: Optional[float] = Query(default=None, gt=0.0, lt=5000.0, allow_inf_nan=False),
    length_mm: Optional[float] = Query(default=None, gt=0.0, lt=10000.0, allow_inf_nan=False),
    dry_kg: Optional[float] = Query(default=None, ge=0.0, lt=10000.0, allow_inf_nan=False),
    session: UserSession = Depends(get_session),
):
    """The burn's thrust curve as a RASP .eng file for OpenRocket (engine/layerx/eng.py)."""
    from fastapi.responses import PlainTextResponse

    from engine.layerx.eng import filename, motor_header, to_eng

    run = get_run(run_id, session)
    result = run.get("result")
    if run.get("kind", "run") != "run" or run.get("status") != "done" or not result:
        raise HTTPException(status_code=400, detail="Only a finished burn exports a thrust curve.")
    motor = result.get("motor") or {}
    if motor.get("diameter_mm") is None and session.app_state.has_config():
        # A run from before the header was recorded: size it from the design loaded now, but only
        # when that is the design the run burned (same fingerprint). Otherwise the caller gives them.
        from engine.layerx.prepare import config_fingerprint

        if config_fingerprint(session.app_state.config) == (result.get("provenance") or {}).get("config_sha256"):
            result = {**result, "motor": motor_header(session.app_state.config)}
    try:
        text = to_eng(result, run_id=run_id, diameter_mm=diameter_mm, length_mm=length_mm, dry_kg=dry_kg)
        name = filename(result, run_id)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return PlainTextResponse(text, headers={"Content-Disposition": f'attachment; filename="{name}"'})


def _read_sidecar(session: UserSession, run_id: str, name: str) -> Optional[Dict[str, Any]]:
    if name not in SIDECARS or not RUN_ID_RE.match(run_id):
        return None
    return _read_json(_sidecar_path(_runs_dir(session), run_id, name))


@router.get("/runs/{run_id}/sidecar/{name}")
def get_sidecar(run_id: str, name: str, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    """A finished run's large side data (DATA-CONTRACT 4), loaded lazily by the page that draws it.
    ``axial``: ``{x_mm, t, q_MW_m2: [[...]], T_wall_K: [[...]]}``, rows on ``t``. 404 when the run
    has none (a run saved before sidecars, a replay that did not run, or another kind of job)."""
    if name not in SIDECARS:
        raise HTTPException(status_code=404, detail=f"No sidecar {name!r}; there is {', '.join(SIDECARS)}.")
    data = _read_sidecar(session, run_id, name)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} has no {name} sidecar.")
    return data


#: Export formats: media type, file suffix.
EXPORTS = {"csv": ("text/csv", "csv"), "parquet": ("application/vnd.apache.parquet", "parquet"),
           "fea": ("application/zip", "zip")}


@router.get("/runs/{run_id}/export/{fmt}")
def export_run(run_id: str, fmt: str, session: UserSession = Depends(get_session)):
    """A finished burn as a file (engine/layerx/export.py): ``csv`` every signal on the twin's
    steps (``name [unit]`` headers), ``parquet`` the same table typed, ``fea`` a zip of the
    chamber pressure, thrust and axial heat flux against time, and the peak loads."""
    from fastapi.responses import Response

    from engine.layerx import export as ex

    if fmt not in EXPORTS:
        raise HTTPException(status_code=404, detail=f"No export {fmt!r}; there is {', '.join(EXPORTS)}.")
    run = get_run(run_id, session)
    result = run.get("result")
    if run.get("kind", "run") != "run" or run.get("status") != "done" or not isinstance(result, dict) \
            or not isinstance(result.get("series"), dict):
        raise HTTPException(status_code=400, detail="Only a finished burn exports.")
    media, suffix = EXPORTS[fmt]
    try:
        if fmt == "csv":
            body: Any = ex.to_csv(result).encode("utf-8")
        elif fmt == "parquet":
            try:
                body = ex.to_parquet(result)
            except ImportError as exc:
                raise HTTPException(status_code=501, detail=f"Parquet export needs pyarrow on the server ({exc}).") from exc
        else:
            body = ex.fea_bundle(result, _read_sidecar(session, run_id, "axial"))
    except HTTPException:
        raise
    except (TypeError, ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=f"The run could not be exported: {exc}") from exc
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", f"layerx-{run_id}" + (f"-{fmt}" if fmt == "fea" else "")) + f".{suffix}"
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, session: UserSession = Depends(get_session)) -> Dict[str, Any]:
    with _JOBS_LOCK:
        job = _JOBS.get(run_id)
    if job is None or job.user != session.user:
        raise HTTPException(status_code=404, detail=f"No live run {run_id!r}.")
    job.cancel.set()
    return {"id": job.id, "status": "cancelling"}

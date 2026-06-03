"""PID diagram persistence and git-backed version control."""

import json
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any

router = APIRouter(prefix="/api/pid", tags=["pid"])

REPO_ROOT = Path(__file__).resolve().parents[2]
DIAGRAM_PATH = REPO_ROOT / "diagrams" / "pid_main.json"

def _git_root() -> Path:
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=REPO_ROOT,
                       capture_output=True, text=True)
    return Path(r.stdout.strip())

GIT_ROOT = _git_root()
# Path used in `git show <hash>:<path>` — must be relative to the git repo root.
GIT_DIAGRAM_PATH = str(DIAGRAM_PATH.relative_to(GIT_ROOT))


def _run_git(*args: str) -> str:
    """Run a git command in the repo root, return stdout. Raises RuntimeError on failure."""
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout


def _read_diagram() -> dict:
    if not DIAGRAM_PATH.exists():
        return {"nodes": [], "edges": []}
    return json.loads(DIAGRAM_PATH.read_text())


def _write_diagram(data: dict) -> None:
    DIAGRAM_PATH.parent.mkdir(parents=True, exist_ok=True)
    DIAGRAM_PATH.write_text(json.dumps(data, indent=2))


# ── Request models ────────────────────────────────────────────────────────────

class DiagramPayload(BaseModel):
    nodes: list[Any]
    edges: list[Any]


class CheckpointPayload(BaseModel):
    nodes: list[Any]
    edges: list[Any]
    title: str
    description: str = ""


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/load")
async def load_diagram():
    """Load the current diagram from disk."""
    return _read_diagram()


@router.post("/autosave")
async def autosave_diagram(payload: DiagramPayload):
    """Write diagram to disk silently — no git commit."""
    _write_diagram({"nodes": payload.nodes, "edges": payload.edges})
    return {"ok": True}


@router.post("/pull")
async def pull_latest():
    """Git pull then return the updated diagram."""
    try:
        _run_git("pull")
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=f"git pull failed: {e}")
    return _read_diagram()


@router.post("/checkpoint")
async def checkpoint(payload: CheckpointPayload):
    """Write diagram, commit, and push with a user-provided title + description."""
    _write_diagram({"nodes": payload.nodes, "edges": payload.edges})

    commit_message = payload.title.strip()
    if payload.description.strip():
        commit_message += f"\n\n{payload.description.strip()}"

    try:
        rel_path = str(DIAGRAM_PATH.relative_to(REPO_ROOT))
        _run_git("add", rel_path)
        _run_git("commit", "-m", commit_message)
        _run_git("push")
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=f"git operation failed: {e}")

    commit_hash = _run_git("rev-parse", "--short", "HEAD").strip()
    return {"ok": True, "commit": commit_hash}


@router.get("/history")
async def get_history():
    """Return the last 10 commits that touched diagrams/pid_main.json."""
    rel_path = str(DIAGRAM_PATH.relative_to(REPO_ROOT))
    try:
        log = _run_git("log", "--format=%H|%s|%aI", "-10", "--", rel_path)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=f"git log failed: {e}")

    entries = []
    for line in log.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|", 2)
        if len(parts) == 3:
            entries.append({"hash": parts[0], "title": parts[1], "timestamp": parts[2]})
    return entries


@router.get("/version/{commit_hash}")
async def get_version(commit_hash: str):
    """Return the diagram snapshot at a specific commit."""
    try:
        content = _run_git("show", f"{commit_hash}:{GIT_DIAGRAM_PATH}")
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=f"Version not found: {e}")
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Snapshot at that commit is not valid JSON")

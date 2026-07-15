"""PID diagram persistence and git-backed version control.

Checkpoints are committed to a single dedicated branch (DIAGRAM_BRANCH) that
holds only the diagram file — never to whatever code branch the developer
happens to have checked out. The commit is built with git plumbing against a
throwaway index, so the developer's working tree, index, and current branch
are left untouched. This keeps diagram history isolated from code history and
out of the code branches' CI.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any

router = APIRouter(prefix="/api/pid", tags=["pid"])

# Dedicated branch that stores diagram checkpoints. Excluded from CI in
# .github/workflows/pid-designer-ci.yml so checkpoints never trigger a build.
DIAGRAM_BRANCH = "pid-diagrams"

REPO_ROOT = Path(__file__).resolve().parents[2]
DIAGRAM_PATH = REPO_ROOT / "diagrams" / "pid_main.json"

def _git_root() -> Path:
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=REPO_ROOT,
                       capture_output=True, text=True)
    return Path(r.stdout.strip())

GIT_ROOT = _git_root()
# Path used in `git show <hash>:<path>` — must be relative to the git repo root.
GIT_DIAGRAM_PATH = str(DIAGRAM_PATH.relative_to(GIT_ROOT))


def _run_git(*args: str, env: dict | None = None) -> str:
    """Run a git command in the repo root, return stdout. Raises RuntimeError on failure."""
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout


def _resolve(ref: str) -> str | None:
    """Return the commit sha a ref points to, or None if it doesn't exist."""
    try:
        return _run_git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").strip() or None
    except RuntimeError:
        return None


def _fetch_diagram_branch() -> None:
    """Best-effort fetch of the diagram branch so remote-tracking ref is current.

    Silently ignored when the branch doesn't exist on the remote yet (first
    ever checkpoint) or when offline — callers fall back to local refs.
    """
    try:
        _run_git("fetch", "origin", DIAGRAM_BRANCH)
    except RuntimeError:
        pass


def _diagram_ref() -> str | None:
    """Best available ref for reading diagram history: remote-tracking, then local."""
    return _resolve(f"refs/remotes/origin/{DIAGRAM_BRANCH}") or _resolve(f"refs/heads/{DIAGRAM_BRANCH}")


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
    """Fetch the latest diagram from the diagram branch and write it to disk.

    Only the diagram file is materialized — the developer's working tree and
    current branch are untouched (no `git pull`/checkout).
    """
    _fetch_diagram_branch()
    ref = _diagram_ref()
    if not ref:
        # No checkpoints pushed yet; just return whatever is on disk.
        return _read_diagram()
    try:
        content = _run_git("show", f"{ref}:{GIT_DIAGRAM_PATH}")
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=f"git show failed: {e}")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Latest diagram snapshot is not valid JSON")
    _write_diagram(data)
    return data


@router.post("/checkpoint")
async def checkpoint(payload: CheckpointPayload):
    """Write the diagram and commit it onto the dedicated diagram branch.

    The commit is assembled with git plumbing against a temporary index so the
    developer's working tree, staged changes, and current branch are never
    touched. The new commit is pushed to origin/<DIAGRAM_BRANCH>; the local
    branch ref is updated to match.
    """
    _write_diagram({"nodes": payload.nodes, "edges": payload.edges})

    commit_message = payload.title.strip()
    if not commit_message:
        raise HTTPException(status_code=400, detail="Checkpoint title is required")
    if payload.description.strip():
        commit_message += f"\n\n{payload.description.strip()}"

    # Parent is the current tip of the diagram branch (remote preferred), if any.
    _fetch_diagram_branch()
    parent = _diagram_ref()

    # Build the commit against a throwaway index that contains ONLY the diagram
    # file, so nothing else from the working tree leaks into the diagram branch.
    fd, tmp_index = tempfile.mkstemp(prefix="pid-index-")
    os.close(fd)
    # Remove the empty placeholder: git treats a 0-byte index as corrupt. It
    # creates a fresh index at this path on first write instead.
    os.unlink(tmp_index)
    try:
        env = {**os.environ, "GIT_INDEX_FILE": tmp_index}
        rel_path = str(DIAGRAM_PATH.relative_to(REPO_ROOT))

        # Seed the temp index from the parent tree (if any) so the commit is a
        # clean delta on the diagram branch, then stage just the diagram file.
        if parent:
            _run_git("read-tree", parent, env=env)
        _run_git("add", "--", rel_path, env=env)
        tree = _run_git("write-tree", env=env).strip()

        commit_args = ["commit-tree", tree, "-m", commit_message]
        if parent:
            commit_args += ["-p", parent]
        new_commit = _run_git(*commit_args).strip()

        # Move the local branch ref and push. Use an explicit refspec so we never
        # depend on (or disturb) the developer's checked-out branch or upstream.
        _run_git("update-ref", f"refs/heads/{DIAGRAM_BRANCH}", new_commit)
        _run_git("push", "origin", f"{new_commit}:refs/heads/{DIAGRAM_BRANCH}")
        # Keep the remote-tracking ref in sync so /history and /pull see it.
        _run_git("update-ref", f"refs/remotes/origin/{DIAGRAM_BRANCH}", new_commit)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=f"git operation failed: {e}")
    finally:
        if os.path.exists(tmp_index):
            os.unlink(tmp_index)

    return {"ok": True, "commit": new_commit[:7]}


@router.get("/history")
async def get_history():
    """Return the last 10 commits that touched diagrams/pid_main.json."""
    _fetch_diagram_branch()
    ref = _diagram_ref()
    if not ref:
        return []
    try:
        # `:(top)` forces the pathspec to be resolved from the git root rather
        # than the process cwd (which is REPO_ROOT == pid-designer/, a subdir of
        # the git root), so the filter matches the diagram's actual path.
        log = _run_git("log", "--format=%H|%s|%aI", "-10", ref, "--", f":(top){GIT_DIAGRAM_PATH}")
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

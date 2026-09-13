"""Importing straight out of the other design tools, not out of a file dialog.

feed-twin is the fourth app on a shared document layer. EngineDesign,
pid-designer and recovery-calculator all mount :mod:`stardesign.documents`,
which gives every design an owner, a share list, automatic microversions and
named, immutable **releases**. A drawing in that store is a far better thing to
import than a file somebody exported to their Downloads folder, for three
reasons that all bite eventually:

*Identity.* The store answers "which designs may this person open" -- so
feed-twin forwards the caller's identity header and asks the same question,
rather than being a hole in the fleet's access model.

*Immutability where it matters.* A release is a label on bytes that cannot
change. Pull one and the provenance chain closes: this run used pid-designer
diagram ``ox-stand`` at release ``0.3``, and that phrase means one thing
forever. Pulling the *working copy* is also allowed and is often what you want
mid-session -- but it is recorded as the working copy, so nobody later mistakes
it for a milestone.

*No re-export step.* The loop today is: save in pid-designer, find the export
button, download, switch tabs, drag the file in. Every one of those is a chance
to import last week's drawing.

This module knows only how to *talk* to those stores. What arrives is handed to
the same content-addressed library an uploaded file goes to, so a pulled
artifact and an uploaded one are the same kind of thing -- and if they are the
same bytes, they are literally the same artifact.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from backend.library import ArtifactKind

import httpx

#: Headers forwarded from the caller to the design tool. Only identity: Caddy
#: sets ``X-Auth-Email`` in front of every app in the fleet, and a request
#: without it is the local dev user rather than a rejection -- see
#: stardesign.userdata. Nothing else is forwarded, because nothing else is ours
#: to pass on.
FORWARD = ("X-Auth-Email",)

#: How long to wait on a sibling tool. Short: these are same-network calls, and
#: a design tool that is down should be reported as down within a couple of
#: seconds rather than hanging the import panel.
TIMEOUT = 8.0


def _diagram_bytes(payload: Mapping[str, Any]) -> bytes:
    """A pid-designer document is already the shape feed-twin reads."""
    return json.dumps(
        {"nodes": payload.get("nodes") or [], "edges": payload.get("edges") or []},
        indent=1,
    ).encode("utf-8")


def _engine_bytes(payload: Mapping[str, Any]) -> bytes:
    """An EngineDesign document wraps the config; feed-twin wants the config.

    Written back out as YAML because that is what the Layer-1 importer reads and
    what a person would recognise if they opened the stored artifact. The ``ui``
    block is dropped: it is editor state, not a boundary condition.
    """
    import yaml

    config = payload.get("config")
    if not isinstance(config, Mapping):
        raise DesignToolError(
            "that document has no 'config' block, so it is not an engine design"
        )
    dumped: str = yaml.safe_dump(dict(config), sort_keys=False)
    return dumped.encode("utf-8")


@dataclass(frozen=True, slots=True)
class DesignTool:
    """One sibling app's document store.

    Args:
        key: Short id used in routes and in an artifact's ``source``.
        label: What a person calls it.
        kind: What feed-twin will store the result as.
        base_url: Where the app's API lives. Overridable by environment so the
            same build runs against dev, a laptop, and the deployed fleet.
        documents: Route prefix of its document router.
        extract: Turns a loaded document into the bytes feed-twin stores.
        suffix: Extension for the stored blob.
    """

    key: str
    label: str
    kind: ArtifactKind
    base_url: str
    documents: str
    extract: Callable[[Mapping[str, Any]], bytes]
    suffix: str


class DesignToolError(RuntimeError):
    """A sibling tool could not be reached, or did not answer usefully."""


#: Swapped for an ``httpx.MockTransport`` in tests. A seam rather than a mock
#: library: the point of testing this module is that the *requests it builds*
#: are right -- the paths, the forwarded headers, the release-versus-working
#: choice -- and a transport is the last place those are still visible.
transport: httpx.AsyncBaseTransport | None = None


def _client(headers: Mapping[str, str]) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=TIMEOUT, headers=forwarded(headers), transport=transport
    )


def _env(name: str, default: str) -> str:
    return (os.environ.get(name) or default).rstrip("/")


def tools() -> dict[str, DesignTool]:
    """The design tools this instance can import from.

    Defaults are the **local dev ports** each app's ``dev.sh`` fixes, so a
    developer who runs two of these gets a working import panel with no
    configuration. The deployed fleet sets the environment variables to the
    compose service names, which is the one place that knows them.

    Defaulting the other way round was worse in the case that matters: on a
    laptop every tool showed as offline, and the fix was an environment
    variable nobody had a reason to look for.
    """
    return {
        "pid-designer": DesignTool(
            key="pid-designer",
            label="pid-designer",
            kind="diagram",
            base_url=_env("PID_DESIGNER_URL", "http://127.0.0.1:8001"),
            documents="/api/pid/diagrams",
            extract=_diagram_bytes,
            suffix=".json",
        ),
        "engine-design": DesignTool(
            key="engine-design",
            label="EngineDesign",
            kind="engine",
            base_url=_env("ENGINE_DESIGN_URL", "http://127.0.0.1:8000"),
            documents="/api/engine/documents",
            extract=_engine_bytes,
            suffix=".yaml",
        ),
    }


def forwarded(headers: Mapping[str, str]) -> dict[str, str]:
    """The subset of the caller's headers we pass on: identity, and only that."""
    out: dict[str, str] = {}
    for name in FORWARD:
        value = headers.get(name) or headers.get(name.lower())
        if value:
            out[name] = value
    return out


async def _get(
    client: httpx.AsyncClient, tool: DesignTool, path: str, **params: Any
) -> Any:
    url = f"{tool.base_url}{path}"
    try:
        response = await client.get(url, params={k: v for k, v in params.items() if v})
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as exc:
        raise DesignToolError(
            f"{tool.label} answered {exc.response.status_code} for {path}"
            + (
                ". That design may not be shared with you."
                if exc.response.status_code == 403
                else ""
            )
        ) from exc
    except httpx.HTTPError as exc:
        raise DesignToolError(
            f"could not reach {tool.label} at {tool.base_url} ({exc}). Set "
            f"{'PID_DESIGNER_URL' if tool.key == 'pid-designer' else 'ENGINE_DESIGN_URL'} "
            "if it is somewhere else."
        ) from exc


async def list_documents(
    tool: DesignTool, headers: Mapping[str, str]
) -> list[dict[str, Any]]:
    """Everything the caller could import: their own, shared, and browsable.

    Two calls, because the store separates them: ``/`` is what you may edit and
    ``/browse`` is everyone else's, grouped by owner. feed-twin never edits
    either, so the distinction it keeps is not "editable" but *whose it is* --
    which is the only part a person picking a drawing cares about.
    """
    async with _client(headers) as c:
        mine = await _get(c, tool, tool.documents)
        try:
            others = await _get(c, tool, f"{tool.documents}/browse")
        except DesignToolError:
            # Browsing is a convenience; a store that will not answer it should
            # not stop somebody importing their own work.
            others = []

    out: list[dict[str, Any]] = []
    for record in mine if isinstance(mine, list) else []:
        out.append(
            {
                "id": record.get("id", ""),
                "name": record.get("name") or record.get("id", ""),
                "owner": record.get("owner", ""),
                "owner_name": record.get("ownerName") or "",
                "updated_at": record.get("updatedAt") or "",
                "mine": True,
            }
        )
    for group in others if isinstance(others, list) else []:
        for record in group.get("designs", []):
            out.append(
                {
                    "id": record.get("id", ""),
                    "name": record.get("name") or record.get("id", ""),
                    "owner": group.get("owner", ""),
                    "owner_name": group.get("ownerName") or group.get("owner", ""),
                    "updated_at": record.get("updatedAt") or "",
                    "mine": False,
                }
            )
    out.sort(key=lambda d: (not d["mine"], d["updated_at"]), reverse=False)
    return out


async def releases(
    tool: DesignTool, doc_id: str, owner: str, headers: Mapping[str, str]
) -> list[dict[str, Any]]:
    """Named, immutable milestones of one document, newest first."""
    async with _client(headers) as c:
        found = await _get(c, tool, f"{tool.documents}/{doc_id}/releases", owner=owner)
    if not isinstance(found, list):
        return []
    return [
        {
            "label": str(r.get("label", "")),
            "saved_at": r.get("savedAt") or "",
        }
        for r in found
        if r.get("label")
    ]


async def fetch(
    tool: DesignTool,
    doc_id: str,
    *,
    owner: str = "",
    release: str = "",
    headers: Mapping[str, str] | None = None,
) -> tuple[bytes, str]:
    """Pull one document. Returns its bytes and a provenance string.

    ``release`` empty means the working copy -- the freshest state, and what
    somebody mid-session usually wants. The provenance string says which was
    taken, so a result never has to be interpreted to find out.
    """
    headers = headers or {}
    path = (
        f"{tool.documents}/{doc_id}/release/{release}"
        if release
        else f"{tool.documents}/{doc_id}/load"
    )
    async with _client(headers) as c:
        payload = await _get(c, tool, path, owner=owner)

    if not isinstance(payload, Mapping):
        raise DesignToolError(f"{tool.label} returned no document for {doc_id!r}")
    document: Mapping[str, Any] = payload
    # Both routes return the stored snapshot itself -- {"nodes","edges"} or
    # {"config","ui"}. The "data" unwrap is a guard for a store that grows an
    # envelope later, not a shape either one uses today.
    inner = document.get("data")
    body: Mapping[str, Any] = inner if isinstance(inner, Mapping) else document

    where = f"{owner}/{doc_id}" if owner else doc_id
    stamp = f"release {release}" if release else "working copy"
    return tool.extract(body), f"{tool.key}:{where}@{stamp}"

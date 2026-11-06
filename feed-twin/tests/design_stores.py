"""Real design-tool stores, in process, for the tests that pull from them.

A stub transport answers what the test writer thought the store answers;
these are :mod:`stardesign.documents` itself, mounted the way EngineDesign
(``open_to_all`` off, not curated) and pid-designer (curated, featured) mount
it, behind ``designtools.transport``. Two people's access is then the store's
own decision, which is the thing a pull must not widen.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel
from stardesign.documents import DesignStore, make_router
from stardesign.storage import LocalBackend
from stardesign.userdata import UserData

from backend import designtools


class _Config(BaseModel):
    config: dict[str, Any] = {}
    ui: dict[str, Any] = {}


class _ConfigCreate(BaseModel):
    name: str
    config: dict[str, Any] | None = None
    ui: dict[str, Any] | None = None


class _ConfigRelease(BaseModel):
    label: str
    config: dict[str, Any] | None = None
    ui: dict[str, Any] | None = None


class _Diagram(BaseModel):
    nodes: list[Any] = []
    edges: list[Any] = []


class _DiagramCreate(BaseModel):
    name: str


class _DiagramRelease(BaseModel):
    label: str
    nodes: list[Any] | None = None
    edges: list[Any] | None = None


def engine_design(root: Path) -> FastAPI:
    """EngineDesign's store: designs are their owner's and their share list's."""
    ud = UserData(f"engine-{uuid.uuid4().hex[:6]}", root)
    store = DesignStore(
        ud=ud,
        backend=LocalBackend(ud),
        body_model=_Config,
        create_model=_ConfigCreate,
        release_model=_ConfigRelease,
        to_data=lambda p: {
            "config": getattr(p, "config", None) or {},
            "ui": getattr(p, "ui", None) or {},
        },
        release_body=lambda p: (
            None if p.config is None else {"config": p.config, "ui": p.ui or {}}
        ),
        empty_payload=lambda: {"config": {}, "ui": {}},
    )
    app = FastAPI()
    app.include_router(make_router(store, prefix="/api/engine/documents"))
    return app


def pid_designer(root: Path) -> FastAPI:
    """pid-designer's store: curated, with a main diagram."""
    ud = UserData(f"pid-{uuid.uuid4().hex[:6]}", root)
    store = DesignStore(
        ud=ud,
        backend=LocalBackend(ud),
        body_model=_Diagram,
        create_model=_DiagramCreate,
        release_model=_DiagramRelease,
        to_data=lambda p: {
            "nodes": getattr(p, "nodes", None) or [],
            "edges": getattr(p, "edges", None) or [],
        },
        release_body=lambda p: (
            None
            if p.nodes is None and p.edges is None
            else {"nodes": p.nodes or [], "edges": p.edges or []}
        ),
        noun="diagram",
        empty_payload=lambda: {"nodes": [], "edges": []},
        featured=True,
        main_admin_only=False,
        curated=True,
    )
    app = FastAPI()
    app.include_router(make_router(store, prefix="/api/pid", sub="/diagrams"))
    return app


class _Both(httpx.AsyncBaseTransport):
    """Each request to the store its path names."""

    def __init__(self, engine: FastAPI, pid: FastAPI) -> None:
        self.engine = httpx.ASGITransport(app=engine)
        self.pid = httpx.ASGITransport(app=pid)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/api/engine/"):
            return await self.engine.handle_async_request(request)
        return await self.pid.handle_async_request(request)


class Tools:
    """The two stores, and a client on each to act in them as a person."""

    def __init__(self, root: Path) -> None:
        self.engine_app = engine_design(root)
        self.pid_app = pid_designer(root)
        self.engine = TestClient(self.engine_app)
        self.pid = TestClient(self.pid_app)
        self.transport = _Both(self.engine_app, self.pid_app)


@pytest.fixture
def stores(tmp_path: Path) -> Iterator[Tools]:
    """Both design tools, wired in as what feed-twin pulls from."""
    tools = Tools(tmp_path)
    designtools.transport = tools.transport
    try:
        yield tools
    finally:
        designtools.transport = None


def who(email: str) -> dict[str, str]:
    """The header Caddy sets in front of every app."""
    return {"X-Auth-Email": email}

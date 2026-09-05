"""Persistent cache for the model picker's Onshape lookups.

Onshape bills per API call against a finite quota, and the picker was the most
expensive thing in the app that produces no artifact: a debounced search fired
one `/documents` call per typing pause, so browsing for a model could cost more
requests than building one.

So the picker reads from here instead. Everything Onshape has ever told us about
a document or an assembly tab is kept on disk and served without a network call;
the only thing that talks to Onshape is an explicit refresh the user asked for.

There is deliberately no TTL. A time-based cache still repulls on its own
schedule, which is exactly the behaviour that costs quota without anyone
choosing it. Staleness here is cheap and visible -- the UI shows when the data
was fetched and offers a refresh -- whereas a surprise bill is not.

The store is a single JSON file rather than SQLite: it holds a few hundred small
records, it is rewritten whole, and being hand-readable makes "why is this
document missing" a `jq` question.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

#: Bumped when the on-disk shape changes; an older file is discarded, not
#: migrated, because every field in it can be re-fetched.
SCHEMA_VERSION = 1

_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _empty() -> dict[str, Any]:
    return {
        "version": SCHEMA_VERSION,
        # documentId -> document record. A union of everything ever seen, so a
        # search for "nose" still finds a document first surfaced by "rocket".
        "documents": {},
        # Normalised query -> the documentIds Onshape answered it with, in rank
        # order. Replaying a past query has to give back exactly what Onshape
        # said, because its ranking is not a substring match: searching "rocket"
        # on this account returns six documents, none of which have "rocket" in
        # the name (it matches the owner, "UC Berkeley Space Technologies and
        # Rocketry", among other fields). Without this, pressing "search
        # Onshape" showed six results and typing one more character showed none.
        "queries": {},
        # "{documentId}/{workspaceId}" -> {"items": [...], "cachedAt": ...}
        "assemblies": {},
        "documentsRefreshedAt": None,
    }


class BrowseCache:
    """Reads and writes the picker's document/assembly cache.

    Safe to call from FastAPI's threadpool: every mutation takes the module lock
    and rewrites the file atomically, so a crash mid-write cannot leave a
    truncated JSON file that makes the picker permanently empty.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    # -- storage --------------------------------------------------------------

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return _empty()
        if not isinstance(data, dict) or data.get("version") != SCHEMA_VERSION:
            return _empty()
        # Guard the containers individually: a hand-edited file that dropped one
        # key should not take out the whole cache.
        for key in ("documents", "queries", "assemblies"):
            if not isinstance(data.get(key), dict):
                data[key] = {}
        return data

    def _save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-rename so a reader never observes a partial file.
        handle, tmp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(handle, "w") as stream:
                json.dump(data, stream, indent=1)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    # -- documents ------------------------------------------------------------

    @staticmethod
    def _normalise(query: str) -> str:
        return " ".join(query.split()).lower()

    def search_documents(self, query: str) -> dict[str, Any]:
        """Documents already known, matched locally. Costs nothing.

        Two ways a term can match, in order:

        1. If this exact query was refreshed before, replay Onshape's own answer
           in its own rank order. Onshape matches more than the name, so this is
           the only way a repeat of a query stays faithful to it -- and it is
           what makes pressing "search Onshape" twice for the same term free.
        2. Otherwise, a case-insensitive substring of the document name. Owner is
           deliberately not matched: nearly every document on this account is
           owned by "UC Berkeley Space Technologies and Rocketry", so including
           it made "rocket" return the entire library.

        An empty query returns everything cached, newest-modified first.
        """
        with _lock:
            data = self._load()

        term = self._normalise(query)
        documents = data["documents"]

        remembered = data["queries"].get(term) if term else None
        if isinstance(remembered, list):
            items = [documents[did] for did in remembered if did in documents]
            return {
                "items": items,
                "fromCache": True,
                "cachedAt": data.get("documentsRefreshedAt"),
            }

        items = list(documents.values())
        if term:
            items = [item for item in items if term in (item.get("name") or "").lower()]
        # Most-recently-modified first, which is what a picker wants; records
        # with no modifiedAt sort last rather than crashing the comparison.
        items.sort(key=lambda item: item.get("modifiedAt") or "", reverse=True)
        return {
            "items": items,
            "fromCache": True,
            "cachedAt": data.get("documentsRefreshedAt"),
        }

    def store_documents(
        self, documents: list[dict[str, Any]], query: str = ""
    ) -> dict[str, Any]:
        """Merge a live result into the index and return it in Onshape's order.

        Merging rather than replacing: a search for "rocket" returns at most 20
        documents, and replacing would evict everything the user found earlier
        in the session, making the next lookup cost another call.

        `query` is recorded alongside so the same search can be replayed for
        free later; see `search_documents`.
        """
        stamp = _now()
        term = self._normalise(query)
        with _lock:
            data = self._load()
            for document in documents:
                document_id = document.get("documentId")
                if not document_id:
                    continue
                data["documents"][document_id] = {**document, "seenAt": stamp}
            if term:
                data["queries"][term] = [
                    document["documentId"]
                    for document in documents
                    if document.get("documentId")
                ]
            data["documentsRefreshedAt"] = stamp
            self._save(data)
        return {"items": list(documents), "fromCache": False, "cachedAt": stamp}

    # -- assemblies -----------------------------------------------------------

    @staticmethod
    def _assembly_key(document_id: str, workspace_id: str) -> str:
        return f"{document_id}/{workspace_id}"

    def get_assemblies(
        self, document_id: str, workspace_id: str
    ) -> dict[str, Any] | None:
        """Cached assembly tabs, or None if this document was never expanded."""
        with _lock:
            data = self._load()
        entry = data["assemblies"].get(self._assembly_key(document_id, workspace_id))
        if not isinstance(entry, dict):
            return None
        return {
            "items": entry.get("items", []),
            "fromCache": True,
            "cachedAt": entry.get("cachedAt"),
        }

    def store_assemblies(
        self, document_id: str, workspace_id: str, assemblies: list[dict[str, Any]]
    ) -> dict[str, Any]:
        stamp = _now()
        with _lock:
            data = self._load()
            data["assemblies"][self._assembly_key(document_id, workspace_id)] = {
                "items": assemblies,
                "cachedAt": stamp,
            }
            self._save(data)
        return {"items": assemblies, "fromCache": False, "cachedAt": stamp}

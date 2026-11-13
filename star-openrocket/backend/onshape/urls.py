"""Onshape document URL parsing and workspace-to-immutable-ref resolution.

orkv2.md 3.3 requires building against something immutable, so that the GLB and
the manifest cannot be generated from two different states of the model. It
names versions as the way to get that.

Versions are not the only immutable handle. Microversions are equally immutable
and always exist, so a workspace URL is pinned to the workspace's *current*
microversion: the model as it stands now, frozen for the length of the build.

A workspace URL used to resolve to the newest *version* that had geometry. That
built whatever someone last named -- LE4 SD's "V61", a week stale, while the team
had been editing it all day -- and nothing on screen said so. A /w/ link is
someone pointing at the live model; to build a named version, paste its /v/ URL.

The lookup of the current microversion is never served from the disk cache: the
cache is keyed by request, so a cached answer would pin the first build's state
forever.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .client import OnshapeClient, OnshapeError

# Matches both cad.onshape.com and enterprise hosts, with or without a trailing
# path or query string.
_URL_RE = re.compile(
    r"/documents/(?P<did>[0-9a-f]{24})"
    r"(?:/(?P<wvm>[wvm])/(?P<wvmid>[0-9a-f]{24}))?"
    r"(?:/e/(?P<eid>[0-9a-f]{24}))?",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class DocumentRef:
    """A parsed Onshape URL, before resolution."""

    document_id: str
    wvm: str  # 'w', 'v' or 'm'
    wvm_id: str
    element_id: str | None


@dataclass
class ResolvedRef:
    """An immutable handle to build against.

    `wvm`/`wvm_id` are what goes into API paths. `resolved_from` records how we
    got there so the manifest can be honest about it.
    """

    document_id: str
    element_id: str
    wvm: str
    wvm_id: str
    resolved_from: str
    version_id: str | None = None
    microversion_id: str | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def path_prefix(self) -> str:
        """Document-and-ref segment, without an element."""
        return f"d/{self.document_id}/{self.wvm}/{self.wvm_id}"

    @property
    def element_path(self) -> str:
        """Full path segment for endpoints scoped to this assembly tab."""
        return f"{self.path_prefix}/e/{self.element_id}"


def parse_document_url(url: str) -> DocumentRef:
    """Extract document/wvm/element ids from an Onshape URL.

    Raises OnshapeError if the URL is not recognisable, rather than returning a
    half-populated ref that fails confusingly several calls later.
    """
    match = _URL_RE.search(url)
    if not match or not match.group("wvm"):
        raise OnshapeError(
            f"Could not parse an Onshape document URL from {url!r}. Expected the form "
            "https://<host>/documents/{did}/{w|v|m}/{wvmid}/e/{eid}"
        )
    return DocumentRef(
        document_id=match.group("did"),
        wvm=match.group("wvm").lower(),
        wvm_id=match.group("wvmid"),
        element_id=match.group("eid"),
    )


def resolve(client: OnshapeClient, ref: DocumentRef, element_id: str | None = None) -> ResolvedRef:
    """Turn a parsed URL into an immutable ref to build against.

    Resolution order:
      * ``/v/`` or ``/m/`` -- already immutable, used as-is.
      * ``/w/`` -- pinned to the workspace's current microversion (asked live).
    """
    eid = element_id or ref.element_id
    if not eid:
        raise OnshapeError(
            "No element id in the URL. Open the assembly tab in Onshape and copy that URL."
        )

    if ref.wvm == "v":
        return ResolvedRef(ref.document_id, eid, "v", ref.wvm_id, "version", version_id=ref.wvm_id)

    if ref.wvm == "m":
        return ResolvedRef(
            ref.document_id, eid, "m", ref.wvm_id, "microversion", microversion_id=ref.wvm_id
        )

    return _resolve_workspace(client, ref.document_id, ref.wvm_id, eid)


def _resolve_workspace(client: OnshapeClient, did: str, wid: str, eid: str) -> ResolvedRef:
    payload = client.get_json(f"/documents/d/{did}/w/{wid}/currentmicroversion", cache=False)
    microversion = (payload or {}).get("microversion")
    if not microversion:
        raise OnshapeError(
            f"Workspace {wid} reported no current microversion; cannot pin an immutable build."
        )
    return ResolvedRef(
        did, eid, "m", microversion, "workspace-microversion",
        microversion_id=microversion,
        warnings=[
            f"Built the workspace as it stands now (microversion {microversion}). "
            "To build a named version instead, use that version's /v/ URL."
        ],
    )


def _get_assembly(client: OnshapeClient, did: str, wvm: str, wvmid: str, eid: str) -> dict:
    return client.get_json(
        f"/assemblies/d/{did}/{wvm}/{wvmid}/e/{eid}",
        {
            "includeMateFeatures": "false",
            "includeNonSolids": "false",
            "excludeSuppressed": "true",
        },
    )

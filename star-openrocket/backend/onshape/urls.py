"""Onshape document URL parsing and workspace-to-immutable-ref resolution.

orkv2.md 3.3 requires building against something immutable, so that the GLB and
the manifest cannot be generated from two different states of the model. It
names versions as the way to get that.

Versions are not the only immutable handle, and on real documents they are often
not an available one -- the BART document this was built against has exactly one
version, cut at document creation, containing zero instances. Microversions are
equally immutable and always exist, so when no usable version is present the
resolver pins the workspace's *current* microversion and builds against that.
The result is just as reproducible; it is only less human-meaningful.
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
      * ``/w/`` -- prefer the newest version that actually contains geometry;
        otherwise pin the workspace's current microversion and warn.
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
    warnings: list[str] = []

    versions = client.get_json(f"/documents/d/{did}/versions")
    # The API returns versions oldest-first; the creation-time version is the
    # one we most want to avoid silently selecting.
    candidates = [v for v in reversed(versions) if v.get("id")]

    for version in candidates:
        vid = version["id"]
        if _assembly_is_populated(client, did, "v", vid, eid):
            return ResolvedRef(
                did, eid, "v", vid, "version", version_id=vid,
                warnings=[f"Resolved workspace to version {version.get('name')!r} ({vid})."],
            )
        warnings.append(
            f"Version {version.get('name')!r} ({vid}) contains no geometry for this "
            "assembly; skipped."
        )

    # No version has anything in it. Pin the workspace's current microversion --
    # immutable, so the build stays reproducible, just not tied to a named version.
    assembly = _get_assembly(client, did, "w", wid, eid)
    microversion = assembly.get("rootAssembly", {}).get("documentMicroversion")
    if not microversion:
        raise OnshapeError(
            f"Workspace {wid} returned an assembly with no documentMicroversion; "
            "cannot pin an immutable build."
        )

    warnings.append(
        f"No version of this document contains geometry, so the build is pinned to the "
        f"workspace's current microversion {microversion}. This is immutable and "
        f"reproducible, but it is not a named version -- cut a version in Onshape for a "
        f"human-meaningful build key."
    )
    return ResolvedRef(
        did, eid, "m", microversion, "workspace-microversion",
        microversion_id=microversion, warnings=warnings,
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


def _assembly_is_populated(client: OnshapeClient, did: str, wvm: str, wvmid: str, eid: str) -> bool:
    """True if this ref's assembly actually has occurrences.

    A version cut before any modelling happened returns HTTP 200 with an empty
    instance list, which would otherwise build a valid, empty, useless model.
    """
    try:
        assembly = _get_assembly(client, did, wvm, wvmid, eid)
    except OnshapeError:
        # The element may not exist at that version at all.
        return False
    return bool(assembly.get("rootAssembly", {}).get("occurrences"))

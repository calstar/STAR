"""The artifact library: what has been imported, and exactly what it was.

A run is only reproducible if you can say what it was run *on*. So an imported
drawing or engine config is not a file somebody dropped in a folder -- it is an
**artifact**: content-addressed, versioned by its own bytes, with a record of
where it came from and when.

Three properties fall out of doing it that way, and all three are the difference
between a tool and a toy:

**The same bytes are the same artifact.** Importing a drawing twice does not make
two of them; it makes one, with the second import recorded as a re-upload. A run
that names ``a3f9c1...`` names a specific drawing forever.

**A changed drawing is a different artifact.** Not a mutation of the old one. So
a result from last week still points at the thing that produced it, and the
difference between two runs can be attributed rather than guessed at.

**Nothing is silently overwritten.** Re-importing under the same name creates a
new version; the old one keeps its hash and stays addressable.

The store is a directory of content-addressed blobs plus one manifest. That is
deliberately boring: a Postgres would be a dependency to run, back up and
migrate, and would buy nothing until several people are importing at once. When
that day comes, this module's interface is what a database implementation
implements -- which is why the storage is behind it rather than spread through
the routes.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
import os
from pathlib import Path
from typing import Iterable, Literal

ArtifactKind = Literal["diagram", "engine"]

#: Where blobs and the manifest live.
#:
#: Read from the environment rather than fixed, for two reasons that turned out
#: to be the same one. A deployment puts the library on a mounted volume, not
#: inside the image. And the test suite needs a store of its own -- pointing at
#: the shipped one made every listing assertion depend on whatever the last
#: person happened to import, which is a suite that fails for reasons unrelated
#: to the change under test.
DEFAULT_ROOT = Path(
    os.environ.get("FEEDTWIN_LIBRARY") or Path(__file__).parent / "library"
)


class LibraryError(ValueError):
    """The artifact could not be stored or read."""


@dataclass(frozen=True, slots=True)
class Artifact:
    """One imported thing, addressed by the hash of its own bytes."""

    id: str
    """First 12 hex of the sha256. Short enough to read, long enough to be
    unique across anything this team will ever import."""

    kind: ArtifactKind
    name: str
    """Human name. Not unique -- several versions share it."""

    sha256: str
    size: int
    imported_at: str
    source: str
    """Where it came from: ``upload``, ``pid-designer``, or a file path. Part of
    the audit trail, not decoration -- "which of these did the optimiser
    actually write" is a question that gets asked."""

    filename: str
    notes: str = ""
    #: Extracted at import so a listing can be useful without opening the blob.
    summary: dict[str, object] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return f"{self.name} · {self.id}"


class Library:
    """A content-addressed store of imported artifacts."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root or DEFAULT_ROOT)
        self.blobs = self.root / "blobs"
        self.manifest_path = self.root / "manifest.json"
        self.blobs.mkdir(parents=True, exist_ok=True)

    # ----------------------------------------------------------- the manifest

    def _read(self) -> list[Artifact]:
        if not self.manifest_path.exists():
            return []
        try:
            raw = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise LibraryError(
                f"the library manifest at {self.manifest_path} is not readable "
                f"({exc}). It is a plain JSON list; a corrupt one can be deleted "
                "and the blobs re-imported rather than lost."
            ) from exc
        return [Artifact(**entry) for entry in raw]

    def _write(self, artifacts: Iterable[Artifact]) -> None:
        payload = [asdict(a) for a in artifacts]
        # Written whole and replaced, so a crash mid-write cannot leave a
        # half-manifest that loses every artifact recorded before it.
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        temporary.replace(self.manifest_path)

    # -------------------------------------------------------------- the store

    def list(self, kind: ArtifactKind | None = None) -> list[Artifact]:
        """Newest first, optionally of one kind."""
        artifacts = self._read()
        if kind is not None:
            artifacts = [a for a in artifacts if a.kind == kind]
        return sorted(artifacts, key=lambda a: a.imported_at, reverse=True)

    def get(self, artifact_id: str) -> Artifact:
        for artifact in self._read():
            if artifact.id == artifact_id:
                return artifact
        known = ", ".join(a.id for a in self._read()) or "(the library is empty)"
        raise LibraryError(f"no artifact {artifact_id!r}. Imported: {known}")

    def path(self, artifact_id: str) -> Path:
        artifact = self.get(artifact_id)
        blob = self.blobs / artifact.filename
        if not blob.exists():
            raise LibraryError(
                f"artifact {artifact_id} is in the manifest but its blob is "
                f"missing from {self.blobs}. Re-import it."
            )
        return blob

    def read(self, artifact_id: str) -> bytes:
        return self.path(artifact_id).read_bytes()

    def add(
        self,
        data: bytes,
        *,
        kind: ArtifactKind,
        name: str,
        source: str,
        suffix: str,
        summary: dict[str, object] | None = None,
        notes: str = "",
    ) -> tuple[Artifact, bool]:
        """Store bytes. Returns the artifact and whether it was already there.

        Content-addressed, so importing the same drawing twice is idempotent --
        it returns the existing artifact rather than making a second one. That
        matters more than it sounds: without it, saving from pid-designer twice
        in a session leaves two ids for one drawing and a run that cannot say
        which it used.

        The **summary is refreshed** on a repeat import even though the bytes
        are unchanged. Content addressing promises the bytes are the same; it
        promises nothing about a summary, which is derived by code that gets
        fixed. Keeping the first one meant an importer fix never reached a
        drawing already in the library: the config whose O/F and chamber
        pressure had been sorted out went on reporting the warnings it was
        imported with, and re-importing it -- the obvious thing to try -- was
        precisely the operation that did nothing.
        """
        digest = hashlib.sha256(data).hexdigest()
        artifact_id = digest[:12]

        existing = next((a for a in self._read() if a.id == artifact_id), None)
        if existing is not None:
            if summary is not None and summary != existing.summary:
                existing = self._resummarise(existing, summary)
            return existing, True

        filename = f"{artifact_id}{suffix}"
        (self.blobs / filename).write_bytes(data)

        artifact = Artifact(
            id=artifact_id,
            kind=kind,
            name=name,
            sha256=digest,
            size=len(data),
            imported_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            source=source,
            filename=filename,
            notes=notes,
            summary=summary or {},
        )
        self._write([*self._read(), artifact])
        return artifact, False

    def _resummarise(self, artifact: Artifact, summary: dict[str, object]) -> Artifact:
        """Replace one artifact's summary in place, keeping its id and bytes.

        Everything else is left alone -- ``imported_at`` in particular, because
        the artifact really was imported when it says it was, and the summary
        being re-derived is not a new import.
        """
        updated = replace(artifact, summary=summary)
        self._write([updated if a.id == artifact.id else a for a in self._read()])
        return updated

    def remove(self, artifact_id: str) -> None:
        artifacts = self._read()
        kept = [a for a in artifacts if a.id != artifact_id]
        if len(kept) == len(artifacts):
            raise LibraryError(f"no artifact {artifact_id!r} to remove")
        gone = next(a for a in artifacts if a.id == artifact_id)
        self._write(kept)
        blob = self.blobs / gone.filename
        if blob.exists():
            blob.unlink()

    def clear(self) -> None:
        """Empty the store. For tests; there is no route that calls this."""
        if self.root.exists():
            shutil.rmtree(self.root)
        self.blobs.mkdir(parents=True, exist_ok=True)

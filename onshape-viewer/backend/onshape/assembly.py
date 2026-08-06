"""Assembly walk: flatten an Onshape assembly into a list of part occurrences.

Two traps from orkv2.md 6 (Phase 1) are handled here explicitly, because both
fail silently rather than loudly:

  * Nested instances live in ``subAssemblies[].instances``, not in
    ``rootAssembly.instances``. Reading only the root list drops every part
    inside a subassembly -- on the BART assembly that is 12 of 26 parts, and the
    result still renders and still produces a centre of mass.

  * Occurrence transforms are absolute in the root assembly frame. Chaining them
    through the occurrence path multiplies each transform in twice.
"""

from __future__ import annotations

from dataclasses import dataclass

from .client import OnshapeClient
from .urls import ResolvedRef, _get_assembly

# Onshape's identity for "no configuration", used as a cache/grouping key.
DEFAULT_CONFIGURATION = "default"


@dataclass(frozen=True)
class SourceKey:
    """Identifies a Part Studio to tessellate and take mass from.

    Every field comes from the *instance*, never from the root assembly.
    Instances of linked documents carry their own document id and microversion,
    and assuming the assembly's ids apply to them is the single most common bug
    in this area (orkv2.md 7.5).
    """

    document_id: str
    microversion_id: str
    element_id: str
    configuration: str

    def path_prefix(self) -> str:
        """Immutable API path segment for this source."""
        return f"d/{self.document_id}/m/{self.microversion_id}/e/{self.element_id}"


@dataclass
class Occurrence:
    """One placed instance of one part in the root assembly frame."""

    key: str
    part_id: str
    instance_id: str
    path: list[str]
    name: str
    source: SourceKey
    transform: list[float]  # row-major 4x4, absolute in the root frame
    is_standard_content: bool
    hidden: bool


@dataclass
class AssemblyWalk:
    root_microversion: str
    assembly_name: str
    occurrences: list[Occurrence]
    sources: list[SourceKey]
    subassembly_count: int
    total_occurrences: int
    warnings: list[str]


def occurrence_key(path: list[str]) -> str:
    """Stable join key between the manifest and the glTF node `extras`.

    Built from the occurrence path, which is unique per placement. Names are not
    usable here: two instances of "Bulkhead" collide, and names change when the
    model is edited (orkv2.md 3.4).
    """
    return "occ:" + "/".join(path)


def walk_assembly(client: OnshapeClient, ref: ResolvedRef) -> AssemblyWalk:
    """Fetch and flatten the assembly at `ref` into placed part occurrences."""
    data = _get_assembly(client, ref.document_id, ref.wvm, ref.wvm_id, ref.element_id)
    root = data.get("rootAssembly", {})
    subassemblies = data.get("subAssemblies", [])
    warnings: list[str] = []

    # One dictionary spanning the root and every subassembly. Instance ids are
    # unique across the whole assembly, so a flat map is safe.
    instances: dict[str, dict] = {}
    for instance in root.get("instances", []):
        instances[instance["id"]] = instance
    for sub in subassemblies:
        for instance in sub.get("instances", []):
            instances[instance["id"]] = instance

    occurrences: list[Occurrence] = []
    sources: dict[SourceKey, None] = {}  # dict preserves first-seen order
    skipped_subassembly = 0

    for occ in root.get("occurrences", []):
        path = occ.get("path") or []
        if not path:
            continue
        instance = instances.get(path[-1])
        if instance is None:
            warnings.append(f"Occurrence {'/'.join(path)} resolves to no known instance; skipped.")
            continue
        if instance.get("type") != "Part":
            # The tail is a subassembly node. Its children appear as their own
            # occurrences, so skipping this one drops nothing.
            skipped_subassembly += 1
            continue

        transform = occ.get("transform")
        if not transform or len(transform) != 16:
            warnings.append(f"Occurrence {'/'.join(path)} has no usable transform; skipped.")
            continue

        source = SourceKey(
            document_id=instance["documentId"],
            microversion_id=instance["documentMicroversion"],
            element_id=instance["elementId"],
            configuration=instance.get("fullConfiguration") or DEFAULT_CONFIGURATION,
        )
        sources.setdefault(source, None)

        occurrences.append(
            Occurrence(
                key=occurrence_key(path),
                part_id=instance["partId"],
                instance_id=instance["id"],
                path=list(path),
                name=instance.get("name") or instance["partId"],
                source=source,
                transform=list(transform),
                is_standard_content=bool(instance.get("isStandardContent")),
                hidden=bool(occ.get("hidden")),
            )
        )

    if skipped_subassembly:
        warnings.append(
            f"{skipped_subassembly} occurrence(s) resolved to subassembly nodes rather than "
            "parts and were skipped (their children are listed separately)."
        )

    return AssemblyWalk(
        root_microversion=root.get("documentMicroversion", ""),
        assembly_name=_assembly_name(data, ref),
        occurrences=occurrences,
        sources=list(sources),
        subassembly_count=len(subassemblies),
        total_occurrences=len(root.get("occurrences", [])),
        warnings=warnings,
    )


def _assembly_name(data: dict, ref: ResolvedRef) -> str:
    # The assembly definition response does not carry the tab name, so fall back
    # to the element id; build.py overwrites this from the element list.
    return data.get("rootAssembly", {}).get("name") or ref.element_id

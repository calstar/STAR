"""A stand as one file: everything it names, carried with it.

A stand document (:mod:`backend.routers.stands`) is mostly references -- the
drawing and the engine are library ids, the state machine is a name, and the
drawing's operator overrides and saved hookup live beside the library. That is
the right shape inside one server, where a version of the stand names exact
bytes, and the wrong one for handing a stand to someone else: their server has
none of what the ids point at.

A **bundle** (``*.hotbench.json``) carries the referents too:

* the drawing and the engine as their exact bytes (UTF-8 text), with the
  SHA-256 the library ids are cut from -- so an import onto any server rebuilds
  the same ids, and a bundle edited by hand is refused rather than quietly
  becoming a different drawing;
* the engine's card (EngineDesign's performance tables, ADR 0003), with its
  SHA-256, so the importer fires the same engine without EngineDesign
  running -- the stand's card, where the importer's library holds another;
* the state table the stand names, so a server whose shipped table differs (or
  has none of that name) still runs the stand's;
* the drawing's operator overrides and console view (keyed by drawing name);
* the stand payload itself -- setup, hookup (its own state table included),
  operating point, console, notes.

Nothing here touches the library or the stand store: :mod:`backend.main` reads
and writes those, and this module only builds, checks and merges plain data.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any, Mapping

FORMAT = "hotbench-stand"
VERSION = 1
#: The file extension a bundle is saved under.
SUFFIX = ".hotbench.json"


class BundleError(ValueError):
    """A bundle this server cannot take, said in one plain sentence."""


def blob(
    *, artifact_id: str, name: str, kind: str, source: str, suffix: str, data: bytes
) -> dict[str, Any]:
    """One library artifact, carried: its bytes as text and their hash."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise BundleError(
            f"{name} is not text, so it cannot go in a bundle ({exc})."
        ) from exc
    return {
        "id": artifact_id,
        "name": name,
        "kind": kind,
        "source": source,
        "suffix": suffix,
        "sha256": hashlib.sha256(data).hexdigest(),
        "text": text,
    }


def pack(
    *,
    name: str,
    stand: Mapping[str, Any],
    drawing: Mapping[str, Any],
    engine: Mapping[str, Any] | None,
    card: str | None,
    machine: Mapping[str, Any] | None,
    overrides: Mapping[str, Any],
    code: Mapping[str, Any],
) -> dict[str, Any]:
    """The bundle: one JSON object, every key always present."""
    return {
        "format": FORMAT,
        "version": VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "code": dict(code),
        "name": name,
        "stand": dict(stand),
        "drawing": dict(drawing),
        "engine": (
            {
                **dict(engine),
                "card": card,
                # Checked like the drawing's and the engine's: a hand-edited
                # card is a different engine under the same name.
                "card_sha256": (
                    hashlib.sha256(card.encode("utf-8")).hexdigest() if card else None
                ),
            }
            if engine is not None
            else None
        ),
        "machine": {
            "name": str(stand.get("machine") or "diablo"),
            "table": dict(machine) if machine is not None else None,
        },
        "overrides": dict(overrides),
    }


def check(bundle: Any) -> None:
    """Refuse what is not a bundle, a newer one, or one whose bytes changed."""
    if not isinstance(bundle, Mapping) or bundle.get("format") != FORMAT:
        raise BundleError(
            "That file is not a Hotbench stand. Export one from the stand menu "
            "(the ⋯ beside the stand name)."
        )
    version = bundle.get("version")
    if not isinstance(version, int) or version > VERSION:
        raise BundleError(
            f"That stand was exported by a newer Hotbench (bundle version "
            f"{version!r}; this one reads {VERSION}). Update this server first."
        )
    if not isinstance(bundle.get("stand"), Mapping):
        raise BundleError("That bundle has no stand in it.")
    parts = [("drawing", bundle.get("drawing"))]
    if bundle.get("engine") is not None:
        parts.append(("engine", bundle.get("engine")))
    for label, part in parts:
        if not isinstance(part, Mapping) or not isinstance(part.get("text"), str):
            raise BundleError(f"That bundle's {label} is missing or unreadable.")
        actual = hashlib.sha256(part["text"].encode("utf-8")).hexdigest()
        if actual != part.get("sha256"):
            raise BundleError(
                f"That bundle's {label} ({part.get('name') or 'unnamed'}) was "
                "changed after it was exported, so it is not the one the stand "
                "names. Export it again rather than editing the file."
            )
    engine = bundle.get("engine")
    # A bundle exported before cards were hashed carries none: taken as it is.
    if isinstance(engine, Mapping) and engine.get("card_sha256"):
        card = engine.get("card")
        actual = (
            hashlib.sha256(card.encode("utf-8")).hexdigest()
            if isinstance(card, str)
            else ""
        )
        if actual != engine["card_sha256"]:
            raise BundleError(
                f"That bundle's engine card ({engine.get('name') or 'unnamed'}) was "
                "changed after it was exported, so it is not the engine the stand "
                "fires. Export it again rather than editing the file."
            )


def merge_overrides(
    local: Mapping[str, Any], incoming: Mapping[str, Any]
) -> tuple[dict[str, Any], list[str]]:
    """The drawing's overrides after an import, and a note per conflict.

    ``local`` is what this server already holds for the drawing's name
    (:meth:`backend.overrides.OverrideStore.entry`), ``incoming`` what the
    bundle carries; both have the keys ``params`` ({element: {param: {value,
    unit, source, reference, by, at, was}}}), ``console_hidden``,
    ``console_shown`` ({element: {by, at}}) and ``console_order`` ({pts: [ids],
    tanks: [ids]}). An empty ``local`` is a drawing new to this server.

    Merged per element and parameter: what only this server has stays, what
    only the bundle has comes in, and where both set the same parameter to
    different values the bundle's wins -- the stand imported runs as it was
    exported -- with a note naming both, so nobody's tuning goes silently.
    The console's view (hidden, shown, order) is the bundle's where it says
    anything: it is how the stand looked, and changes no physics.
    """
    notes: list[str] = []
    params: dict[str, dict[str, Any]] = {
        element: dict(by_param)
        for element, by_param in (local.get("params") or {}).items()
    }
    for element, by_param in (incoming.get("params") or {}).items():
        mine = params.setdefault(element, {})
        for name, theirs in by_param.items():
            ours = mine.get(name)
            if ours is not None and (ours.get("value"), ours.get("unit")) != (
                theirs.get("value"),
                theirs.get("unit"),
            ):
                notes.append(
                    f"{element} {name}: this server had {ours.get('value')} "
                    f"{ours.get('unit') or ''} (by {ours.get('by') or 'someone'}); "
                    f"the stand's {theirs.get('value')} {theirs.get('unit') or ''} "
                    f"(by {theirs.get('by') or 'someone'}) is used."
                )
            mine[name] = dict(theirs)
    merged: dict[str, Any] = {"params": params}
    for key in ("console_hidden", "console_shown"):
        merged[key] = {**dict(local.get(key) or {}), **dict(incoming.get(key) or {})}
    # An element the stand shows is not hidden here, and the other way round.
    for element in incoming.get("console_shown") or {}:
        merged["console_hidden"].pop(element, None)
    for element in incoming.get("console_hidden") or {}:
        merged["console_shown"].pop(element, None)
    merged["console_order"] = {
        **dict(local.get("console_order") or {}),
        **dict(incoming.get("console_order") or {}),
    }
    return merged, notes

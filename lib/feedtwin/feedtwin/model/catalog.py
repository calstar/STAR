"""The parts database: real hardware, with the datasheet and what we measured.

A catalog entry is a part number and the parameters that describe it. Two sets
of them, deliberately kept apart::

    [swagelok-ss-8bk-v51]
    type = "valve"
    manufacturer = "Swagelok"

    [swagelok-ss-8bk-v51.params.Cv]
    value = 1.2
    unit = "Cv"
    source = "manufacturer"
    reference = "SS-8BK-V51 datasheet rev C, table 2"

    [swagelok-ss-8bk-v51.measured.Cv]
    value = 1.14
    unit = "Cv"
    source = "measured"
    reference = "CF-2026-03, 12 points, R^2 0.998"

:meth:`Part.resolve` merges them with the measurement winning. The datasheet
value is *not* overwritten -- it stays visible, so "the valve flows 5% under
its rating" is a question anyone can ask later. Overwriting would destroy the
only record that the discrepancy exists.

This is where Phase 12 writes back: fitting parameters against a cold-flow
produces ``measured`` blocks, with the test that produced them in ``reference``.
Building the shape now means that phase adds data, not plumbing.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from feedtwin.model.component import ComponentInstance
from feedtwin.model.curve import Curve
from feedtwin.model.param import Param, Provenance


class CatalogError(KeyError):
    """A part is missing, or a catalog file is malformed."""


@dataclass(frozen=True, slots=True)
class Part:
    """One catalogued piece of hardware."""

    id: str
    type: str
    manufacturer: str = ""
    description: str = ""
    params: dict[str, Param] = field(default_factory=dict)
    measured: dict[str, Param] = field(default_factory=dict)
    curves: dict[str, Curve] = field(default_factory=dict)
    """Tabulated data belonging to this part -- a manufacturer's Cv-versus-travel
    chart, or a measured pressure drop against flow.

    Kept alongside the scalars because a part is not only scalars, and because
    without it a part with measured flow data cannot be catalogued at all: the
    ``measured`` model needs a ``dp_mdot`` curve, so the flagship feature was
    reachable in code and not from the parts database. It is also where Phase 12
    writes a fitted curve back to."""

    def resolve(self) -> dict[str, Param]:
        """Datasheet values with measurements layered over them."""
        return {**self.params, **self.measured}

    def disagreements(self, tolerance: float = 0.0) -> dict[str, tuple[Param, Param]]:
        """Parameters where measurement and datasheet differ by more than
        ``tolerance`` (relative).

        Worth surfacing rather than burying. A part that consistently measures
        below its rating is either mis-specified, installed wrong, or the
        datasheet is optimistic -- all three are findings, and all three are
        invisible if the override silently replaces the original.
        """
        out: dict[str, tuple[Param, Param]] = {}
        for name, measured in self.measured.items():
            claimed = self.params.get(name)
            if claimed is None:
                continue
            denominator = abs(claimed.si) or 1.0
            if abs(measured.si - claimed.si) / denominator > tolerance:
                out[name] = (claimed, measured)
        return out

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"type": self.type}
        if self.manufacturer:
            data["manufacturer"] = self.manufacturer
        if self.description:
            data["description"] = self.description
        if self.params:
            data["params"] = {k: v.to_dict() for k, v in sorted(self.params.items())}
        if self.measured:
            data["measured"] = {
                k: v.to_dict() for k, v in sorted(self.measured.items())
            }
        if self.curves:
            data["curves"] = {k: v.to_dict() for k, v in sorted(self.curves.items())}
        return data

    @classmethod
    def from_dict(cls, part_id: str, data: Mapping[str, Any]) -> Part:
        if "type" not in data:
            raise CatalogError(f"part {part_id!r} does not say what type it is")
        return cls(
            id=part_id,
            type=str(data["type"]),
            manufacturer=str(data.get("manufacturer", "")),
            description=str(data.get("description", "")),
            params=_params(part_id, data.get("params", {}), "params"),
            measured=_params(part_id, data.get("measured", {}), "measured"),
            curves=_curves(part_id, data.get("curves", {})),
        )


def _curves(part_id: str, raw: Any) -> dict[str, Curve]:
    if not isinstance(raw, Mapping):
        raise CatalogError(f"part {part_id!r}: [curves] must be a table")
    return {
        name: Curve.from_dict(dict(body), where=f"{part_id}.curves.{name}")
        for name, body in raw.items()
    }


def _params(part_id: str, raw: Any, block: str) -> dict[str, Param]:
    if not isinstance(raw, Mapping):
        raise CatalogError(f"part {part_id!r}: [{block}] must be a table")
    return {
        name: Param.from_dict(dict(body), where=f"{part_id}.{block}.{name}")
        for name, body in raw.items()
    }


class Catalog:
    """A collection of parts, loadable from one or more TOML files.

    Layering is by design: a shipped catalog, a team catalog and a
    campaign-specific one can all be loaded in order, with later definitions
    replacing earlier ones by part number.
    """

    def __init__(self, parts: Iterable[Part] = ()) -> None:
        self._parts: dict[str, Part] = {p.id: p for p in parts}

    def __len__(self) -> int:
        return len(self._parts)

    def __contains__(self, part_id: object) -> bool:
        return part_id in self._parts

    def add(self, part: Part) -> Part:
        self._parts[part.id] = part
        return part

    def get(self, part_id: str) -> Part:
        try:
            return self._parts[part_id]
        except KeyError:
            known = ", ".join(sorted(self._parts)[:12]) or "(catalog is empty)"
            raise CatalogError(
                f"no part {part_id!r} in the catalog. Known parts include: {known}"
            ) from None

    def parts(self, type_name: str | None = None) -> list[str]:
        """Part numbers, optionally filtered by component type."""
        return sorted(p.id for p in self._parts.values() if type_name in (None, p.type))

    def load(self, path: Path | str) -> list[Part]:
        """Load a TOML catalog file, replacing any parts it redefines."""
        path = Path(path)
        with path.open("rb") as handle:
            raw = tomllib.load(handle)

        loaded: list[Part] = []
        for part_id, body in raw.items():
            if not isinstance(body, dict):
                raise CatalogError(
                    f"{path}: [{part_id}] must be a table, got {type(body).__name__}"
                )
            loaded.append(self.add(Part.from_dict(part_id, body)))
        return loaded

    @classmethod
    def from_file(cls, path: Path | str) -> Catalog:
        catalog = cls()
        catalog.load(path)
        return catalog

    def instantiate(
        self,
        instance_id: str,
        part_id: str,
        *,
        overrides: Mapping[str, Param] | None = None,
        curves: Mapping[str, Curve] | None = None,
        model: str = "",
        connections: Mapping[str, str] | None = None,
    ) -> ComponentInstance:
        """Turn a part number into a configured component.

        Precedence, lowest to highest: datasheet values, then measurements, then
        anything given in ``overrides``. Curves layer the same way, the part's
        beneath anything passed in. An override is how a single instance
        differs from its catalogue entry -- this particular valve was trimmed,
        this run of tube is longer -- without inventing a new part number.

        The result is validated against the component's spec, so a catalog entry
        missing a required parameter fails here with the parameter named, rather
        than at solve time as a missing key.
        """
        part = self.get(part_id)
        params = part.resolve()
        if overrides:
            params = {**params, **dict(overrides)}

        resolved_curves = {**part.curves, **dict(curves or {})}

        return ComponentInstance.build(
            id=instance_id,
            type_name=part.type,
            params=params,
            curves=resolved_curves,
            model=model,
            connections=dict(connections or {}),
            part=part.id,
        )

    def to_dict(self) -> dict[str, Any]:
        return {pid: part.to_dict() for pid, part in sorted(self._parts.items())}


def measured(value: float, unit: str, reference: str, uncertainty: Any = None) -> Param:
    """A measured value, tagged as such. Shorthand for Phase 12 write-back."""
    return Param(
        value=value,
        unit=unit,
        source=Provenance.MEASURED,
        reference=reference,
        uncertainty=uncertainty,
    )

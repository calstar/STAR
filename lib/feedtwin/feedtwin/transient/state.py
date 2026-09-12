"""Packing a system's differential states into one vector, and back.

An integrator wants a flat ``numpy`` array. The physics wants a COPV with a
mass and an energy, a tank with an ullage and a liquid inventory, and a wall
temperature or two. This module is the translation, and it exists as its own
file because getting it wrong is both easy and silent -- an off-by-one in the
packing produces a run that integrates smoothly and means nothing.

Three properties are enforced rather than assumed:

* Every owner declares its own slot names, so a state vector can be *printed*
  with labels. A run that goes wrong at index 7 should be able to say which
  quantity index 7 was.
* Pack and unpack are checked against each other by a round-trip test on every
  owner type.
* Owners are asked for their states in a stable, declared order, so a rebuilt
  system produces an identical vector rather than a permuted one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence, runtime_checkable

import numpy as np


@runtime_checkable
class StateOwner(Protocol):
    """Something that holds differential state an integrator must march.

    A COPV, a tank, a manifold plenum with volume. Deliberately *not* a
    component: most components are algebraic, and the ones that are not are
    vessels.
    """

    @property
    def id(self) -> str: ...

    def state_names(self) -> Sequence[str]:
        """Slot labels, in packing order. Used for reporting and for errors."""
        ...

    def pack(self) -> Sequence[float]:
        """Current state as a flat sequence, matching :meth:`state_names`."""
        ...

    def unpack(self, values: Sequence[float]) -> None:
        """Adopt a state from a flat sequence."""
        ...

    def derivatives(self, t: float) -> Sequence[float]:
        """Time derivatives of each slot, in the same order."""
        ...


@dataclass(frozen=True, slots=True)
class Slot:
    """Where one owner's states live in the flat vector."""

    owner: str
    start: int
    names: tuple[str, ...]

    @property
    def stop(self) -> int:
        return self.start + len(self.names)

    def labels(self) -> list[str]:
        return [f"{self.owner}.{name}" for name in self.names]


class StateLayout:
    """The map from owners to indices in the flat state vector."""

    def __init__(self, owners: Sequence[StateOwner]) -> None:
        self.owners = list(owners)
        self.slots: list[Slot] = []
        cursor = 0
        seen: set[str] = set()
        for owner in self.owners:
            if owner.id in seen:
                raise ValueError(
                    f"two state owners share the id {owner.id!r}; ids index "
                    "the result and must be unique"
                )
            seen.add(owner.id)
            names = tuple(owner.state_names())
            if not names:
                raise ValueError(
                    f"{owner.id!r} declares no states, so it is not a state "
                    "owner -- leave it out rather than carrying an empty slot"
                )
            self.slots.append(Slot(owner.id, cursor, names))
            cursor += len(names)
        self.size = cursor

    @property
    def labels(self) -> list[str]:
        """Every slot's full label, in vector order."""
        return [label for slot in self.slots for label in slot.labels()]

    def pack(self) -> np.ndarray:
        vector = np.empty(self.size, dtype=float)
        for owner, slot in zip(self.owners, self.slots):
            values = owner.pack()
            if len(values) != len(slot.names):
                raise ValueError(
                    f"{owner.id!r} packed {len(values)} values but declares "
                    f"{len(slot.names)} states {slot.names}"
                )
            vector[slot.start : slot.stop] = values
        return vector

    def unpack(self, vector: np.ndarray) -> None:
        if vector.shape[0] != self.size:
            raise ValueError(
                f"state vector has {vector.shape[0]} entries, layout expects "
                f"{self.size}"
            )
        for owner, slot in zip(self.owners, self.slots):
            owner.unpack([float(v) for v in vector[slot.start : slot.stop]])

    def derivatives(self, t: float) -> np.ndarray:
        vector = np.empty(self.size, dtype=float)
        for owner, slot in zip(self.owners, self.slots):
            rates = owner.derivatives(t)
            if len(rates) != len(slot.names):
                raise ValueError(
                    f"{owner.id!r} produced {len(rates)} derivatives but "
                    f"declares {len(slot.names)} states"
                )
            vector[slot.start : slot.stop] = rates
        return vector

    def unpack_named(self, vector: np.ndarray) -> dict[str, float]:
        """A labelled view of a state vector. What a report and an error print."""
        return dict(zip(self.labels, (float(v) for v in vector)))

    def __repr__(self) -> str:
        return f"StateLayout({len(self.owners)} owners, {self.size} states)"

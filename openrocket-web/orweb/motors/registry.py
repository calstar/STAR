"""A small motor registry: resolve an .ork's motor references to thrust curves.

Lookup follows OpenRocket 24.12's DatabaseMotorFinder.findMotor (GPLv3): candidates
are matched on designation and manufacturer; among several, the one whose digest
matches wins; a single candidate with a different digest is used with a warning.

The bundled set (``orweb/data/motors.json``) is OpenRocket's own data for every
motor the example rockets use, dumped by ``tools/oracle/Oracle.java`` ("allMotors")
-- the curves are OpenRocket's, not re-parsed here.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .motor import ThrustCurveMotor

BUNDLED = Path(__file__).resolve().parent.parent / "data" / "motors.json"

# Manufacturer abbreviations OpenRocket treats as one (Manufacturer.getManufacturer aliases, abridged).
_ALIASES = {
    "aerotech": {"aerotech", "aerotech/rcs", "rcs", "rouse tech", "a", "at", "aerotech-rcs", "isp"},
    "estes": {"estes", "estes industries", "e", "es"},
    "cesaroni technology": {"cesaroni", "cesaroni technology", "cesaroni technology inc.", "cti", "c"},
    "apogee": {"apogee", "apogee components", "ap", "apog"},
    "quest": {"quest", "quest aerospace", "q", "qu"},
    "loki research": {"loki", "loki research", "lr"},
    "animal motor works": {"animal motor works", "amw", "aw", "animal"},
    "hypertek": {"hypertek", "ht", "hyper"},
    "contrail rockets": {"contrail", "contrail rockets", "cr"},
    "kosdon by aerotech": {"kosdon by aerotech", "kba"},
}


def _canon_manufacturer(name: str | None) -> str:
    n = (name or "").strip().lower()
    for canon, names in _ALIASES.items():
        if n in names:
            return canon
    return n


def _canon_designation(d: str | None) -> str:
    return "".join((d or "").split()).upper()


class MotorRegistry:
    def __init__(self, motors: list[ThrustCurveMotor] | None = None):
        self.motors: list[ThrustCurveMotor] = []
        self._by_digest: dict[str, ThrustCurveMotor] = {}
        for m in motors or []:
            self.add(m)

    def add(self, m: ThrustCurveMotor) -> None:
        if m.digest and m.digest in self._by_digest:
            return
        self.motors.append(m)
        if m.digest:
            self._by_digest[m.digest] = m

    def __len__(self) -> int:
        return len(self.motors)

    def __iter__(self):
        return iter(self.motors)

    # -- loading -----------------------------------------------------------------------------
    def load_json(self, path: str | os.PathLike) -> "MotorRegistry":
        data = json.loads(Path(path).read_text())
        for d in data["motors"] if isinstance(data, dict) else data:
            self.add(ThrustCurveMotor.from_dict(d))
        return self

    def load_file(self, path: str | os.PathLike) -> list[ThrustCurveMotor]:
        p = Path(path)
        return self.load_text(p.name, p.read_text(errors="replace"))

    def load_text(self, filename: str, text: str) -> list[ThrustCurveMotor]:
        from .rasp import load_rasp
        from .rocksim import load_rocksim
        low = filename.lower()
        if low.endswith(".eng"):
            ms = load_rasp(text)
        elif low.endswith(".rse"):
            ms = load_rocksim(text)
        else:
            raise ValueError(f"unsupported motor file {filename!r} (.eng or .rse)")
        for m in ms:
            self.add(m)
        return ms

    def add_golden(self, golden: dict) -> None:
        """Add the motors an oracle dump carries ("allMotors", else "motors")."""
        for d in golden.get("allMotors") or golden.get("motors") or []:
            d = dict(d)
            d.setdefault("type", d.get("motorType"))
            self.add(ThrustCurveMotor.from_dict(d))

    # -- lookup ----------------------------------------------------------------------------------
    def find(self, designation: str | None, manufacturer: str | None = None, digest: str | None = None,
             warnings: list[str] | None = None) -> ThrustCurveMotor | None:
        """DatabaseMotorFinder.findMotor."""
        warnings = warnings if warnings is not None else []
        if designation is None:
            warnings.append("No motor specified, ignoring.")
            return None
        des = _canon_designation(designation)
        man = _canon_manufacturer(manufacturer) if manufacturer else None
        cands = [m for m in self.motors
                 if (_canon_designation(m.designation) == des or _canon_designation(m.common_name) == des)
                 and (man is None or _canon_manufacturer(m.manufacturer) == man)]
        if not cands and digest and digest in self._by_digest:
            cands = [self._by_digest[digest]]
        if not cands:
            warnings.append(f"Motor not found: {manufacturer or ''} {designation} (digest {digest}).")
            return None
        if len(cands) == 1:
            m = cands[0]
            if digest is not None and digest != m.digest:
                warnings.append(f"Motor with designation '{designation}' has differing thrust curve than the original.")
            return m
        if digest is not None:
            for m in cands:
                if m.digest == digest:
                    return m
            warnings.append(f"Motor with designation '{designation}' has differing thrust curve than the original.")
        else:
            warnings.append(f"Multiple motors with designation '{designation}' found, one chosen arbitrarily.")
        return cands[0]

    def search(self, q: str = "", diameter: float | None = None, tol: float = 0.0005) -> list[dict]:
        ql = q.strip().lower()
        out = []
        for m in self.motors:
            if ql and ql not in m.designation.lower() and ql not in m.manufacturer.lower() \
                    and ql not in m.common_name.lower():
                continue
            if diameter is not None and abs(m.diameter - diameter) > tol:
                continue
            out.append(m.summary())
        return out


_default: MotorRegistry | None = None


def default_registry() -> MotorRegistry:
    """The bundled motor set (loaded once)."""
    global _default
    if _default is None:
        _default = MotorRegistry()
        if BUNDLED.exists():
            _default.load_json(BUNDLED)
    return _default

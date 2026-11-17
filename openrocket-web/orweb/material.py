"""Materials and the built-in material database.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.material.Material,
info.openrocket.core.material.MaterialGroup, info.openrocket.core.database.Databases
(the built-in BULK/SURFACE/LINE lists), and the default component materials of
info.openrocket.core.preferences.ApplicationPreferences.

A material is its type, name and density; nothing else enters the physics.
Densities are kg/m^3 (bulk), kg/m^2 (surface) or kg/m (line).
"""

from __future__ import annotations

from dataclasses import dataclass

from .util.mathutil import equals

BULK, SURFACE, LINE = "bulk", "surface", "line"


@dataclass(frozen=True)
class Material:
    type: str  # "bulk" | "surface" | "line"
    name: str
    density: float
    group: str | None = None  # MaterialGroup database string, e.g. "PaperProducts"

    def get_density(self) -> float:
        return self.density

    def get_type(self) -> str:
        return self.type

    def get_name(self) -> str:
        return self.name

    def to_param(self) -> dict:
        d = {"type": self.type, "density": self.density, "name": self.name}
        if self.group is not None:
            d["group"] = self.group
        return d

    @staticmethod
    def from_param(p: dict, expected_type: str | None = None) -> "Material":
        t = p.get("type") or expected_type
        if expected_type is not None and t != expected_type:
            raise ValueError(f"material {p.get('name')!r}: expected a {expected_type} material, got {t}")
        return Material(t, str(p.get("name", "")), float(p["density"]), p.get("group"))


_B = [
    ("Acrylic", 1190, "Plastics"), ("Aluminum", 2700, "Metals"), ("Balsa", 170, "Woods"),
    ("Basswood", 500, "Woods"), ("Birch", 670, "Woods"), ("Brass", 8600, "Metals"),
    ("Cardboard", 680, "PaperProducts"), ("Carbon fiber", 1780, "Composites"), ("Cork", 240, "Woods"),
    ("Delrin", 1420, "Plastics"), ("Depron (XPS)", 40, "Foams"), ("Fiberglass", 1850, "Composites"),
    ("Kraft phenolic", 950, "Composites"), ("Maple", 755, "Woods"), ("Nylon", 1150, "Fibers"),
    ("Paper (office)", 820, "PaperProducts"), ("Pine", 530, "Woods"), ("Plywood (birch)", 630, "Woods"),
    ("Polycarbonate (Lexan)", 1200, "Plastics"), ("Polystyrene", 1050, "Plastics"), ("PVC", 1390, "Plastics"),
    ("Spruce", 450, "Woods"), ("Steel", 7850, "Metals"), ("Styrofoam (generic EPS)", 20, "Foams"),
    ("Styrofoam \"Blue foam\" (XPS)", 32, "Foams"), ("Titanium", 4500, "Metals"),
    ("Quantum tubing", 1050, "Plastics"), ("Blue tube", 1300, "Composites"),
    ("PLA - 100% infill", 1250, "Plastics"), ("PETG - 100% infill", 1250, "Plastics"),
    ("ABS - 100% infill", 1050, "Plastics"),
]
_S = [
    ("Ripstop nylon", 0.067, "Fabrics"), ("Mylar", 0.021, "Plastics"), ("Polyethylene (thin)", 0.015, "Plastics"),
    ("Polyethylene (heavy)", 0.040, "Plastics"), ("Silk", 0.060, "Fabrics"), ("Paper (office)", 0.080, "PaperProducts"),
    ("Cellophane", 0.018, "Plastics"), ("Crêpe paper", 0.025, "PaperProducts"),
]
_L = [
    ("Thread (heavy-duty)", 0.0003), ("Elastic cord (round 2 mm, 1/16 in)", 0.0018),
    ("Elastic cord (flat 6 mm, 1/4 in)", 0.0043), ("Elastic cord (flat 12 mm, 1/2 in)", 0.008),
    ("Elastic cord (flat 19 mm, 3/4 in)", 0.0012), ("Elastic cord (flat 25 mm, 1 in)", 0.0016),
    ("Braided nylon (2 mm, 1/16 in)", 0.001), ("Braided nylon (3 mm, 1/8 in)", 0.0035),
    ("Tubular nylon (11 mm, 7/16 in)", 0.013), ("Tubular nylon (14 mm, 9/16 in)", 0.016),
    ("Tubular nylon (25 mm, 1 in)", 0.029), ("Kevlar thread 138  (0.4 mm, 1/64 in)", 0.00014808),
    ("Kevlar thread 207  (0.5 mm, 1/64 in)", 0.00023622), ("Kevlar thread 346  (0.7 mm, 1/32 in)", 0.00047243),
    ("Kevlar thread 415  (0.8 mm, 1/32 in)", 0.00055117), ("Kevlar thread 800 (1.1 mm, 3/64 in)", 0.00099211),
    ("Kevlar 12-strand (3.2 mm, 1/8 in)", 0.00967306), ("Kevlar 12-strand (4.8 mm, 3/16 in)", 0.01785797),
    ("Kevlar 12-strand (6.4 mm, 1/4 in)", 0.02976328), ("Kevlar 12-strand (7.9 mm, 5/16 in)", 0.04464491),
    ("Kevlar 12-strand (10 mm, 3/8 in)", 0.05952655), ("Kevlar 12-strand (11 mm, 7/16 in)", 0.07440819),
    ("Kevlar 12-strand (13 mm, 1/2 in)", 0.11607678), ("Kevlar 12-strand (14 mm, 9/16 in)", 0.20834293),
    ("Kevlar 12-strand (16 mm, 5/8 in)", 0.28721562), ("Kevlar 12-strand (19 mm, 3/4 in)", 0.3497185),
    ("Kevlar 12-strand (25 mm, 1 in)", 0.45686629), ("Nylon flat webbing md. (10 mm, 3/8 in)", 0.00951444),
    ("Nylon flat webbing md. (13 mm, 1/2  in)", 0.01334208), ("Nylon flat webbing md. (16 mm, 5/8 in)", 0.01618548),
    ("Nylon flat webbing lg. (14 mm, 9/16 in)", 0.02723097), ("Nylon flat webbing lg. (25 mm, 1 in)", 0.03969816),
    ("Paraline small IIIA (6.4 mm, 1.4 in)", 0.00371829), ("Elastic rubber band (flat 3.2 mm, 1/8 in)", 0.00297638),
    ("Elastic rubber band (flat 6.4 mm, 1/4 in)", 0.00613107), ("Elastic braided cord (flat 3.2 mm, 1/8 in)", 0.00106),
    ("Elastic braided cord (flat 4 mm, 5/32 in)", 0.002), ("Elastic braided cord (flat 6.4 mm, 1/4 in)", 0.00254),
    ("Elastic braided cord (round 2 mm, 1/16 in)", 0.0035), ("Elastic braided cord (round 2.5 mm, 3/32 in)", 0.0038),
    ("Elastic braided cord (flat 10 mm, 3/8 in)", 0.00381), ("Elastic braided cord (flat 13 mm, 1/2 in)", 0.00551172),
]

DATABASE: dict[str, list[Material]] = {
    BULK: [Material(BULK, n, float(d), g) for n, d, g in _B],
    SURFACE: [Material(SURFACE, n, float(d), g) for n, d, g in _S],
    LINE: [Material(LINE, n, float(d), "ThreadsLines") for n, d in _L],
}


def find_material(mtype: str, name: str, density: float | None = None, group: str | None = None) -> Material:
    """Databases.findMaterial: a database entry with this name (and density), else a custom one."""
    for m in DATABASE[mtype]:
        if m.name.lower() == name.lower() and (density is None or equals(m.density, density)):
            return m
    if density is None:
        raise KeyError(f"no {mtype} material named {name!r}")
    return Material(mtype, name, density, group)


# ApplicationPreferences.StaticFieldHolder defaults
DEFAULT_BULK = find_material(BULK, "Cardboard")
DEFAULT_SURFACE = find_material(SURFACE, "Ripstop nylon")
DEFAULT_LINE = find_material(LINE, "Elastic cord (round 2 mm, 1/16 in)")
DELRIN = find_material(BULK, "Delrin")


def materials_listing() -> dict:
    """The /api/materials payload."""
    return {t: [{"name": m.name, "density": m.density, "group": m.group} for m in ms]
            for t, ms in DATABASE.items()}

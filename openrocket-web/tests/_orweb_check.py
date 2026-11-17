"""orweb against OpenRocket 24.12: the comparison the golden tests (and the mutation
checks that prove those tests can fail) share.

The oracle (tools/oracle/Oracle.java) prints OpenRocket's own numbers at 15
significant digits; orweb evaluates the same formulas in the same order, so the
tolerance is 1e-9 relative (observed agreement is ~5e-15). A value OpenRocket
reports as zero must be zero to 1e-12 absolute.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from orweb import (MotorRegistry, build_rocket, calculate_burnout, calculate_launch, calculate_motor,
                   calculate_structure, get_cm_analysis, read_ork)

HERE = Path(__file__).parent
REL = 1e-9
ABS = 1e-12

#: (rocket dir, golden dir) pairs: OpenRocket's examples, and orweb-written variants
SETS = [(HERE / "rockets", HERE / "golden"), (HERE / "variants" / "rockets", HERE / "variants" / "golden")]


def cases() -> list[tuple[Path, Path]]:
    out = []
    for rdir, gdir in SETS:
        for g in sorted(gdir.glob("*.json")):
            ork = rdir / (g.stem + ".ork")
            if ork.exists():
                out.append((ork, g))
    return out


def case_id(case) -> str:
    return case[0].stem


def close(a, b, rel: float = REL, abs_: float = ABS) -> bool:
    if b is None:  # the oracle prints NaN/inf as null
        return a is None or (isinstance(a, float) and (math.isnan(a) or math.isinf(a)))
    if a is None or (isinstance(a, float) and math.isnan(a)):
        return False
    if b == 0:
        return abs(a) <= abs_
    return abs(a - b) <= rel * max(abs(a), abs(b)) or abs(a - b) <= abs_ * 1e-3


def load(ork: Path, golden: dict, registry: MotorRegistry | None = None):
    """The rocket as orweb builds it, motors resolved from the oracle's own dump."""
    if registry is None:
        registry = MotorRegistry()
        registry.add_golden(golden)
    return build_rocket(read_ork(ork), registry=registry)


class Mismatches(list):
    def check(self, label: str, ours, theirs, rel: float = REL) -> None:
        if not close(ours, theirs, rel):
            self.append(f"{label}: orweb {ours!r} != OpenRocket {theirs!r}")

    def same(self, label: str, ours, theirs) -> None:
        if ours != theirs:
            self.append(f"{label}: orweb {ours!r} != OpenRocket {theirs!r}")


def component_mismatches(rocket, g: dict) -> Mismatches:
    """Per component: type, name, activeness, position, every instance location, length,
    mass, CG, unit inertias, overrides, and the geometry accessors the oracle dumps."""
    m = Mismatches()
    cfg = rocket.get_selected_configuration()
    for gc in g["components"]:
        c = rocket if gc["type"] == "Rocket" else rocket.by_id.get(gc["id"])
        lbl = f"{gc['name']} ({gc['type']})"
        if c is None:
            m.append(f"{lbl}: missing from orweb's tree")
            continue
        m.same(lbl + " type", type(c).__name__, gc["type"])
        m.same(lbl + " name", c.get_name(), gc["name"])
        m.same(lbl + " active", cfg.is_component_active(c), gc["active"])
        m.same(lbl + " axialMethod", c.get_axial_method().name, gc["axialMethod"])
        m.same(lbl + " instanceCount", c.get_instance_count(), gc["instanceCount"])
        m.check(lbl + " relX", c.get_position().x, gc["relX"])
        m.check(lbl + " axialOffset", c.get_axial_offset(), gc["axialOffset"])
        locs = c.get_component_locations()
        if len(locs) != len(gc["locations"]):
            m.append(f"{lbl}: {len(locs)} instance locations, OpenRocket has {len(gc['locations'])}")
        else:
            for i, (p, q) in enumerate(zip(locs, gc["locations"])):
                for axis, a, b in zip("xyz", (p.x, p.y, p.z), q):
                    m.check(f"{lbl} location[{i}].{axis}", a, b)
        cg = c.get_component_cg()
        m.check(lbl + " length", c.get_length(), gc["length"])
        m.check(lbl + " mass", c.get_component_mass(), gc["mass"])
        m.check(lbl + " cgx", cg.x, gc["cgx"])
        m.check(lbl + " cgy", cg.y, gc["cgy"])
        m.check(lbl + " cgz", cg.z, gc["cgz"])
        m.check(lbl + " longUnitInertia", c.get_longitudinal_unit_inertia(), gc["longUnitInertia"])
        m.check(lbl + " rotUnitInertia", c.get_rotational_unit_inertia(), gc["rotUnitInertia"])
        if gc["overrideMass"] is not None:
            m.same(lbl + " mass overridden", c.is_mass_overridden(), True)
            m.check(lbl + " overrideMass", c.get_override_mass(), gc["overrideMass"])
        if gc["overrideCG"] is not None:
            m.same(lbl + " cg overridden", c.is_cg_overridden(), True)
            m.check(lbl + " overrideCG", c.get_override_cgx(), gc["overrideCG"])
        if "foreRadius" in gc:  # SymmetricComponent
            m.check(lbl + " foreRadius", c.get_fore_radius(), gc["foreRadius"])
            m.check(lbl + " aftRadius", c.get_aft_radius(), gc["aftRadius"])
            m.check(lbl + " wetArea", c.get_component_wet_area(), gc["wetArea"])
            m.check(lbl + " volume", c.get_component_volume(), gc["volume"])
            m.check(lbl + " planformArea", c.get_component_planform_area(), gc["planformArea"])
            if type(c).__name__ != "BodyTube":  # BodyTube does not override these two
                m.check(lbl + " planformCenter", c.get_component_planform_center(), gc["planformCenter"])
                m.check(lbl + " fullVolume", c.get_full_volume(), gc["fullVolume"])
            for i, r in enumerate(gc["radii"]):
                m.check(f"{lbl} radius({i}/20 L)", c.get_radius(c.get_length() * i / 20.0), r)
        if "shape" in gc:
            m.same(lbl + " shape", c.get_shape_type().name, gc["shape"])
            m.same(lbl + " clipped", c.is_clipped(), gc["clipped"])
            m.check(lbl + " shapeParameter", c.get_shape_parameter(), gc["shapeParameter"])
        if "radius" in gc:  # MassObject
            m.check(lbl + " radius", c.get_radius(), gc["radius"])
        if "outerRadius" in gc:  # RingComponent
            m.check(lbl + " outerRadius", c.get_outer_radius(), gc["outerRadius"])
            m.check(lbl + " innerRadius", c.get_inner_radius(), gc["innerRadius"])
        if "finPoints" in gc:  # FinSet
            m.check(lbl + " planform area", c.get_planform_area(), gc["finArea"])
            m.check(lbl + " span", c.get_span(), gc["span"])
            for key, pts in (("finPoints", c.get_fin_points()), ("rootPoints", c.get_root_points())):
                if len(pts) != len(gc[key]):
                    m.append(f"{lbl}: {len(pts)} {key}, OpenRocket has {len(gc[key])}")
                    continue
                for i, (p, q) in enumerate(zip(pts, gc[key])):
                    m.check(f"{lbl} {key}[{i}].x", p.x, q[0])
                    m.check(f"{lbl} {key}[{i}].y", p.y, q[1])
    if len(g["components"]) != len(list(rocket.iterator(True))):
        m.append(f"{len(list(rocket.iterator(True)))} components, OpenRocket has {len(g['components'])}")
    return m


BODIES = {"launch": calculate_launch, "structure": calculate_structure, "burnout": calculate_burnout,
          "motor": calculate_motor}


def rocket_mismatches(rocket, g: dict) -> Mismatches:
    """The four rigid bodies, reference length, lengths, selected configuration."""
    m = Mismatches()
    cfg = rocket.get_selected_configuration()
    m.same("selected configuration", cfg.get_id(), g["rocket"]["selectedConfig"])
    for name, fn in BODIES.items():
        b = fn(cfg)
        gb = g["rocket"][name]
        m.check(name + " mass", b.cm.weight, gb["mass"])
        m.check(name + " cgx", b.cm.x, gb["cgx"])
        m.check(name + " Ixx", b.Ixx, gb["Ixx"])
        m.check(name + " Iyy", b.Iyy, gb["Iyy"])
        m.check(name + " Izz", b.Izz, gb["Izz"])
    m.check("refLength", cfg.get_reference_length(), g["rocket"]["refLength"])
    m.check("refArea", cfg.get_reference_area(), g["rocket"]["refArea"])
    m.check("lengthAero", cfg.get_length_aerodynamic(), g["rocket"]["lengthAero"])
    m.check("length", cfg.get_length(), g["rocket"]["length"])
    return m


def cm_mismatches(rocket, g: dict) -> Mismatches:
    """MassCalculator.getCMAnalysis: each component's (and motor's) mass and CG."""
    m = Mismatches()
    cfg = rocket.get_selected_configuration()
    ours = {}
    for key, e in get_cm_analysis(cfg).items():
        ours[("motor", e.name) if isinstance(key, tuple) else key] = e
    for ge in g["cm"]:
        key = ge["id"] if ge["id"] is not None else ("motor", ge["name"])
        e = ours.get(key)
        if e is None:
            m.append(f"CM analysis: no entry for {ge['name']}")
            continue
        m.check(f"CM {ge['name']} eachMass", e.each_mass, ge["eachMass"])
        m.check(f"CM {ge['name']} cgx", e.total_cm.x, ge["cgx"])
        m.check(f"CM {ge['name']} totalMass", e.total_cm.weight, ge["totalMass"])
    if len(ours) != len(g["cm"]):
        m.append(f"CM analysis has {len(ours)} entries, OpenRocket {len(g['cm'])}")
    return m


def motor_mismatches(rocket, g: dict) -> Mismatches:
    """Active motors (mount, position, count, delays) and every configuration's masses."""
    m = Mismatches()
    cfg = rocket.get_selected_configuration()
    active = {mc.get_mount().id: mc for mc in cfg.get_active_motors()}
    for gm in g["motors"]:
        mc = active.get(gm["mount"])
        if mc is None:
            m.append(f"no motor in mount {gm['mount']} ({gm['designation']})")
            continue
        mo = mc.get_motor()
        m.same(gm["designation"] + " designation", mo.get_designation(), gm["designation"])
        m.same(gm["designation"] + " digest", mo.get_digest(), gm["digest"])
        m.check(gm["designation"] + " x", mc.get_x(), gm["x"])
        m.same(gm["designation"] + " count", mc.get_motor_count(), gm["motorCount"])
        m.check(gm["designation"] + " ejectionDelay", mc.get_ejection_delay(), gm["ejectionDelay"])
        m.check(gm["designation"] + " ignitionDelay", mc.get_ignition_delay(), gm["ignitionDelay"])
        m.same(gm["designation"] + " ignitionEvent", mc.get_ignition_event().upper(), gm["ignitionEvent"])
    if len(active) != len(g["motors"]):
        m.append(f"{len(active)} active motors, OpenRocket {len(g['motors'])}")
    for gc in g.get("configs", []):
        c2 = rocket.configurations.get(gc["id"])
        if c2 is None:
            m.append(f"no flight configuration {gc['id']}")
            continue
        for name in ("launch", "burnout"):
            b = BODIES[name](c2)
            for k, v in (("mass", b.cm.weight), ("cgx", b.cm.x), ("Ixx", b.Ixx), ("Iyy", b.Iyy)):
                m.check(f"config {gc['id'][:8]} {name} {k}", v, gc[name][k])
    return m


def all_mismatches(ork: Path, golden_path: Path) -> Mismatches:
    g = json.loads(golden_path.read_text())
    r = load(ork, g)
    m = Mismatches()
    for fn in (component_mismatches, rocket_mismatches, cm_mismatches, motor_mismatches):
        m.extend(fn(r, g))
    return m

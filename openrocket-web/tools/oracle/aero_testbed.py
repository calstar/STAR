"""Write tests/rockets_aero/*.ork: variants of "A simple model rocket" that reach the
aerodynamics the bundled examples never touch.

The examples only fly ogive, conical and ellipsoid noses, normal/smooth finishes,
3-4 fins and no real CD override; a port could get the power, parabolic and Haack
nose-drag interpolation, boattail fineness, the other finishes' roughness, 5+ fin
interference or override bookkeeping wrong and still match every example. Each
variant changes a few elements of the example's XML; tools/oracle then runs the
.ork through OpenRocket itself:

    python3 tools/oracle/aero_testbed.py
    GOLDEN_DIR=tests/golden_aero OPENROCKET_JAR=... tools/oracle/run.sh tests/rockets_aero/*.ork

Deterministic: ids are derived from the variant name, so re-running gives the same files.
"""

from __future__ import annotations

import copy
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "tests" / "rockets" / "A simple model rocket.ork"
OUT = ROOT / "tests" / "rockets_aero"


def _id(variant: str, what: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"orweb-aero-testbed/{variant}/{what}"))


def _set(parent: ET.Element, tag: str, text: str) -> None:
    e = parent.find(tag)
    if e is None:
        e = ET.SubElement(parent, tag)
    e.text = text


def _transition(variant: str, name: str, length: float, fore: float, aft: float,
                shape: str = "conical", param: float = 0.0) -> ET.Element:
    t = ET.Element("transition")
    for tag, text in [("name", name), ("id", _id(variant, name)), ("finish", "normal"),
                      ("length", repr(length)), ("thickness", "0.001"), ("shape", shape),
                      ("shapeparameter", repr(param)), ("foreradius", repr(fore)), ("aftradius", repr(aft)),
                      ("foreshoulderradius", "0.0"), ("foreshoulderlength", "0.0"),
                      ("foreshoulderthickness", "0.0"), ("foreshouldercapped", "false"),
                      ("aftshoulderradius", "0.0"), ("aftshoulderlength", "0.0"),
                      ("aftshoulderthickness", "0.0"), ("aftshouldercapped", "false")]:
        ET.SubElement(t, tag).text = text
    m = ET.SubElement(t, "material", {"type": "bulk", "density": "1050.0"})
    m.text = "Polystyrene"
    return t


def _bodytube(variant: str, name: str, length: float, radius: float) -> ET.Element:
    b = ET.Element("bodytube")
    for tag, text in [("name", name), ("id", _id(variant, name)), ("finish", "normal"),
                      ("length", repr(length)), ("thickness", "0.001"), ("radius", repr(radius))]:
        ET.SubElement(b, tag).text = text
    m = ET.SubElement(b, "material", {"type": "bulk", "density": "680.0"})
    m.text = "Cardboard"
    return b


def _override_cd(c: ET.Element, cd: float, subcomponents: bool = False) -> None:
    _set(c, "overridecd", repr(cd))
    _set(c, "overridesubcomponentscd", "true" if subcomponents else "false")


def variants():
    """name -> function(rocket_element, variant_name) editing the rocket in place."""

    def nose(shape, param, finish=None, fins=None, xsec=None, cant=None):
        def edit(r, v):
            n = r.find(".//nosecone")
            _set(n, "shape", shape)
            _set(n, "shapeparameter", repr(param))
            if finish:
                for f in r.iter("finish"):
                    f.text = finish
            fs = r.find(".//trapezoidfinset")
            if fins:
                _set(fs, "fincount", str(fins))
                _set(fs, "instancecount", str(fins))
            if xsec:
                _set(fs, "crosssection", xsec)
            if cant is not None:
                _set(fs, "cant", repr(cant))  # degrees in the file
        return edit

    def after_body(*make):
        def edit(r, v):
            stage = r.find("subcomponents/stage/subcomponents")
            for m in make:
                stage.append(m(v))
        return edit

    def two_fin_sets(r, v):
        """Overlapping fin sets: 6 + 6 fins in interference, beyond the table (75%)."""
        fs = r.find(".//trapezoidfinset")
        _set(fs, "fincount", "6")
        _set(fs, "instancecount", "6")
        second = copy.deepcopy(fs)
        _set(second, "name", "Second fin set")
        _set(second, "id", _id(v, "second fin set"))
        _set(second, "rotation", repr(0.5))
        _set(second, "height", "0.02")
        r.find(".//bodytube/subcomponents").append(second)

    def overrides(r, v):
        _override_cd(r.find(".//nosecone"), 0.35)
        _override_cd(r.find(".//trapezoidfinset"), 0.02)
        _override_cd(r.find(".//launchlug"), 0.004)

    def override_body_sub(r, v):
        _override_cd(r.find(".//bodytube"), 0.3, subcomponents=True)

    def override_stage(r, v):
        _override_cd(r.find("subcomponents/stage"), 0.5, subcomponents=True)

    return {
        "aero power 0.1 rough 5 fins": nose("power", 0.1, "rough", fins=5),
        "aero power 0.4 roughunfinished 6 fins": nose("power", 0.4, "roughunfinished", fins=6, xsec="square"),
        "aero power 0.6 unfinished 7 fins": nose("power", 0.6, "unfinished", fins=7, xsec="airfoil"),
        "aero power 0.9 optimum 8 fins": nose("power", 0.9, "optimum", fins=8),
        "aero parabolic 0.3 polished 10 fins": nose("parabolic", 0.3, "polished", fins=10),
        "aero parabolic 0.6 finishpolished cant": nose("parabolic", 0.6, "finishpolished", cant=2.5),
        "aero parabolic 1.0 mirror": nose("parabolic", 1.0, "mirror", xsec="square"),
        "aero haack 0": nose("haack", 0.0),
        "aero haack 0.333 1 fin": nose("haack", 0.333, fins=1),
        "aero boattails": after_body(
            lambda v: _transition(v, "Long boattail", 0.016, 0.0125, 0.0105),      # fineness 4: no drag
            lambda v: _transition(v, "Mid boattail", 0.012, 0.0105, 0.0075),       # fineness 2
            lambda v: _transition(v, "Blunt boattail", 0.002, 0.0075, 0.003)),     # fineness < 1
        "aero shoulder and disk": after_body(
            lambda v: _transition(v, "Shoulder", 0.03, 0.0125, 0.016, "ogive", 0.5),
            lambda v: _bodytube(v, "Upper tube", 0.1, 0.016),
            lambda v: _transition(v, "Power shoulder", 0.02, 0.016, 0.02, "power", 0.5),
            lambda v: _bodytube(v, "Wide tube", 0.05, 0.02),
            lambda v: _transition(v, "Disk", 0.0, 0.02, 0.01),
            lambda v: _transition(v, "Tiny step out", 0.0005, 0.01, 0.014),       # length < 1 mm: stagnation
            lambda v: _transition(v, "Tiny step in", 0.0005, 0.014, 0.012)),      # length < 1 mm: base
        "aero two fin sets": two_fin_sets,
        "aero cd overrides": overrides,
        "aero cd override body subcomponents": override_body_sub,
        "aero cd override stage": override_stage,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(BASE) as z:
        base_xml = z.read("rocket.ork")
    for name, edit in variants().items():
        tree = ET.ElementTree(ET.fromstring(base_xml))
        root = tree.getroot()
        for parent in root.iter():
            for child in list(parent):
                if child.tag in ("decal", "simulations", "photostudio"):
                    parent.remove(child)
        rocket = root.find("rocket")
        _set(rocket, "name", name)
        _set(rocket, "id", _id(name, "rocket"))
        edit(rocket, name)
        data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        path = OUT / f"{name}.ork"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            info = zipfile.ZipInfo("rocket.ork", date_time=(2026, 1, 1, 0, 0, 0))
            z.writestr(info, data, zipfile.ZIP_DEFLATED)
        print("wrote", path.relative_to(ROOT))


if __name__ == "__main__":
    main()

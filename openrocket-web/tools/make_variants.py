"""Write tests/variants/rockets/*.ork: example designs edited through the document API
(shapes, clipping, shoulders, tabs, fillets, cant, clusters, pods, overrides, every
component type at its defaults, ...) to cover code paths the examples do not.

    python3 tools/make_variants.py
    GOLDEN_DIR=tests/variants/golden OPENROCKET_JAR=... tools/oracle/run.sh tests/variants/rockets/*.ork

The .ork files are written by orweb and their golden data computed by OpenRocket, so a
variant tests both that OpenRocket loads what orweb writes and that the model agrees.
"""

from __future__ import annotations

import copy
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from orweb import default_component, new_document, read_ork, write_ork  # noqa: E402

OUT = ROOT / "tests" / "variants" / "rockets"


def load(name: str) -> dict:
    return read_ork(ROOT / "tests" / "rockets" / f"{name}.ork", keep_simulations=False)


def find(doc: dict, ctype: str, nth: int = 0, name: str | None = None) -> dict:
    hits = []

    def walk(c):
        if c["type"] == ctype and (name is None or c["name"] == name):
            hits.append(c)
        for ch in c["children"]:
            walk(ch)
    walk(doc["rocket"])
    return hits[nth]


def add(parent: dict, ctype: str, name: str | None = None, **params) -> dict:
    c = default_component(ctype)
    if name:
        c["name"] = name
    c["params"].update(params)
    parent["children"].append(c)
    return c


def axial(method: str, value: float) -> dict:
    return {"method": method, "value": value}


def angle(rad: float) -> dict:
    return {"method": "relative", "value": rad}


def variants() -> dict[str, dict]:
    v: dict[str, dict] = {}

    d = load("Base drag hack (short-wide)")
    t = find(d, "transition")
    t["params"].update(shape="power", shapeparameter=0.3, shapeclipped=True)
    n = find(d, "nosecone")
    n["params"].update(shape="haack", shapeparameter=0.2)
    v["power clipped transition, haack nose"] = d

    d = load("Base drag hack (short-wide)")
    t = find(d, "transition")
    t["params"].update(shape="haack", shapeparameter=0.5, shapeclipped=False, foreshoulderradius=0.03,
                       foreshoulderlength=0.02, foreshoulderthickness=0.002, foreshouldercapped=True,
                       aftshoulderradius=0.02, aftshoulderlength=0.01, aftshoulderthickness=0.001,
                       aftshouldercapped=True)
    n = find(d, "nosecone")
    n["params"].update(shape="parabolic", shapeparameter=0.5, thickness="filled")
    v["haack transition with capped shoulders, filled parabolic nose"] = d

    d = load("Base drag hack (short-wide)")
    t = find(d, "transition")
    t["params"].update(shape="ellipsoid", shapeclipped=True)
    n = find(d, "nosecone")
    n["params"].update(shape="ogive", shapeparameter=0.6, thickness=0.05)
    v["clipped ellipsoid transition, thick ogive nose"] = d

    d = load("A simple model rocket")
    f = find(d, "trapezoidfinset")
    f["params"].update(tabheight=0.004, tablength=0.03, tabposition=axial("middle", 0.002), filletradius=0.004,
                       cant=math.radians(3.0), crosssection="airfoil", instancecount=4, angleoffset=angle(0.3))
    v["fins with tabs, fillets and cant"] = d

    d = load("Clustered motors")
    f = find(d, "ellipticalfinset")
    f["params"].update(instancecount=1, angleoffset=angle(0.5), tabheight=0.003, tablength=0.02,
                       tabposition=axial("top", 0.005))
    nose = find(d, "nosecone")
    add(nose, "freeformfinset", "Nose strakes", axialoffset=axial("top", 0.02), instancecount=2)
    v["single elliptical fin, freeform fins on a nose"] = d

    d = load("Clustered motors")
    it = find(d, "innertube")
    it["params"].update(clusterconfiguration="3-ring", clusterscale=1.3, clusterrotation=0.4, radialposition=0.001,
                        radialdirection=0.7)
    cr = find(d, "centeringring")
    cr["params"].update(instancecount=2, instanceseparation=0.01)
    v["3-ring cluster offset, doubled centering ring"] = d

    d = load("A simple model rocket")
    lug = find(d, "launchlug")
    lug["params"].update(instancecount=3, instanceseparation=0.04)
    bt = find(d, "bodytube")
    add(bt, "railbutton", axialoffset=axial("top", 0.05), instancecount=2, instanceseparation=0.1, screwheight=0.003,
        angleoffset=angle(1.0))
    v["three lugs, two rail buttons"] = d

    d = load("Two stage high power rocket")
    st = find(d, "stage", 1)
    st["params"].update(overridemass=1.5, overridesubcomponentsmass=True)
    bt = find(d, "bodytube")
    bt["params"].update(overridecg=0.2, overridesubcomponentscg=True)
    nose = find(d, "nosecone")
    nose["params"].update(overridemass=0.3, overridesubcomponentsmass=False)
    v["stage and component overrides"] = d

    d = load("Pods--airframes and winglets")
    pod = find(d, "podset")
    pod["params"].update(radiusoffset={"method": "free", "value": 0.05}, angleoffset=angle(0.3), instancecount=3,
                         axialoffset=axial("absolute", 0.1))
    v["three free-radius pods"] = d

    d = load("Parallel booster staging")
    ps = find(d, "parallelstage")
    ps["params"].update(instancecount=3, radiusoffset={"method": "relative", "value": 0.01},
                        axialoffset=axial("middle", 0.05))
    v["three boosters"] = d

    d = load("A simple model rocket")
    find(d, "masscomponent")["params"].update(axialoffset=axial("absolute", 0.2))
    find(d, "parachute")["params"].update(axialoffset=axial("middle", -0.01), packedradius={"auto": True, "value": 0.009})
    find(d, "shockcord")["params"].update(axialoffset=axial("after", 0.0))
    find(d, "innertube")["params"].update(axialoffset=axial("top", 0.2))
    v["axial methods"] = d

    d = load("Tube fin rocket")
    tf = find(d, "tubefinset")
    tf["params"].update(instancecount=3, radius={"auto": False, "value": 0.012}, thickness=0.0008, angleoffset=angle(0.2))
    v["three manual tube fins"] = d

    d = load("Tube fin rocket")
    tf = find(d, "tubefinset")
    tf["params"].update(instancecount=8)
    v["eight auto tube fins"] = d

    # every component at OpenRocket's defaults
    d = new_document("Defaults")
    stage = d["rocket"]["children"][0]
    add(stage, "nosecone")
    b1 = add(stage, "bodytube")
    tr = add(stage, "transition")
    b2 = add(stage, "bodytube")
    add(b1, "innertube")
    add(b1, "centeringring")
    add(b1, "bulkhead")
    tc = add(b1, "tubecoupler")
    add(tc, "engineblock")
    add(b1, "masscomponent", mass=0.05)
    add(b1, "shockcord")
    add(b1, "parachute")
    add(b1, "streamer")
    add(b1, "launchlug")
    add(b1, "railbutton")
    add(b1, "trapezoidfinset")
    add(tr, "freeformfinset")
    add(b2, "ellipticalfinset")
    add(b2, "tubefinset")
    pods = add(b2, "podset")
    add(pods, "nosecone")
    add(pods, "bodytube")
    boost = add(b2, "parallelstage")
    add(boost, "nosecone")
    add(boost, "bodytube")
    v["every component at defaults"] = d

    d = new_document("Defaults, two stages")
    s1 = d["rocket"]["children"][0]
    add(s1, "nosecone")
    add(s1, "bodytube")
    s2 = default_component("stage")
    d["rocket"]["children"].append(s2)
    add(s2, "transition")
    bt = add(s2, "bodytube")
    add(bt, "trapezoidfinset")
    d["motorConfigs"][0]["stages"] = {"0": True, "1": True}
    v["two default stages"] = d
    return v


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, doc in variants().items():
        write_ork(doc, OUT / f"{name}.ork")
        print("wrote", name)


if __name__ == "__main__":
    main()

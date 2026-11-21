""".ork <-> document round trips.

* read -> write -> read gives the same document (nothing lost, nothing invented);
* the saved file builds to the same numbers OpenRocket computed for the original;
* with a JDK and OPENROCKET_JAR, OpenRocket 24.12 itself loads every saved file and its
  oracle output equals the original's, field for field (aerodynamics included).
"""

from __future__ import annotations

import io
import json
import math
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

from _orweb_check import HERE, all_mismatches, case_id, cases
from orweb import (build_rocket, default_component, document_from_json, document_to_json, new_document,
                   read_ork, write_ork)
from orweb.build import TYPE_CLASSES

EXAMPLES = sorted((HERE / "rockets").glob("*.ork"))
CASES = cases()


@pytest.mark.parametrize("ork", EXAMPLES, ids=[p.stem for p in EXAMPLES])
def test_read_write_read_is_identity(ork):
    a = read_ork(ork)
    b = read_ork(write_ork(a))
    assert b["rocket"] == a["rocket"]
    assert b["motorConfigs"] == a["motorConfigs"]
    assert b["selectedConfig"] == a["selectedConfig"]
    assert b["ork"]["extra"] == a["ork"]["extra"]
    assert b["ork"]["files"] == a["ork"]["files"]


@pytest.mark.parametrize("ork", EXAMPLES, ids=[p.stem for p in EXAMPLES])
def test_json_round_trip(ork):
    a = read_ork(ork)
    assert document_from_json(document_to_json(a)) == a


@pytest.mark.parametrize("case", CASES, ids=[case_id(c) for c in CASES])
def test_saved_file_builds_to_openrockets_numbers(case, tmp_path):
    ork, golden = case
    saved = tmp_path / ork.name
    write_ork(read_ork(ork), saved)
    m = all_mismatches(saved, golden)
    assert not m, "\n".join(m[:20])


def test_passthrough_is_verbatim():
    doc = read_ork(HERE / "rockets" / "A simple model rocket.ork")
    nose = doc["rocket"]["children"][0]["children"][0]
    assert nose["type"] == "nosecone"
    assert nose["params"]["appearance"]["_xml"].startswith("<appearance>")
    assert any(n.startswith("decals/") for n in doc["ork"]["files"])
    assert any(x.startswith("<simulations") for x in doc["ork"]["extra"])
    z = zipfile.ZipFile(io.BytesIO(write_ork(doc)))
    assert set(z.namelist()) == {"rocket.ork"} | set(doc["ork"]["files"])


def test_schema_value_shapes():
    doc = read_ork(HERE / "rockets" / "A simple model rocket.ork")
    stage = doc["rocket"]["children"][0]
    nose, body = stage["children"][:2]
    assert nose["params"]["material"] == {"type": "bulk", "density": 1050.0, "name": "Polystyrene",
                                          "group": "Plastics"}
    assert nose["params"]["aftradius"] == {"auto": False, "value": 0.0125}
    assert body["params"]["radius"] == {"auto": True, "value": 0.0125}
    kids = {c["type"]: c for c in body["children"]}
    assert kids["parachute"]["params"]["axialoffset"] == {"method": "top", "value": 0.032}
    assert kids["launchlug"]["params"]["angleoffset"]["value"] == pytest.approx(math.radians(19.0))
    assert kids["centeringring"]["params"]["outerradius"] == {"auto": True, "value": None}
    assert "position" not in kids["parachute"]["params"]  # the saver's duplicate, folded in
    assert "fincount" not in kids["trapezoidfinset"]["params"]
    cfg = next(c for c in doc["motorConfigs"] if c["id"] == doc["selectedConfig"])
    m = cfg["motors"][kids["innertube"]["id"]]
    assert m["designation"] == "C6" and m["delay"] == 5.0 and m["ignitionEvent"] == "automatic"


@pytest.mark.parametrize("ctype", sorted(set(TYPE_CLASSES) - {"boosterset"}))
def test_default_components_build(ctype):
    c = default_component(ctype)
    assert c["type"] == ctype and (c["params"] or ctype == "stage")
    doc = new_document()
    stage = doc["rocket"]["children"][0]
    host = stage
    if ctype == "stage":
        host = doc["rocket"]
    elif ctype not in ("nosecone", "bodytube", "transition"):
        body = default_component("transition" if ctype == "freeformfinset" else "bodytube")
        stage["children"].append(body)
        host = body
    host["children"].append(c)
    r = build_rocket(read_ork(write_ork(doc)))
    assert r.warnings == []
    assert c["id"] in r.by_id


# ---------------------------------------------------------------------------- OpenRocket itself

def _jar() -> Path | None:
    for p in (os.environ.get("OPENROCKET_JAR"),):
        if p and Path(p).exists():
            return Path(p)
    return None


@pytest.fixture(scope="module")
def oracle(tmp_path_factory):
    jar = _jar()
    if jar is None or shutil.which("javac") is None:
        pytest.skip("needs a JDK and OPENROCKET_JAR=OpenRocket-24.12.jar")
    build = tmp_path_factory.mktemp("oracle")
    subprocess.run(["javac", "-d", str(build), "-cp", str(jar), str(HERE.parent / "tools/oracle/Oracle.java")],
                   check=True, capture_output=True)

    def run(ork: Path) -> dict:
        p = subprocess.run(["java", "-Djava.awt.headless=true", "-cp", f"{jar}{os.pathsep}{build}", "Oracle", str(ork)],
                           capture_output=True, text=True, timeout=300)
        line = next(l for l in p.stdout.splitlines() if l.startswith("{"))
        return json.loads(line)
    return run


def _diff(a, b, path="", out=None):
    out = [] if out is None else out
    if isinstance(a, dict):
        for k in a:
            if k not in b:
                out.append(f"{path}.{k} missing")
            else:
                _diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: {len(a)} vs {len(b)} items")
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                _diff(x, y, f"{path}[{i}]", out)
    elif isinstance(a, float) and isinstance(b, (int, float)):
        if a != b and abs(a - b) > 1e-12 * max(abs(a), abs(b)):
            out.append(f"{path}: {a!r} vs {b!r}")
    elif a != b:
        out.append(f"{path}: {a!r} vs {b!r}")
    return out


@pytest.mark.oracle
@pytest.mark.parametrize("case", CASES, ids=[case_id(c) for c in CASES])
def test_openrocket_loads_what_orweb_saves(case, oracle, tmp_path):
    """Save with orweb, load with OpenRocket: every oracle number equals the original's."""
    ork, golden = case
    saved = tmp_path / ork.name
    write_ork(read_ork(ork), saved)
    a = json.loads(golden.read_text())
    b = oracle(saved)
    for g in (a, b):  # HashMap order in the oracle's output
        g["cm"] = sorted(g["cm"], key=lambda e: (str(e["id"]), e["name"]))
        g["motors"] = sorted(g["motors"], key=lambda e: e["mount"])
    d = _diff(a, b)
    assert not d, "\n".join(d[:20])

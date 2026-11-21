"""The .ork file <-> the rocket document (docs/SCHEMA.md).

Reads what OpenRocket 24.12's importer reads (file/openrocket/importt: OpenRocketLoader,
ComponentHandler, ComponentParameterHandler, MotorMountHandler, MotorHandler,
MotorConfigurationHandler, FinSetPointHandler and the setters of DocumentConfig) and
writes what its savers write (file/openrocket/savers), OpenRocket 24.12, GPLv3.

The document mirrors the file: a component's ``type`` is its element name and its
``params`` are its child elements, in file order. Values are decoded to the shapes
SCHEMA.md lists (angles in radians, auto values as ``{"auto", "value"}``, ...).
Anything the port does not interpret -- appearance, decals, presets, per-configuration
deployment/separation overrides, simulations, photo studio, document preferences,
the zip's other entries -- is carried verbatim (``{"_xml": "<raw element>"}`` in
params, ``document["ork"]`` for the rest), so load -> save loses nothing.
"""

from __future__ import annotations

import base64
import io
import math
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ORK_VERSION = "1.10"
CREATOR = "openrocket-web (orweb, OpenRocket 24.12 port)"

# ---------------------------------------------------------------------------- value kinds

FLOAT_TAGS = {
    "length", "shapeparameter", "foreshoulderradius", "foreshoulderlength", "foreshoulderthickness",
    "aftshoulderradius", "aftshoulderlength", "aftshoulderthickness", "rootchord", "tipchord", "sweeplength",
    "height", "tabheight", "tablength", "filletradius", "instanceseparation", "radialposition", "packedlength",
    "mass", "cordlength", "diameter", "linelength", "striplength", "stripwidth", "deployaltitude", "deploydelay",
    "separationaltitude", "separationdelay", "clusterscale", "outerdiameter", "innerdiameter", "baseheight",
    "flangeheight", "screwheight", "customreference", "overridemass", "overridecg", "overridecd", "thickness",
}
INT_TAGS = {"instancecount", "fincount", "linecount"}
BOOL_TAGS = {"shapeclipped", "foreshouldercapped", "aftshouldercapped", "isflipped", "overridesubcomponents",
             "overridesubcomponentsmass", "overridesubcomponentscg", "overridesubcomponentscd"}
STR_TAGS = {"finish", "shape", "crosssection", "clusterconfiguration", "masscomponenttype", "deployevent",
            "separationevent", "referencetype", "designtype", "comment", "designer", "revision", "kitname"}
DEG_TAGS = {"cant", "clusterrotation", "radialdirection"}
MATERIAL_TAGS = {"material", "filletmaterial", "linematerial"}
SYMMETRIC_TYPES = {"nosecone", "bodytube", "transition"}
FIN_TYPES = {"trapezoidfinset", "ellipticalfinset", "freeformfinset", "tubefinset"}
MOUNT_TYPES = {"bodytube", "innertube"}

#: (type, tag) pairs that may be written "auto" / "auto <value>"; True = "auto <value>" form
AUTO_TAGS = {
    ("bodytube", "radius"): True,
    ("transition", "foreradius"): True, ("transition", "aftradius"): True,
    ("nosecone", "aftradius"): True, ("nosecone", "foreradius"): True,
    ("tubefinset", "radius"): False,
    ("engineblock", "outerradius"): False, ("tubecoupler", "outerradius"): False,
    ("bulkhead", "outerradius"): False,
    ("centeringring", "outerradius"): False, ("centeringring", "innerradius"): False,
}
_MASS_OBJECTS = {"masscomponent", "shockcord", "parachute", "streamer"}
_RECOVERY = {"parachute", "streamer"}
for _t in _MASS_OBJECTS:
    AUTO_TAGS[(_t, "packedradius")] = True
for _t in _RECOVERY:
    AUTO_TAGS[(_t, "cd")] = False

TYPE_ALIASES = {"boosterset": "parallelstage"}
COMPONENT_TYPES = {
    "stage", "parallelstage", "podset", "nosecone", "bodytube", "transition", "trapezoidfinset",
    "ellipticalfinset", "freeformfinset", "tubefinset", "launchlug", "railbutton", "innertube", "tubecoupler",
    "centeringring", "bulkhead", "engineblock", "masscomponent", "shockcord", "parachute", "streamer",
}


def jfloat(s: str) -> float:
    """Double.parseDouble / DocumentConfig.stringToDouble."""
    s = s.strip()
    low = s.lower()
    if low == "nan":
        return math.nan
    if low in ("inf", "infinity", "+infinity"):
        return math.inf
    if low in ("-inf", "-infinity"):
        return -math.inf
    return float(s.rstrip("dDfF") if s[-1:] in "dDfF" and not low.endswith("inf") else s)


def jstr(v: float) -> str:
    """A number as text Java's Double.parseDouble reads back to the same double."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if math.isnan(v):
        return "NaN"
    if math.isinf(v):
        return "Infinity" if v > 0 else "-Infinity"
    r = repr(float(v))
    return r


def _raw(elem: ET.Element) -> dict:
    e = _copy_without_tail(elem)
    return {"_xml": ET.tostring(e, encoding="unicode")}


def _copy_without_tail(elem: ET.Element) -> ET.Element:
    e = ET.Element(elem.tag, dict(elem.attrib))
    e.text = elem.text
    for c in elem:
        e.append(_copy_with_tail(c))
    return e


def _copy_with_tail(elem: ET.Element) -> ET.Element:
    e = _copy_without_tail(elem)
    e.tail = elem.tail
    return e


def _text(elem: ET.Element) -> str:
    return (elem.text or "").strip()


def _put(params: dict, key: str, value) -> None:
    """Store a param; a repeated element becomes a list (passthrough only)."""
    if key in params:
        prev = params[key]
        if isinstance(prev, list) and prev and isinstance(prev[0], dict) and "_xml" in prev[0]:
            prev.append(value)
        elif isinstance(prev, dict) and "_xml" in prev and isinstance(value, dict) and "_xml" in value:
            params[key] = [prev, value]
        else:
            params[key] = value  # a later value of a plain param wins, as the setter would
    else:
        params[key] = value


def decode_param(ctype: str, elem: ET.Element):
    """One .ork parameter element -> its document value (None: not a component parameter)."""
    tag = elem.tag
    text = _text(elem)
    if (ctype, tag) in AUTO_TAGS:
        if text.lower().startswith("auto"):
            rest = text[4:].strip()
            return {"auto": True, "value": jfloat(rest) if rest else None}
        return {"auto": False, "value": jfloat(text)}
    if tag in ("axialoffset", "position"):
        method = elem.get("method") or elem.get("type")
        return {"method": method, "value": jfloat(text)}
    if tag == "angleoffset":
        return {"method": elem.get("method") or "relative", "value": math.radians(jfloat(text))}
    if tag == "radiusoffset":
        return {"method": elem.get("method") or "surface", "value": jfloat(text)}
    if tag == "tabposition":
        rel = elem.get("relativeto") or ""
        if "front" in rel:
            rel = "top"
        elif "center" in rel:
            rel = "middle"
        elif "end" in rel:
            rel = "bottom"
        return {"method": rel, "value": jfloat(text)}
    if tag in MATERIAL_TAGS:
        m = {"type": elem.get("type"), "density": jfloat(elem.get("density")), "name": text}
        if elem.get("group") is not None:
            m["group"] = elem.get("group")
        return m
    if tag == "finpoints":
        return [[jfloat(p.get("x")), jfloat(p.get("y"))] for p in elem if p.tag == "point"]
    if tag == "thickness" and ctype in SYMMETRIC_TYPES:
        return "filled" if text == "filled" else jfloat(text)
    if tag in ("rotation",) or (tag == "radialdirection" and ctype == "launchlug"):
        return {"method": "relative", "value": math.radians(jfloat(text))}
    if tag in DEG_TAGS:
        return math.radians(jfloat(text))
    if tag in INT_TAGS:
        return int(text)
    if tag in BOOL_TAGS:
        return text.lower() == "true"
    if tag in STR_TAGS:
        if tag in ("comment", "designer", "revision", "kitname"):
            return elem.text or ""
        return text
    if tag in FLOAT_TAGS or tag in ("radius", "outerradius", "innerradius", "packedradius", "cd"):
        return jfloat(text)
    return None


# ---------------------------------------------------------------------------- reading

def _read_motormount(elem: ET.Element, mount_id: str, motors_by_config: dict) -> dict:
    mm: dict = {}
    for c in elem:
        if c.tag in ("ignitionevent",):
            mm["ignitionevent"] = _text(c)
        elif c.tag == "ignitiondelay":
            mm["ignitiondelay"] = jfloat(_text(c))
        elif c.tag == "overhang":
            mm["overhang"] = jfloat(_text(c))
        elif c.tag == "motor":
            cid = c.get("configid")
            m: dict = {}
            for e in c:
                t = _text(e)
                if e.tag == "type":
                    m["type"] = t
                elif e.tag == "manufacturer":
                    m["manufacturer"] = t
                elif e.tag == "designation":
                    m["designation"] = t
                elif e.tag == "digest":
                    m["digest"] = t
                elif e.tag == "diameter":
                    m["diameter"] = jfloat(t)
                elif e.tag == "length":
                    m["length"] = jfloat(t)
                elif e.tag == "delay":
                    m["delay"] = None if t == "none" else jfloat(t)
            m.setdefault("delay", None)
            m["ignitionEvent"] = mm.get("ignitionevent", "automatic")
            m["ignitionDelay"] = mm.get("ignitiondelay", 0.0)
            motors_by_config.setdefault(cid, {})[mount_id] = m
        elif c.tag == "ignitionconfiguration":
            cid = c.get("configid")
            entry = motors_by_config.get(cid, {}).get(mount_id)
            if entry is not None:
                for e in c:
                    if e.tag == "ignitionevent":
                        entry["ignitionEvent"] = _text(e)
                    elif e.tag == "ignitiondelay":
                        entry["ignitionDelay"] = jfloat(_text(e))
    return mm


# Per-flight-configuration overrides a stage's separation or a recovery device's
# deployment (StageSeparationConfiguration / DeploymentConfiguration). Structured
# rather than carried as raw XML, so the Motors & Configuration tab can edit them:
#   "separationconfiguration": [{"configid": "…", "separationevent": "burnout",
#                                "separationaltitude": 200.0, "separationdelay": 0.0}]
PER_CONFIG_TAGS = ("separationconfiguration", "deploymentconfiguration")


def _read_per_config(elem: ET.Element) -> dict:
    out: dict = {"configid": elem.get("configid")}
    for e in elem:
        t = _text(e)
        try:
            out[e.tag] = float(t)
        except ValueError:
            out[e.tag] = t
    return out


def _write_per_config(out: "_Out", ind: int, tag: str, items: list) -> None:
    for item in items:
        out.add(ind, f'<{tag} configid="{_esc(str(item["configid"]))}">')
        for k, v in item.items():
            if k == "configid":
                continue
            out.add(ind + 1, f"<{k}>{jstr(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else _esc(str(v))}</{k}>")
        out.add(ind, f"</{tag}>")


def _read_component(elem: ET.Element, motors_by_config: dict, configs: list) -> dict:
    ctype = TYPE_ALIASES.get(elem.tag, elem.tag)
    comp = {"id": None, "type": ctype, "name": "", "params": {}, "children": []}
    params = comp["params"]
    for c in elem:
        tag = c.tag
        if tag == "name":
            comp["name"] = c.text or ""
        elif tag == "id":
            comp["id"] = _text(c)
        elif tag == "subcomponents":
            for sub in c:
                if TYPE_ALIASES.get(sub.tag, sub.tag) in COMPONENT_TYPES:
                    comp["children"].append(_read_component(sub, motors_by_config, configs))
                else:
                    params.setdefault("_unknownchildren", []).append(_raw(sub))
        elif tag == "motormount" and ctype in MOUNT_TYPES:
            if comp["id"] is None:
                comp["id"] = str(uuid.uuid4())
            params["motormount"] = _read_motormount(c, comp["id"], motors_by_config)
        elif tag in PER_CONFIG_TAGS:
            params.setdefault(tag, []).append(_read_per_config(c))
        elif tag in ("motorconfiguration", "flightconfiguration") and ctype == "rocket":
            cfg = {"id": c.get("configid"), "name": "", "default": c.get("default") == "true", "stages": {},
                   "motors": {}}
            for e in c:
                if e.tag == "name":
                    cfg["name"] = e.text or ""
                elif e.tag == "stage":
                    cfg["stages"][e.get("number")] = (e.get("active") or "").lower() == "true"
            configs.append(cfg)
            params.setdefault("motorconfiguration", {"_configs": True})  # where they go on write
        else:
            v = decode_param(ctype, c)
            if v is None:
                _put(params, tag, _raw(c))
                continue
            # aliases the savers write twice: keep one
            if tag == "position":
                if "axialoffset" in params:
                    continue
                tag = "axialoffset"
            elif tag == "rotation" or (tag == "radialdirection" and ctype == "launchlug"):
                if "angleoffset" in params:
                    continue
                tag = "angleoffset"
            elif tag == "fincount" and ctype in FIN_TYPES:
                if "instancecount" in params:
                    continue
                tag = "instancecount"
            _put(params, tag, v)
    if comp["id"] is None:
        comp["id"] = str(uuid.uuid4())
    return comp


def read_ork(source, keep_simulations: bool = True) -> dict:
    """Read an .ork (path, bytes or file object; zip, gzip or plain XML) into a document."""
    if isinstance(source, (str, Path)):
        data = Path(source).read_bytes()
    elif isinstance(source, (bytes, bytearray)):
        data = bytes(source)
    else:
        data = source.read()
    files: dict[str, str] = {}
    xml_name = "rocket.ork"
    if data[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(data))
        names = z.namelist()
        xml_name = next((n for n in names if n.lower().endswith(".ork")), names[0])
        xml = z.read(xml_name)
        for n in names:
            if n != xml_name:
                files[n] = base64.b64encode(z.read(n)).decode("ascii")
    elif data[:2] == b"\x1f\x8b":
        import gzip
        xml = gzip.decompress(data)
    else:
        xml = data
    root = ET.fromstring(xml)
    if root.tag != "openrocket":
        raise ValueError("not an OpenRocket document")
    motors_by_config: dict = {}
    configs: list = []
    rocket = None
    extra = []
    for c in root:
        if c.tag == "rocket" and rocket is None:
            rocket = _read_component(c, motors_by_config, configs)
            rocket["type"] = "rocket"
        elif c.tag == "simulations" and not keep_simulations:
            continue
        else:
            extra.append(ET.tostring(_copy_without_tail(c), encoding="unicode"))
    if rocket is None:
        raise ValueError("no <rocket> in the document")
    for cfg in configs:
        cfg["motors"] = motors_by_config.get(cfg["id"], {})
    known = {c["id"] for c in configs}
    for cid, motors in motors_by_config.items():  # motors in configurations never declared
        if cid not in known:
            configs.append({"id": cid, "name": "", "default": False, "stages": {}, "motors": motors})
    selected = next((c["id"] for c in configs if c.get("default")), None)
    return {
        "version": 1,
        "rocket": rocket,
        "motorConfigs": configs,
        "selectedConfig": selected,
        "ork": {"version": root.get("version"), "creator": root.get("creator"), "extra": extra,
                "files": files, "xmlName": xml_name},
    }


# ---------------------------------------------------------------------------- writing

def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


class _Out:
    def __init__(self):
        self.lines: list[str] = []

    def add(self, indent: int, s: str) -> None:
        self.lines.append("  " * indent + s)

    def raw(self, indent: int, xml: str) -> None:
        for i, line in enumerate(xml.splitlines()):
            self.lines.append(("  " * indent if i == 0 else "") + line)


def _encode_param(out: _Out, ind: int, ctype: str, tag: str, v) -> None:
    """One document param -> element(s), as the savers write them."""
    if tag in PER_CONFIG_TAGS and isinstance(v, list) and all(isinstance(i, dict) and "configid" in i for i in v):
        _write_per_config(out, ind, tag, v)
        return
    if isinstance(v, list) and v and isinstance(v[0], dict) and "_xml" in v[0]:
        for item in v:
            out.raw(ind, item["_xml"])
        return
    if isinstance(v, dict) and "_xml" in v:
        out.raw(ind, v["_xml"])
        return
    if (ctype, tag) in AUTO_TAGS:
        if isinstance(v, dict):
            if v.get("auto"):
                with_value = AUTO_TAGS[(ctype, tag)] and v.get("value") is not None
                out.add(ind, f"<{tag}>auto{' ' + jstr(v['value']) if with_value else ''}</{tag}>")
            else:
                out.add(ind, f"<{tag}>{jstr(v['value'])}</{tag}>")
        else:
            out.add(ind, f"<{tag}>{jstr(v)}</{tag}>")
        return
    if tag == "axialoffset":
        m, val = v["method"], jstr(v["value"])
        if m == "after":
            return  # "Save position unless AFTER"
        out.add(ind, f'<axialoffset method="{m}">{val}</axialoffset>')
        out.add(ind, f'<position type="{m}">{val}</position>')
        return
    if tag == "angleoffset":
        deg = jstr(v["value"] * 180.0 / math.pi)
        out.add(ind, f'<angleoffset method="{v.get("method") or "relative"}">{deg}</angleoffset>')
        if ctype in FIN_TYPES:
            out.add(ind, f"<rotation>{deg}</rotation>")
        elif ctype == "launchlug":
            out.add(ind, f"<radialdirection>{deg}</radialdirection>")
        return
    if tag == "radiusoffset":
        out.add(ind, f'<radiusoffset method="{v.get("method") or "surface"}">{jstr(v["value"])}</radiusoffset>')
        return
    if tag == "tabposition":
        out.add(ind, f'<tabposition relativeto="{v["method"]}">{jstr(v["value"])}</tabposition>')
        return
    if tag in MATERIAL_TAGS:
        grp = f' group="{_esc(v["group"])}"' if v.get("group") is not None else ""
        out.add(ind, f'<{tag} type="{v["type"]}" density="{jstr(v["density"])}"{grp}>{_esc(v["name"])}</{tag}>')
        return
    if tag == "finpoints":
        out.add(ind, "<finpoints>")
        for x, y in v:
            out.add(ind + 1, f'<point x="{jstr(x)}" y="{jstr(y)}"/>')
        out.add(ind, "</finpoints>")
        return
    if tag in DEG_TAGS:
        out.add(ind, f"<{tag}>{jstr(v * 180.0 / math.pi)}</{tag}>")
        return
    if tag == "instancecount":
        out.add(ind, f"<instancecount>{int(v)}</instancecount>")
        if ctype in FIN_TYPES:
            out.add(ind, f"<fincount>{int(v)}</fincount>")
        return
    if isinstance(v, bool):
        out.add(ind, f"<{tag}>{'true' if v else 'false'}</{tag}>")
    elif isinstance(v, (int, float)):
        out.add(ind, f"<{tag}>{jstr(v)}</{tag}>")
    elif isinstance(v, str):
        out.add(ind, f"<{tag}>{_esc(v)}</{tag}>")
    else:
        raise ValueError(f"cannot write param {tag!r} = {v!r}")


def _write_motor_configs(out: _Out, ind: int, doc: dict) -> None:
    selected = doc.get("selectedConfig")
    for cfg in doc.get("motorConfigs", []):
        dflt = ' default="true"' if cfg["id"] == selected else ""
        out.add(ind, f'<motorconfiguration configid="{cfg["id"]}"{dflt}>')
        if cfg.get("name"):
            out.add(ind + 1, f"<name>{_esc(cfg['name'])}</name>")
        for num, active in sorted(cfg.get("stages", {}).items(), key=lambda kv: int(kv[0])):
            out.add(ind + 1, f'<stage number="{num}" active="{"true" if active else "false"}"/>')
        out.add(ind, "</motorconfiguration>")


def _write_motormount(out: _Out, ind: int, comp: dict, mm: dict, doc: dict) -> None:
    out.add(ind, "<motormount>")
    out.add(ind + 1, f"<ignitionevent>{mm.get('ignitionevent', 'automatic')}</ignitionevent>")
    out.add(ind + 1, f"<ignitiondelay>{jstr(mm.get('ignitiondelay', 0.0))}</ignitiondelay>")
    out.add(ind + 1, f"<overhang>{jstr(mm.get('overhang', 0.0))}</overhang>")
    for cfg in doc.get("motorConfigs", []):
        m = cfg.get("motors", {}).get(comp["id"])
        if not m:
            continue
        out.add(ind + 1, f'<motor configid="{cfg["id"]}">')
        if m.get("type") and m["type"].lower() != "unknown":
            out.add(ind + 2, f"<type>{m['type'].lower()}</type>")
        if m.get("manufacturer") is not None:
            out.add(ind + 2, f"<manufacturer>{_esc(m['manufacturer'])}</manufacturer>")
        if m.get("digest"):
            out.add(ind + 2, f"<digest>{m['digest']}</digest>")
        out.add(ind + 2, f"<designation>{_esc(m['designation'])}</designation>")
        if m.get("diameter") is not None:
            out.add(ind + 2, f"<diameter>{jstr(m['diameter'])}</diameter>")
        if m.get("length") is not None:
            out.add(ind + 2, f"<length>{jstr(m['length'])}</length>")
        d = m.get("delay")
        out.add(ind + 2, f"<delay>{'none' if d is None or (isinstance(d, float) and math.isinf(d)) else jstr(d)}</delay>")
        out.add(ind + 1, "</motor>")
        out.add(ind + 1, f'<ignitionconfiguration configid="{cfg["id"]}">')
        out.add(ind + 2, f"<ignitionevent>{m.get('ignitionEvent', 'automatic')}</ignitionevent>")
        out.add(ind + 2, f"<ignitiondelay>{jstr(m.get('ignitionDelay', 0.0))}</ignitiondelay>")
        out.add(ind + 1, "</ignitionconfiguration>")
    out.add(ind, "</motormount>")


def _write_component(out: _Out, ind: int, comp: dict, doc: dict) -> None:
    ctype = comp["type"]
    tag = "rocket" if ctype == "rocket" else ctype
    out.add(ind, f"<{tag}>")
    out.add(ind + 1, f"<name>{_esc(comp.get('name', ''))}</name>")
    out.add(ind + 1, f"<id>{comp['id']}</id>")
    if ctype == "rocket":
        out.add(ind + 1, '<axialoffset method="absolute">0.0</axialoffset>')
        out.add(ind + 1, '<position type="absolute">0.0</position>')
    wrote_configs = False
    for key, v in comp.get("params", {}).items():
        if key in ("_unknownchildren",):
            continue
        if key == "motorconfiguration" and ctype == "rocket":
            _write_motor_configs(out, ind + 1, doc)
            wrote_configs = True
            continue
        if ctype == "rocket" and key == "axialoffset":
            continue
        if key == "motormount":
            _write_motormount(out, ind + 1, comp, v, doc)
            continue
        _encode_param(out, ind + 1, ctype, key, v)
    if ctype == "rocket" and not wrote_configs:
        _write_motor_configs(out, ind + 1, doc)
    kids = comp.get("children", [])
    unknown = comp.get("params", {}).get("_unknownchildren", [])
    if kids or unknown:
        out.add(0, "")
        out.add(ind + 1, "<subcomponents>")
        for k in kids:
            _write_component(out, ind + 2, k, doc)
        for u in unknown:
            out.raw(ind + 2, u["_xml"])
        out.add(ind + 1, "</subcomponents>")
    out.add(ind, f"</{tag}>")


def write_ork_xml(doc: dict) -> str:
    out = _Out()
    out.add(0, "<?xml version='1.0' encoding='utf-8'?>")
    out.add(0, f'<openrocket version="{ORK_VERSION}" creator="{_esc(CREATOR)}">')
    _write_component(out, 1, doc["rocket"], doc)
    for raw in (doc.get("ork") or {}).get("extra", []):
        out.add(0, "")
        out.raw(1, raw)
    out.add(0, "</openrocket>")
    return "\n".join(out.lines) + "\n"


def write_ork(doc: dict, path: str | Path | None = None) -> bytes:
    """The document as an .ork (zip with rocket.ork and the carried-through files)."""
    xml = write_ork_xml(doc).encode("utf-8")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("rocket.ork", xml)
        for name, b64 in ((doc.get("ork") or {}).get("files") or {}).items():
            z.writestr(name, base64.b64decode(b64))
    data = buf.getvalue()
    if path is not None:
        Path(path).write_bytes(data)
    return data

"""Read an OpenRocket .ork into placed, weighed components.

Positions follow OpenRocket's rules (``RocketComponent.getAxialOffset`` /
``AxialMethod``): a stage's airframe pieces stack nose to tail; every other
component is placed against its parent by ``top`` / ``middle`` / ``bottom`` /
``after`` / ``absolute``. All positions here are metres aft of the nose tip.

Masses follow OpenRocket's ``MassCalculator``: a component with ``overridemass``
weighs exactly that, at the CG of its own geometry (or ``overridecg``); one with
``overridesubcomponentsmass`` weighs that *with everything inside it*, and the
subtree keeps its own CG. A component without an override is weighed from its
geometry and material, as OpenRocket does -- shells of revolution, fin plates with
tabs and fillets, canopies by area, cords by length.

Every simplification is reported in ``OrkDocument.warnings``: nothing silently
falls back. The motor is not a part here; it is described in ``motors`` so the app
can fold it in like any other motor selection.
"""

from __future__ import annotations

import io
import math
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

import numpy as np

from . import shapes

#: Largest .ork accepted, compressed and uncompressed. A real rocket is tens of kB;
#: one with stored simulation data a few MB.
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_XML_BYTES = 100 * 1024 * 1024

#: Stations along a nose cone or transition.
PROFILE_STATIONS = 241

AIRFRAME = ("nosecone", "bodytube", "transition")
FIN_SETS = ("trapezoidfinset", "ellipticalfinset", "freeformfinset")
TUBES = ("innertube", "tubecoupler", "engineblock", "launchlug")
RINGS = ("bulkhead", "centeringring")
PACKED = ("masscomponent", "parachute", "streamer", "shockcord")
UNSUPPORTED = ("podset", "parallelstage", "pods", "boosterset")


class OrkError(ValueError):
    """The file is not an .ork this importer can read."""


@dataclass
class Material:
    name: str
    #: "bulk" kg/m^3, "surface" kg/m^2, or "line" kg/m.
    kind: str
    density: float


@dataclass
class Revolution:
    """A solid of revolution between an outer and an inner radius profile."""

    x: np.ndarray  # absolute stations, nose -> tail
    r_out: np.ndarray
    r_in: np.ndarray
    #: B-rep type of the outer surface: CYLINDER for a tube, CONE, or SPUN.
    surface: str


@dataclass
class FinPlates:
    """A fin set: ``count`` plates of one planform around the body."""

    #: Planform outline, (x aft of the root leading edge, y outward from the root).
    points: np.ndarray
    thickness: float
    count: int
    root_radius: float
    x_lead: float  # absolute axial position of the root leading edge
    first_angle_deg: float


@dataclass
class Component:
    id: str
    name: str
    tag: str
    depth: int
    x: float  # fore end, metres aft of the nose tip
    length: float
    mass: float
    cg: float  # absolute axial CG
    mass_overridden: bool
    material: Material | None
    #: What to draw; None for a part that is weighed but not drawn.
    shapes: list[Revolution | FinPlates] = field(default_factory=list)
    parent: str | None = None


@dataclass
class OrkMotor:
    config_id: str
    default: bool
    manufacturer: str
    designation: str
    digest: str | None
    diameter: float
    length: float
    #: Absolute axial position of the motor's aft end.
    aft_x: float
    mount: str


@dataclass
class OrkDocument:
    rocket_name: str
    components: list[Component]
    #: Airframe length, nose tip to the aft end of the last airframe piece.
    length: float
    reference_radius: float
    motors: list[OrkMotor]
    #: OpenRocket's own stored simulation summaries, as written in the file.
    simulations: list[dict]
    warnings: list[str]

    @property
    def mass(self) -> float:
        return sum(c.mass for c in self.components)

    @property
    def cg(self) -> float:
        m = self.mass
        return sum(c.mass * c.cg for c in self.components) / m if m > 0 else 0.0


# -- reading ------------------------------------------------------------------


def read_xml(data: bytes) -> ET.Element:
    """The ``<openrocket>`` root of an .ork: a zip holding ``rocket.ork``, or bare XML."""
    if len(data) > MAX_FILE_BYTES:
        raise OrkError(f"file is {len(data) / 1e6:.1f} MB; the limit is {MAX_FILE_BYTES / 1e6:.0f} MB")
    if data[:2] == b"PK":
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise OrkError("not a readable .ork (bad zip)") from exc
        names = [n for n in archive.namelist() if n.lower().endswith(".ork")]
        if not names:
            raise OrkError("the archive holds no rocket.ork")
        info = archive.getinfo(names[0])
        if info.file_size > MAX_XML_BYTES:
            raise OrkError("the rocket inside the archive is implausibly large")
        data = archive.read(info)
    elif data[:2] == b"\x1f\x8b":
        import gzip

        with gzip.GzipFile(fileobj=io.BytesIO(data)) as handle:
            data = handle.read(MAX_XML_BYTES + 1)
        if len(data) > MAX_XML_BYTES:
            raise OrkError("the rocket inside the archive is implausibly large")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise OrkError(f"not a readable .ork ({exc})") from exc
    if root.tag != "openrocket" or root.find("rocket") is None:
        raise OrkError("not an OpenRocket file (no <openrocket><rocket>)")
    return root


def _num(e: ET.Element, tag: str, default: float | None = None) -> float | None:
    """A numeric field. ``auto 0.1016`` (OpenRocket 23+) reads as its resolved value;
    a bare ``auto`` reads as None so the caller resolves it."""
    text = e.findtext(tag)
    if text is None:
        return default
    text = text.strip()
    if text.startswith("auto"):
        text = text[4:].strip()
        if not text:
            return None
    try:
        return float(text)
    except ValueError:
        return default


def _is_auto(e: ET.Element, tag: str) -> bool:
    text = (e.findtext(tag) or "").strip()
    return text == "auto"


def _bool(e: ET.Element, tag: str) -> bool:
    return (e.findtext(tag) or "").strip().lower() == "true"


def _material(e: ET.Element, tag: str = "material") -> Material | None:
    node = e.find(tag)
    if node is None:
        return None
    try:
        density = float(node.get("density", "nan"))
    except ValueError:
        return None
    if not math.isfinite(density):
        return None
    return Material((node.text or "").strip(), node.get("type", "bulk"), density)


# -- geometry integrals ---------------------------------------------------------


def _revolution_mass(rev: Revolution, density: float) -> tuple[float, float]:
    """Mass and axial CG of a solid of revolution, by exact frustum segments."""
    x, ro, ri = rev.x, rev.r_out, rev.r_in
    dx = np.diff(x)

    def frustum(r: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        a, b = r[:-1], r[1:]
        vol = math.pi * dx / 3 * (a * a + a * b + b * b)
        # Centroid of a frustum from its fore face, (h/4)(a^2 + 2ab + 3b^2)/(a^2 + ab + b^2).
        den = a * a + a * b + b * b
        with np.errstate(invalid="ignore", divide="ignore"):
            off = np.where(den > 0, dx / 4 * (a * a + 2 * a * b + 3 * b * b) / den, dx / 2)
        return vol, x[:-1] + off

    v_out, c_out = frustum(ro)
    v_in, c_in = frustum(ri)
    vol = v_out.sum() - v_in.sum()
    if vol <= 0:
        return 0.0, float((x[0] + x[-1]) / 2)
    cg = (np.sum(v_out * c_out) - np.sum(v_in * c_in)) / vol
    return float(vol * density), float(cg)


def _shell_inner(x: np.ndarray, r: np.ndarray, thickness: float, filled: bool) -> np.ndarray:
    """Inner surface of a shell of wall ``thickness`` measured normal to the surface."""
    if filled or thickness <= 0:
        return np.zeros_like(r)
    slope = np.gradient(r, x) if len(x) > 2 else np.zeros_like(r)
    return np.maximum(r - thickness * np.sqrt(1 + slope**2), 0.0)


def _tube(x0: float, length: float, r_out: float, r_in: float) -> Revolution:
    return Revolution(
        np.array([x0, x0 + length]),
        np.array([r_out, r_out]),
        np.array([max(r_in, 0.0)] * 2),
        "CYLINDER",
    )


def _polygon_area_centroid(points: np.ndarray) -> tuple[float, float]:
    x, y = points[:, 0], points[:, 1]
    cross = x * np.roll(y, -1) - np.roll(x, -1) * y
    area = cross.sum() / 2
    if abs(area) < 1e-15:
        return 0.0, float(x.mean())
    cx = ((x + np.roll(x, -1)) * cross).sum() / (6 * area)
    return float(abs(area)), float(cx)


# -- the walk -------------------------------------------------------------------


class _Walker:
    def __init__(self, root: ET.Element) -> None:
        self.root = root
        self.rocket = root.find("rocket")
        self.components: list[Component] = []
        self.motors: list[OrkMotor] = []
        self.warnings: list[str] = []
        self.default_config = next(
            (c.get("configid") for c in self.rocket.findall("motorconfiguration") if c.get("default") == "true"),
            None,
        )
        #: (x0, x1, inner radius function) of each placed airframe piece, for "auto"
        #: radii on whatever sits inside it.
        self._airframe: list[tuple[float, float, callable]] = []

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)

    # ---- placement

    def place(self, e: ET.Element, parent_x: float, parent_len: float, prev_end: float, length: float) -> float:
        node = e.find("axialoffset")
        if node is not None:
            method, value = node.get("method", "top"), node.text
        else:
            node = e.find("position")
            method, value = (node.get("type", "top"), node.text) if node is not None else ("after", "0")
        try:
            offset = float(value or 0.0)
        except ValueError:
            offset = 0.0
        if method == "after":
            return prev_end + offset
        if method == "top":
            return parent_x + offset
        if method == "bottom":
            return parent_x + parent_len - length + offset
        if method == "middle":
            return parent_x + (parent_len - length) / 2 + offset
        if method == "absolute":
            return offset
        self.warn(f"{e.findtext('name')}: unknown position method {method!r}; placed at its parent's top.")
        return parent_x + offset

    # ---- the airframe, with "auto" radii resolved from neighbours

    def airframe_radii(self, pieces: list[ET.Element]) -> list[tuple[float, float]]:
        """(fore radius, aft radius) of each airframe piece, bare "auto" resolved as
        OpenRocket does: from the previous piece's aft radius, else the next one's fore."""
        raw: list[list[float | None]] = []
        for e in pieces:
            if e.tag == "bodytube":
                r = _num(e, "radius")
                raw.append([r, r])
            elif e.tag == "nosecone":
                raw.append([0.0, _num(e, "aftradius")])
            else:
                raw.append([_num(e, "foreradius"), _num(e, "aftradius")])
        for _ in range(len(raw) + 1):
            for i, (fore, aft) in enumerate(raw):
                if fore is None and i > 0 and raw[i - 1][1] is not None:
                    raw[i][0] = raw[i - 1][1]
                if aft is None and i + 1 < len(raw) and raw[i + 1][0] is not None:
                    raw[i][1] = raw[i + 1][0]
                if pieces[i].tag == "bodytube":
                    value = raw[i][0] if raw[i][0] is not None else raw[i][1]
                    raw[i] = [value, value]
        out = []
        for e, (fore, aft) in zip(pieces, raw):
            if fore is None or aft is None:
                self.warn(f"{e.findtext('name')}: radius left on 'auto' with nothing to take it from; 0.05 m used.")
            out.append((fore if fore is not None else 0.05, aft if aft is not None else 0.05))
        return out

    def walk_stages(self) -> tuple[float, float]:
        subs = self.rocket.find("subcomponents")
        x = 0.0
        r_ref = 0.0
        for stage in (subs if subs is not None else []):
            if stage.tag != "stage":
                self.warn(f"top-level <{stage.tag}> is not supported; skipped.")
                continue
            # Not `find(...) or []`: an Element's truth value is its child count.
            stage_subs = stage.find("subcomponents")
            children = list(stage_subs) if stage_subs is not None else []
            pieces = [c for c in children if c.tag in AIRFRAME]
            for c in children:
                if c.tag not in AIRFRAME:
                    self.warn(
                        f"{c.findtext('name')}: a <{c.tag}> directly in a stage is not supported; skipped."
                    )
            radii = self.airframe_radii(pieces)
            for e, (r_fore, r_aft) in zip(pieces, radii):
                length = _num(e, "length", 0.0) or 0.0
                self.airframe_piece(e, x, length, r_fore, r_aft)
                x += length
                r_ref = max(r_ref, r_fore, r_aft)
        return x, r_ref

    def airframe_piece(self, e: ET.Element, x0: float, length: float, r_fore: float, r_aft: float) -> None:
        name = (e.findtext("name") or e.tag).strip()
        thickness = _num(e, "thickness", 0.0) or 0.0
        filled = _bool(e, "filled")
        material = _material(e)
        revs: list[Revolution] = []

        if e.tag == "bodytube":
            outer = _tube(x0, length, r_fore, 0.0 if filled else r_fore - thickness)
            revs.append(outer)

            def inner(_x: float, r=r_fore, t=thickness) -> float:
                return r - t

        else:
            shape = (e.findtext("shape") or "conical").strip().lower()
            if shape not in shapes.SHAPES:
                self.warn(f"{name}: shape {shape!r} is not supported; drawn conical.")
                shape = "conical"
            param = _num(e, "shapeparameter", shapes.DEFAULT_PARAM.get(shape, 0.0))
            clipped = e.findtext("shapeclipped") is None or _bool(e, "shapeclipped")
            if e.tag == "nosecone" and _bool(e, "isflipped"):
                r_fore, r_aft = r_aft, 0.0
            xs, rs = shapes.profile(shape, param or 0.0, length, r_fore, r_aft, PROFILE_STATIONS, clipped)
            xs = xs + x0
            r_in = _shell_inner(xs, rs, thickness, filled)
            revs.append(Revolution(xs, rs, r_in, "CONE" if shape == "conical" else "SPUN"))

            def inner(xq: float, xs=xs, r_in=r_in) -> float:
                return float(np.interp(xq, xs, r_in))

            # Shoulders: tubes that slide into the neighbouring body tube.
            for end, x_at in (("fore", x0), ("aft", x0 + length)):
                s_len = _num(e, f"{end}shoulderlength", 0.0) or 0.0
                s_rad = _num(e, f"{end}shoulderradius", 0.0) or 0.0
                s_thk = _num(e, f"{end}shoulderthickness", 0.0) or 0.0
                if s_len <= 0 or s_rad <= 0:
                    continue
                start = x_at - s_len if end == "fore" else x_at
                revs.append(_tube(start, s_len, s_rad, s_rad - s_thk))
                if _bool(e, f"{end}shouldercapped") and s_thk > 0:
                    cap_at = start if end == "fore" else start + s_len - s_thk
                    revs.append(_tube(cap_at, s_thk, s_rad - s_thk, 0.0))

        mass, cg = self.weigh_revolutions(name, revs, material)
        self._airframe.append((x0, x0 + length, inner))
        comp = self.add(e, x0, length, mass, cg, material, revs, depth=0, parent=None)
        # A body tube can be the motor mount itself (LE4 SD's T5 is).
        self._motor_mount(e, comp)
        self.walk_children(e, comp, inner_radius=inner)

    def weigh_revolutions(self, name: str, revs: list[Revolution], material: Material | None) -> tuple[float, float]:
        if material is None or material.kind != "bulk":
            return 0.0, float(np.mean([r.x.mean() for r in revs])) if revs else 0.0
        total, moment = 0.0, 0.0
        for rev in revs:
            m, c = _revolution_mass(rev, material.density)
            total += m
            moment += m * c
        return total, (moment / total if total > 0 else float(revs[0].x.mean()))

    # ---- components inside the airframe

    def walk_children(self, e: ET.Element, parent: Component, inner_radius) -> None:
        subs = e.find("subcomponents")
        if subs is None:
            return
        prev_end = parent.x
        for child in subs:
            end = self.child(child, parent, inner_radius, prev_end)
            if end is not None:
                prev_end = end

    def child(self, e: ET.Element, parent: Component, parent_inner, prev_end: float) -> float | None:
        tag = e.tag
        name = (e.findtext("name") or tag).strip()
        if tag in UNSUPPORTED:
            self.warn(f"{name}: pods and side boosters are not supported; skipped.")
            return None
        material = _material(e)
        count = int(_num(e, "instancecount", 1) or 1)
        separation = _num(e, "instanceseparation", 0.0) or 0.0

        if tag in FIN_SETS:
            return self.fins(e, parent, material)

        if tag in TUBES or tag in RINGS:
            length = _num(e, "length", 0.0) or 0.0
            x = self.place(e, parent.x, parent.length, prev_end, length)
            here = x + length / 2
            outer_tag = "radius" if tag == "launchlug" else "outerradius"
            r_out = _num(e, outer_tag)
            if r_out is None:
                r_out = parent_inner(here)
            if tag == "bulkhead":
                r_in = 0.0
            elif tag == "centeringring":
                r_in = _num(e, "innerradius")
                if r_in is None:
                    r_in = self._inner_tube_radius(parent, x, length)
                    if r_in is None:
                        self.warn(f"{name}: inner radius 'auto' with no inner tube there; drawn solid.")
                        r_in = 0.0
            else:
                r_in = r_out - (_num(e, "thickness", 0.0) or 0.0)
            if tag == "launchlug":
                self.warn(f"{name}: launch lug drawn on the axis (its mass is what counts).")
            revs = [_tube(x + k * (length + separation), length, r_out, r_in) for k in range(count)]
            if count > 1:
                self.warn(f"{name}: {count} instances, each weighed and drawn {separation * 1000:.1f} mm apart.")
            mass, cg = self.weigh_revolutions(name, revs, material)
            comp = self.add(e, x, length, mass, cg, material, revs, parent.depth + 1, parent.id)
            self._motor_mount(e, comp)
            inner_r = r_in

            def inner(_x: float, r=inner_r) -> float:
                return r

            self.walk_children(e, comp, inner_radius=inner)
            return x + length

        if tag in PACKED:
            length = _num(e, "packedlength", 0.0) or 0.0
            x = self.place(e, parent.x, parent.length, prev_end, length)
            radius = _num(e, "packedradius")
            if radius is None:
                radius = _num(e, "radius")
            if radius is None:
                radius = parent_inner(x + length / 2)
            mass = self.packed_mass(e, name, material)
            revs = [_tube(x, length, radius, 0.0)] if length > 0 and radius > 0 else []
            comp = self.add(e, x, length, mass, x + length / 2, material, revs, parent.depth + 1, parent.id)
            self.walk_children(e, comp, inner_radius=lambda _x, r=radius: r)
            return x + length

        if tag == "railbutton":
            height = _num(e, "totalheight", _num(e, "height", 0.01)) or 0.01
            x = self.place(e, parent.x, parent.length, prev_end, 0.0)
            r = (_num(e, "outerdiameter", 0.01) or 0.01) / 2
            mass = (math.pi * r * r * height * material.density) if material and material.kind == "bulk" else 0.0
            if e.findtext("overridemass") is None:
                self.warn(f"{name}: rail button weighed as a solid cylinder.")
            self.add(e, x, 0.0, mass, x, material, [], parent.depth + 1, parent.id)
            return None

        self.warn(f"{name}: <{tag}> is not supported; skipped.")
        return None

    def packed_mass(self, e: ET.Element, name: str, material: Material | None) -> float:
        tag = e.tag
        if tag == "masscomponent":
            return _num(e, "mass", 0.0) or 0.0
        if material is None:
            return 0.0
        if tag == "parachute":
            d = _num(e, "diameter", 0.0) or 0.0
            mass = math.pi * d * d / 4 * material.density
            lines = _material(e, "linematerial")
            if lines is not None:
                mass += (_num(e, "linecount", 0) or 0) * (_num(e, "linelength", 0.0) or 0.0) * lines.density
            return mass
        if tag == "streamer":
            return (_num(e, "striplength", 0.0) or 0.0) * (_num(e, "stripwidth", 0.0) or 0.0) * material.density
        if tag == "shockcord":
            return (_num(e, "cordlength", 0.0) or 0.0) * material.density
        return 0.0

    def _inner_tube_radius(self, parent: Component, x: float, length: float) -> float | None:
        """Outer radius of an inner tube spanning ``x`` inside ``parent`` (an 'auto' ring's hole)."""
        best = None
        for c in self.components:
            if c.parent == parent.id and c.tag == "innertube":
                if c.x - 1e-9 <= x + length / 2 <= c.x + c.length + 1e-9:
                    best = float(c.shapes[0].r_out[0]) if c.shapes else None
        if best is None:
            # The inner tube may come later in the file; look ahead.
            for node in parent_xml_children(self, parent):
                if node.tag == "innertube":
                    best = _num(node, "outerradius")
        return best

    def fins(self, e: ET.Element, parent: Component, material: Material | None) -> None:
        name = (e.findtext("name") or e.tag).strip()
        tag = e.tag
        count = int(_num(e, "fincount", 3) or 3)
        thickness = _num(e, "thickness", 0.003) or 0.003
        if tag == "trapezoidfinset":
            cr, ct = _num(e, "rootchord", 0.0) or 0.0, _num(e, "tipchord", 0.0) or 0.0
            sweep, h = _num(e, "sweeplength", 0.0) or 0.0, _num(e, "height", 0.0) or 0.0
            points = np.array([[0.0, 0.0], [sweep, h], [sweep + ct, h], [cr, 0.0]])
            length = cr
        elif tag == "ellipticalfinset":
            cr, h = _num(e, "rootchord", 0.0) or 0.0, _num(e, "height", 0.0) or 0.0
            t = np.linspace(0.0, math.pi, 41)
            points = np.column_stack([cr / 2 * (1 - np.cos(t)), h * np.sin(t)])
            length = cr
        else:
            pts = [(float(p.get("x", 0)), float(p.get("y", 0))) for p in e.iter("point")]
            if len(pts) < 3:
                self.warn(f"{name}: freeform fin with fewer than 3 points; skipped.")
                return None
            points = np.array(pts)
            length = float(points[:, 0].max())
        x = self.place(e, parent.x, parent.length, parent.x, length)
        # The file stores these angles in degrees (OpenRocket's FinSetSaver).
        cant = _num(e, "cant", 0.0) or 0.0
        if abs(cant) > 1e-9:
            self.warn(f"{name}: fin cant {cant:.2f} deg is not modelled (fins drawn straight).")
        offset = _num(e, "radiusoffset", 0.0) or 0.0
        root_r = self._radius_at(x) + offset
        angle = _num(e, "angleoffset", None)
        if angle is None:
            angle = _num(e, "rotation", 0.0) or 0.0

        area, cx = _polygon_area_centroid(points)
        mass, moment = 0.0, 0.0
        if material is not None and material.kind == "bulk":
            mass = area * thickness * material.density * count
            moment = mass * (x + cx)
            tab_h, tab_l = _num(e, "tabheight", 0.0) or 0.0, _num(e, "tablength", 0.0) or 0.0
            if tab_h > 0 and tab_l > 0:
                tab_x = x + (_num(e, "tabposition", 0.0) or 0.0)
                tab_mass = tab_h * tab_l * thickness * material.density * count
                mass += tab_mass
                moment += tab_mass * (tab_x + tab_l / 2)
        fillet_r = _num(e, "filletradius", 0.0) or 0.0
        fillet_mat = _material(e, "filletmaterial")
        if fillet_r > 0 and fillet_mat is not None and fillet_mat.kind == "bulk":
            root_len = float(points[points[:, 1] <= 1e-9, 0].max() - points[points[:, 1] <= 1e-9, 0].min()) if np.any(points[:, 1] <= 1e-9) else length
            fillet = 2 * fillet_r * fillet_r * (1 - math.pi / 4) * root_len * fillet_mat.density * count
            mass += fillet
            moment += fillet * (x + root_len / 2)
        cg = moment / mass if mass > 0 else x + cx
        plates = FinPlates(points, thickness, count, root_r, x, angle)
        self.add(e, x, length, mass, cg, material, [plates], parent.depth + 1, parent.id)
        return None

    def _radius_at(self, x: float) -> float:
        """Outer airframe radius at axial ``x`` (where a fin set's root sits)."""
        for comp in self.components:
            if comp.depth == 0 and comp.x - 1e-9 <= x <= comp.x + comp.length + 1e-9:
                rev = comp.shapes[0]
                return float(np.interp(x, rev.x, rev.r_out))
        return 0.0

    def _motor_mount(self, e: ET.Element, comp: Component) -> None:
        mount = e.find("motormount")
        if mount is None:
            return
        cluster = (e.findtext("clusterconfiguration") or "single").strip()
        if cluster != "single":
            self.warn(f"{comp.name}: motor cluster {cluster!r}; only one motor is folded in.")
        overhang = _num(mount, "overhang", 0.0) or 0.0
        for motor in mount.findall("motor"):
            cfg = motor.get("configid", "")
            self.motors.append(
                OrkMotor(
                    config_id=cfg,
                    default=cfg == self.default_config,
                    manufacturer=(motor.findtext("manufacturer") or "").strip(),
                    designation=(motor.findtext("designation") or "").strip(),
                    digest=(motor.findtext("digest") or "").strip() or None,
                    diameter=_num(motor, "diameter", 0.0) or 0.0,
                    length=_num(motor, "length", 0.0) or 0.0,
                    aft_x=comp.x + comp.length + overhang,
                    mount=comp.name,
                )
            )

    # ---- bookkeeping

    def add(self, e, x, length, mass, cg, material, revs, depth, parent) -> Component:
        name = (e.findtext("name") or e.tag).strip()
        comp_id = (e.findtext("id") or "").strip() or f"{e.tag}-{len(self.components)}"
        override = _num(e, "overridemass")
        overridden = override is not None
        if overridden:
            mass = override
        cg_override = _num(e, "overridecg")
        if cg_override is not None:
            cg = x + cg_override
        comp = Component(comp_id, name, e.tag, depth, x, length, float(mass), float(cg), overridden, material, list(revs), parent)
        comp._xml = e  # type: ignore[attr-defined]
        self.components.append(comp)
        return comp

    def apply_subtree_overrides(self) -> None:
        """``overridesubcomponentsmass``: the override is the mass of the component
        *and everything inside it*. The subtree keeps its own CG, so every member is
        scaled by the same factor; an empty subtree puts it all on the component."""
        by_parent: dict[str | None, list[Component]] = {}
        for c in self.components:
            by_parent.setdefault(c.parent, []).append(c)

        def subtree(c: Component) -> list[Component]:
            out = [c]
            for k in by_parent.get(c.id, []):
                out.extend(subtree(k))
            return out

        for c in list(self.components):
            e = c._xml  # type: ignore[attr-defined]
            if not (_bool(e, "overridesubcomponentsmass") and c.mass_overridden):
                continue
            target = c.mass
            members = subtree(c)
            # The component's own computed mass before its override took over.
            own = self._computed_mass(c)
            others = members[1:]
            current = own + sum(m.mass for m in others)
            if current <= 0:
                c.mass = target
                for m in others:
                    m.mass = 0.0
                continue
            scale = target / current
            c.mass = own * scale
            for m in others:
                m.mass *= scale
                m.mass_overridden = True

    def _computed_mass(self, c: Component) -> float:
        e = c._xml  # type: ignore[attr-defined]
        if c.tag in PACKED:
            return self.packed_mass(e, c.name, c.material)
        revs = [s for s in c.shapes if isinstance(s, Revolution)]
        if revs:
            return self.weigh_revolutions(c.name, revs, c.material)[0]
        return 0.0


def parent_xml_children(walker: _Walker, parent: Component):
    e = getattr(parent, "_xml", None)
    subs = e.find("subcomponents") if e is not None else None
    return list(subs) if subs is not None else []


def _simulations(root: ET.Element) -> list[dict]:
    out = []
    for sim in root.iter("simulation"):
        data = sim.find("flightdata")
        conditions = sim.find("conditions")
        out.append(
            {
                "name": (sim.findtext("name") or "").strip(),
                "configId": (conditions.findtext("configid") if conditions is not None else None),
                "summary": {k: float(v) for k, v in (data.attrib.items() if data is not None else []) if _is_float(v)},
            }
        )
    return out


def _is_float(text: str) -> bool:
    try:
        return math.isfinite(float(text))
    except ValueError:
        return False


def parse_ork(data: bytes) -> OrkDocument:
    """Read an .ork's bytes into an :class:`OrkDocument`."""
    root = read_xml(data)
    walker = _Walker(root)
    length, r_ref = walker.walk_stages()
    if not walker.components:
        raise OrkError("the rocket has no airframe (no nose cone, body tube or transition)")
    walker.apply_subtree_overrides()
    for c in walker.components:
        if hasattr(c, "_xml"):
            del c._xml  # type: ignore[attr-defined]
    return OrkDocument(
        rocket_name=(walker.rocket.findtext("name") or "Rocket").strip(),
        components=walker.components,
        length=length,
        reference_radius=r_ref,
        motors=walker.motors,
        simulations=_simulations(root),
        warnings=walker.warnings,
    )

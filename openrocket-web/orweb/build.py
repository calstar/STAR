"""Document -> component model, and component model -> document params.

``build_rocket`` replays a document onto fresh components the way OpenRocket 24.12's
importer does (file/openrocket/importt: ComponentHandler adds each component to its
parent before its parameters are set; ComponentParameterHandler then applies each
parameter through DocumentConfig's setter for the most specific class that has one,
with change events live, so every setter sees the tree as it stood at that moment).

``model_params`` is the other direction: a port of the savers
(file/openrocket/savers/*Saver.addParams) that writes a component's state as params.
It gives OpenRocket's defaults for a new component (``default_component``).

OpenRocket 24.12, GPLv3.
"""

from __future__ import annotations

import math
import uuid

from . import material as matmod
from .components.assemblies import AxialStage, ComponentAssembly, ParallelStage, PodSet, Rocket
from .components.base import RocketComponent
from .components.external import BodyComponent, ExternalComponent, Finish
from .components.fins import (CrossSection, EllipticalFinSet, FinSet, FreeformFinSet, TrapezoidFinSet,
                              TubeFinSet)
from .components.internal import (CLUSTERS_BY_NAME, Bulkhead, CenteringRing, EngineBlock, InnerTube,
                                  InternalComponent, RadiusRingComponent, RingComponent, StructuralComponent,
                                  ThicknessRingComponent, TubeCoupler)
from .components.lugs import LaunchLug, RailButton
from .components.massobjects import (MassComponent, MassComponentType, MassObject, Parachute, RecoveryDevice,
                                     ShockCord, Streamer)
from .components.position import AngleMethod, AxialMethod, RadiusMethod
from .components.symmetric import BodyTube, NoseCone, Shape, SymmetricComponent, Transition
from .config import MotorConfiguration, default_motor_config, motor_configs_of
from .util.coordinate import Coordinate

TYPE_CLASSES: dict[str, type] = {
    "stage": AxialStage, "parallelstage": ParallelStage, "boosterset": ParallelStage, "podset": PodSet,
    "nosecone": NoseCone, "bodytube": BodyTube, "transition": Transition, "trapezoidfinset": TrapezoidFinSet,
    "ellipticalfinset": EllipticalFinSet, "freeformfinset": FreeformFinSet, "tubefinset": TubeFinSet,
    "launchlug": LaunchLug, "railbutton": RailButton, "innertube": InnerTube, "tubecoupler": TubeCoupler,
    "centeringring": CenteringRing, "bulkhead": Bulkhead, "engineblock": EngineBlock,
    "masscomponent": MassComponent, "shockcord": ShockCord, "parachute": Parachute, "streamer": Streamer,
}

# ---------------------------------------------------------------------------- value helpers


def _auto(v):
    """(auto?, value) from an auto param ({"auto", "value"} or a bare number)."""
    if isinstance(v, dict):
        return bool(v.get("auto")), v.get("value")
    return False, v


def _auto_setter(set_value, set_auto, with_separator: bool):
    """DoubleSetter with an "auto" special string (and, with_separator, the "auto <value>" form)."""
    def apply(c, v, ctx):
        auto, value = _auto(v)
        if auto:
            if with_separator and value is not None:
                set_value(c, float(value))
            set_auto(c, True)
        else:
            set_value(c, float(value))
    return apply


def _material(expected: str, setter):
    def apply(c, v, ctx):
        if v.get("type") is not None and v.get("type") != expected:
            ctx.warn(f"{c.get_name()}: illegal material type {v.get('type')!r}, ignoring.")
            return
        name = str(v.get("name", "")).strip()
        if not name:
            ctx.warn(f"{c.get_name()}: illegal material specification, ignoring.")
            return
        setter(c, matmod.find_material(expected, name, float(v["density"]), v.get("group")))
    return apply


def _axial_position(c, v, ctx):
    """AxialPositionSetter."""
    if not isinstance(c, (ComponentAssembly, InternalComponent, FinSet, RailButton, TubeFinSet, LaunchLug)):
        ctx.warn(f"{c.get_name()}: axial position is not valid for {type(c).__name__}")
        return
    m = AxialMethod.parse(v.get("method"))
    if m is None:
        ctx.warn(f"{c.get_name()}: invalid axial method {v.get('method')!r}")
        return
    c.set_axial_method(m)
    c.set_axial_offset(float(v["value"]))


def _angle_position(c, v, ctx):
    """AnglePositionSetter."""
    m = AngleMethod.parse(v.get("method")) or AngleMethod.RELATIVE
    c.set_angle_method(m)
    c.set_angle_offset(float(v["value"]))


def _radius_position(c, v, ctx):
    """RadiusPositionSetter."""
    m = RadiusMethod.parse(v.get("method")) or RadiusMethod.SURFACE
    c.set_radius_method(m)
    c.set_radius_offset(float(v["value"]))


def _override(set_value, set_flag):
    def apply(c, v, ctx):
        set_value(c, float(v))
        set_flag(c, True)
    return apply


def _tab_position(c, v, ctx):
    """FinTabPositionSetter."""
    m = AxialMethod.parse(v.get("method"))
    if m is None:
        ctx.warn(f"{c.get_name()}: illegal tab position {v.get('method')!r}")
        return
    c.set_tab_offset_method(m)
    c.set_tab_offset(float(v["value"]))


def _fin_points(c, v, ctx):
    """FinSetPointHandler.endHandler."""
    c.set_points([Coordinate(float(x), float(y)) for x, y in v])
    c.update_tab_position()


def _symmetric_thickness(c, v, ctx):
    if v == "filled" or (isinstance(v, dict) and v.get("filled")):
        c.set_filled(True)
    else:
        c.set_thickness(float(v), False)


def _motor_mount(c, v, ctx):
    """MotorMountHandler: the mount is a mount; its default ignition and overhang."""
    c.set_motor_mount(True)
    d = default_motor_config(c)
    if "ignitionevent" in v:
        d.ignition_event = v["ignitionevent"]
    if "ignitiondelay" in v:
        d.ignition_delay = float(v["ignitiondelay"])
    if "overhang" in v:
        c.set_motor_overhang(float(v["overhang"]))


def _store(attr):
    def apply(c, v, ctx):
        setattr(c, attr, v)
    return apply


def _rocket_reftype(c, v, ctx):
    v = str(v).strip().lower()
    if v not in ("nosecone", "maximum", "custom"):
        ctx.warn(f"unknown reference type {v!r}")
        return
    c.reference_type = v


def _f(method_name):
    return lambda c, v, ctx: getattr(c, method_name)(float(v))


def _i(method_name):
    return lambda c, v, ctx: getattr(c, method_name)(int(v))


def _b(method_name, *extra):
    return lambda c, v, ctx: getattr(c, method_name)(bool(v), *extra)


IGNORE = None  # DocumentConfig maps the key to null: silently ignored

#: DocumentConfig.setters: (Java class name, element) -> setter(component, value, ctx)
SETTERS = {
    ("RocketComponent", "comment"): lambda c, v, ctx: c.set_comment(v),
    ("RocketComponent", "axialoffset"): _axial_position,
    ("RocketComponent", "position"): _axial_position,
    ("RocketComponent", "overridemass"): _override(lambda c, x: c.set_override_mass(x),
                                                   lambda c, b: c.set_mass_overridden(b)),
    ("RocketComponent", "overridecg"): _override(lambda c, x: c.set_override_cgx(x),
                                                 lambda c, b: c.set_cg_overridden(b)),
    ("RocketComponent", "overridecd"): _override(lambda c, x: c.set_override_cd(x),
                                                 lambda c, b: c.set_cd_overridden(b)),
    ("RocketComponent", "overridesubcomponents"): _b("set_subcomponents_overridden"),
    ("RocketComponent", "overridesubcomponentsmass"): _b("set_subcomponents_overridden_mass"),
    ("RocketComponent", "overridesubcomponentscg"): _b("set_subcomponents_overridden_cg"),
    ("RocketComponent", "overridesubcomponentscd"): _b("set_subcomponents_overridden_cd"),
    ("ExternalComponent", "finish"): lambda c, v, ctx: c.set_finish(Finish.parse(v)),
    ("ExternalComponent", "material"): _material(matmod.BULK, lambda c, m: c.set_material(m)),
    ("BodyComponent", "length"): _f("set_length"),
    ("BodyTube", "radius"): _auto_setter(lambda c, x: c.set_outer_radius(x),
                                         lambda c, b: c.set_outer_radius_automatic(b), True),
    ("ParallelStage", "instancecount"): _i("set_instance_count"),
    ("ParallelStage", "angleoffset"): _angle_position,
    ("ParallelStage", "radiusoffset"): _radius_position,
    ("SymmetricComponent", "thickness"): _symmetric_thickness,
    ("LaunchLug", "instancecount"): _i("set_instance_count"),
    ("LaunchLug", "instanceseparation"): _f("set_instance_separation"),
    ("LaunchLug", "angleoffset"): _angle_position,
    ("LaunchLug", "radius"): _f("set_outer_radius"),
    ("LaunchLug", "length"): _f("set_length"),
    ("LaunchLug", "thickness"): _f("set_thickness"),
    ("RailButton", "instancecount"): _i("set_instance_count"),
    ("RailButton", "instanceseparation"): _f("set_instance_separation"),
    ("RailButton", "angleoffset"): _angle_position,
    ("RailButton", "height"): _f("set_total_height"),
    ("RailButton", "baseheight"): _f("set_base_height"),
    ("RailButton", "flangeheight"): _f("set_flange_height"),
    ("RailButton", "screwheight"): _f("set_screw_height"),
    ("RailButton", "outerdiameter"): _f("set_outer_diameter"),
    ("RailButton", "innerdiameter"): _f("set_inner_diameter"),
    ("Transition", "shape"): lambda c, v, ctx: c.set_shape_type(Shape.parse(v)),
    ("Transition", "shapeclipped"): _b("set_clipped"),
    ("Transition", "shapeparameter"): _f("set_shape_parameter"),
    ("Transition", "foreradius"): _auto_setter(lambda c, x: c.set_fore_radius(x, False),
                                               lambda c, b: c.set_fore_radius_automatic(b), True),
    ("Transition", "aftradius"): _auto_setter(lambda c, x: c.set_aft_radius(x, False),
                                              lambda c, b: c.set_aft_radius_automatic(b), True),
    ("Transition", "foreshoulderradius"): lambda c, v, ctx: c.set_fore_shoulder_radius(float(v), False),
    ("Transition", "foreshoulderlength"): _f("set_fore_shoulder_length"),
    ("Transition", "foreshoulderthickness"): _f("set_fore_shoulder_thickness"),
    ("Transition", "foreshouldercapped"): _b("set_fore_shoulder_capped"),
    ("Transition", "aftshoulderradius"): lambda c, v, ctx: c.set_aft_shoulder_radius(float(v), False),
    ("Transition", "aftshoulderlength"): _f("set_aft_shoulder_length"),
    ("Transition", "aftshoulderthickness"): _f("set_aft_shoulder_thickness"),
    ("Transition", "aftshouldercapped"): _b("set_aft_shoulder_capped"),
    ("NoseCone", "isflipped"): _b("set_flipped", False),
    ("NoseCone", "foreradius"): IGNORE,
    ("NoseCone", "foreshoulderradius"): IGNORE,
    ("NoseCone", "foreshoulderlength"): IGNORE,
    ("NoseCone", "foreshoulderthickness"): IGNORE,
    ("NoseCone", "foreshouldercapped"): IGNORE,
    ("FinSet", "fincount"): _i("set_fin_count"),
    ("FinSet", "instancecount"): _i("set_instance_count"),
    ("FinSet", "rotation"): _angle_position,
    ("FinSet", "angleoffset"): _angle_position,
    ("FinSet", "radiusoffset"): _radius_position,
    ("FinSet", "thickness"): _f("set_thickness"),
    ("FinSet", "crosssection"): lambda c, v, ctx: c.set_cross_section(CrossSection.parse(v)),
    ("FinSet", "cant"): _f("set_cant_angle"),
    ("FinSet", "tabheight"): _f("set_tab_height"),
    ("FinSet", "tablength"): _f("set_tab_length"),
    ("FinSet", "tabposition"): _tab_position,
    ("FinSet", "filletradius"): _f("set_fillet_radius"),
    ("FinSet", "filletmaterial"): _material(matmod.BULK, lambda c, m: c.set_fillet_material(m)),
    ("FreeformFinSet", "finpoints"): _fin_points,
    ("TrapezoidFinSet", "rootchord"): _f("set_root_chord"),
    ("TrapezoidFinSet", "tipchord"): _f("set_tip_chord"),
    ("TrapezoidFinSet", "sweeplength"): _f("set_sweep"),
    ("TrapezoidFinSet", "height"): _f("set_height"),
    ("EllipticalFinSet", "rootchord"): _f("set_length"),
    ("EllipticalFinSet", "height"): _f("set_height"),
    ("TubeFinSet", "fincount"): _i("set_fin_count"),
    ("TubeFinSet", "rotation"): _angle_position,
    ("TubeFinSet", "thickness"): _f("set_thickness"),
    ("TubeFinSet", "length"): _f("set_length"),
    ("TubeFinSet", "radius"): _auto_setter(lambda c, x: c.set_outer_radius(x),
                                           lambda c, b: c.set_outer_radius_automatic(b), False),
    ("TubeFinSet", "instancecount"): _i("set_instance_count"),
    ("TubeFinSet", "angleoffset"): _angle_position,
    ("TubeFinSet", "radiusoffset"): _radius_position,
    ("StructuralComponent", "material"): _material(matmod.BULK, lambda c, m: c.set_material(m)),
    ("RingComponent", "length"): _f("set_length"),
    ("RingComponent", "radialposition"): _f("set_radial_position"),
    ("RingComponent", "radialdirection"): _f("set_radial_direction"),
    ("ThicknessRingComponent", "thickness"): _f("set_thickness"),
    ("EngineBlock", "outerradius"): _auto_setter(lambda c, x: c.set_outer_radius(x),
                                                 lambda c, b: c.set_outer_radius_automatic(b), False),
    ("TubeCoupler", "outerradius"): _auto_setter(lambda c, x: c.set_outer_radius(x),
                                                 lambda c, b: c.set_outer_radius_automatic(b), False),
    ("InnerTube", "outerradius"): lambda c, v, ctx: c.set_outer_radius(float(_auto(v)[1])),
    ("InnerTube", "clusterconfiguration"): lambda c, v, ctx: (
        c.set_cluster_configuration(CLUSTERS_BY_NAME[v]) if v in CLUSTERS_BY_NAME
        else ctx.warn("Illegal cluster configuration specified.")),
    ("InnerTube", "clusterscale"): _f("set_cluster_scale"),
    ("InnerTube", "clusterrotation"): _f("set_cluster_rotation"),
    ("RadiusRingComponent", "instancecount"): _i("set_instance_count"),
    ("RadiusRingComponent", "instanceseparation"): _f("set_instance_separation"),
    ("RadiusRingComponent", "innerradius"): lambda c, v, ctx: c.set_inner_radius(float(_auto(v)[1])),
    ("Bulkhead", "outerradius"): _auto_setter(lambda c, x: c.set_outer_radius(x),
                                              lambda c, b: c.set_outer_radius_automatic(b), False),
    ("CenteringRing", "innerradius"): _auto_setter(lambda c, x: c.set_inner_radius(x),
                                                   lambda c, b: c.set_inner_radius_automatic(b), False),
    ("CenteringRing", "outerradius"): _auto_setter(lambda c, x: c.set_outer_radius(x),
                                                   lambda c, b: c.set_outer_radius_automatic(b), False),
    ("MassObject", "packedlength"): _f("set_length"),
    ("MassObject", "packedradius"): _auto_setter(lambda c, x: c.set_radius(x),
                                                 lambda c, b: c.set_radius_automatic(b), True),
    ("MassObject", "radialposition"): _f("set_radial_position"),
    ("MassObject", "radialdirection"): _f("set_radial_direction"),
    ("MassComponent", "mass"): _f("set_component_mass"),
    ("MassComponent", "masscomponenttype"): lambda c, v, ctx: c.set_mass_component_type(MassComponentType(v)),
    ("ShockCord", "cordlength"): _f("set_cord_length"),
    ("ShockCord", "material"): _material(matmod.LINE, lambda c, m: c.set_material(m)),
    ("RecoveryDevice", "cd"): _auto_setter(lambda c, x: c.set_cd(x), lambda c, b: c.set_cd_automatic(b), False),
    ("RecoveryDevice", "deployevent"): _store("deploy_event"),
    ("RecoveryDevice", "deployaltitude"): _store("deploy_altitude"),
    ("RecoveryDevice", "deploydelay"): _store("deploy_delay"),
    ("RecoveryDevice", "material"): _material(matmod.SURFACE, lambda c, m: c.set_material(m)),
    ("Parachute", "diameter"): _f("set_diameter"),
    ("Parachute", "linecount"): _i("set_line_count"),
    ("Parachute", "linelength"): _f("set_line_length"),
    ("Parachute", "linematerial"): _material(matmod.LINE, lambda c, m: c.set_line_material(m)),
    ("PodSet", "instancecount"): _i("set_instance_count"),
    ("PodSet", "radiusoffset"): _radius_position,
    ("PodSet", "angleoffset"): _angle_position,
    ("Streamer", "striplength"): _f("set_strip_length"),
    ("Streamer", "stripwidth"): _f("set_strip_width"),
    ("Rocket", "referencetype"): _rocket_reftype,
    ("Rocket", "customreference"): _f("set_custom_reference_length"),
    ("Rocket", "designer"): _store("designer"),
    ("Rocket", "revision"): _store("revision"),
    ("Rocket", "designtype"): _store("design_type"),
    ("Rocket", "kitname"): _store("kit_name"),
    ("AxialStage", "separationevent"): _store("separation_event"),
    ("AxialStage", "separationaltitude"): _store("separation_altitude"),
    ("AxialStage", "separationdelay"): _store("separation_delay"),
    ("BodyTube", "motormount"): _motor_mount,
    ("InnerTube", "motormount"): _motor_mount,
}


def find_setter(component: RocketComponent, tag: str):
    """ComponentParameterHandler.closeElement's lookup: most specific class first;
    returns (found, setter) where setter None means 'known and ignored'."""
    for klass in type(component).__mro__:
        key = (klass.__name__, tag)
        if key in SETTERS:
            return True, SETTERS[key]
    return False, None


# ---------------------------------------------------------------------------- building

class BuildContext:
    def __init__(self, registry=None):
        self.warnings: list[str] = []
        self.registry = registry
        self.by_id: dict[str, RocketComponent] = {}

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def _apply_params(c: RocketComponent, params: dict, ctx: BuildContext) -> None:
    for tag, value in params.items():
        if tag.startswith("_") or tag == "motorconfiguration":
            continue
        if isinstance(value, dict) and "_xml" in value:
            continue  # carried through, not interpreted
        if isinstance(value, list) and value and isinstance(value[0], dict) and "_xml" in value[0]:
            continue
        found, setter = find_setter(c, tag)
        if not found:
            ctx.warn(f"Unknown parameter type '{tag}' for {c.get_component_name()}, ignoring.")
            continue
        if setter is None:
            continue
        try:
            setter(c, value, ctx)
        except (ValueError, KeyError, TypeError) as e:
            ctx.warn(f"{c.get_name()}: invalid {tag} = {value!r} ({e})")


def _build_component(parent: RocketComponent, doc_comp: dict, ctx: BuildContext) -> RocketComponent:
    ctype = doc_comp["type"]
    klass = TYPE_CLASSES.get(ctype)
    if klass is None:
        raise ValueError(f"unknown component type {ctype!r}")
    c = klass()
    c.id = doc_comp.get("id") or str(uuid.uuid4())
    c.params = doc_comp.get("params", {})
    c.doc = doc_comp
    parent.add_child(c)
    c.set_name(doc_comp.get("name") or "")
    _apply_params(c, doc_comp.get("params", {}), ctx)
    ctx.by_id[c.id] = c
    for child in doc_comp.get("children", []):
        _build_component(c, child, ctx)
    return c


def _attach_motors(rocket: Rocket, doc: dict, ctx: BuildContext) -> None:
    from .motors.registry import default_registry
    registry = ctx.registry if ctx.registry is not None else default_registry()
    for cfg in doc.get("motorConfigs", []):
        fcid = cfg["id"]
        fc = rocket.create_flight_configuration(fcid)
        fc.name = cfg.get("name") or None
        stages = cfg.get("stages") or {}
        active = {int(k): bool(v) for k, v in stages.items()}
        if active and not any(active.values()):  # MotorConfigurationHandler: no active stage -> stage 0
            active[0] = True
        fc.stage_flags = active
        for mount_id, m in (cfg.get("motors") or {}).items():
            mount = ctx.by_id.get(mount_id)
            if mount is None or not hasattr(mount, "set_motor_mount"):
                ctx.warn(f"motor configuration {fcid}: no motor mount {mount_id}")
                continue
            w: list[str] = []
            motor = registry.find(m.get("designation"), m.get("manufacturer"), m.get("digest"), w)
            ctx.warnings.extend(w)
            mc = MotorConfiguration(mount, fcid, default_motor_config(mount))
            mc.motor = motor
            d = m.get("delay")
            mc.ejection_delay = math.inf if d is None else float(d)
            if m.get("ignitionEvent") is not None:
                mc.ignition_event = m["ignitionEvent"]
            if m.get("ignitionDelay") is not None:
                mc.ignition_delay = float(m["ignitionDelay"])
            motor_configs_of(mount)[fcid] = mc
            if not mount.is_motor_mount():
                mount.set_motor_mount(True)
    sel = doc.get("selectedConfig")
    if sel is not None and sel in rocket.configurations:
        rocket.set_selected_configuration(sel)


def build_rocket(doc: dict, registry=None, warnings: list | None = None) -> Rocket:
    """The component model of a document, as OpenRocket would hold it after loading the .ork.

    ``registry`` resolves motors (default: the bundled set). Warnings (unknown params,
    missing motors) go to ``rocket.warnings`` and, if given, ``warnings``.
    """
    ctx = BuildContext(registry)
    rocket = Rocket()
    rocket.enable_events()  # OpenRocketDocument(rocket) enables events before the load
    rdoc = doc["rocket"]
    rocket.id = rdoc.get("id") or str(uuid.uuid4())
    rocket.params = rdoc.get("params", {})
    rocket.doc = rdoc
    rocket.set_name(rdoc.get("name") or "")
    _apply_params(rocket, rdoc.get("params", {}), ctx)
    ctx.by_id[rocket.id] = rocket
    for child in rdoc.get("children", []):
        _build_component(rocket, child, ctx)
    _attach_motors(rocket, doc, ctx)
    # What any user of a freshly loaded design does first (the GUI's figure, the oracle's
    # FlightConditions and getLengthAerodynamic): this settles MassObject's automatic radius.
    cfg = rocket.get_selected_configuration()
    cfg.get_reference_length()
    cfg.calculate_bounds()
    rocket.warnings = ctx.warnings
    rocket.by_id = ctx.by_id
    if warnings is not None:
        warnings.extend(ctx.warnings)
    return rocket


# ---------------------------------------------------------------------------- model -> params (savers)

def _deg_angle(c) -> dict:
    return {"method": c.get_angle_method().value, "value": c.get_angle_offset()}


def model_params(c: RocketComponent) -> dict:
    """A component's state as document params, in the savers' order."""
    p: dict = {}
    # RocketComponentSaver
    if isinstance(c, (ParallelStage, PodSet, LaunchLug, RailButton, FinSet, TubeFinSet, RadiusRingComponent)):
        p["instancecount"] = c.get_instance_count()
    if isinstance(c, (LaunchLug, RailButton, RadiusRingComponent)):
        p["instanceseparation"] = c.get_instance_separation()
    if isinstance(c, (FinSet, TubeFinSet, ParallelStage, PodSet)):
        p["radiusoffset"] = {"method": c.get_radius_method().value, "value": c.get_radius_offset()}
    if isinstance(c, (FinSet, TubeFinSet, ParallelStage, PodSet, LaunchLug, RailButton)):
        p["angleoffset"] = _deg_angle(c)
    if not isinstance(c, Rocket) and c.get_axial_method() is not AxialMethod.AFTER:
        p["axialoffset"] = {"method": c.get_axial_method().value, "value": c.get_axial_offset()}
    if c.is_mass_overridden():
        p["overridemass"] = c.get_override_mass()
        p["overridesubcomponentsmass"] = c.is_subcomponents_overridden_mass()
    if c.is_cg_overridden():
        p["overridecg"] = c.get_override_cgx()
        p["overridesubcomponentscg"] = c.is_subcomponents_overridden_cg()
    if c.is_cd_overridden():
        p["overridecd"] = c.get_override_cd()
        p["overridesubcomponentscd"] = c.is_subcomponents_overridden_cd()
    if c.get_comment():
        p["comment"] = c.get_comment()
    if isinstance(c, Rocket):
        p["designtype"] = getattr(c, "design_type", "original")
        p["referencetype"] = c.get_reference_type()
        if c.get_reference_type() == "custom":
            p["customreference"] = c.get_custom_reference_length()
        return p
    if type(c) is AxialStage and c.get_stage_number() > 0:
        p["separationevent"] = getattr(c, "separation_event", "ejection")
        p["separationaltitude"] = getattr(c, "separation_altitude", 200.0)
        p["separationdelay"] = getattr(c, "separation_delay", 0.0)
    if isinstance(c, ExternalComponent):
        p["finish"] = c.get_finish().name.lower()
        p["material"] = c.get_material().to_param()
    if isinstance(c, BodyComponent):
        p["length"] = c.get_length()
    if isinstance(c, SymmetricComponent):
        p["thickness"] = "filled" if c.is_filled() else c.get_thickness()
    if isinstance(c, Transition):
        p["shape"] = c.get_shape_type().value
        if c.get_shape_type().is_clippable():
            p["shapeclipped"] = c.is_clipped()
        if c.get_shape_type().uses_parameter():
            p["shapeparameter"] = c.get_shape_parameter()
        if isinstance(c, NoseCone):
            p["aftradius"] = {"auto": c.is_base_radius_automatic(), "value": c.get_base_radius()}
            p["aftshoulderradius"] = c.get_shoulder_radius()
            p["aftshoulderlength"] = c.get_shoulder_length()
            p["aftshoulderthickness"] = c.get_shoulder_thickness()
            p["aftshouldercapped"] = c.is_shoulder_capped()
            p["isflipped"] = c.is_flipped()
        else:
            p["foreradius"] = {"auto": c.is_fore_radius_automatic(), "value": c.get_fore_radius()}
            p["aftradius"] = {"auto": c.is_aft_radius_automatic(), "value": c.get_aft_radius()}
            p["foreshoulderradius"] = c.get_fore_shoulder_radius()
            p["foreshoulderlength"] = c.get_fore_shoulder_length()
            p["foreshoulderthickness"] = c.get_fore_shoulder_thickness()
            p["foreshouldercapped"] = c.is_fore_shoulder_capped()
            p["aftshoulderradius"] = c.get_aft_shoulder_radius()
            p["aftshoulderlength"] = c.get_aft_shoulder_length()
            p["aftshoulderthickness"] = c.get_aft_shoulder_thickness()
            p["aftshouldercapped"] = c.is_aft_shoulder_capped()
    if isinstance(c, BodyTube):
        p["radius"] = {"auto": c.is_outer_radius_automatic(), "value": c.get_outer_radius()}
    if isinstance(c, FinSet):
        p["thickness"] = c.get_thickness()
        p["crosssection"] = c.get_cross_section().name.lower()
        p["cant"] = c.get_cant_angle()
        if c.get_tab_height() != 0 and c.get_tab_length() != 0:
            p["tabheight"] = c.get_tab_height()
            p["tablength"] = c.get_tab_length()
            p["tabposition"] = {"method": c.get_tab_offset_method().value, "value": c.get_tab_offset()}
        p["filletradius"] = c.get_fillet_radius()
        p["filletmaterial"] = c.get_fillet_material().to_param()
    if isinstance(c, TrapezoidFinSet):
        p["rootchord"] = c.get_root_chord()
        p["tipchord"] = c.get_tip_chord()
        p["sweeplength"] = c.get_sweep()
        p["height"] = c.get_height()
    if isinstance(c, EllipticalFinSet):
        p["rootchord"] = c.get_length()
        p["height"] = c.get_height()
    if isinstance(c, FreeformFinSet):
        p["finpoints"] = [[q.x, q.y] for q in c.get_fin_points()]
    if isinstance(c, TubeFinSet):
        p["radius"] = {"auto": c.is_outer_radius_automatic(), "value": c.get_outer_radius()}
        p["length"] = c.get_length()
        p["thickness"] = c.get_thickness()
    if isinstance(c, LaunchLug):
        p["radius"] = c.get_outer_radius()
        p["length"] = c.get_length()
        p["thickness"] = c.get_thickness()
    if isinstance(c, RailButton):
        p["outerdiameter"] = c.get_outer_diameter()
        p["innerdiameter"] = c.get_inner_diameter()
        p["height"] = c.get_total_height()
        p["baseheight"] = c.get_base_height()
        p["flangeheight"] = c.get_flange_height()
        p["screwheight"] = c.get_screw_height()
    if isinstance(c, StructuralComponent):
        p["material"] = c.get_material().to_param()
    if isinstance(c, RingComponent):
        p["length"] = c.get_length()
        p["radialposition"] = c.get_radial_position()
        p["radialdirection"] = c.get_radial_direction()
    if isinstance(c, ThicknessRingComponent):
        if isinstance(c, InnerTube):
            p["outerradius"] = c.get_outer_radius()
        else:
            p["outerradius"] = {"auto": c.is_outer_radius_automatic(), "value": c.get_outer_radius()}
        p["thickness"] = c.get_thickness()
    if isinstance(c, RadiusRingComponent):
        p["outerradius"] = {"auto": c.is_outer_radius_automatic(), "value": c.get_outer_radius()}
        if not isinstance(c, Bulkhead):
            p["innerradius"] = {"auto": c.is_inner_radius_automatic(), "value": c.get_inner_radius()}
    if isinstance(c, InnerTube):
        p["clusterconfiguration"] = c.get_cluster_configuration().get_xml_name()
        p["clusterscale"] = c.get_cluster_scale()
        p["clusterrotation"] = c.get_cluster_rotation()
    if isinstance(c, (BodyTube, InnerTube)) and c.is_motor_mount():
        d = default_motor_config(c)
        p["motormount"] = {"ignitionevent": d.ignition_event, "ignitiondelay": d.ignition_delay,
                           "overhang": c.get_motor_overhang()}
    if isinstance(c, MassObject):
        p["packedlength"] = c.get_length()
        p["packedradius"] = {"auto": c.is_radius_automatic(), "value": c.get_radius()}
        p["radialposition"] = c.get_radial_position()
        p["radialdirection"] = c.get_radial_direction()
    if isinstance(c, MassComponent):
        p["mass"] = c.get_component_mass()
        p["masscomponenttype"] = c.mass_component_type.value
    if isinstance(c, ShockCord):
        p["cordlength"] = c.get_cord_length()
        p["material"] = c.get_material().to_param()
    if isinstance(c, RecoveryDevice):
        p["cd"] = {"auto": c.is_cd_automatic(), "value": c.cd}
        p["material"] = c.get_material().to_param()
        p["deployevent"] = getattr(c, "deploy_event", "ejection")
        p["deployaltitude"] = getattr(c, "deploy_altitude", 200.0)
        p["deploydelay"] = getattr(c, "deploy_delay", 0.0)
    if isinstance(c, Parachute):
        p["diameter"] = c.get_diameter()
        p["linecount"] = c.get_line_count()
        p["linelength"] = c.get_line_length()
        p["linematerial"] = c.get_line_material().to_param()
    if isinstance(c, Streamer):
        p["striplength"] = c.get_strip_length()
        p["stripwidth"] = c.get_strip_width()
    return p


def default_component(ctype: str) -> dict:
    """A fresh Component of this type with OpenRocket's defaults (GET /api/components/defaults/{type})."""
    if ctype == "rocket":
        c = Rocket()
    else:
        klass = TYPE_CLASSES.get(ctype)
        if klass is None:
            raise ValueError(f"unknown component type {ctype!r}")
        c = klass()
    return {"id": c.id, "type": "parallelstage" if ctype == "boosterset" else ctype, "name": c.get_name(),
            "params": model_params(c), "children": []}


def new_document(name: str = "Rocket") -> dict:
    """An empty design: a rocket with one empty stage, and one flight configuration."""
    rocket = default_component("rocket")
    rocket["name"] = name
    stage = default_component("stage")
    stage["name"] = "Sustainer"
    rocket["children"].append(stage)
    cid = str(uuid.uuid4())
    return {"version": 1, "rocket": rocket,
            "motorConfigs": [{"id": cid, "name": "", "default": True, "stages": {"0": True}, "motors": {}}],
            "selectedConfig": cid}

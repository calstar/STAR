"""orweb -- OpenRocket 24.12's rocket model, .ork files and mass calculation, in Python.

A port of OpenRocket 24.12 (GPLv3). The document format is docs/SCHEMA.md.

    from orweb import read_ork, write_ork, build_rocket, mass_properties, side_figure

    doc = read_ork("rocket.ork")               # .ork  -> document (JSON-able dict)
    rocket = build_rocket(doc)                 # document -> component model
    config = rocket.get_selected_configuration()
    launch = calculate_launch(config)          # RigidBody: cm (x, weight=mass), Ixx, Iyy
    figure = side_figure(rocket)               # SCHEMA "Figure"
    write_ork(doc, "out.ork")                  # document -> .ork

The aerodynamics live in ``orweb.aero`` (a separate port).
"""

from .build import build_rocket, default_component, model_params, new_document
from .document import (analysis_components, configuration_for, document_from_json, document_to_json,
                       mass_properties, resolve_auto_values)
from .figure import side_figure
from .masscalc import (RigidBody, calculate_burnout, calculate_launch, calculate_motor, calculate_structure,
                       get_cm_analysis)
from .material import materials_listing
from .motors import MotorRegistry, ThrustCurveMotor, default_registry
from .ork import read_ork, write_ork, write_ork_xml

OPENROCKET_VERSION = "24.12"

__all__ = [
    "read_ork", "write_ork", "write_ork_xml", "build_rocket", "default_component", "new_document", "model_params",
    "document_from_json", "document_to_json", "resolve_auto_values", "mass_properties", "analysis_components",
    "configuration_for", "side_figure", "RigidBody", "calculate_launch", "calculate_structure", "calculate_burnout",
    "calculate_motor", "get_cm_analysis", "materials_listing", "MotorRegistry", "ThrustCurveMotor",
    "default_registry", "OPENROCKET_VERSION",
]

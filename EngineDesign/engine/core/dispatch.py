"""Injector-type physics bindings — single source of truth (UNIFICATION_PLAN Phase 2b, decision D4).

Audited reality (2026-06-11), which these bindings encode rather than invent:
  * SMD: ``PintleInjector.solve`` hard-binds ``smd_pintle`` (``spray.smd.model`` is IGNORED on the
    pintle path); ``ImpingingInjector.solve`` dispatches ``spray.smd.model`` (ingebo vs legacy
    lefebvre fallback).
  * Geometry-Cd (``cd_inf_from_orifice_diameter``): called only on the impinging path; pintle keeps
    fixed ``Cd_inf`` semantics (this is WHY anchor A stayed bit-compatible with main).
  * Layer-1 design vector: pintle 10 DOF (integer dim [6]); impinging 13 DOF (integer dim [4]).

``validate_config_bindings`` flags physically-incoherent combos LOUDLY (log warnings at load time)
instead of letting them run silently — the hardcoded-Cd bug class. It does not mutate the config:
behavior changes only happen explicitly in Phase 3 with anchor verification.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional


@dataclass(frozen=True)
class InjectorBindings:
    injector_type: str
    expected_smd_model: Optional[str]   # None = solver hard-binds its own correlation (knob ignored)
    smd_knob_ignored: bool              # spray.smd.model has no effect for this injector
    expected_use_geometry_cd: bool      # drilled-orifice geometry Cd vs fixed Cd_inf
    layer1_dof: Optional[int]
    layer1_integer_dims: Optional[List[int]]


INJECTOR_BINDINGS = {
    "pintle": InjectorBindings(
        injector_type="pintle",
        expected_smd_model=None, smd_knob_ignored=True,
        expected_use_geometry_cd=False,
        layer1_dof=10, layer1_integer_dims=[6],
    ),
    "impinging": InjectorBindings(
        injector_type="impinging",
        expected_smd_model="ingebo", smd_knob_ignored=False,
        expected_use_geometry_cd=True,
        layer1_dof=13, layer1_integer_dims=[4],
    ),
    "coaxial": InjectorBindings(
        injector_type="coaxial",
        expected_smd_model=None, smd_knob_ignored=False,
        expected_use_geometry_cd=False,
        layer1_dof=None, layer1_integer_dims=None,
    ),
}


def bindings_for(injector_type: str) -> InjectorBindings:
    try:
        return INJECTOR_BINDINGS[str(injector_type)]
    except KeyError:
        raise ValueError(
            f"Unknown injector type {injector_type!r}; known: {sorted(INJECTOR_BINDINGS)}"
        ) from None


# Default geometry templates stamped in when the USER switches injector type in the UI (the
# geometry structure differs per type and is incompatible across types, so we can't just toggle a
# flag — we replace the whole geometry block with sane starting values the optimizer then refines).
# Pintle values mirror main's default.yaml; impinging mirror this branch's default.yaml.
INJECTOR_GEOMETRY_TEMPLATES = {
    "pintle": {
        "lox": {"n_orifices": 14, "d_orifice": 0.00272, "theta_orifice": 90.0,
                "A_entry": 5.81e-06, "d_hydraulic": 0.00272},
        "fuel": {"d_pintle_tip": 0.028194, "d_reservoir_inner": 0.0292862, "h_gap": 0.0005461,
                 "A_entry": 0.000624314, "d_hydraulic": 0.0010922},
    },
    "impinging": {
        "oxidizer": {"n_elements": 20, "d_jet": 0.002, "impingement_angle": 50.0, "spacing": 0.006},
        "fuel": {"n_elements": 20, "d_jet": 0.002, "impingement_angle": 60.0, "spacing": 0.006},
    },
}


def default_geometry_for(injector_type: str) -> dict:
    """Default injector.geometry block for a freshly-switched injector type."""
    t = str(injector_type)
    if t not in INJECTOR_GEOMETRY_TEMPLATES:
        raise ValueError(f"No geometry template for injector type {t!r}; "
                         f"known: {sorted(INJECTOR_GEOMETRY_TEMPLATES)}")
    import copy
    return copy.deepcopy(INJECTOR_GEOMETRY_TEMPLATES[t])


# Per-injector discharge-coefficient baselines — the "different Cd models we originally had for each"
# (INJECTOR_PARITY_PLAN W2). Stamped onto discharge.{oxidizer,fuel} on an injector switch so the Cd
# physics actually reverts per type, not just the use_geometry_cd flag.
#   * pintle  = main's ethalox values: LOX orifice 0.40 / annular-gap fuel 0.65, fixed Cd_inf.
#   * impinging = matched drilled-hole 0.60 with geometry-Cd scaling (this branch).
_GEOMETRY_CD_PARAMS = {  # only meaningful when use_geometry_cd=True (impinging)
    "d_ref_m": 0.002, "cd_small_hole_exponent": 0.20, "cd_large_hole_log_gain": 0.015,
    "cd_inf_max": 0.62, "cd_inf_min_geom": 0.48, "d_min_m": 0.0004,
}
INJECTOR_DISCHARGE_BASELINES = {
    "pintle": {
        "oxidizer": {"Cd_inf": 0.40, "a_Re": 0.15, "Cd_min": 0.15, "use_geometry_cd": False},
        "fuel": {"Cd_inf": 0.65, "a_Re": 0.20, "Cd_min": 0.20, "use_geometry_cd": False},
    },
    "impinging": {
        "oxidizer": {"Cd_inf": 0.60, "a_Re": 0.18, "Cd_min": 0.35, "use_geometry_cd": True, **_GEOMETRY_CD_PARAMS},
        "fuel": {"Cd_inf": 0.60, "a_Re": 0.18, "Cd_min": 0.35, "use_geometry_cd": True, **_GEOMETRY_CD_PARAMS},
    },
}


def default_discharge_for(injector_type: str) -> dict:
    """Per-stream discharge-Cd baseline for a freshly-switched injector type. Empty for types without
    a registered baseline (caller then leaves discharge untouched)."""
    import copy
    return copy.deepcopy(INJECTOR_DISCHARGE_BASELINES.get(str(injector_type), {}))


# Which Layer-1 frozen-parameter fields apply to each injector type — the authority the UI uses to
# render ONLY the relevant freeze checkboxes (no pintle fields in doublet mode, vice-versa).
# Names match FrozenParametersConfig fields AND the optimizer's frozen_mapping keys.
_FROZEN_COMMON = ["A_throat_mm2", "Lstar_mm", "expansion_ratio", "D_chamber_outer_mm",
                  "P_O_start_psi", "P_F_start_psi"]
_FROZEN_INJECTOR = {
    "pintle": ["d_pintle_tip_mm", "h_gap_mm", "n_orifices", "d_orifice_mm"],
    "impinging": ["n_doublets", "d_jet_O_mm", "d_jet_F_mm", "impingement_angle_O_deg",
                  "impingement_angle_F_deg", "spacing_O_mm", "spacing_F_mm"],
    "coaxial": [],
}


def frozen_param_fields_for(injector_type: str) -> List[str]:
    """Frozen-param field names valid for this injector type (chamber-common + injector-specific)."""
    t = str(injector_type)
    if t not in _FROZEN_INJECTOR:
        raise ValueError(f"Unknown injector type {t!r}; known: {sorted(_FROZEN_INJECTOR)}")
    return list(_FROZEN_COMMON) + list(_FROZEN_INJECTOR[t])


def validate_config_bindings(config: Any) -> List[str]:
    """Return human-readable warnings for combos that contradict the physics bindings.

    Warn-only by design (Phase 2b): the loader logs these; nothing is mutated so golden anchors
    cannot shift. Tightening to hard errors / auto-derivation is a Phase-3 decision.
    """
    warnings: List[str] = []
    inj_type = str(getattr(getattr(config, "injector", None), "type", "") or "")
    if inj_type not in INJECTOR_BINDINGS:
        return [f"injector.type {inj_type!r} has no physics bindings registered"]
    b = INJECTOR_BINDINGS[inj_type]

    smd_model = str(getattr(getattr(getattr(config, "spray", None), "smd", None), "model", "") or "")
    if b.smd_knob_ignored and smd_model and smd_model != "lefebvre":
        # not harmful (knob ignored) but misleading config state worth surfacing once
        warnings.append(
            f"spray.smd.model='{smd_model}' has NO EFFECT for injector.type='{inj_type}' "
            f"(solver hard-binds its own correlation)"
        )
    if b.expected_smd_model and smd_model and smd_model != b.expected_smd_model:
        warnings.append(
            f"injector.type='{inj_type}' expects spray.smd.model='{b.expected_smd_model}' but config "
            f"says '{smd_model}' — atomization (and stability time-lag, τ∝SMD²) will use the "
            f"unexpected correlation"
        )

    discharge = getattr(config, "discharge", None) or {}
    for side in ("oxidizer", "fuel"):
        d = discharge.get(side) if isinstance(discharge, dict) else getattr(discharge, side, None)
        if d is None:
            continue
        geo = bool(getattr(d, "use_geometry_cd", False))
        if geo != b.expected_use_geometry_cd:
            warnings.append(
                f"discharge.{side}.use_geometry_cd={geo} but injector.type='{inj_type}' expects "
                f"{b.expected_use_geometry_cd} (geometry-Cd is calibrated for drilled impinging "
                f"orifices; pintle uses fixed Cd_inf)"
            )
    return warnings

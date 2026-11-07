"""POST /api/ejection and GET /api/ejection/pins: separation joints.

Shear pins, ejection charge and vent holes; the physics is
`physics/ejection.py`. The request carries the same wire `Config` as
/api/simulate, because two of the loads a joint has to hold come out of it:
the pad and apogee pressures (trapped pressure) and the drogue's opening force
(drogue opening, dual separation).
"""

from dataclasses import asdict
from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from physics.atmosphere import Atmosphere
from physics.cases import _first_to_fire, _primary, evaluate
from physics.ejection import (
    BP_SOURCE,
    PIN_CATALOG,
    VENT_SOURCE,
    Joint,
    Settings,
    Vehicle,
    size_joint,
    vent_hole,
)
from physics.schema import Config

router = APIRouter(prefix="/api", tags=["ejection"])

STRICT = ConfigDict(extra="forbid")


class JointIn(BaseModel):
    model_config = STRICT

    name: str = Field(max_length=80)
    role: Literal["drogue", "main", "other"]
    bay_id: float = Field(gt=0.0, le=2.0, description="Bay inner diameter, m.")
    bay_length: float = Field(gt=0.0, le=10.0,
                              description="Free length the charge pressurises, m.")
    m_forward: float = Field(ge=0.0, le=5000.0,
                             description="Mass forward of the joint, kg.")


class VentIn(BaseModel):
    model_config = STRICT

    bay_id: float = Field(gt=0.0, le=2.0)
    bay_length: float = Field(gt=0.0, le=10.0)
    n_holes: int = Field(ge=1, le=16)


class EjectionSpec(BaseModel):
    model_config = STRICT

    m_burnout: float = Field(ge=0.0, le=50000.0,
                             description="Whole vehicle at burnout, kg.")
    D_burnout: float = Field(ge=0.0, le=1e6,
                             description="Whole-vehicle drag at burnout, N.")
    sf_hold: float = Field(default=2.0, gt=0.0, le=10.0)
    sf_eject: float = Field(default=1.5, gt=0.0, le=10.0)
    trapped_pressure: bool = True
    dual_separation: bool = True
    joints: List[JointIn] = Field(default_factory=list, max_length=8)
    vent: Optional[VentIn] = None


class EjectionRequest(BaseModel):
    model_config = STRICT

    config: Config
    ejection: EjectionSpec


def _drogue_opening(config, atm):
    """The drogue's peak opening force, N, from the nominal axial run, with
    which number it was and which device. None when there is no drogue.

    Axial is the faster-falling attitude bound, so the higher load. Of the
    loads the run reports, the largest is taken: the numerical peak, the eq
    (23) infinite-mass bound, and the snatch load when a stiffness is given.
    """
    if len(config.devices) < 2:
        return None
    main = _primary(config.devices)
    drogue = _first_to_fire([d for d in config.devices if d is not main])
    cr = evaluate(config, "axial", "nominal", atm=atm)
    loads = next((dl for dl in cr.per_device if dl.name == drogue.name), None)
    if loads is None or not loads.fired:
        return None
    candidates = {
        "numerical peak": loads.F_T_peak,
        "infinite-mass bound (eq 23)": loads.F_inf,
        "snatch (eq 34)": loads.F_snatch,
    }
    candidates = {k: float(v) for k, v in candidates.items() if v is not None}
    which = max(candidates, key=candidates.get)
    return {"F": candidates[which], "basis": which, "device": drogue.name,
            "m_descending": float(cr.run.m)}


@router.get("/ejection/pins")
def pin_catalog():
    return [{"key": p.key, "label": p.label, "F_min": p.F_min,
             "F_max": p.F_max, "source": p.source}
            for p in PIN_CATALOG.values()]


@router.post("/ejection")
def run_ejection(req: EjectionRequest):
    config, spec = req.config, req.ejection
    try:
        atm = Atmosphere(config.site.z_site, config.site.T_pad,
                         config.site.p_pad, config.site.lapse)
        h_a = config.vehicle.h_a
        drogue = None
        if spec.dual_separation and any(j.role == "main" for j in spec.joints):
            drogue = _drogue_opening(config, atm)
        vehicle = Vehicle(
            m_burnout=spec.m_burnout, D_burnout=spec.D_burnout,
            m_descending=(drogue["m_descending"] if drogue
                          else config.vehicle.m),
            p_pad=atm.p_pad, p_apogee=atm.p(h_a),
        )
        settings = Settings(sf_hold=spec.sf_hold, sf_eject=spec.sf_eject,
                            trapped_pressure=spec.trapped_pressure,
                            dual_separation=spec.dual_separation)
        joints = []
        for j in spec.joints:
            r = size_joint(
                Joint(name=j.name, role=j.role, bay_id=j.bay_id,
                      bay_length=j.bay_length, m_forward=j.m_forward),
                vehicle, settings,
                F_drogue_open=drogue["F"] if drogue else None,
            )
            joints.append(asdict(r))
        vent = None
        if spec.vent is not None:
            v = vent_hole(spec.vent.bay_id, spec.vent.bay_length,
                          spec.vent.n_holes)
            vent = {"d": v.d, "d_64ths": v.d_64ths, "volume": v.volume,
                    "n_holes": spec.vent.n_holes}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # The loads a joint is sized against are only as complete as its inputs.
    # A zero here silently drops a load, so say so rather than show a pin
    # count that looks finished.
    warnings = []
    if spec.m_burnout <= 0.0 or spec.D_burnout <= 0.0:
        warnings.append("Burnout mass or drag is zero, so drag separation at "
                        "burnout is not included.")
    for j in spec.joints:
        if j.m_forward <= 0.0:
            warnings.append("%s: mass forward of the joint is zero, so drag "
                            "separation and drogue opening load nothing on it."
                            % j.name)
        # The forward part is part of the whole, so a larger number means the
        # two masses describe different vehicles -- and both loads scale with
        # the ratio, so the pin count would be wrong without looking wrong.
        if spec.m_burnout > 0.0 and j.m_forward > spec.m_burnout:
            warnings.append("%s: mass forward of the joint exceeds the mass "
                            "at burnout." % j.name)
        if (j.role == "main" and spec.dual_separation
                and j.m_forward > vehicle.m_descending):
            warnings.append("%s: mass forward of the joint exceeds the "
                            "descending mass on the Setup tab." % j.name)

    return {
        "warnings": warnings,
        "joints": joints,
        "vent": vent,
        "conditions": {
            "h_apogee": h_a,
            "p_pad": vehicle.p_pad,
            "p_apogee": vehicle.p_apogee,
            "m_descending": vehicle.m_descending,
            "drogue": drogue,
        },
        "sources": {"black_powder": BP_SOURCE, "vent": VENT_SOURCE},
    }

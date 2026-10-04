"""The engine on the end of the feed system: EngineDesign's, as the twin runs it.

The twin's own engine is simple:
* an orifice leg per side, with the config's Reynolds-law Cd;
* ``p_c = mdot c* eta / A_t`` on the CEA table, with ``eta_c* = 1``. Its importer says
  that chamber pressure is an upper bound.

EngineDesign's engine has much more in it:
* a plate-passage Cd and a ring-network manifold;
* the Borda dump of the feed line into that manifold;
* a spray/mixing/heat-loss c* efficiency;
* a stagnation loss and the real nozzle exit.

On the 6.8 kN engine at 578 psia the two differ by ~14 % in flow. Three ways to put
an engine on the end of the twin, as ``mode``:

``card`` (default, phase 2)
    EngineDesign sampled across the burn envelope and tabulated as an engine card
    (:mod:`engine.layerx.card`, :mod:`feedtwin.engine.card`). The twin evaluates
    EngineDesign's injector and chamber at every coupling step, everywhere the
    burn goes. The card carries its own measured error.

``calibrated`` (phase 1)
    The twin's engine, with four constants set so that it reproduces EngineDesign
    at one point, T-0:
    * a Cd per side;
    * ``eta_c*``;
    * ``eta_n``.

    Away from T-0 they are held constant. Kept for comparison.

``native``
    The twin's engine as imported. For seeing what the other two change.

Both EngineDesign modes put the boundary at the **line exit**. EngineDesign is
solved with its feed-line losses zeroed and its exit dump kept
(:func:`engine.layerx.card.line_exit_config`), because the drawing's lines carry
every loss upstream of the injector face and none downstream of it.

Phase 1 calibrated against EngineDesign's still-manifold injector drop, which
left that ~26 psi LOX dump on neither side.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from engine.layerx.card import EngineSampler, card_for

PSI = 6894.757293168361

MODES = ("card", "calibrated", "native")


@dataclass
class EngineLink:
    """The twin's engine, and how it was made to agree with EngineDesign."""

    design: Any
    """feedtwin.engine.EngineDesign, with an engine card attached, calibrated, or native."""
    chamber: Any
    """feedtwin.engine.Chamber (a CardChamber in card mode)."""
    mode: str
    reference: Dict[str, float] = field(default_factory=dict)
    """EngineDesign at the line exit, at the T-0 pressures."""
    calibration: Dict[str, Any] = field(default_factory=dict)
    card: Any = None
    """The feedtwin.engine.EngineCard, in card mode."""
    sampler: Any = None
    """EngineDesign at the line exit, for checking a burn against it afterwards."""
    notes: list = field(default_factory=list)


def _reference(sampler: EngineSampler, p_O: float, p_F: float) -> Dict[str, float]:
    point = sampler(p_O, p_F)
    if point is None:
        raise ValueError(f"EngineDesign has no solution at {p_O / PSI:.1f} / {p_F / PSI:.1f} psia "
                         "at the line exit")
    return {**point, "p_O": p_O, "p_F": p_F, "P_ambient": sampler.ambient_pa,
            "dp_line_O": p_O - point["Pc"], "dp_line_F": p_F - point["Pc"]}


def _constant_cd(value: float) -> Any:
    """A discharge model that is ``value`` at every Reynolds number."""
    from feedtwin.engine.design import DischargeModel

    return DischargeModel(cd_inf=value, a_re=0.0, cd_min=min(value, 0.15), cd_inf_max=max(value, 0.62))


def _chamber(design: Any, table: Any, ambient_pa: float, **losses: float) -> Any:
    from feedtwin.engine import Chamber

    return Chamber(design.throat_area, table, volume=design.chamber_volume, ambient_pressure=ambient_pa,
                   **losses)


def link_engine(
    config: Any,
    *,
    tank_pa_O: float,
    tank_pa_F: float,
    cea_path: Optional[Path],
    ambient_pa: float,
    fluid_at: Any,
    mode: str = "card",
    card_center_pa: Optional[float] = None,
) -> EngineLink:
    """The live config as the twin's engine, in ``mode`` (see the module docstring).

    ``fluid_at(side, pressure_pa) -> (rho, mu)`` is the twin's own propellant state at the
    injector inlet, used where a Cd has to be recovered at the density the twin's leg sees.
    ``card_center_pa`` centres the engine card somewhere other than this burn's T-0, so that
    burns at several tank pressures share one card (the optimiser); the card's own envelope
    check and the run's ``card_outside_steps`` say whether the burn stayed inside it.
    """
    from feedtwin.engine import CEATable, ConstantCStar
    from feedtwin.engine.importer import engine_from_config

    if mode not in MODES:
        raise ValueError(f"engine mode {mode!r}; expected one of {', '.join(MODES)}")
    raw = config.model_dump(mode="json")
    design = engine_from_config(raw, name=str(getattr(config, "name", "") or "engine"))
    notes: list = []

    if cea_path is not None:
        table: Any = CEATable(str(cea_path), expansion_ratio=design.expansion_ratio)
    else:
        table = ConstantCStar(cstar=1700.0)
        notes.append("No CEA table found for this engine; the twin's chamber runs a constant c* of "
                     "1700 m/s and reports no thrust coefficient.")

    sampler = EngineSampler(config, ambient_pa)
    reference = _reference(sampler, tank_pa_O, tank_pa_F)
    native_cd = {
        side: getattr(design, side).cd_at(reference[m], *fluid_at(side, reference[p]), pressure=reference[p])
        for side, m, p in (("oxidiser", "mdot_O", "p_O"), ("fuel", "mdot_F", "p_F"))
    }

    if mode == "native":
        chamber = _chamber(design, table, ambient_pa, efficiency=design.cstar_efficiency,
                           nozzle_efficiency=design.nozzle_efficiency)
        return EngineLink(design=design, chamber=chamber, mode="native", reference=reference,
                          calibration={"mode": "native", "native_cd_O": native_cd["oxidiser"],
                                       "native_cd_F": native_cd["fuel"]},
                          sampler=sampler, notes=notes)

    if mode == "card":
        center = card_center_pa if card_center_pa is not None else 0.5 * (tank_pa_O + tank_pa_F)
        card = card_for(config, center_pa=center, ambient_pa=ambient_pa)
        design = card.attach(design)
        chamber = card.chamber_model(ambient_pressure=ambient_pa, volume=design.chamber_volume)
        fit = dict(card.fit)
        calibration = {
            "mode": "card",
            "native_cd_O": native_cd["oxidiser"],
            "native_cd_F": native_cd["fuel"],
            "fit": fit,
            "card": {k: v for k, v in card.provenance.items()},
            "chamber_grid": [card.chamber.cstar.nx, card.chamber.cstar.ny],
            "injector_grid": [card.oxidiser.capacity.nx, card.oxidiser.capacity.ny],
            "of_range": [card.chamber.cstar.x0, card.chamber.cstar.x_max],
            "mdot_range": [card.chamber.cstar.y0, card.chamber.cstar.y_max],
        }
        if not card.provenance.get("within_tolerance", False):
            notes.append(f"The engine card's error against held-out EngineDesign solves is "
                         f"{fit.get('envelope_worst', float('nan')) * 100:.3f} %, over its "
                         f"{fit.get('tolerance', 0) * 100:.1f} % tolerance.")
        return EngineLink(design=design, chamber=chamber, mode="card", reference=reference,
                          calibration=calibration, card=card, sampler=sampler, notes=notes)

    # ---- calibrated: one constant Cd per side at the twin's own density, line exit to chamber ----
    cds: Dict[str, float] = {}
    rhos: Dict[str, float] = {}
    for side, m_key, p_key, dp_key in (("oxidiser", "mdot_O", "p_O", "dp_line_O"),
                                       ("fuel", "mdot_F", "p_F", "dp_line_F")):
        injector = getattr(design, side)
        mdot, p_line, dp = reference[m_key], reference[p_key], reference[dp_key]
        if not (math.isfinite(dp) and dp > 0.0 and injector.area > 0.0):
            raise ValueError(f"EngineDesign reported no usable {side} pressure drop at T-0 (dp = {dp})")
        rho = float(fluid_at(side, p_line)[0])
        rhos[side] = rho
        cds[side] = mdot / (injector.area * math.sqrt(2.0 * rho * dp))
    design = replace(design,
                     oxidiser=replace(design.oxidiser, discharge=_constant_cd(cds["oxidiser"])),
                     fuel=replace(design.fuel, discharge=_constant_cd(cds["fuel"])))

    pc, mo, mf, thrust = reference["Pc"], reference["mdot_O"], reference["mdot_F"], reference["F"]
    eta_c, eta_n = 1.0, 1.0
    for _ in range(8):
        got = _chamber(design, table, ambient_pa, efficiency=eta_c, nozzle_efficiency=eta_n).evaluate(mo, mf)
        if got.pressure <= 0.0:
            break
        eta_c *= pc / got.pressure
        if got.thrust > 0.0:
            eta_n *= thrust / got.thrust
    chamber = _chamber(design, table, ambient_pa, efficiency=eta_c, nozzle_efficiency=eta_n)
    check = chamber.evaluate(mo, mf)
    residual_pc = (check.pressure - pc) / pc
    residual_f = (check.thrust - thrust) / thrust if thrust else float("nan")
    calibration = {
        "mode": "calibrated",
        "at": "T-0 line-exit pressures",
        "tank_psia_O": tank_pa_O / PSI,
        "tank_psia_F": tank_pa_F / PSI,
        "cd_O": cds["oxidiser"],
        "cd_F": cds["fuel"],
        "rho_O": rhos["oxidiser"],
        "rho_F": rhos["fuel"],
        "eta_cstar": eta_c,
        "eta_n": eta_n,
        "ed_eta_cstar": reference.get("eta_cstar", float("nan")),
        "residual_pc": residual_pc,
        "residual_thrust": residual_f,
        "native_cd_O": native_cd["oxidiser"],
        "native_cd_F": native_cd["fuel"],
    }
    if abs(residual_pc) > 1e-4 or (math.isfinite(residual_f) and abs(residual_f) > 1e-4):
        notes.append(f"Chamber calibration left a residual of {residual_pc:+.2e} in Pc and "
                     f"{residual_f:+.2e} in thrust at T-0.")
    return EngineLink(design=design, chamber=chamber, mode="calibrated", reference=reference,
                      calibration=calibration, sampler=sampler, notes=notes)


def twin_injector_check(link: EngineLink, fluid_at: Any) -> Dict[str, Tuple[float, float]]:
    """At EngineDesign's T-0 flows, the twin's line-exit-to-chamber pressure drop per side
    against EngineDesign's: ``side -> (twin_dp, ed_dp)`` [Pa]. Equal by construction when
    calibrated, equal to the card's error with a card, the gap they close when native."""
    out: Dict[str, Tuple[float, float]] = {}
    ref = link.reference
    for side, m_key, p_key, dp_key in (("oxidiser", "mdot_O", "p_O", "dp_line_O"),
                                      ("fuel", "mdot_F", "p_F", "dp_line_F")):
        injector = getattr(link.design, side)
        if injector.card is not None:
            twin_dp = injector.card.pressure_drop(ref[m_key], ref[p_key])
        else:
            rho, mu = fluid_at(side, ref[p_key])
            cd = injector.cd_at(ref[m_key], rho, mu, pressure=ref[p_key])
            twin_dp = ref[m_key] ** 2 / (2.0 * rho * (cd * injector.area) ** 2)
        out[side] = (twin_dp, ref[dp_key])
    return out

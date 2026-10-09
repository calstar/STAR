"""EngineDesign's engine as an engine card for the feed twin (Layer X, phase 2).

A card (:mod:`feedtwin.engine.card`) is this engine downstream of its feed lines, tabulated so the
twin can run it at every coupling step of a burn. This module builds one by sampling EngineDesign
and fitting the tables, and measures how wrong the card is before anything uses it.

The boundary: the line exit
---------------------------
The twin's lines end at the injector face node, at line-end pressure in the lumped K-factor
convention. EngineDesign's ``feed_system`` is a tank-to-manifold model: ``K_eff`` along the
line, plus a Borda dump of the exit bore's velocity head into the manifold.

The card samples a copy of the config with every line loss zeroed (``K0``, ``K1``, fittings,
friction) and the exit dump kept. Its "tank" pressure is then exactly the line-exit pressure,
and the card owns everything downstream:
* the dump;
* the ring manifold;
* the plate passages and their Cd;
* the spray, mixing and heat-loss efficiency;
* the stagnation loss;
* the nozzle.

The drawing owns the lines. On the 6.8 kN engine the dump alone is ~26 psi on the LOX side,
which is why it cannot be left on neither side or put on both.

Sampling and fitting
--------------------
EngineDesign is solved on a grid of line-exit pressures around the T-0 point. Each solve is
~5-20 ms on the numba chamber kernel, which has 1e-9 parity with the Python solve. The fitted
quantities are each nearly constant over the burn, which is why they tabulate well:
* injector flow capacity ``mdot/sqrt(dp)`` over ``(mdot, p_inlet)``;
* ``c*_eff = Pc A_t/mdot`` over ``(O/F, mdot)``;
* the vacuum exhaust velocity ``(F + p_a A_e)/mdot`` over ``(O/F, mdot)``. EngineDesign's thrust
  is exactly linear in ambient pressure for a full-flowing nozzle, so a card built at one
  ambient serves any.

The fit is thin-plate RBF through the samples, resampled onto uniform grids, which the twin
evaluates with Catmull-Rom.

Limit, measured: EngineDesign's efficiency has slope kinks at its CEA table's O/F nodes (its
own trilinear lookup). No smooth table reproduces those, which sets a floor of a few hundredths
of a percent in chamber pressure. The card reports its measured error, and a card whose error
on held-out solves exceeds :data:`TOLERANCE` is flagged, not used quietly.
"""

from __future__ import annotations

import copy
import math
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

PSI = 6894.757293168361

#: Largest relative error, against held-out EngineDesign solves inside the operating envelope,
#: that a card may carry and still be used without a warning. docs/layer-x.md, phase 2.
TOLERANCE = 2.0e-3

#: The scan around T-0, as fractions of the T-0 line pressure (level) and fuel/LOX line
#: pressure (ratio). Wide enough that the burn and the chamber closure's brackets stay inside.
LEVELS = (0.40, 1.30, 21)
RATIOS = (0.75, 1.30, 13)
#: The operating envelope the tolerance is judged on: what a regulated burn actually visits
#: (O/F about 1.35-1.75 on the 6.8 kN engine). Beyond it, above O/F ~1.9, EngineDesign's mixing
#: efficiency falls in irregular steps (striated elements, stream tubes past the c* table) that no
#: smooth table follows to better than ~0.2 %; the whole-scan error is reported as ``box_*`` so
#: that is visible rather than averaged away. What a burn actually saw is checked afterwards,
#: along its own trajectory (engine/layerx/analysis.py engine_check).
ENVELOPE_LEVELS = (0.70, 1.15)
ENVELOPE_RATIOS = (0.90, 1.12)
#: Table resolution.
CHAMBER_GRID = (41, 41)
INJECTOR_GRID = (41, 21)

BOUNDARY = ("line exit: EngineDesign's feed_system with K0, K1, fittings and friction zeroed and "
            "the Borda exit dump kept; the drawing's lines carry every loss upstream of it")


# ------------------------------------------------------------------ the engine at the line exit


def line_exit_config(config: Any) -> Any:
    """A copy of ``config`` whose feed lines lose nothing but the exit dump into the manifold.

    ``supply_K`` goes with ``K0``: it is the share of ``K0`` that is the pressurant supply sagging
    under flow (Layer X's feed fit writes it), and the chug loop subtracts it from the feed drop it
    takes as line resistance (stability/analysis.py ``_chug_feed_drop``). With ``K0`` zeroed the
    drop left is the exit dump alone, which holds no supply share; left in, a feed-fit write took
    the chug gate from 1.330 to 1.248 with nothing physical changed (audit D7, 5.3). A config with
    ``supply_K`` 0 (LE4) is unchanged by this."""
    out = copy.deepcopy(config)
    feeds = out.feed_system
    sides = feeds.values() if isinstance(feeds, dict) else (feeds.oxidizer, feeds.fuel)
    for side in sides:
        side.K0 = 0.0
        side.K1 = 0.0
        side.phi_type = "none"
        if getattr(side, "supply_K", None):
            side.supply_K = 0.0
        if getattr(side, "fittings", None):
            side.fittings = []
        if getattr(side, "roughness_m", None) is not None:
            side.roughness_m = None
    return out


class EngineSampler:
    """EngineDesign at the line exit, one operating point per call.

    ``(p_line_O, p_line_F) -> {Pc, mdot_O, mdot_F, F, ...}`` at ``ambient_pa``, or ``None`` where
    EngineDesign has no solution. The numba kernel when it handles this engine, otherwise the
    Python solve: same physics, ~100x the cost.
    """

    def __init__(self, config: Any, ambient_pa: float) -> None:
        from engine import accel
        from engine.core.runner import PintleEngineRunner

        self.runner = PintleEngineRunner(line_exit_config(config))
        # The runner's copy, not ours: PintleEngineRunner applies the config's measurements
        # (engine/pipeline/measurements.py -- a measured Cd, E_m, D32, nozzle efficiency) to the
        # config it keeps, and the fast path has to sample the same engine the replay runs.
        self.config = self.runner.config
        self.ambient_pa = float(ambient_pa)
        self.fast = bool(accel.enabled() and accel.can_handle_chamber(self.config)
                         and getattr(self.runner.cea_cache, "use_3d", False))
        self.calls = 0

    @property
    def kind(self) -> str:
        return "numba chamber kernel" if self.fast else "Python chamber solve"

    def __call__(self, p_O: float, p_F: float) -> Optional[Dict[str, float]]:
        self.calls += 1
        if self.fast:
            from engine import accel

            point, _ = accel.chamber_point(self.config, self.runner.cea_cache, p_O, p_F, self.ambient_pa)
            if point is not None:
                return point
        try:
            res = self.runner.evaluate(p_O, p_F, silent=True, P_ambient=self.ambient_pa)
        except Exception:  # noqa: BLE001 - no solution here is a gap in the scan, not an error
            return None
        return {"Pc": float(res["Pc"]), "mdot_O": float(res["mdot_O"]), "mdot_F": float(res["mdot_F"]),
                "MR": float(res["MR"]), "F": float(res["F"]), "Isp": float(res["Isp"])}


# ------------------------------------------------------------------ fitting


def _rbf(points: np.ndarray, values: np.ndarray):
    """Thin-plate RBF through ``values`` at ``points`` (columns normalised), as a callable."""
    from scipy.interpolate import RBFInterpolator

    mu, sd = points.mean(axis=0), points.std(axis=0)
    sd = np.where(sd > 0, sd, 1.0)
    f = RBFInterpolator((points - mu) / sd, values, kernel="thin_plate_spline", degree=1)
    return lambda q: f((np.atleast_2d(q) - mu) / sd)


def _table(fn, x_axis: np.ndarray, y_axis: np.ndarray, transform: Callable[[np.ndarray], np.ndarray]):
    from feedtwin.engine.card import Table2D

    X, Y = np.meshgrid(x_axis, y_axis, indexing="ij")
    q = transform(np.c_[X.ravel(), Y.ravel()])
    V = np.asarray(fn(q)).reshape(X.shape)
    return Table2D(x0=float(x_axis[0]), dx=float(x_axis[1] - x_axis[0]), nx=len(x_axis),
                   y0=float(y_axis[0]), dy=float(y_axis[1] - y_axis[0]), ny=len(y_axis),
                   values=tuple(tuple(float(v) for v in row) for row in V))


def _hull(points: np.ndarray) -> Tuple[Tuple[float, float], ...]:
    from scipy.spatial import ConvexHull

    h = ConvexHull(points)
    return tuple((float(points[k, 0]), float(points[k, 1])) for k in h.vertices)


def _axis(values: np.ndarray, n: int) -> np.ndarray:
    lo, hi = float(np.min(values)), float(np.max(values))
    return np.linspace(lo, hi, n)


def fit_card(samples: Sequence[Dict[str, float]], *, throat_area: float, exit_area: float,
             ambient_pa: float, name: str):
    """Tables through ``samples`` (line-exit operating points with ``p_O``, ``p_F``)."""
    from feedtwin.engine.card import ChamberCard, EngineCard, InjectorCard

    S = list(samples)
    mo = np.array([s["mdot_O"] for s in S])
    mf = np.array([s["mdot_F"] for s in S])
    pc = np.array([s["Pc"] for s in S])
    F = np.array([s["F"] for s in S])
    mt, mr = mo + mf, mo / mf

    # Chamber: fitted in (O/F, ln mdot), tabulated on uniform (O/F, mdot).
    feat = np.c_[mr, np.log(mt)]
    f_c = _rbf(feat, pc * throat_area / mt)
    f_v = _rbf(feat, (F + ambient_pa * exit_area) / mt)
    to_feat = lambda q: np.c_[q[:, 0], np.log(q[:, 1])]  # noqa: E731
    mr_ax, mt_ax = _axis(mr, CHAMBER_GRID[0]), _axis(mt, CHAMBER_GRID[1])
    chamber = ChamberCard(
        cstar=_table(f_c, mr_ax, mt_ax, to_feat),
        vacuum_velocity=_table(f_v, mr_ax, mt_ax, to_feat),
        hull=_hull(np.c_[mr, mt]),
    )

    def injector(m: np.ndarray, p: np.ndarray) -> InjectorCard:
        dp = p - pc
        f = _rbf(np.c_[m, p], m / np.sqrt(dp))
        return InjectorCard(capacity=_table(f, _axis(m, INJECTOR_GRID[0]), _axis(p, INJECTOR_GRID[1]), lambda q: q),
                            hull=_hull(np.c_[m, p]))

    p_O = np.array([s["p_O"] for s in S])
    p_F = np.array([s["p_F"] for s in S])
    return EngineCard(name=name, throat_area=float(throat_area), exit_area=float(exit_area),
                      oxidiser=injector(mo, p_O), fuel=injector(mf, p_F), chamber=chamber)


# ------------------------------------------------------------------ checking a card


def solve_card(card: Any, p_O: float, p_F: float, ambient_pa: float) -> Optional[Dict[str, float]]:
    """The card's own operating point at line-exit pressures ``p_O``, ``p_F``: Pc such that the
    flows each injector passes at that Pc are the flows that make that Pc. Independent of the twin's
    network, so it checks the card and nothing else."""
    from scipy.optimize import brentq

    chamber = card.chamber_model(ambient_pressure=ambient_pa)

    def flow(side: Any, p: float, pc: float) -> float:
        dp = max(p - pc, 0.0)
        m = side.capacity(1.0, p) * math.sqrt(dp)
        for _ in range(30):
            m_new = side.capacity(m, p) * math.sqrt(dp)
            if abs(m_new - m) <= 1e-13 * max(m, 1e-12):
                break
            m = m_new
        return m

    def g(pc: float) -> float:
        mo, mf = flow(card.oxidiser, p_O, pc), flow(card.fuel, p_F, pc)
        return chamber.evaluate(mo, mf).pressure - pc

    hi = min(p_O, p_F) * (1.0 - 1e-9)
    lo = ambient_pa * 1.01
    if g(lo) * g(hi) > 0:
        return None
    pc = brentq(g, lo, hi, xtol=1e-6, rtol=1e-12)
    mo, mf = flow(card.oxidiser, p_O, pc), flow(card.fuel, p_F, pc)
    res = chamber.evaluate(mo, mf)
    return {"Pc": res.pressure, "mdot_O": mo, "mdot_F": mf, "F": res.thrust}


def check_card(card: Any, points: Sequence[Dict[str, float]], ambient_pa: float) -> Dict[str, float]:
    """Largest relative errors of ``card`` against EngineDesign solves ``points`` (each with p_O, p_F).

    * ``chamber_*``: the chamber tables given EngineDesign's own flows.
    * ``dp_*``: each injector table given EngineDesign's flow and line pressure.
    * ``closed_*``: the card solved as a whole at the line pressures (:func:`solve_card`), against
      EngineDesign at the same pressures. This is what a burn sees.
    """
    chamber = card.chamber_model(ambient_pressure=ambient_pa)
    worst: Dict[str, float] = {k: 0.0 for k in ("chamber_pc", "chamber_thrust", "dp_O", "dp_F",
                                                "closed_pc", "closed_thrust", "closed_mdot")}

    def bump(key: str, got: float, want: float) -> None:
        if want:
            worst[key] = max(worst[key], abs(got / want - 1.0))

    for s in points:
        res = chamber.evaluate(s["mdot_O"], s["mdot_F"])
        bump("chamber_pc", res.pressure, s["Pc"])
        bump("chamber_thrust", res.thrust, s["F"])
        bump("dp_O", card.oxidiser.pressure_drop(s["mdot_O"], s["p_O"]), s["p_O"] - s["Pc"])
        bump("dp_F", card.fuel.pressure_drop(s["mdot_F"], s["p_F"]), s["p_F"] - s["Pc"])
        closed = solve_card(card, s["p_O"], s["p_F"], ambient_pa)
        if closed is None:
            worst["closed_pc"] = max(worst["closed_pc"], 1.0)
            continue
        bump("closed_pc", closed["Pc"], s["Pc"])
        bump("closed_thrust", closed["F"], s["F"])
        bump("closed_mdot", closed["mdot_O"], s["mdot_O"])
        bump("closed_mdot", closed["mdot_F"], s["mdot_F"])
    worst["points"] = float(len(points))
    return worst


def _scan(sampler: EngineSampler, center_pa: float, levels: Tuple[float, float, int],
          ratios: Tuple[float, float, int]) -> List[Dict[str, float]]:
    out = []
    for u in np.linspace(*levels):
        for v in np.linspace(*ratios):
            p_O, p_F = center_pa * u, center_pa * u * v
            point = sampler(p_O, p_F)
            if point is not None:
                out.append({**point, "p_O": p_O, "p_F": p_F})
    return out


def _random(sampler: EngineSampler, center_pa: float, n: int, levels: Tuple[float, float],
            ratios: Tuple[float, float], seed: int) -> List[Dict[str, float]]:
    rng = np.random.default_rng(seed)
    out = []
    for u, v in zip(rng.uniform(*levels, n), rng.uniform(*ratios, n)):
        p_O, p_F = center_pa * u, center_pa * u * v
        point = sampler(p_O, p_F)
        if point is not None:
            out.append({**point, "p_O": p_O, "p_F": p_F})
    return out


from engine.layerx.fingerprint import config_fingerprint  # noqa: E402,F401 - one definition


def build_card(config: Any, *, center_pa: float, ambient_pa: float, holdout: int = 40, seed: int = 7) -> Any:
    """Sample, fit, check. Returns an :class:`~feedtwin.engine.card.EngineCard` whose ``fit``
    holds its measured errors (``envelope_*`` inside the operating envelope, ``box_*`` over the
    whole scan) and whose ``provenance`` says how it was made."""
    started = time.perf_counter()
    sampler = EngineSampler(config, ambient_pa)
    fast = sampler.fast
    levels = LEVELS if fast else (LEVELS[0], LEVELS[1], 11)
    ratios = RATIOS if fast else (RATIOS[0], RATIOS[1], 7)
    samples = _scan(sampler, center_pa, levels, ratios)
    if len(samples) < 12:
        raise ValueError(f"EngineDesign solved only {len(samples)} of the card's scan points; "
                         "the engine has no operating region around this T-0")
    cg = sampler.config.chamber_geometry
    name = f"{getattr(config, 'name', None) or 'engine'} @ {center_pa / PSI:.1f} psia line exit"
    card = fit_card(samples, throat_area=float(cg.A_throat), exit_area=float(cg.A_exit),
                    ambient_pa=ambient_pa, name=name)

    n_hold = holdout if fast else max(holdout // 4, 6)
    envelope = _random(sampler, center_pa, n_hold, ENVELOPE_LEVELS, ENVELOPE_RATIOS, seed)
    box = _random(sampler, center_pa, n_hold // 2, (levels[0], levels[1]), (ratios[0], ratios[1]), seed + 1)
    fit = {f"envelope_{k}": float(v) for k, v in check_card(card, envelope, ambient_pa).items()}
    fit.update({f"box_{k}": float(v) for k, v in check_card(card, box, ambient_pa).items()})
    worst = max(fit["envelope_closed_pc"], fit["envelope_closed_thrust"], fit["envelope_closed_mdot"],
                fit["envelope_chamber_pc"], fit["envelope_chamber_thrust"], fit["envelope_dp_O"],
                fit["envelope_dp_F"])
    fit["envelope_worst"] = worst
    fit["tolerance"] = TOLERANCE

    from dataclasses import replace

    provenance = {
        "tool": "EngineDesign",
        "config_sha256": config_fingerprint(config),
        "boundary": BOUNDARY,
        "sampler": sampler.kind,
        "samples": len(samples),
        "solves": sampler.calls,
        "center_psia": center_pa / PSI,
        "scan_levels": [levels[0], levels[1]],
        "scan_ratios": [ratios[0], ratios[1]],
        "envelope_levels": list(ENVELOPE_LEVELS),
        "envelope_ratios": list(ENVELOPE_RATIOS),
        "ambient_pa_sampled": ambient_pa,
        "built_s": time.perf_counter() - started,
        "built": time.time(),
        "within_tolerance": worst <= TOLERANCE,
    }
    return replace(card, provenance=provenance, fit=fit)


# ------------------------------------------------------------------ the nozzle following the throat


class _ExpansionScaling:
    """A card chamber whose vacuum exhaust velocity follows the eroding throat (audit D4-B, opt-in).

    Mixed into feedtwin's ``CardChamber`` as :data:`ExpansionCardChamber` (built on first use, so
    this module still imports without feedtwin, as the rest of it does).

    The card tabulates ``v_vac = (F + p_a A_e)/mdot`` at the as-built expansion ratio ``eps0``. When
    the throat opens (``throat_area`` set per step from the replay's schedule) and the exit does
    not, EngineDesign's nozzle runs at ``eps(t) = A_e/A_t(t) < eps0`` and its thrust is
    ``zeta_n Cf_vac(eps(t)) P0 A_t - p_a A_e`` (engine/core/nozzle.py). Its flow is
    ``mdot = P0 A_t / c*`` (chamber_solver.py), so ``v_vac = zeta_n Cf_vac c*``: at the same O/F and
    flow it scales with ``Cf_vac`` alone, and this chamber multiplies the card's ``v_vac`` by
    ``Cf_vac(O/F, Pc, eps(t)) / Cf_vac(O/F, Pc, eps0)`` from the CEA table EngineDesign uses
    (shifting equilibrium, NASA CEA via rocketcea: Gordon & McBride, NASA RP-1311, 1994;
    ``cf_vac`` is ``cea_cache.eval_cf_vac``). Without it the
    twin's thrust ran +0.5 % high at burnout against a fresh EngineDesign solve at the eroded
    geometry (audit D4, table "A. Keep").

    Chamber pressure and flows are the card's exactly: c* does not depend on the nozzle. At the
    as-built throat the result *is* :class:`CardChamber`'s, the same object, so a run that never
    applies a throat schedule is unchanged bit for bit.

    The ratio is read at the card's chamber pressure, where EngineDesign reads ``Cf_vac`` at the
    nozzle's stagnation pressure ``Pc/kappa``; ``Cf_vac`` moves ~1e-5 relative over that 0.4 %
    (LE4), far inside the card's fit. An ``eps`` outside the CEA table is clamped by the table and
    counted in ``eps_clamped``.
    """

    def __init__(self, card: Any, cf_vac: Callable[[float, float, float], float], *,
                 ambient_pressure: float = 101325.0, volume: float = 0.0) -> None:
        super().__init__(card, ambient_pressure=ambient_pressure, volume=volume)
        self.cf_vac = cf_vac
        self.eps0 = float(card.exit_area) / float(card.throat_area)
        self.eps_bounds: Optional[Tuple[float, float]] = None
        self.eps_clamped = 0
        #: Whether the CEA table has an expansion-ratio axis (set by :func:`expansion_chamber`).
        #: Without one a tabulated Cf_vac does not move with eps and the scale is 1: EngineDesign's
        #: own thrust, read from the same table, is then equally blind to the eroding throat.
        self.eps_axis: Optional[bool] = None

    def expansion_scale(self, mixture_ratio: float, pressure: float) -> float:
        """``Cf_vac(eps(t))/Cf_vac(eps0)`` at this O/F and pressure; exactly 1 at the as-built throat."""
        if self.throat_area == self.card.throat_area:
            return 1.0
        eps = float(self.card.exit_area) / float(self.throat_area)
        if self.eps_bounds is not None and not (self.eps_bounds[0] <= eps <= self.eps_bounds[1]):
            self.eps_clamped += 1
        return float(self.cf_vac(mixture_ratio, pressure, eps)) / float(self.cf_vac(mixture_ratio, pressure, self.eps0))

    def model_block(self) -> Dict[str, Any]:
        """The run record's description of this option (``{name, source, assumptions, inputs}``)."""
        return {
            "name": "card vacuum velocity scaled by Cf_vac(eps(t))/Cf_vac(eps0) (audit D4-B)",
            "source": ("EngineDesign thrust model (engine/core/nozzle.py: F = zeta_n Cf_vac P0 A_t - p_a A_e, "
                       "mdot = P0 A_t / c*) and its CEA table (shifting equilibrium; Gordon & McBride, "
                       "NASA RP-1311, 1994, via rocketcea)"),
            "assumptions": [
                "A_e fixed (the nozzle does not ablate); eps(t) = A_e / A_t(t) from the applied throat schedule",
                "zeta_n, c* and the card's fit unchanged by the throat: only the nozzle's expansion moves",
                "Cf_vac read at the card's chamber pressure, not P0 = Pc/kappa (~1e-5 relative on LE4)",
                "an eps outside the CEA table is clamped by the table (counted in eps_clamped)",
            ],
            "inputs": {
                "eps0": {"value": self.eps0, "unit": "", "provenance": "card exit_area / throat_area (as built)"},
                "cea_eps_axis": {"value": self.eps_axis, "unit": "",
                                 "provenance": "cea_cache.use_3d (a 2-D table holds Cf_vac at the design eps only)"},
                "eps_clamped": {"value": self.eps_clamped, "unit": "evaluations",
                                "provenance": "derived during the run"},
            },
        }

    def evaluate(self, mdot_oxidiser: float, mdot_fuel: float) -> Any:
        res = super().evaluate(mdot_oxidiser, mdot_fuel)
        firing = res.pressure > self.ambient_pressure * 1.001
        if not firing or res.mdot_total <= 0.0 or self.throat_area == self.card.throat_area:
            return res
        from dataclasses import replace

        total = res.mdot_total
        scale = self.expansion_scale(res.mixture_ratio, res.pressure)
        v_vac = self.card.chamber.vacuum_velocity(res.mixture_ratio, total) * scale
        thrust = max(total * v_vac - self.ambient_pressure * self.card.exit_area, 0.0)
        from feedtwin.engine.chamber import GRAVITY

        return replace(
            res,
            thrust=thrust,
            specific_impulse=thrust / (total * GRAVITY) if thrust > 0.0 else 0.0,
            combustion=replace(res.combustion, thrust_coefficient=thrust / (res.pressure * self.throat_area)),
        )


_EXPANSION_CLASS: Optional[type] = None


def expansion_chamber_class() -> type:
    """``ExpansionCardChamber``: :class:`_ExpansionScaling` over feedtwin's ``CardChamber``."""
    global _EXPANSION_CLASS
    if _EXPANSION_CLASS is None:
        from feedtwin.engine.card import CardChamber

        _EXPANSION_CLASS = type("ExpansionCardChamber", (_ExpansionScaling, CardChamber),
                                {"__doc__": _ExpansionScaling.__doc__, "__module__": __name__})
    return _EXPANSION_CLASS


def __getattr__(name: str) -> Any:  # PEP 562: ``from engine.layerx.card import ExpansionCardChamber``
    if name == "ExpansionCardChamber":
        return expansion_chamber_class()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def expansion_chamber(card: Any, cea_cache: Any, *, ambient_pressure: float, volume: float = 0.0) -> Any:
    """``ExpansionCardChamber`` on EngineDesign's CEA table (``cea_cache.eval_cf_vac``): the chamber
    to put in the twin in place of ``card.chamber_model(...)`` when the option is on."""
    ch = expansion_chamber_class()(card, cea_cache.eval_cf_vac, ambient_pressure=ambient_pressure, volume=volume)
    lo, hi = getattr(cea_cache, "eps_min", None), getattr(cea_cache, "eps_max", None)
    ch.eps_axis = bool(getattr(cea_cache, "use_3d", False))
    if lo is not None and hi is not None and ch.eps_axis:
        ch.eps_bounds = (float(lo), float(hi))
    return ch


# ------------------------------------------------------------------ a small cache

_CACHE: "OrderedDict[Tuple[str, float, float], Any]" = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_SIZE = 8


def card_for(config: Any, *, center_pa: float, ambient_pa: float) -> Any:
    """:func:`build_card`, remembered per (config, T-0, ambient). Preflight and the run that follows
    it share one card; a changed config is a different key, so a stale card is never served."""
    key = (config_fingerprint(config), round(center_pa, 1), round(ambient_pa, 1))
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    card = build_card(config, center_pa=center_pa, ambient_pa=ambient_pa)
    with _CACHE_LOCK:
        _CACHE[key] = card
        while len(_CACHE) > _CACHE_SIZE:
            _CACHE.popitem(last=False)
    return card


# ------------------------------------------------------------------ a card for another tool


def card_for_config_text(text: str, *, center_psia: Optional[float] = None) -> Dict[str, Any]:
    """The engine card for an engine config given as YAML text: what the feed-twin cockpit asks
    for when it imports an engine, so the stand fires the engine EngineDesign designed rather than
    feedtwin's own simplified one.

    Centred on the config's tank pressure (``lox_tank.initial_pressure_psi``) unless told
    otherwise; the scan then covers 40-130 % of it, which is every dome the cockpit's regulator
    can be set to. Sampled at the site's ambient (``environment.elevation``), as Layer X does.
    """
    import tempfile
    from pathlib import Path

    from engine.core.runner import compute_ambient_pressure_from_elevation
    from engine.pipeline.io import load_config

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "engine.yaml"
        path.write_text(text, encoding="utf-8")
        config = load_config(path)
    if center_psia is None:
        center_psia = float(getattr(config.lox_tank, "initial_pressure_psi", 0.0) or 0.0)
    if not center_psia or center_psia <= 0.0:
        raise ValueError("the config states no tank pressure (lox_tank.initial_pressure_psi) to centre the card on")
    elevation = float(getattr(getattr(config, "environment", None), "elevation", 0.0) or 0.0)
    ambient = compute_ambient_pressure_from_elevation(elevation) if elevation > 0 else 101325.0
    card = card_for(config, center_pa=center_psia * PSI, ambient_pa=ambient)
    return {
        "card": card.to_dict(),
        "config_sha256": config_fingerprint(config),
        "center_psia": center_psia,
        "ambient_pa": float(ambient),
        "within_tolerance": bool(card.provenance.get("within_tolerance", False)),
        "envelope_worst": float(card.fit.get("envelope_worst", float("nan"))),
    }

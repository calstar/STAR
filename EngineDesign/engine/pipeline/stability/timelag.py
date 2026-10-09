"""Conversion time lags for the chug loop — a registry of NAMED models.

The chug characteristic equation (``chug.py``) needs one number per propellant stream: the lag
between an injection-rate perturbation and the heat release it produces. That number is where the
propellant and the injector enter the stability problem, so it is the one place that must not
hardcode either.

Two models, both selectable through ``StabilityConfig.time_lag_model``:

``d2_law``
    The historical STAR model: ``tau = D32**2 / K_v`` with the Godsave/Spalding evaporation
    constant. This is the **quiescent** droplet lifetime — no convection, no atomization, no
    mixing — and it is reproduced here bit-for-bit so old results stay reproducible.

``leonardi_dtl``
    The double-time-lag decomposition of Leonardi, Nasuti, Di Matteo & Steelant, *"A methodology
    to study the possible occurrence of chugging in liquid rocket engines during transient
    start-up"*, Acta Astronautica 139 (2017) 344-356 [hereafter **L17**]:

        tau_tot = tau_atom + tau_vap + tau_mix                                        (L17 eq. 5)

    with a convection-corrected vaporization lag (eq. 8-9) and an atomization lag (eq. 6-7). The
    decisive structural point is **phase**: L17 §3.2 gives the gaseous propellant *only* the mixing
    lag, because a gas neither atomizes nor vaporizes. STAR's previous code ran the d^2-law on both
    streams unconditionally, which silently invents a droplet lifetime for a gas.

What is deliberately NOT implemented
------------------------------------
L17 eq. 10 (the initial droplet diameter ``D0``) is a correlation "specifically developed for
coaxial injectors and liquid oxygen". EngineDesign already solves a Sauter mean diameter with the
injector-appropriate model — Ingebo for impinging, Lefebvre for coaxial, the pintle sheet model for
pintle — so ``D0`` is taken from that solve. Adopting eq. 10 would hardcode *one* injector and *one*
oxidizer into a multi-injector, multi-propellant tool, which is precisely the coupling this module
exists to remove. (It is also not dimensionally closed as printed: the exponents 2.25 and -2.65 do
not cancel, so its units depend on ref. [24] and cannot be reconstructed from L17 alone.)

The convection correction (L17 eq. 8) is OFF by default — and why
-----------------------------------------------------------------
L17 eq. 8 divides the quiescent droplet lifetime by ``1 + 1.5*alpha``, ``alpha = 1 - 3e-3*pc[bar]``.
Applying it makes the model *worse* against the paper's own experiment, so it ships behind a named
switch set to ``"none"``. The evidence (``scripts/chug_timelag_benchmark.py``, benchmarks B and E,
on the GH2/LOX rig of L17 ref. [25]):

  * Eq. 9's evaporation constant in the QUIESCENT form, ``tau_vap = D0**2 / k``, gives 4.98 ms at
    L17's own reference point (D0 = 83 um, MR 5, 44.8 bar, 2038 K) against the experiment-derived
    4.4 ms — **+13 %**. Apply eq. 8 and it becomes 2.17 ms, **-51 %**.
  * End-to-end through ``chug.py``, quiescent eq. 9 predicts 53 Hz and a stability boundary at
    Delta_p_ox/pc = 0.30 against a measured 66 Hz and 0.35. With eq. 8 it is 104 Hz and 0.20.
  * Eq. 8 also disagrees with Ranz-Marshall in *trend*, not just magnitude: it depends on chamber
    pressure alone — no slip velocity, no drop size — and it FALLS as Pc rises, while the physical
    correction does not.

The coherent reading is that eq. 9's ``k`` was already calibrated against real chamber data (L17
routes its 4.4 ms through Priem-Heidmann's L50/v_inj), so it *contains* the convective enhancement
and eq. 8 double-counts it. That also reconciles L17's two otherwise-inconsistent statements about
the same working point. Both corrections remain available through ``CONVECTION_MODELS`` so the run
report can say which one produced the answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Optional, Tuple

import numpy as np

from engine.pipeline.stability import core

__all__ = [
    "StreamThermo",
    "ChamberThermo",
    "LagBreakdown",
    "atomization_lag",
    "vaporization_lag_leonardi",
    "evaporation_constant_leonardi",
    "convection_correction_leonardi",
    "ranz_marshall_correction",
    "CONVECTION_MODELS",
    "DEFAULT_CONVECTION_MODEL",
    "TIME_LAG_MODELS",
    "compute_lags",
    "resolve_mixing_lag",
    "MASS_HALF_LIFE_FRACTION",
]


#: Fraction of the d^2-law droplet lifetime at which HALF the droplet MASS has vaporized.
#: Closed form, not a fit: under d^2 = d0^2 (1 - t/tau_vap) the remaining mass fraction is
#: (1 - t/tau_vap)^{3/2}, so m/m0 = 1/2 at t/tau_vap = 1 - (1/2)^{2/3} = 0.3700.
#: This is what turns a vaporization lifetime into L17's L50 (the length to vaporize 50% of the
#: liquid), which is the abscissa of the Szuch mixing-lag curve (L17 fig. 1).
MASS_HALF_LIFE_FRACTION: float = float(1.0 - 0.5 ** (2.0 / 3.0))


# ---------------------------------------------------------------------------
# Parameter containers
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class StreamThermo:
    """One propellant stream at the injector face. All SI.

    ``phase`` is ``"liquid"`` or ``"gas"`` **at injection conditions** and decides which lags apply
    at all — it is not a cosmetic label. ``D0`` is the initial drop size from the injector's own
    spray model (SMD), ``d_orifice`` is L17's liquid post inner diameter ``D_l``, and ``u_inj`` is
    its injection velocity ``u_l``.
    """
    name: str
    phase: str
    rho_l: float = float("nan")
    mu_l: float = float("nan")
    sigma_l: float = float("nan")
    T_boil: float = float("nan")
    T_crit: float = float("nan")
    h_fg: float = float("nan")
    D0: float = float("nan")
    u_inj: float = float("nan")
    d_orifice: float = float("nan")

    @property
    def is_gas(self) -> bool:
        return str(self.phase).lower().startswith("g")


@dataclass(frozen=True)
class ChamberThermo:
    """Chamber gas state the lags are evaluated against. All SI except where noted."""
    Pc: float
    Tc: float
    MR: float
    rho_g: float
    u_g: float
    k_g: float
    cp_g: float

    @property
    def Pc_bar(self) -> float:
        return float(self.Pc / 1.0e5)


@dataclass(frozen=True)
class LagBreakdown:
    """Per-stream lag decomposition. ``tau_total`` is what the chug loop consumes as ``tau_conv``."""
    stream: str
    model: str
    phase: str
    convection: str
    tau_atom: float
    tau_vap: float
    tau_mix: float
    tau_total: float
    K_v: float = float("nan")
    notes: Tuple[str, ...] = field(default_factory=tuple)

    def as_dict(self) -> Dict[str, object]:
        return {
            "stream": self.stream, "model": self.model, "phase": self.phase,
            "convection": self.convection,
            "tau_atom_s": float(self.tau_atom), "tau_vap_s": float(self.tau_vap),
            "tau_mix_s": float(self.tau_mix), "tau_total_s": float(self.tau_total),
            "K_v": float(self.K_v), "notes": list(self.notes),
        }


# ---------------------------------------------------------------------------
# L17 correlations
# ---------------------------------------------------------------------------

def atomization_lag(st: StreamThermo, ch: ChamberThermo) -> float:
    """Atomization lag [s].  **L17 eq. 6-7** (after Boronine, Vollmer & Frey, ref. [23]):

        tau_atom = 6e-4 * (rho_g/rho_l)^-0.32 * We_g^0.03 * Re_l^0.55 * D_l/u_l
        Re_l     = u_l D_l rho_l / mu_l
        We_g     = 2 rho_g (u_g - u_l)^2 D_l / sigma_l

    Returns 0.0 for a gas stream (nothing to atomize) and NaN when an input is missing, so a caller
    that cannot supply injector geometry gets a recorded fallback rather than a fabricated lag.
    """
    if st.is_gas:
        return 0.0
    D_l, u_l = float(st.d_orifice), float(st.u_inj)
    if not (np.isfinite(D_l) and D_l > 0 and np.isfinite(u_l) and u_l > 0):
        return float("nan")
    if not (np.isfinite(st.rho_l) and st.rho_l > 0 and np.isfinite(ch.rho_g) and ch.rho_g > 0):
        return float("nan")
    if not (np.isfinite(st.mu_l) and st.mu_l > 0 and np.isfinite(st.sigma_l) and st.sigma_l > 0):
        return float("nan")
    Re_l = u_l * D_l * st.rho_l / st.mu_l
    We_g = 2.0 * ch.rho_g * (float(ch.u_g) - u_l) ** 2 * D_l / st.sigma_l
    # We_g -> 0 when the gas and the jet move together; We^0.03 is a very weak power, but 0**0.03
    # is 0 and would zero the lag outright, so the degenerate case falls back to the We-free form.
    we_term = float(We_g ** 0.03) if We_g > 0 else 1.0
    return float(6.0e-4 * (ch.rho_g / st.rho_l) ** (-0.32) * we_term * Re_l ** 0.55 * (D_l / u_l))


def evaporation_constant_leonardi(MR: float, T_inf: float, T_crit: float) -> float:
    """L17 eq. 9 evaporation constant ``k`` [m^2/s]:

        k = 1e-6 * [ 1.01/(1 + MR) + 1.16e-3 (T_inf - T_cr)^0.93 ]^0.86

    ``T_inf`` is the combustion-gas temperature [K] and ``T_cr`` the LIQUID critical temperature
    [K] — a propellant property, which is why it is a per-stream input here and not a constant.
    """
    if not (np.isfinite(MR) and MR > -1.0):
        return float("nan")
    if not (np.isfinite(T_inf) and np.isfinite(T_crit)):
        return float("nan")
    dT = float(T_inf) - float(T_crit)
    if dT <= 0.0:
        # Chamber colder than the liquid's critical point: the correlation's (T_inf - T_cr)^0.93
        # is undefined. Report NaN rather than clipping — a caller must record the substitution.
        return float("nan")
    inner = 1.01 / (1.0 + float(MR)) + 1.16e-3 * dT ** 0.93
    if inner <= 0.0:
        return float("nan")
    return float(1.0e-6 * inner ** 0.86)


def convection_correction_leonardi(Pc_bar: float) -> float:
    """L17 eq. 8 convective speed-up factor ``1 + 1.5*alpha`` with ``alpha = 1 - 3e-3*pc[bar]``.

    ``tau_vap = tau_vap(Re=0) / (1 + 1.5*alpha)`` — a droplet in a crossflow lives shorter than a
    quiescent one. Note the factor FALLS with chamber pressure (alpha -> 0 near 333 bar), i.e. the
    correlation says the convective enhancement washes out at high Pc. Floored at 1.0 so the
    correction can never *lengthen* the lag past the quiescent value.
    """
    if not np.isfinite(Pc_bar):
        return float("nan")
    alpha = 1.0 - 3.0e-3 * float(Pc_bar)
    return float(max(1.0, 1.0 + 1.5 * alpha))


def ranz_marshall_correction(Re_d: float, Pr: float = 0.7) -> float:
    """Textbook convective correction ``Nu/2 = 1 + 0.3 Re_d^0.5 Pr^(1/3)`` (Ranz-Marshall).

    Not used by any model — it is the independent yardstick the benchmark scores L17 eq. 8 against,
    so a disagreement shows up as a number instead of an assumption. ``Re_d`` is the droplet
    Reynolds number based on the slip velocity and the drop diameter.
    """
    if not (np.isfinite(Re_d) and Re_d >= 0 and np.isfinite(Pr) and Pr > 0):
        return float("nan")
    return float(1.0 + 0.3 * np.sqrt(Re_d) * Pr ** (1.0 / 3.0))


def _slip_reynolds(st: StreamThermo, ch: ChamberThermo, mu_g: float = 7.0e-5) -> float:
    """Droplet Reynolds number on the gas-droplet slip velocity. Used only by ``ranz_marshall``."""
    u_l = float(st.u_inj) if np.isfinite(st.u_inj) else 0.0
    slip = abs(float(ch.u_g) - u_l)
    if not (np.isfinite(slip) and slip > 0 and np.isfinite(st.D0) and st.D0 > 0):
        return float("nan")
    return float(ch.rho_g * slip * st.D0 / mu_g)


#: Named convective speed-up factors for the droplet lifetime: ``tau = tau_quiescent / factor``.
#: ``"none"`` is the default — see the module docstring for the benchmark that decided it.
CONVECTION_MODELS: Dict[str, Callable[[StreamThermo, ChamberThermo], float]] = {
    "none": lambda st, ch: 1.0,
    "leonardi_eq8": lambda st, ch: convection_correction_leonardi(ch.Pc_bar),
    "ranz_marshall": lambda st, ch: ranz_marshall_correction(_slip_reynolds(st, ch)),
}

#: Ships off. L17 eq. 9's evaporation constant already carries the convective enhancement
#: (benchmark B: quiescent +13 % vs the experiment-derived anchor, eq. 8-corrected -51 %).
DEFAULT_CONVECTION_MODEL = "none"


def vaporization_lag_leonardi(st: StreamThermo, ch: ChamberThermo,
                              *, convection: str = DEFAULT_CONVECTION_MODEL) -> float:
    """Vaporization lag [s] from **L17 eq. 9**'s evaporation constant: ``tau = D0**2 / k / factor``.

    ``convection`` names an entry of ``CONVECTION_MODELS``; the default ``"none"`` leaves the
    quiescent form, which is the variant that matches the experiment (module docstring). 0.0 for a
    gas stream.
    """
    if st.is_gas:
        return 0.0
    D0 = float(st.D0)
    if not (np.isfinite(D0) and D0 > 0):
        return float("nan")
    k = evaporation_constant_leonardi(ch.MR, ch.Tc, st.T_crit)
    if not (np.isfinite(k) and k > 0):
        return float("nan")
    fn = CONVECTION_MODELS.get(str(convection))
    if fn is None:
        raise ValueError(
            f"unknown convection model {convection!r}; known: {sorted(CONVECTION_MODELS)}"
        )
    corr = fn(st, ch)
    if not (np.isfinite(corr) and corr > 0):
        # A correction that cannot be evaluated must not silently become 1.0 — that would be a
        # different model wearing this one's name. Report NaN and let the caller record it.
        return float("nan")
    return float((D0 * D0 / k) / corr)


def vaporization_lag_d2(st: StreamThermo, ch: ChamberThermo) -> Tuple[float, float]:
    """Quiescent d^2-law lag [s] and its evaporation constant K_v — STAR's historical model.

    Exactly ``core.lags_from_smd(..., chi=1.0)``: same call, same arguments, same order, so the
    ``d2_law`` branch is bit-for-bit what the code did before this module existed.
    """
    if st.is_gas:
        return 0.0, float("nan")
    tau_vap, _, K_v = core.lags_from_smd(
        st.D0, k_g=ch.k_g, rho_l=st.rho_l, cp_g=ch.cp_g, T_inf=ch.Tc,
        T_boil=st.T_boil, h_fg=st.h_fg, chi=1.0,
    )
    return float(tau_vap), float(K_v)


# ---------------------------------------------------------------------------
# Mixing lag (shared by every stream — it is a chamber property, not a stream property)
# ---------------------------------------------------------------------------

def resolve_mixing_lag(tau_vap_liquid: float, mix_fraction: float) -> float:
    """Mixing lag [s] shared by all streams, as a fraction of the rate-limiting vaporization lag.

    **Why a fraction and not L17 fig. 1.** The paper reads tau_mix off Szuch's empirical curve of
    mixing time versus L50 (the length to vaporize 50% of the liquid, NASA TN-D-7026). That curve is
    a figure, not a table, and is not reproduced here; digitizing it by eye would be inventing a
    correlation. What L17 *does* state numerically is its own calibration point — tau_vap = 4.4 ms
    and tau_mix = 2.2 ms for the validation engine (L17 §3.1), i.e. a ratio of 0.5 — and L50 is
    itself proportional to tau_vap at fixed droplet speed (``MASS_HALF_LIFE_FRACTION``), so a
    constant of proportionality is the faithful reduction of the curve to one number.

    The default 0.5 therefore carries the paper's provenance, and the caller records it through the
    assumptions registry. Swap in a digitized curve by replacing this function, not by tuning 0.5.
    """
    if not (np.isfinite(tau_vap_liquid) and tau_vap_liquid >= 0):
        return float("nan")
    if not (np.isfinite(mix_fraction) and mix_fraction >= 0):
        return float("nan")
    return float(mix_fraction * tau_vap_liquid)


# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

_ModelResult = Tuple[float, float, float, float, Tuple[str, ...]]


def _model_d2_law(st: StreamThermo, ch: ChamberThermo, convection: str) -> _ModelResult:
    """-> (tau_atom, tau_vap, K_v, tau_mix_basis, notes). tau_mix is applied by ``compute_lags``.

    ``convection`` is accepted and ignored: the d^2-law is the historical model and is reproduced
    unchanged, corrections included (there were none).
    """
    tau_vap, K_v = vaporization_lag_d2(st, ch)
    notes: Tuple[str, ...] = ()
    if st.is_gas:
        notes = ("gas at injection: no atomization or vaporization lag",)
    return 0.0, tau_vap, K_v, tau_vap, notes


def _model_leonardi(st: StreamThermo, ch: ChamberThermo, convection: str) -> _ModelResult:
    notes_l = []
    if st.is_gas:
        # Belt and braces: both primitives below already return 0.0 for a gas, so deleting this
        # early return changes no number today (a mutation test confirms it). It stays because it
        # is where L17 §3.2's rule is legible -- but do not remove it on the grounds that it is
        # redundant without re-checking that BOTH primitives still guard the gas case themselves.
        notes_l.append("gas at injection: no atomization or vaporization lag (L17 §3.2)")
        return 0.0, 0.0, float("nan"), 0.0, tuple(notes_l)
    tau_atom = atomization_lag(st, ch)
    if not np.isfinite(tau_atom):
        notes_l.append("atomization lag unavailable (injector jet diameter/velocity missing)")
    tau_vap = vaporization_lag_leonardi(st, ch, convection=convection)
    K_v = float("nan")
    if not np.isfinite(tau_vap):
        notes_l.append(
            "L17 eq. 9 unavailable (needs the liquid critical temperature and Tc > T_crit); "
            "fell back to the d^2-law for this stream"
        )
        tau_vap, K_v = vaporization_lag_d2(st, ch)
    elif convection != "none":
        notes_l.append(f"convective speed-up applied: {convection}")
    return tau_atom, tau_vap, K_v, tau_vap, tuple(notes_l)


#: name -> callable. Keep the keys stable: they are written into config files and report payloads.
TIME_LAG_MODELS: Dict[str, Callable[[StreamThermo, ChamberThermo, str], _ModelResult]] = {
    "d2_law": _model_d2_law,
    "leonardi_dtl": _model_leonardi,
}


def compute_lags(
    streams: Dict[str, StreamThermo],
    ch: ChamberThermo,
    *,
    model: str = "d2_law",
    mix_fraction: float = 0.0,
    convection: str = DEFAULT_CONVECTION_MODEL,
    on_fallback: Optional[Callable[[str, float, str, str], float]] = None,
) -> Dict[str, LagBreakdown]:
    """Lag breakdown for every stream under one named model.

    ``mix_fraction`` scales the shared mixing lag off the SLOWEST liquid stream's vaporization lag
    (the rate-limiting one — L17 assigns the same tau_mix to both propellants). Pass 0.0 to disable
    it, which is what ``d2_law`` does by default so it reproduces the historical numbers exactly.

    ``on_fallback(name, value, unit, reason) -> value`` is the assumptions hook; the integration
    layer passes ``assumptions.assume`` so nothing is substituted silently. Defaults to identity for
    pure-numeric use (tests, the benchmark script).
    """
    fb = on_fallback if on_fallback is not None else (lambda name, value, unit, reason: value)
    fn = TIME_LAG_MODELS.get(str(model))
    if fn is None:
        raise ValueError(
            f"unknown time_lag_model {model!r}; known models: {sorted(TIME_LAG_MODELS)}"
        )

    if str(convection) not in CONVECTION_MODELS:
        raise ValueError(
            f"unknown convection model {convection!r}; known: {sorted(CONVECTION_MODELS)}"
        )
    raw = {key: fn(st, ch, str(convection)) for key, st in streams.items()}

    # Mixing lag: one number for the whole chamber, scaled off the slowest LIQUID stream.
    liquid_taus = [
        r[3] for key, r in raw.items()
        if not streams[key].is_gas and np.isfinite(r[3]) and r[3] > 0
    ]
    if mix_fraction > 0.0 and liquid_taus:
        tau_mix = resolve_mixing_lag(max(liquid_taus), mix_fraction)
    else:
        tau_mix = 0.0

    out: Dict[str, LagBreakdown] = {}
    for key, st in streams.items():
        tau_atom, tau_vap, K_v, _, notes = raw[key]
        ta = tau_atom if np.isfinite(tau_atom) else fb(
            f"stability.tau_atom_{key}", 0.0, "s",
            f"{model}: atomization lag for the {key} stream needs the injector jet diameter and "
            f"injection velocity; neither reached the stability layer",
        )
        tv = tau_vap
        if not np.isfinite(tv):
            tv = fb(
                f"stability.tau_vap_{key}", 2.0e-3, "s",
                f"{model}: vaporization lag non-finite for {st.name or key} "
                f"(check T_boil < Tc, h_fg > 0, and a positive SMD)",
            )
        tm = tau_mix if np.isfinite(tau_mix) else 0.0
        out[key] = LagBreakdown(
            stream=key, model=str(model), phase=str(st.phase), convection=str(convection),
            tau_atom=float(ta), tau_vap=float(tv), tau_mix=float(tm),
            tau_total=float(ta + tv + tm), K_v=float(K_v), notes=notes,
        )
    return out

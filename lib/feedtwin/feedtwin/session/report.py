"""What the engine did over a burn, from the steps that burned.

One summary for every caller that fires an engine through a feed system: the
cockpit finds its burns in the session's history; a burn recorded as columns
(:class:`~feedtwin.session.burn.BurnTrace`) goes through :func:`summarise`.
Layer X keeps its own summary, and its impulse, mean thrust, O/F and Isp are
held to this arithmetic by ``EngineDesign/tests/test_layerx_cockpit_parity.py``,
so a disagreement between the tools is physics, not bookkeeping.

The rules
---------
* **A step burns** when both propellants reach the chamber, each above
  :data:`~feedtwin.session.core.MIN_CHAMBER_FLOW`. A burn is a run of burning
  steps; one quiet step ends it. One propellant alone is not a burn: when the
  LOX runs out first the fuel keeps flowing for a step or two, and the
  chamber model, clamped at the edge of its combustion table, still reports
  thrust for it (~2 kN on LE4). Nothing is burning, and none of it is counted.
* **Totals are right-endpoint sums**: each burning sample carries the step that
  ended at it, ``F_k (t_k - t_{k-1})``, where ``t_{k-1}`` is the sample before
  it even when that one did not burn. That is how :func:`feedtwin.session.burn.burn`
  steps, so the first step after Fire counts once, at its own thrust, and a
  burn read from the cockpit's history totals exactly what Layer X totals from
  the same steps.
* **Mean O/F is the mass ratio** of what was burned (ox kg over fuel kg), not
  the mean of the instantaneous ratios. **Isp is delivered**: impulse over the
  weight of the propellant burned.
* **Full flow** is the part of the burn whose total mass flow is at least
  :data:`FULL_FLOW_FRACTION` of the burn's median. The start (valves still
  travelling) and the tail-off are outside it. The minima a design rule is
  judged on -- thrust, chamber pressure, injector stiffness -- are read there,
  because a valve half open has no stiffness to speak of and that is not a
  finding about the injector.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Mapping, Sequence

from feedtwin.engine.chamber import GRAVITY
from feedtwin.session.core import MIN_CHAMBER_FLOW, Sample

#: Fraction of the burn's median mass flow above which a step is at full flow.
FULL_FLOW_FRACTION = 0.8


@dataclass(frozen=True, slots=True)
class BurnReport:
    """One burn, totalled. Absolute SI throughout."""

    start_s: float
    """Clock at the start of the first burning step [s]."""
    end_s: float
    """Clock at the last burning sample [s]."""
    burning: bool
    """The last sample given still burned: the burn is not over."""
    steps: int
    impulse_Ns: float
    thrust_mean_N: float
    """Impulse over duration."""
    thrust_peak_N: float
    thrust_min_N: float
    """Lowest thrust at full flow."""
    pc_mean_Pa: float
    """Time-weighted mean chamber pressure."""
    pc_min_Pa: float
    """Lowest chamber pressure at full flow."""
    pc_max_Pa: float
    of_mean: float
    """Oxidiser burned over fuel burned."""
    of_min: float
    """Over full flow."""
    of_max: float
    isp_s: float
    """Delivered: impulse over the weight of propellant burned."""
    cstar_mps: float
    """Mass-weighted mean of the chamber's ``c*``."""
    oxidiser_kg: float
    fuel_kg: float
    stiffness_oxidiser_min: float
    """Lowest ``dp_injector / p_c`` on the oxidiser side at full flow, the
    drop measured from the injector inlet; 0 when :func:`burns` was given no
    inlet and the steps carried no mixture balance."""
    stiffness_fuel_min: float
    extrapolated_steps: int
    """Steps whose combustion point was clamped at the edge of its table."""

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s

    @property
    def propellant_kg(self) -> float:
        return self.oxidiser_kg + self.fuel_kg


def summarise(
    t: Sequence[float],
    thrust: Sequence[float],
    pressure: Sequence[float],
    mdot_oxidiser: Sequence[float],
    mdot_fuel: Sequence[float],
    *,
    before: float,
    cstar: Sequence[float] | None = None,
    stiffness_oxidiser: Sequence[float] | None = None,
    stiffness_fuel: Sequence[float] | None = None,
    extrapolated: Sequence[bool] | None = None,
    burning: bool = False,
) -> BurnReport:
    """Total one burn given as columns over its burning samples.

    ``before`` is the clock of the sample preceding the first one: where the
    first burning step began.
    """
    n = len(t)
    if n == 0:
        raise ValueError("a burn needs at least one burning sample")
    dt = [t[0] - before] + [t[k] - t[k - 1] for k in range(1, n)]
    duration = t[-1] - before
    impulse = sum(f * d for f, d in zip(thrust, dt))
    ox = sum(m * d for m, d in zip(mdot_oxidiser, dt))
    fu = sum(m * d for m, d in zip(mdot_fuel, dt))
    total = [o + f for o, f in zip(mdot_oxidiser, mdot_fuel)]
    burned = ox + fu

    median = sorted(total)[n // 2]
    full = [k for k in range(n) if total[k] >= FULL_FLOW_FRACTION * median] or list(
        range(n)
    )

    def lowest(values: Sequence[float] | None) -> float:
        if values is None:
            return 0.0
        return min(values[k] for k in full)

    ratios = [mdot_oxidiser[k] / mdot_fuel[k] for k in full if mdot_fuel[k] > 0.0]
    return BurnReport(
        start_s=before,
        end_s=t[-1],
        burning=burning,
        steps=n,
        impulse_Ns=impulse,
        thrust_mean_N=impulse / duration if duration > 0.0 else 0.0,
        thrust_peak_N=max(thrust),
        thrust_min_N=lowest(thrust),
        pc_mean_Pa=(
            sum(p * d for p, d in zip(pressure, dt)) / duration
            if duration > 0.0
            else pressure[0]
        ),
        pc_min_Pa=lowest(pressure),
        pc_max_Pa=max(pressure),
        of_mean=ox / fu if fu > 0.0 else 0.0,
        of_min=min(ratios) if ratios else 0.0,
        of_max=max(ratios) if ratios else 0.0,
        isp_s=impulse / (GRAVITY * burned) if burned > 0.0 else 0.0,
        cstar_mps=(
            sum(c * m * d for c, m, d in zip(cstar, total, dt)) / burned
            if cstar is not None and burned > 0.0
            else 0.0
        ),
        oxidiser_kg=ox,
        fuel_kg=fu,
        stiffness_oxidiser_min=lowest(stiffness_oxidiser),
        stiffness_fuel_min=lowest(stiffness_fuel),
        extrapolated_steps=sum(1 for e in extrapolated or () if e),
    )


def is_burning(sample: Sample) -> bool:
    chamber = sample.chamber
    return (
        chamber is not None
        and chamber.mdot_oxidiser > MIN_CHAMBER_FLOW
        and chamber.mdot_fuel > MIN_CHAMBER_FLOW
    )


def burns(
    samples: Sequence[Sample], inlets: Mapping[str, str] | None = None
) -> list[BurnReport]:
    """Every burn in ``samples``, oldest first.

    ``inlets`` maps ``oxidiser``/``fuel`` to the injector inlet node
    (:attr:`feedtwin.session.burn.Probes.injector_inlet`). With it, stiffness
    is the drop from that node to the chamber over chamber pressure -- the
    line exit to the chamber, which is the whole of what an engine card owns.
    Without it, a sample's mixture balance is used when it carries one.

    A burn whose first step is the first sample given has no sample before it
    to start from; it is timed from that sample's own clock less the next
    step, which is right when the steps are even and is said by
    :attr:`BurnReport.start_s` either way.
    """
    out: list[BurnReport] = []
    k = 0
    n = len(samples)
    while k < n:
        if not is_burning(samples[k]):
            k += 1
            continue
        first = k
        while k < n and is_burning(samples[k]):
            k += 1
        run = samples[first:k]
        if first > 0:
            before = samples[first - 1].t
        elif len(run) > 1:
            before = run[0].t - (run[1].t - run[0].t)
        else:
            before = run[0].t
        out.append(_summarise_samples(run, before, inlets or {}, burning=k == n))
    return out


def _summarise_samples(
    run: Sequence[Sample],
    before: float,
    inlets: Mapping[str, str],
    *,
    burning: bool,
) -> BurnReport:
    chambers = [s.chamber for s in run]
    assert all(c is not None for c in chambers)

    def stiffness(side: str) -> list[float] | None:
        node = inlets.get(side)
        if node and all(node in s.pressures for s in run):
            return [
                (s.pressures[node] - c.pressure) / c.pressure  # type: ignore[union-attr]
                for s, c in zip(run, chambers)
            ]
        out: list[float] = []
        for s in run:
            balance = s.balance
            if balance is None:
                return None
            leg = getattr(balance, side)
            out.append(leg.stiffness(balance.chamber_pressure))
        return out

    return summarise(
        [s.t for s in run],
        [c.thrust for c in chambers],  # type: ignore[union-attr]
        [c.pressure for c in chambers],  # type: ignore[union-attr]
        [c.mdot_oxidiser for c in chambers],  # type: ignore[union-attr]
        [c.mdot_fuel for c in chambers],  # type: ignore[union-attr]
        before=before,
        cstar=[c.combustion.cstar for c in chambers],  # type: ignore[union-attr]
        stiffness_oxidiser=stiffness("oxidiser"),
        stiffness_fuel=stiffness("fuel"),
        extrapolated=[bool(c.combustion.extrapolated) for c in chambers],  # type: ignore[union-attr]
        burning=burning,
    )


def finite(value: float) -> float:
    """``value``, or 0 where it is not a number (a wire format has no NaN)."""
    return value if math.isfinite(value) else 0.0

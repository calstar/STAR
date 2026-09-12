"""
Streaming noise filters for the live sensor trace, plus a way to rank them.

Aimed at the load-cell-as-a-scale case: a slowly varying load (a bucket filling
over a few seconds) buried in ADC and mains noise. Two things matter and they
pull against each other:

  * NOISE  - the spread of the reading when the load is static.
  * LAG    - the filter's group delay. Against a *ramp* (which is what filling
             a bucket is) a delay of tau seconds makes the reading trail the
             true weight by slope * tau for the whole fill. A filter that looks
             beautifully smooth but lags 2 s will read low by 2 s' worth of
             water the entire time you are pouring.

So :func:`compare` reports both, plus the ramp error each filter would cause at
a given fill rate, and lets you pick the trade-off rather than guessing.

A note on mains hum: 50/60 Hz pickup is the classic load-cell noise source. A
moving average whose window is exactly one mains period (or a multiple) puts a
null right on the interference and its harmonics, which usually beats a
general-purpose low-pass of similar lag. :func:`mains_window` sizes that for
you from the measured sample rate.

Moving averages only — a boxcar is the best noise-per-unit-lag linear option
here and it is the one whose nulls can be parked on mains hum. Pure stdlib plus
the GUI's existing numpy, so this stays dependency-free.

Run ``python -m boardgui.filters`` for the self-test.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, List, Optional, Sequence


class Filter:
    """Streaming scalar filter: feed samples in order, get filtered values out."""

    label = "filter"

    def reset(self) -> None:
        raise NotImplementedError

    def update(self, x: float) -> float:
        raise NotImplementedError


class NoFilter(Filter):
    label = "none (raw)"

    def reset(self) -> None:
        pass

    def update(self, x: float) -> float:
        return x


class MovingAverage(Filter):
    """Boxcar average of the last n samples.

    Best noise reduction per unit of lag among the linear options here
    (sqrt(n) improvement for (n-1)/2 samples of delay), and its frequency nulls
    can be parked on mains hum — see :func:`mains_window`.
    """

    def __init__(self, n: int):
        self.n = max(1, int(n))
        self.label = f"moving average n={self.n}"
        self.reset()

    def reset(self) -> None:
        self._buf: Deque[float] = deque(maxlen=self.n)
        self._sum = 0.0

    def update(self, x: float) -> float:
        if len(self._buf) == self.n:
            self._sum -= self._buf[0]
        self._buf.append(x)
        self._sum += x
        return self._sum / len(self._buf)


# -----------------------------------------------------------------------------
def mains_window(fs_hz: float, mains_hz: float = 60.0,
                 max_periods: int = 8, tol: float = 0.02) -> int:
    """Moving-average length whose nulls land on the mains frequency.

    A boxcar of N samples has zeros at multiples of fs/N, so N = fs/mains puts a
    zero on mains_hz and every harmonic — the cheapest possible hum rejection.

    The catch is that fs/mains is rarely an integer (at 100 Hz against 60 Hz it
    is 1.67, and rounding to 2 nulls 50 Hz instead — worse than useless in a
    60 Hz country). So this searches whole numbers of mains PERIODS and takes
    the first that lands close enough to an integer sample count; three periods
    at 100 Hz gives exactly 5 samples. Returns 0 if nothing within max_periods
    fits, meaning "no good mains-null length at this rate" — the caller should
    then omit the option rather than offer a misleading one.
    """
    best = 0
    for periods in range(1, max_periods + 1):
        exact = periods * fs_hz / mains_hz
        if abs(exact - round(exact)) / exact <= tol:
            best = max(1, int(round(exact)))
            break
    return best


def allan_deviation(samples: Sequence[float], dt: float,
                    max_points: int = 24) -> List[tuple]:
    """Overlapping Allan deviation sigma(tau) versus averaging time tau.

    This is the tool for the question "how long should I average?", and it is
    the right one when the signal is drifting rather than just noisy:

      * white noise      -> sigma falls as 1/sqrt(tau)   (slope -1/2)
      * flicker / 1/f    -> sigma flattens               (slope  0)
      * random walk      -> sigma RISES as sqrt(tau)     (slope +1/2)

    So the curve has a minimum. Left of it you are still averaging away white
    noise and longer is better; right of it drift dominates and averaging
    longer actively makes the reading worse while also costing lag. The minimum
    is the best averaging time this sensor can support, and its sigma is the
    floor no causal filter can beat.

    Returns [(tau_seconds, sigma), ...] over log-spaced averaging lengths.
    """
    import numpy as np

    x = np.asarray(samples, dtype=float)
    n = x.size
    if n < 32:
        return []
    # Detrend first: a genuine ramp in the window is signal, not instability,
    # and would otherwise swamp the long-tau end of the curve.
    t = np.arange(n, dtype=float)
    a, b = np.polyfit(t, x, 1)
    x = x - (a * t + b)

    cumsum = np.concatenate(([0.0], np.cumsum(x)))
    out: List[tuple] = []
    max_m = max(2, n // 4)
    ms = np.unique(np.round(np.logspace(0, math.log10(max_m), max_points)).astype(int))
    for m in ms:
        if m < 1 or 2 * m >= n:
            continue
        # Overlapping averages of length m, then the Allan sum of successive
        # differences: sigma^2 = mean((ybar[i+m] - ybar[i])^2) / 2
        ybar = (cumsum[m:] - cumsum[:-m]) / m
        d = ybar[m:] - ybar[:-m]
        if d.size < 2:
            continue
        out.append((m * dt, float(math.sqrt(np.mean(d * d) / 2.0))))
    return out


def optimal_averaging(curve: Sequence[tuple]) -> Optional[tuple]:
    """(tau, sigma) at the Allan minimum — the best averaging time available."""
    return min(curve, key=lambda p: p[1]) if curve else None


def drift_slope(curve: Sequence[tuple]) -> Optional[float]:
    """Log-log slope of the LONG-tau half of the Allan curve.

    Around -0.5 means white noise still dominates (average longer). Around 0
    is flicker. Approaching +0.5 means random walk: averaging longer is
    counter-productive and the fix has to come from the sensor or the wiring,
    not the filter.
    """
    import numpy as np

    if len(curve) < 6:
        return None
    half = curve[len(curve) // 2:]
    lt = np.log10([p[0] for p in half])
    ls = np.log10([max(p[1], 1e-30) for p in half])
    return float(np.polyfit(lt, ls, 1)[0])


@dataclass
class FilterReport:
    label: str
    noise: float           # sigma of the filtered output, data units
    noise_reduction: float  # raw sigma / filtered sigma (higher is better)
    lag_s: float           # group delay, seconds (50% point of a step)
    ramp_error: float      # reading error during a steady ramp = slope * lag


def ramp_lag_samples(make: Callable[[], Filter], n: int = 4000) -> float:
    """Delay in samples, measured as the steady-state offset under a ramp.

    This is the DC group delay, and it is the number that matters here: while
    the bucket fills at a steady rate, a filter with lag tau reads low by
    slope * tau for the whole pour. Feeding a unit-slope ramp makes that offset
    read out directly as the lag.

    Measured rather than derived so any filter is characterised the same way;
    for a boxcar of n samples it comes out at (n-1)/2, as it should.

    Note this is NOT the 50% step-response point — for a filter with a tail the
    two differ, and it is the DC group delay that sets the ramp error.
    """
    f = make()
    acc = 0.0
    tail = 200
    for i in range(n):
        y = f.update(float(i))
        if i >= n - tail:
            acc += i - y
    return max(0.0, acc / tail)


def compare(samples: Sequence[float], dt: float,
            factories: Sequence[Callable[[], Filter]],
            ramp_rate: float = 0.0) -> List[FilterReport]:
    """Rank filters on real data.

    samples    recent readings, evenly spaced (data units)
    dt         sample interval in seconds
    ramp_rate  expected signal slope in data units/second (e.g. how fast the
               reading climbs while pouring). Used to price each filter's lag
               as a reading error; pass 0 to ignore.

    Noise is measured on the *detrended* signal so a genuine ramp in the sample
    window is not counted as noise.
    """
    import numpy as np

    x = np.asarray(samples, dtype=float)
    if x.size < 8:
        return []
    # Remove any real trend before measuring noise, else a filter that tracks
    # the ramp well is unfairly penalised.
    t = np.arange(x.size, dtype=float)
    slope, intercept = np.polyfit(t, x, 1)
    raw_sigma = float(np.std(x - (slope * t + intercept)))

    def measure(make):
        """sigma of one filter's output, detrended, past its start-up."""
        f = make()
        y = np.fromiter((f.update(v) for v in x), dtype=float, count=x.size)
        warm = min(x.size // 4, max(8, int(ramp_lag_samples(make) * 3)))
        seg = y[warm:]
        if seg.size < 8:
            return None
        tt = np.arange(seg.size, dtype=float)
        a, b = np.polyfit(tt, seg, 1)
        return float(np.std(seg - (a * tt + b)))

    # Reference the reduction against an UNFILTERED pass through the identical
    # warm-up/detrend path, so "none (raw)" reads exactly 1.0x instead of
    # drifting from the whole-array sigma.
    ref = measure(lambda: NoFilter()) or raw_sigma

    reports: List[FilterReport] = []
    for make in factories:
        sigma = measure(make)
        if sigma is None:
            continue
        lag = ramp_lag_samples(make) * dt
        reports.append(FilterReport(
            label=make().label,
            noise=sigma,
            noise_reduction=(ref / sigma) if sigma > 0 else float("inf"),
            lag_s=lag,
            ramp_error=abs(ramp_rate) * lag,
        ))
    reports.sort(key=lambda r: -r.noise_reduction)
    return reports


def suggest(reports: Sequence[FilterReport], slack: float = 1.5
            ) -> Optional[FilterReport]:
    """Pick the shortest-lag filter that is still within `slack` of the best.

    Maximum smoothing is rarely the right answer: past a point you are buying
    tiny noise gains with lag that shows up directly as ramp error. This takes
    the best noise figure, allows `slack` times that much noise, and returns
    the fastest filter meeting it.
    """
    if not reports:
        return None
    best_noise = min(r.noise for r in reports)
    ok = [r for r in reports if r.noise <= best_noise * slack]
    return min(ok, key=lambda r: r.lag_s) if ok else reports[0]


def default_bank(fs_hz: float, mains_hz: float = 60.0
                 ) -> List[Callable[[], Filter]]:
    """A spread of candidates sized for the measured sample rate.

    Spans roughly 0.05 s to 1 s of averaging so the noise-vs-lag trade-off is
    visible across the range that suits a slow fill.
    """
    n_mains = mains_window(fs_hz, mains_hz)
    quarter = max(1, int(fs_hz * 0.25))
    half = max(1, int(fs_hz * 0.5))
    one = max(1, int(fs_hz * 1.0))
    bank: List[Callable[[], Filter]] = [lambda: NoFilter()]
    if n_mains > 1:
        bank.append(lambda: MovingAverage(n_mains))
    return bank + [
        lambda: MovingAverage(quarter),
        lambda: MovingAverage(half),
        lambda: MovingAverage(one),
    ]


# -----------------------------------------------------------------------------
def _self_test() -> None:
    import numpy as np
    rng = np.random.default_rng(7)
    fs = 100.0

    # -- a boxcar reduces white noise by sqrt(n) ------------------------------
    noise = rng.normal(0, 1.0, 40000)
    for n in (4, 16, 64):
        f = MovingAverage(n)
        out = np.fromiter((f.update(v) for v in noise), float, noise.size)[n * 4:]
        got, want = np.std(out), 1.0 / math.sqrt(n)
        assert abs(got - want) / want < 0.06, (n, got, want)

    # -- measured ramp lag matches theory exactly ----------------------------
    for n in (5, 21, 101):                       # boxcar: (n-1)/2
        got = ramp_lag_samples(lambda n=n: MovingAverage(n))
        assert abs(got - (n - 1) / 2) < 0.01, (n, got)

    # -- mains window nulls hum ----------------------------------------------
    n = mains_window(fs, 50.0)           # 100 Hz / 50 Hz -> 2 samples exactly
    assert n == 2, n
    n60 = mains_window(100.0, 60.0)      # 1.67 is no good; 3 periods -> 5
    assert n60 == 5, n60
    t60 = np.arange(4000) / 100.0
    f60 = MovingAverage(n60)
    out60 = np.fromiter((f60.update(v) for v in np.sin(2*math.pi*60*t60)),
                        float, t60.size)[10:]
    assert np.std(out60) < 0.02, f"3-period boxcar failed to null 60 Hz: {np.std(out60)}"
    assert mains_window(37.0, 60.0, max_periods=2) == 0, "should report no good length"
    t = np.arange(4000) / fs
    hum = np.sin(2 * math.pi * 50.0 * t)
    f = MovingAverage(n)
    out = np.fromiter((f.update(v) for v in hum), float, hum.size)[10:]
    assert np.std(out) < 0.02, f"mains-sized boxcar failed to null hum: {np.std(out)}"

    # -- compare() ranks on real-ish data and prices the lag -----------------
    sig = 0.5 * t                        # a 0.5 unit/s ramp, like a fill
    data = sig + rng.normal(0, 0.05, t.size)
    reps = compare(data, 1 / fs, default_bank(fs), ramp_rate=0.5)
    assert reps[0].noise_reduction > reps[-1].noise_reduction
    raw = [r for r in reps if r.label.startswith("none")][0]
    assert abs(raw.noise_reduction - 1.0) < 1e-9, raw   # exact by construction
    assert suggest(reps) is not None
    assert raw.lag_s == 0.0
    for r in reps:
        assert r.ramp_error == abs(0.5) * r.lag_s

    # -- Allan deviation distinguishes white noise from a random walk -------
    white = rng.normal(0, 1.0, 20000)
    cw = allan_deviation(white, 1 / fs)
    assert cw, "no allan curve"
    sw = drift_slope(cw)
    assert -0.62 < sw < -0.38, f"white noise should slope ~-0.5, got {sw}"

    walk = np.cumsum(rng.normal(0, 1.0, 20000))
    cr = allan_deviation(walk, 1 / fs)
    sr = drift_slope(cr)
    assert sr > 0.3, f"random walk should slope ~+0.5, got {sr}"

    # a walk plus white noise has a real minimum in between
    mixed = np.cumsum(rng.normal(0, 0.02, 20000)) + rng.normal(0, 1.0, 20000)
    cm = allan_deviation(mixed, 1 / fs)
    tau_opt, sig_opt = optimal_averaging(cm)
    assert cm[0][1] > sig_opt < cm[-1][1], "expected an interior Allan minimum"
    assert 0.01 < tau_opt < 100.0, tau_opt

    print("filters self-test: OK (boxcar sqrt(n), measured lag, mains null, "
          "compare ranking, Allan slopes)")


if __name__ == "__main__":
    _self_test()

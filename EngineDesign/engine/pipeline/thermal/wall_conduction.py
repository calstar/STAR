"""One-dimensional transient conduction through a layered wall with a receding hot face.

Backward Euler on a graded grid (fine at the hot face), layer interfaces on nodes, back face
adiabatic -- the conservative bound when the backing is not declared. The hot-face flux is a
function of the surface temperature, closed exactly each step: the interior is linear in the
surface temperature, so the surface balance is a scalar root.

Two recession modes:
  * ablating (liner): the surface cannot exceed ``T_ablation``; once it gets there the flux
    it cannot conduct away consumes material at ``H_surface`` J/kg (Landau problem);
  * chemical (graphite): recession is the carbon mass flux the surface chemistry returns at
    the solved surface temperature, not an energy balance.

A receding face is handled by remapping the profile onto the shortened wall each step.

A layer may carry ``cp_of(T)``: its heat capacity is then taken at each cell's temperature at the
start of every step (lagged one step, as backward Euler does with a property). Without it the
wall is exactly the constant-property model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple

import numpy as np
from scipy.optimize import brentq


@dataclass
class Layer:
    thickness: float
    k: float
    rho: float
    cp: float
    name: str = ""
    cp_of: Optional[Callable[[np.ndarray], np.ndarray]] = None


def _graded(L: float, n: int, first: float) -> np.ndarray:
    """n+1 node positions on [0, L], geometric from a first cell of ``first`` (capped uniform)."""
    if n < 1:
        return np.array([0.0, L])
    if first * n >= L:
        return np.linspace(0.0, L, n + 1)
    hi = 2.0
    f = lambda r: first * (r ** n - 1.0) / (r - 1.0) - L
    while f(hi) < 0:
        hi *= 2.0
    r = brentq(f, 1.0 + 1e-12, hi)
    cells = first * r ** np.arange(n)
    x = np.concatenate([[0.0], np.cumsum(cells)])
    x[-1] = L
    return x


def _thomas(a: np.ndarray, b: np.ndarray, c: np.ndarray, d: np.ndarray) -> np.ndarray:
    n = len(b)
    cp = np.empty(n)
    dp = np.empty(n)
    cp[0] = c[0] / b[0]
    dp[0] = d[0] / b[0]
    for i in range(1, n):
        m = b[i] - a[i] * cp[i - 1]
        cp[i] = c[i] / m if i < n - 1 else 0.0
        dp[i] = (d[i] - a[i] * dp[i - 1]) / m
    x = np.empty(n)
    x[-1] = dp[-1]
    for i in range(n - 2, -1, -1):
        x[i] = dp[i] - cp[i] * x[i + 1]
    return x


@dataclass
class WallModel:
    """Temperature field through ``layers`` (layers[0] at the hot face)."""
    layers: List[Layer]
    T_init: float
    n_first: int = 80
    n_other: int = 20
    first_cell: float = 5e-6
    receded: float = 0.0
    y: np.ndarray = field(init=False)
    T: np.ndarray = field(init=False)
    T_surface_peak: float = field(init=False)
    T_back_peak: float = field(init=False)

    def __post_init__(self):
        self._build_grid()
        self.T = np.full_like(self.y, float(self.T_init))
        self.T_surface_peak = float(self.T_init)
        self.T_back_peak = float(self.T_init)

    # -- grid -------------------------------------------------------------
    def _build_grid(self):
        segs, props = [], []
        x0 = 0.0
        for i, lay in enumerate(self.layers):
            t = lay.thickness - (self.receded if i == 0 else 0.0)
            if i == 0 and t <= 0:
                t = 1e-9
            n = self.n_first if i == 0 else self.n_other
            first = self.first_cell if i == 0 else t / n
            xs = _graded(t, n, first) + x0
            segs.append(xs if i == 0 else xs[1:])
            props.append((len(xs) - 1, lay))
            x0 += t
        self.y = np.concatenate(segs)                 # distance from the hot face
        k_cell, rc_cell, owner = [], [], []
        for n, lay in props:
            k_cell += [lay.k] * n
            rc_cell += [lay.rho * lay.cp] * n
            owner += [lay] * n
        self._k = np.array(k_cell)
        self._rc = np.array(rc_cell)
        self._varying = [(np.array([o is lay for o in owner]), lay)
                         for lay in self.layers if lay.cp_of is not None]
        dx = np.diff(self.y)
        self._dx = dx
        self._G = self._k / dx                       # cell conductance
        self._set_capacity()

    def _set_capacity(self):
        """Node heat capacity per area from the cell rho*cp (cp(T) layers at the cell mean T)."""
        if self._varying and getattr(self, "T", None) is not None and len(self.T) == len(self.y):
            Tc = 0.5 * (self.T[:-1] + self.T[1:])
            for mask, lay in self._varying:
                self._rc[mask] = lay.rho * lay.cp_of(Tc[mask])
        C = np.zeros_like(self.y)
        C[:-1] += 0.5 * self._rc * self._dx
        C[1:] += 0.5 * self._rc * self._dx
        self._C = C                                   # node heat capacity per area

    @property
    def thickness_first(self) -> float:
        return max(self.layers[0].thickness - self.receded, 0.0)

    def _remap(self, dx_recede: float):
        """Shorten layer 0 by dx_recede and carry the profile (measured from the back face)."""
        L_old = self.y[-1]
        z_old = L_old - self.y
        T_old = self.T.copy()
        self.receded += dx_recede
        self._build_grid()
        z_new = self.y[-1] - self.y
        self.T = np.interp(z_new, z_old[::-1], T_old[::-1])

    # -- one implicit step --------------------------------------------------
    def _interior(self, dt: float, s: float) -> np.ndarray:
        """Nodes 1..N at the new time for surface temperature s (Dirichlet at node 0)."""
        G, C, T = self._G, self._C, self.T
        n = len(T) - 1
        a = np.zeros(n)
        b = np.zeros(n)
        c = np.zeros(n)
        d = C[1:] / dt * T[1:]
        for j in range(n):
            i = j + 1
            gl = G[i - 1]
            gr = G[i] if i < len(G) else 0.0
            a[j] = -gl
            c[j] = -gr if i < len(G) else 0.0
            b[j] = C[i] / dt + gl + gr
        d[0] += G[0] * s
        a[0] = 0.0
        return _thomas(a, b, c, d)

    def step(self, dt: float, q_in: Callable[[float], float],
             T_ablation: Optional[float] = None, H_surface: Optional[float] = None,
             rho_surface: Optional[float] = None,
             chemical_mass_flux: Optional[Callable[[float], float]] = None,
             T_bracket: Tuple[float, float] = (150.0, 4500.0)) -> dict:
        """Advance by dt. Returns the surface temperature, the recession this step [m] and
        the surface mass flux [kg/(m^2 s)]."""
        if self._varying:
            self._set_capacity()
        G0, C0, T0 = self._G[0], self._C[0], self.T[0]
        lin0 = self._interior(dt, 0.0)
        lin1 = self._interior(dt, 1.0)
        slope1 = lin1[0] - lin0[0]

        def resid(s):
            T1 = lin0[0] + slope1 * s
            return q_in(s) - C0 * (s - T0) / dt - G0 * (s - T1)

        lo, hi = T_bracket
        rlo, rhi = resid(lo), resid(hi)
        if rlo <= 0:
            s = lo
        elif rhi >= 0:
            s = hi
        else:
            s = brentq(resid, lo, hi, xtol=1e-6)
        mass_flux = 0.0
        if T_ablation is not None and s > T_ablation:
            s = float(T_ablation)
            excess = resid(s)
            mass_flux = max(excess, 0.0) / H_surface
        elif chemical_mass_flux is not None:
            mass_flux = max(chemical_mass_flux(s), 0.0)
        interior = self._interior(dt, s)
        self.T = np.concatenate([[s], interior])
        recede = 0.0
        if mass_flux > 0 and rho_surface:
            recede = min(mass_flux / rho_surface * dt, max(self.thickness_first - 1e-6, 0.0))
            if recede > 0:
                self._remap(recede)
                self.T[0] = s          # the new face is the receding surface
        self.T_surface_peak = max(self.T_surface_peak, float(self.T[0]))
        self.T_back_peak = max(self.T_back_peak, float(self.T[-1]))
        return {"T_surface": float(s), "recession": float(recede), "mass_flux": float(mass_flux)}

    def advance(self, dt: float, n_sub: int, **kw) -> dict:
        """dt split into n_sub implicit steps; returns the last surface state and totals."""
        total_recession = 0.0
        out = {"T_surface": float(self.T[0]), "recession": 0.0, "mass_flux": 0.0}
        for _ in range(max(n_sub, 1)):
            out = self.step(dt / max(n_sub, 1), **kw)
            total_recession += out["recession"]
        out["recession"] = total_recession
        return out

    # -- read-outs ------------------------------------------------------------
    def depth_of_isotherm(self, T_iso: float) -> float:
        """Distance below the current hot face to the first node cooler than T_iso [m]."""
        above = self.T >= T_iso
        if not above[0]:
            return 0.0
        idx = np.argmin(above)
        if above.all():
            return float(self.y[-1])
        i = idx - 1
        f = (self.T[i] - T_iso) / max(self.T[i] - self.T[idx], 1e-12)
        return float(self.y[i] + f * (self.y[idx] - self.y[i]))

    def interface_temperature(self, index: int) -> float:
        """Temperature at the back of layers[index] (the bondline for index 0)."""
        z = sum(l.thickness for l in self.layers[: index + 1]) - self.receded
        return float(np.interp(z, self.y, self.T))

    @property
    def T_back(self) -> float:
        return float(self.T[-1])

    def soak(self, duration: float, dt: float = 0.05) -> dict:
        """Continue with an adiabatic hot face after shutdown; peak back-face and bondline
        temperatures reached while the stored heat redistributes."""
        peak_back, peak_bond = self.T_back, self.interface_temperature(0)
        t = 0.0
        while t < duration - 1e-12:
            h = min(dt, duration - t)
            self.step(h, q_in=lambda s: 0.0)
            peak_back = max(peak_back, self.T_back)
            peak_bond = max(peak_bond, self.interface_temperature(0))
            t += h
        return {"T_back_peak": float(peak_back), "T_bondline_peak": float(peak_bond)}

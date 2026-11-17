"""PolyInterpolator and LinearInterpolator.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.util.PolyInterpolator,
info.openrocket.core.util.LinearInterpolator.
"""

from __future__ import annotations

import bisect


class PolyInterpolator:
    """Polynomial through values and derivatives at given points.

    ``PolyInterpolator(points0, points1, ...)``: points_j are the x positions at
    which the j-th derivative is specified.
    """

    def __init__(self, *points):
        count = sum(len(p) for p in points)
        if count == 0:
            raise ValueError("No interpolation points defined.")
        self.count = count
        mul = [1] * count
        matrix = [[0.0] * count for _ in range(count)]
        row = 0
        for j, pts in enumerate(points):
            for xi in pts:
                x = 1.0
                for col in range(count - 1 - j, -1, -1):
                    matrix[row][col] = x * mul[col]
                    x *= xi
                row += 1
            for i in range(count):
                mul[i] *= count - i - j - 1
        assert row == count
        self.interpolation_matrix = _inverse(matrix)

    def interpolator(self, *values) -> list[float]:
        if len(values) != self.count:
            raise ValueError(f"Wrong number of arguments {len(values)} expected {self.count}")
        ret = [0.0] * self.count
        m = self.interpolation_matrix
        for j in range(self.count):
            acc = 0.0
            for i in range(self.count):
                acc += m[j][i] * values[i]
            ret[j] = acc
        return ret

    def interpolate(self, x: float, *values) -> float:
        return PolyInterpolator.eval(x, self.interpolator(*values))

    @staticmethod
    def eval(x: float, coefficients) -> float:
        v = 1.0
        result = 0.0
        for i in range(len(coefficients) - 1, -1, -1):
            result += coefficients[i] * v
            v *= x
        return result


def _inverse(matrix):
    n = len(matrix)
    a = [list(r) for r in matrix]
    x = [[0.0] * n for _ in range(n)]
    b = [[0.0] * n for _ in range(n)]
    index = [0] * n
    for i in range(n):
        b[i][i] = 1.0
    _gaussian(a, index)
    for i in range(n - 1):
        for j in range(i + 1, n):
            for k in range(n):
                b[index[j]][k] -= a[index[j]][i] * b[index[i]][k]
    for i in range(n):
        x[n - 1][i] = b[index[n - 1]][i] / a[index[n - 1]][n - 1]
        for j in range(n - 2, -1, -1):
            x[j][i] = b[index[j]][i]
            for k in range(j + 1, n):
                x[j][i] -= a[index[j]][k] * x[k][i]
            x[j][i] /= a[index[j]][j]
    return x


def _gaussian(a, index):
    n = len(index)
    c = [0.0] * n
    for i in range(n):
        index[i] = i
    for i in range(n):
        c1 = 0.0
        for j in range(n):
            c0 = abs(a[i][j])
            if c0 > c1:
                c1 = c0
        c[i] = c1
    k = 0
    for j in range(n - 1):
        pi1 = 0.0
        for i in range(j, n):
            pi0 = abs(a[index[i]][j])
            pi0 /= c[index[i]]
            if pi0 > pi1:
                pi1 = pi0
                k = i
        index[j], index[k] = index[k], index[j]
        for i in range(j + 1, n):
            pj = a[index[i]][j] / a[index[j]][j]
            a[index[i]][j] = pj
            for l in range(j + 1, n):
                a[index[i]][l] -= pj * a[index[j]][l]


class LinearInterpolator:
    """Piecewise-linear over a sorted map; constant beyond the ends (TreeMap semantics)."""

    def __init__(self, x=None, y=None):
        self._xs: list[float] = []
        self._ys: list[float] = []
        if x is not None:
            self.add_points(x, y)

    def add_point(self, x: float, y: float) -> None:
        x = float(x)
        i = bisect.bisect_left(self._xs, x)
        if i < len(self._xs) and self._xs[i] == x:
            self._ys[i] = float(y)  # TreeMap.put replaces
        else:
            self._xs.insert(i, x)
            self._ys.insert(i, float(y))

    def add_points(self, x, y) -> None:
        if len(x) != len(y):
            raise ValueError(f"Array lengths do not match, x={len(x)} y={len(y)}")
        for xi, yi in zip(x, y):
            self.add_point(xi, yi)

    def get_value(self, x: float) -> float:
        xs, ys = self._xs, self._ys
        if not xs:
            raise RuntimeError("No points added yet to the interpolator.")
        i = bisect.bisect_left(xs, x)
        if i < len(xs) and xs[i] == x:
            return ys[i]
        if x < xs[0]:
            return ys[0]
        # floor: largest key < x
        x1, y1 = xs[i - 1], ys[i - 1]
        if i >= len(xs):
            return y1
        x2, y2 = xs[i], ys[i]
        return (x - x1) / (x2 - x1) * (y2 - y1) + y1

    def get_x_points(self) -> list[float]:
        return list(self._xs)

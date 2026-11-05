"""Numbers written the way JavaScript writes them.

Some files the apps hand out (EngineDesign's pressure-curve CSV, feed-twin's
plot CSV) used to be built in the browser. Now the backends write them, and the
files must not change in the move, so the numbers in them are printed by these:

- ``js_number(x)`` is ``String(x)``: ECMAScript Number::toString over the
  shortest round-trip digits, which Python's ``repr`` also produces;
- ``js_to_fixed(x, d)`` is ``x.toFixed(d)``: the exact binary value rounded to
  ``d`` places, a tie going away from zero (Python's own format rounds a tie to
  even, so ``f"{0.125:.2f}"`` is ``0.12`` where JavaScript writes ``0.13``).
"""

from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal
from typing import Any


def _special(f: float) -> str | None:
    if math.isnan(f):
        return "NaN"
    if math.isinf(f):
        return "Infinity" if f > 0 else "-Infinity"
    return None


def js_number(x: Any) -> str:
    if x is None:
        return "null"
    if isinstance(x, bool):
        return "true" if x else "false"
    f = float(x)
    special = _special(f)
    if special:
        return special
    if f == 0:
        return "0"
    sign = "-" if f < 0 else ""
    tup = Decimal(repr(abs(f))).normalize().as_tuple()
    digits = "".join(map(str, tup.digits))
    k = len(digits)
    n = tup.exponent + k  # value = 0.<digits> x 10^n
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    exp = ("+" if e >= 0 else "-") + str(abs(e))
    return sign + (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + exp


def js_to_fixed(x: Any, digits: int) -> str:
    f = float(x)
    special = _special(f)
    if special:
        return special
    if abs(f) >= 1e21:
        return js_number(f)
    q = Decimal(f).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    text = format(q, "f")
    # -0.0001.toFixed(2) is "-0.00" in JavaScript: the sign stays.
    if f < 0 and not text.startswith("-"):
        text = "-" + text
    return text

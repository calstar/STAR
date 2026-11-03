"""Keeping tool results small.

A tool result is read in full by the model, so nothing large goes into one:

- ``compact`` shrinks any JSON an app returns: long arrays become a one-line
  summary (length, min, max, first, last), long strings are cut. The summary
  says which tool gets the full data.
- ``downsample`` thins a series to a point budget with min/max buckets, so the
  peaks survive (an ignition spike, a parachute snatch) where every-Nth-sample
  would step over them.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

MAX_LIST = 24
MAX_STR = 1500
MAX_DEPTH = 8


def _number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def summarize_list(values: list[Any]) -> dict[str, Any]:
    nums = [float(v) for v in values if _number(v) and math.isfinite(float(v))]
    out: dict[str, Any] = {"_list_of": len(values)}
    if nums and len(nums) >= len(values) // 2:
        out.update(min=min(nums), max=max(nums), first=values[0], last=values[-1])
    else:
        out["sample"] = [compact(v, depth=MAX_DEPTH - 1) for v in values[:3]]
    return out


def compact(obj: Any, *, max_list: int = MAX_LIST, depth: int = 0) -> Any:
    if depth >= MAX_DEPTH:
        return "…" if isinstance(obj, (dict, list)) else obj
    if isinstance(obj, dict):
        return {k: compact(v, max_list=max_list, depth=depth + 1) for k, v in obj.items()}
    if isinstance(obj, list):
        if len(obj) > max_list:
            return summarize_list(obj)
        return [compact(v, max_list=max_list, depth=depth + 1) for v in obj]
    if isinstance(obj, str) and len(obj) > MAX_STR:
        return obj[:MAX_STR] + f"… [{len(obj) - MAX_STR} more characters]"
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


def downsample(t: np.ndarray, y: np.ndarray, max_points: int) -> tuple[np.ndarray, np.ndarray]:
    """At most ~``max_points`` samples of (t, y), keeping each bucket's min and max."""
    n = len(t)
    if n <= max_points:
        return t, y
    buckets = max(1, max_points // 2)
    edges = np.linspace(0, n, buckets + 1, dtype=int)
    keep: list[int] = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        if hi <= lo:
            continue
        seg = y[lo:hi]
        finite = np.isfinite(seg)
        if not finite.any():
            keep.append(lo)
            continue
        masked_lo = np.where(finite, seg, np.inf)
        masked_hi = np.where(finite, seg, -np.inf)
        a, b = lo + int(np.argmin(masked_lo)), lo + int(np.argmax(masked_hi))
        keep.extend(sorted({a, b}))
    idx = np.asarray(keep, dtype=int)
    return t[idx], y[idx]


def as_list(values: np.ndarray) -> list[float | None]:
    return [None if not math.isfinite(v) else round(float(v), 9) for v in values]


def stats(values: np.ndarray) -> dict[str, Any]:
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {"n": int(values.size), "finite": 0}
    return {
        "n": int(values.size),
        "finite": int(finite.size),
        "min": float(finite.min()),
        "max": float(finite.max()),
        "mean": float(finite.mean()),
    }

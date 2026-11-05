"""Plots drawn on the server, so an agent can look at a result.

A PNG costs the model roughly the same whether ten or ten million samples sit
behind it, which makes it the cheapest way to show a whole run. Signals sharing a
unit share an axis; each distinct unit gets its own panel (up to MAX_PANELS).
"""

from __future__ import annotations

import io
from collections import OrderedDict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from .data import downsample  # noqa: E402

MAX_PANELS = 4
POINTS_PER_LINE = 4000


def render(
    series: list[tuple[str, str, np.ndarray, np.ndarray]],
    *,
    title: str,
    xlabel: str = "t [s]",
) -> bytes:
    """``series`` is ``[(name, unit, t, y)]``; each line may have its own time axis."""
    groups: OrderedDict[str, list[tuple[str, np.ndarray, np.ndarray]]] = OrderedDict()
    for name, unit, t, y in series:
        groups.setdefault(unit or "", []).append((name, np.asarray(t, float), np.asarray(y, float)))
    units = list(groups)[:MAX_PANELS]
    fig, axes = plt.subplots(len(units), 1, sharex=True, figsize=(10, 2.2 + 2.0 * len(units)), dpi=100, squeeze=False)
    for ax, unit in zip(axes[:, 0], units):
        for name, t, y in groups[unit]:
            ts, ys = downsample(t, y, POINTS_PER_LINE)
            ax.plot(ts, ys, linewidth=1.0, label=name)
        ax.set_ylabel(f"[{unit}]" if unit else "")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8, loc="best")
    axes[-1, 0].set_xlabel(xlabel)
    dropped = len(groups) - len(units)
    fig.suptitle(title + (f"  (+{dropped} more unit groups not drawn)" if dropped > 0 else ""), fontsize=11)
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()

"""Standard hardware the injector plate has to accommodate, with where each number came from.

Every row is a published standard, not a design choice. The ``source`` strings travel with the
numbers into the layout, so a warning that cites a thread length can say whose thread length.
"""

from __future__ import annotations

from typing import Dict, NamedTuple

IN = 0.0254


class NptThread(NamedTuple):
    tpi: int
    od: float              # actual outside diameter [m]
    l1_hand_tight: float   # hand-tight engagement L1 [m]
    l2_effective: float    # effective thread length L2 [m] -- the engagement a joint is made to
    tap_drill: float       # [m]
    source: str


_NPT_SRC = "ASME B1.20.1 (as tabulated in Wikipedia 'National pipe thread', checked 2026-09-25)"

#: American National Standard taper pipe thread.
NPT: Dict[str, NptThread] = {
    "1/8 NPT": NptThread(27, 0.405 * IN, 0.1615 * IN, 0.2639 * IN, 0.339 * IN, _NPT_SRC),
    "1/4 NPT": NptThread(18, 0.540 * IN, 0.2278 * IN, 0.4018 * IN, (7 / 16) * IN, _NPT_SRC),
    "3/8 NPT": NptThread(18, 0.675 * IN, 0.2400 * IN, 0.4078 * IN, (37 / 64) * IN, _NPT_SRC),
    "1/2 NPT": NptThread(14, 0.840 * IN, 0.3200 * IN, 0.5337 * IN, (23 / 32) * IN, _NPT_SRC),
    "3/4 NPT": NptThread(14, 1.050 * IN, 0.3390 * IN, 0.5457 * IN, (59 / 64) * IN, _NPT_SRC),
}



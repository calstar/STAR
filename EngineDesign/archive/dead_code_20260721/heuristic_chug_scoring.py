"""ARCHIVED 2026-07-21 — heuristic chug "stability index/margin" removed from
``engine/pipeline/stability/analysis.py::calculate_chugging_frequency``.

Why it was removed
------------------
1. It measured the WRONG variables. The index was a product of a chamber-pressure factor, an
   L* factor and a frequency-band factor. It never looked at **injector stiffness
   (dP_inj / Pc)**, feed inertance/resistance, or the combustion time lag — i.e. none of the
   physics that actually drives chug. It therefore could not distinguish a stable design from
   an unstable one, and was structurally blind to the blowdown failure mode (stiffness
   degrading as tank pressure decays).

2. It was NON-BINDING. With ``stability_index`` floored at 0.4 and the mapping
   ``margin = index * 1.5 + 0.4``, the minimum achievable margin was exactly 1.0, and a typical
   design landed ~1.42 — comfortably above every configured threshold. It could not fail a real
   design. The floors and the "more generous mapping" were added incrementally to stop it
   rejecting good designs (see the commit comments: "More lenient factors...", "Minimum 0.4 for
   any reasonable design", "More generous mapping...") rather than fixing the model.

3. It was already DEAD. ``comprehensive_stability_analysis`` overwrote
   ``chugging["stability_margin"]`` with the physical ``chug_gate_margin`` from
   ``compute_physical_stability``, so this value was computed and then discarded on every
   evaluation. It survived only as the silent neutral-pass fallback, which is now fail-safe.

Replacement: the rigorous lumped model in ``engine/pipeline/stability/chug.py`` (impedance
characteristic equation -> Nyquist gain margin / growth rate), reached via
``compute_physical_stability``.

Kept for reference only. Not imported anywhere.
"""


def _archived_chug_stability_index(Pc: float, Lstar: float, freq: float) -> "tuple[float, float]":
    """The removed heuristic. Returns (stability_index, stability_margin)."""
    Pc_ref = 1.0e6
    Lstar_ref = 1.0
    Pc_factor = min(1.0, (Pc / Pc_ref) ** 0.3) if Pc > 0 else 0.0
    Lstar_factor = min(1.0, (Lstar / Lstar_ref) ** 0.2) if Lstar > 0 else 0.0
    Pc_factor = max(Pc_factor, 0.6) if Pc > 0.3e6 else Pc_factor
    Lstar_factor = max(Lstar_factor, 0.7) if Lstar > 0.6 else Lstar_factor

    if freq < 5.0:
        f_factor = 0.6
    elif freq < 10.0:
        f_factor = 0.75
    elif freq > 600.0:
        f_factor = 0.9
    elif freq > 400.0:
        f_factor = 0.95
    else:
        f_factor = 1.0

    stability_index = Pc_factor * Lstar_factor * f_factor
    stability_index = max(stability_index, 0.4)
    stability_margin = stability_index * 1.5 + 0.4
    return float(stability_index), float(stability_margin)

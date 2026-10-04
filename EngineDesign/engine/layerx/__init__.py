"""Layer X: the burn, solved whole.

The feed system from the pressurant bottle to the injector inlet is feedtwin's
(``lib/feedtwin``, in-process per ADR-0001). The injector and chamber are
EngineDesign's, linked into the twin. The tank pressure curve is an *output*.
See ``docs/layer-x.md`` for the phases and what each one owns, and
``docs/layerx/DATA-CONTRACT.md`` for the result.

    from engine.layerx import DrawingStore, LayerXSettings, prepare, run_prepared

* :mod:`~engine.layerx.sources` -- drawings, state machines, the CEA table.
* :mod:`~engine.layerx.link` -- the engine, calibrated to EngineDesign at T-0.
* :mod:`~engine.layerx.prepare` -- settings (and their opt-in choices), preflight checks, the plan.
* :mod:`~engine.layerx.analysis` -- run, reduce, cross-check; the diagnostics, the graded
  limits, the event keys and the run record's models (``run_prepared(..., diagnostics=True)``).
* :mod:`~engine.layerx.diag` -- one module per diagnostics block (DATA-CONTRACT 3).
"""

from engine.layerx.analysis import (StandTripped, cross_check, diagnostics_of, grade_limits, reduce_trace,
                                   run_prepared)
from engine.layerx.prepare import Check, LayerXSettings, Prepared, options, prepare
from engine.layerx.sources import Drawing, DrawingStore

__all__ = [
    "Check",
    "Drawing",
    "DrawingStore",
    "LayerXSettings",
    "Prepared",
    "StandTripped",
    "cross_check",
    "diagnostics_of",
    "grade_limits",
    "options",
    "prepare",
    "reduce_trace",
    "run_prepared",
]

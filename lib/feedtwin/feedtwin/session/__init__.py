"""A feed system that exists in time: the marching session, headless.

The feed-twin app built this as its cockpit -- vessels with inventory that
integrates, a network solved at each instant, valves that slew, a chamber
closed by root-finding every coupling step -- and it was the only part of the
twin that ran a whole burn. It lives here now because the twin has two callers
(ADR-0001): the app, and EngineDesign's Layer X, which runs burns in-process.

    from feedtwin.session import assemble_model, Session, Setup, load_machine, bind
    from feedtwin.session.burn import BurnPlan, run_burn

* :mod:`~feedtwin.session.gauge` -- where the gauge wire meets Pa, and
  :func:`~feedtwin.session.gauge.say`, how a person is shown a pressure (psia).
* :mod:`~feedtwin.session.model` -- drawing + engine in, an audited model out.
* :mod:`~feedtwin.session.statemachine` -- the DAQ's tables, read and bound.
* :mod:`~feedtwin.session.core` -- :class:`Session` and its :class:`Setup`.
* :mod:`~feedtwin.session.burn` -- T-0 to depletion, as one call.

Imported lazily by nothing: ``import feedtwin`` stays cheap, and pulling in a
session pulls in the property tables, which is the cost of asking for one.
"""

from __future__ import annotations

from feedtwin.session.core import Sample, Session, Setup
from feedtwin.session.gauge import (
    ATMOSPHERE,
    ATMOSPHERE_PSI,
    PSI,
    from_psig,
    psia,
    psig,
    psig_from_psia,
    say,
)
from feedtwin.session.model import (
    AssemblyError,
    AssemblyReport,
    Assumption,
    Model,
    assemble_model,
    chamber_for,
)
from feedtwin.session.statemachine import Binding, StateMachine, bind, load_machine

__all__ = [
    "ATMOSPHERE",
    "ATMOSPHERE_PSI",
    "PSI",
    "AssemblyError",
    "AssemblyReport",
    "Assumption",
    "Binding",
    "Model",
    "Sample",
    "Session",
    "Setup",
    "StateMachine",
    "assemble_model",
    "bind",
    "chamber_for",
    "from_psig",
    "load_machine",
    "psia",
    "psig",
    "psig_from_psia",
    "say",
]

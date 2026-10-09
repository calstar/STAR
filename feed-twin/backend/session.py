"""A stand that exists in time -- now library code.

The marching session (inventory that integrates, a network solved at each
instant, the chamber closed by root-finding every coupling step) moved to
:mod:`feedtwin.session.core` so a second caller can run it in-process:
EngineDesign's Layer X burns the same physics the cockpit flies. ADR-0001
always said this was where it would end up.

This module re-exports what the app and its tests import from it, unchanged.
Read the docstring in the library for how a tick works.
"""

from __future__ import annotations

from feedtwin.session.core import AMBIENT_T as AMBIENT_T
from feedtwin.session.core import BOTTLE_WALL as BOTTLE_WALL
from feedtwin.session.core import COUPLING_SAFETY as COUPLING_SAFETY
from feedtwin.session.core import LIVE_STEP as LIVE_STEP
from feedtwin.session.core import MAX_STEP as MAX_STEP
from feedtwin.session.core import PAD_HOLD_S as PAD_HOLD_S
from feedtwin.session.core import Sample as Sample
from feedtwin.session.core import Session as Session
from feedtwin.session.core import Setup as Setup
from feedtwin.session.core import TANK_WALL as TANK_WALL
from feedtwin.session.core import _trip_limit as _trip_limit
from feedtwin.session.core import _vessel_wall as _vessel_wall

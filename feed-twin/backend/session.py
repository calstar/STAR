"""A stand that exists in time -- now library code.

The marching session (inventory that integrates, a network solved at each
instant, the chamber closed by root-finding every coupling step) moved to
:mod:`feedtwin.session.core` so a second caller can run it in-process:
EngineDesign's Layer X burns the same physics the cockpit flies. ADR-0001
always said this was where it would end up.

This module re-exports it unchanged so every ``from backend.session import``
in the app and its tests keeps meaning exactly what it meant. Read the docstring
in the library for how a tick works.
"""

from __future__ import annotations

from feedtwin.session.core import AMBIENT as AMBIENT
from feedtwin.session.core import MAX_STEP as MAX_STEP
from feedtwin.session.core import MAX_COUPLED_CHANGE as MAX_COUPLED_CHANGE
from feedtwin.session.core import ROOM as ROOM
from feedtwin.session.core import MIN_CHAMBER_FLOW as MIN_CHAMBER_FLOW
from feedtwin.session.core import DRY_MASS as DRY_MASS
from feedtwin.session.core import MAX_COUPLING_STEPS as MAX_COUPLING_STEPS
from feedtwin.session.core import COUPLING_SAFETY as COUPLING_SAFETY
from feedtwin.session.core import PAD_HOLD_S as PAD_HOLD_S
from feedtwin.session.core import LOW_TANK as LOW_TANK
from feedtwin.session.core import LOW_BOTTLE as LOW_BOTTLE
from feedtwin.session.core import CHAMBER_TOL as CHAMBER_TOL
from feedtwin.session.core import CHAMBER_ITERATIONS as CHAMBER_ITERATIONS
from feedtwin.session.core import SUPPLY_BAND as SUPPLY_BAND
from feedtwin.session.core import DEFAULT_TRAVEL as DEFAULT_TRAVEL
from feedtwin.session.core import TICK_BUDGET as TICK_BUDGET
from feedtwin.session.core import LIVE_STEP as LIVE_STEP
from feedtwin.session.core import SUBSTEPS as SUBSTEPS
from feedtwin.session.core import FILL_SUPPLY_T as FILL_SUPPLY_T
from feedtwin.session.core import AMBIENT_T as AMBIENT_T
from feedtwin.session.core import FIBERGLASS_K as FIBERGLASS_K
from feedtwin.session.core import CRYOGENIC_K as CRYOGENIC_K
from feedtwin.session.core import WARM_WALL_K as WARM_WALL_K
from feedtwin.session.core import HOT_BOTTLE_K as HOT_BOTTLE_K
from feedtwin.session.core import MAX_MASS_STEP as MAX_MASS_STEP
from feedtwin.session.core import CHARGE_GAMMA as CHARGE_GAMMA
from feedtwin.session.core import STIR_BAND as STIR_BAND
from feedtwin.session.core import MAX_MASS_FRACTION as MAX_MASS_FRACTION
from feedtwin.session.core import MAX_TEMPERATURE_FRACTION as MAX_TEMPERATURE_FRACTION
from feedtwin.session.core import STEP_RETRIES as STEP_RETRIES
from feedtwin.session.core import MAX_VESSEL_STEPS as MAX_VESSEL_STEPS
from feedtwin.session.core import LIVE_ITERATIONS as LIVE_ITERATIONS
from feedtwin.session.core import LIVE_TOL as LIVE_TOL
from feedtwin.session.core import HISTORY as HISTORY
from feedtwin.session.core import FULL_FRACTION as FULL_FRACTION
from feedtwin.session.core import Setup as Setup
from feedtwin.session.core import TANK_WALL as TANK_WALL
from feedtwin.session.core import BOTTLE_WALL as BOTTLE_WALL
from feedtwin.session.core import Snapshot as Snapshot
from feedtwin.session.core import TankSim as TankSim
from feedtwin.session.core import BottleSim as BottleSim
from feedtwin.session.core import Sample as Sample
from feedtwin.session.core import Session as Session
from feedtwin.session.core import _trip_limit as _trip_limit
from feedtwin.session.core import _vessel_wall as _vessel_wall

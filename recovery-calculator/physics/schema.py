"""Pydantic contract. PLAN.md §11.3.

This is the schema the GUI serialises and the CLI accepts verbatim -- one
serialiser, no translation layer (§11.7). It is written before the physics
because both sides build against it.

**Everything about a device is on the device.** PLAN.md §6.1.1 promises that
nothing assumes two devices or any particular device, and that only holds if
the inflation *and* harness parameters are indexed. A drogue and a main do not
share a filling constant (it is coupled to j), a separation velocity (one is an
ejection charge against a stowed canopy, the other a bag extraction from a
stabilised descent), or a harness stiffness. Carrying any of them as a global
would be a silent coupling between two independent events.
"""

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from physics.constants import LBF_TO_N
from physics.site import FAR_ELEV_CONFIRMED, FAR_ELEV_M, FAR_NAME


class TriggerKind(str, Enum):
    """PLAN.md §6.1. Exactly one per device."""

    ALTITUDE = "ALTITUDE"
    TIME = "TIME"


class Trigger(BaseModel):
    """When the *charge* fires. Not when the canopy inflates -- see `Device.delay`."""

    model_config = ConfigDict(extra="forbid")

    kind: TriggerKind
    value: float = Field(
        description="Altitude AGL in m for ALTITUDE, seconds after the run "
        "start for TIME. Since the run begins at apogee, a TIME value "
        "is literally 'seconds after apogee'."
    )

    @model_validator(mode="after")
    def _check(self):
        if self.kind is TriggerKind.ALTITUDE and self.value < 0.0:
            raise ValueError("ALTITUDE trigger cannot be below ground")
        if self.kind is TriggerKind.TIME and self.value < 0.0:
            raise ValueError("TIME trigger cannot be before the run starts")
        return self


class Device(BaseModel):
    """One recovery device. PLAN.md §4, §6, §8.4."""

    model_config = ConfigDict(extra="forbid")

    name: str = "device"

    # --- drag and geometry, eqs (12), (A1)-(A3) ---------------------------
    CdS: float = Field(gt=0.0, description="Full-open drag area, m^2. One "
                       "atomic symbol -- do NOT factor it into a coefficient "
                       "and an area.")
    D0: float = Field(gt=0.0, description="Nominal diameter, m. Enters the "
                      "model only through filling distance, eq (9).")
    m_c: float = Field(ge=0.0, description="Canopy + lines (+ bag) mass, kg. "
                       "The bag rides on the canopy side of the harness, so it "
                       "belongs here and not in body mass.")

    # --- inflation, eqs (9)-(12) ------------------------------------------
    j: int = Field(default=2, description="Area growth exponent: 2 solid "
                   "cloth, 1 slotted.")
    n: float = Field(default=8.0, gt=0.0, description="Filling constant, "
                     "diameters fallen during inflation. Swept 6-12; coupled "
                     "to j, hence per device.")
    Cx: float = Field(default=1.8, ge=1.0, description="Opening force "
                      "coefficient, eq (23). The dominant uncertainty in the "
                      "whole model.")

    # --- deployment, eqs (8)/(8a) -----------------------------------------
    trigger: Trigger
    delay: float = Field(default=0.0, ge=0.0, description="Charge-to-line-"
                         "stretch lag, s. 0 free-packed, 0.3-1.0 s bagged. "
                         "NOT a rounding term: +55% on drogue load at 0.5 s. "
                         "Implemented as a scheduled event, not an offset.")

    # --- harness, eqs (30)-(34) -------------------------------------------
    k_eff: Optional[float] = Field(default=None, gt=0.0,
                                   description="Series harness stiffness, "
                                   "N/m, eq (32). Snatch is skipped if absent.")
    v_rel: float = Field(default=10.0, ge=0.0, description="Separation "
                         "velocity at line stretch, m/s. NOT the descent "
                         "speed v_s -- ground-test it.")

    @model_validator(mode="after")
    def _check(self):
        if self.j not in (1, 2):
            raise ValueError("j must be 1 (slotted) or 2 (solid cloth)")
        return self

    @property
    def s_f(self):
        """Eq (9). Filling distance, m."""
        return self.n * self.D0

    @property
    def v_floor(self):
        """The eq (23) validity floor, sqrt(g*s_f). Below this the
        infinite-mass bound is not a bound -- see the §8.2 validity note."""
        from physics.constants import G0

        return (G0 * self.s_f) ** 0.5


class Vehicle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    m: float = Field(gt=0.0, description="Total descending mass, kg.")
    h_a: float = Field(gt=0.0, description="Apogee AGL, m.")
    d_body: float = Field(gt=0.0, description="Airframe diameter, m.")
    l_body: float = Field(gt=0.0, description="Airframe length, m.")

    # Airframe drag area is DERIVED from d_body and l_body via eqs (14)/(15),
    # never entered. Two reasons, and both matter:
    #
    #   1. §6.4 does not permit picking one attitude. The axial/broadside band
    #      is 36x in the input and 2.1x on the design load -- the single
    #      largest term in the model (§15.7) -- so an editable field is an
    #      invitation to collapse it to whichever number looks reasonable,
    #      which is exactly the error the band exists to prevent.
    #   2. It is redundant with the geometry above, so it can disagree with
    #      it. A vehicle with d_body = 0.1016 m and CdS_body = 0.05 m^2 is
    #      describing a 12.8 in airframe in one field and a 4 in one in
    #      another, and nothing would flag it. (That inconsistency was real:
    #      it sat in this plan's own worked example until it was caught.)
    #
    # `solver.integrate` still accepts a CdS_body override for tests and for
    # anyone with measured or CFD data, but it is not a config field, so the
    # GUI cannot offer it.

    z0: Optional[float] = Field(default=None, description="Initial altitude "
                                "override, m AGL. Defaults to apogee.")
    v0: Optional[float] = Field(default=None, description="Initial velocity "
                                "override, m/s. Defaults to 0. Positive "
                                "values are only meaningful for a device the "
                                "eq (56) bound says survives.")


class Site(BaseModel):
    """Pad conditions. **Elevation is not an input.**

    This project models one range -- FAR -- so pad elevation is a constant in
    `physics/site.py` rather than a field. `extra="forbid"` means posting a
    `z_site` is a 422 rather than a silently ignored value, which is the point:
    a wrong elevation typed into a form is invisible, and 10 m of it is 0.12%
    in pressure.

    Only the two genuinely per-launch measurements remain.
    """

    model_config = ConfigDict(extra="forbid")

    T_pad: Optional[float] = Field(default=None, gt=0.0,
                                   description="Measured pad temperature, K. "
                                   "The one atmospheric input worth an "
                                   "instrument -- worth ~7% in density.")
    p_pad: Optional[float] = Field(default=None, gt=0.0,
                                   description="Pad STATION pressure, Pa. "
                                   "Defaults to eq (7a), good to ~2%. Never a "
                                   "raw METAR altimeter setting.")

    lapse: Optional[float] = Field(
        default=None, gt=-0.030, lt=0.030,
        description="Temperature lapse rate over the flight band, K per METRE "
        "(not K/km), negative for a cooling column. None keeps the eq (7) "
        "re-fit, which infers the slope from T_pad alone. Supplying a measured "
        "monthly value from site-climatology replaces that inference with an "
        "observation -- worth up to 1.4 K/km over the Mojave in July.",
    )

    @property
    def z_site(self):
        """Pad elevation, m MSL. Fixed at FAR; see physics/site.py."""
        return FAR_ELEV_M

    @property
    def name(self):
        return FAR_NAME


class SweepKey(str, Enum):
    """The parameters the §11.9 corner sweep can perturb.

    A closed set, not free text. Every entry needs code in `cases.sweep` that
    knows where to apply it -- `Cx` is per device, `m` is on the vehicle,
    `CdS_body` is a solver argument with no config field at all -- so an
    unknown key cannot be honoured, and silently ignoring one would report a
    sweep narrower than the caller asked for.
    """

    Cx = "Cx"
    n = "n"
    delay = "delay"
    v_rel = "v_rel"
    CdS_body = "CdS_body"
    m = "m"


class SweepParam(BaseModel):
    """One swept parameter and its bounds. PLAN.md §11.9.

    Bounds are a pair of *corners*, not a range to sample: Phase 1 has no
    random inputs, so the sweep visits the endpoints. `low == high` is legal
    and pins the parameter to that value.

    Disabling a parameter is not the same as pinning it to its nominal. A
    disabled parameter keeps whatever the config already carries -- which for
    a per-device parameter may differ *between* devices, where a swept one is
    applied in common across all of them (see `cases.sweep`).
    """

    model_config = ConfigDict(extra="forbid")

    key: SweepKey
    enabled: bool = True
    low: float
    high: float

    @model_validator(mode="after")
    def _check(self):
        if self.low > self.high:
            self.low, self.high = self.high, self.low
        if self.key in (SweepKey.Cx, SweepKey.n, SweepKey.m,
                        SweepKey.CdS_body) and self.low <= 0.0:
            raise ValueError("%s must be positive" % self.key.value)
        if self.key in (SweepKey.delay, SweepKey.v_rel) and self.low < 0.0:
            raise ValueError("%s cannot be negative" % self.key.value)
        return self

    @property
    def bounds(self):
        """The corner values. Collapses to one when the bounds coincide, so a
        pinned parameter costs a factor of 1 in run count rather than 2."""
        return (self.low,) if self.low == self.high else (self.low, self.high)


class StudyMode(str, Enum):
    """How a study axis enumerates its values."""

    LINEAR = "linear"   # start, stop, points -- BOTH ends inclusive
    LIST = "list"       # the values, written out


class StudyKey(str, Enum):
    """What a design study can vary.

    Note the name. This is **not** the corner sweep: `SweepKey` above perturbs
    the parameters nobody has measured, in common across every device, to their
    endpoints. These are things the designer *chooses* -- which canopy, how high
    the main comes out, how heavy the vehicle ended up -- varied over a grid or
    a list, on **one named device**. The two answer different questions and have
    no key in common by accident, so they stay separate enums.
    """

    # --- vehicle ---------------------------------------------------------
    m = "m"
    h_a = "h_a"
    d_body = "d_body"
    l_body = "l_body"

    # --- per device ------------------------------------------------------
    CdS = "CdS"
    D0 = "D0"
    m_c = "m_c"
    j = "j"
    n = "n"
    Cx = "Cx"
    delay = "delay"
    v_rel = "v_rel"
    k_eff = "k_eff"
    # `Trigger.value` only. The kind is left alone: sweeping a device from an
    # altitude trigger to a time trigger is not one axis, it is two designs.
    trigger = "trigger"
    # CdS, D0, m_c and j together -- one catalogue row. See `Canopy`.
    canopy = "canopy"

    # --- site ------------------------------------------------------------
    # T_pad, p_pad and lapse together -- one resolved pad state. See
    # `PadState`. Two keys rather than one because they answer different
    # questions with the same machinery: `pad_source` compares ways of
    # KNOWING the pad state (standard column, barometer, METAR, monthly
    # normal) and `pad_month` compares SEASONS of one of them. A single key
    # would leave a column of four labels with no way to say which question
    # produced it.
    pad_source = "pad_source"
    pad_month = "pad_month"


class Canopy(BaseModel):
    """One catalogue row as a design point.

    The values are carried explicitly rather than as a SKU the backend would
    look up, and that is deliberate:

      * `physics/` never has to know the catalogue exists, so the library keeps
        working with no `parachutes.csv` and the CLI runs the same config the
        GUI does;
      * a saved study cannot silently change meaning when the catalogue is
        rescraped and a vendor has revised a drag area.

    `label` is what the chart legend and the table row say. It is presentation,
    but it has to travel: `CdS = 3.889` is not something a reader can match back
    to "Iris Ultra 60".
    """

    model_config = ConfigDict(extra="forbid")

    label: str
    CdS: float = Field(gt=0.0)
    D0: float = Field(gt=0.0)
    m_c: float = Field(ge=0.0)
    j: int = 2

    @model_validator(mode="after")
    def _check(self):
        if self.j not in (1, 2):
            raise ValueError("j must be 1 (slotted) or 2 (solid cloth)")
        return self


class PadState(BaseModel):
    """One resolved pad state as a design point.

    The same reasoning as `Canopy`, applied to §5's three site fields. The
    values travel rather than the recipe that produced them -- "KNID, March,
    monthly normal" is a lookup against a climatology bundle that `physics/`
    does not have and that gets regenerated when the record is re-scraped, so
    a study carrying the recipe could change meaning between two runs of the
    same file. Resolving once, at the moment the user picks it, is also what
    makes a METAR point reproducible: an observation is only an observation if
    it is the one that was actually read.

    All three fields are optional because *unset is meaningful* here, and it
    is not the same as zero. `T_pad = None` means the standard column at pad
    elevation (eq 7a) rather than a measurement, and `lapse = None` means the
    eq (7) re-fit infers the slope from the pad temperature instead of being
    handed a measured one. This is exactly `Site`'s own convention, so a
    `PadState` is assignable to a `Site` field for field, which is what
    `study._apply` does.

    `label` is what the chart legend and the table column say. `p_pad = 92871`
    is not something a reader can match back to "KNID March normal".
    """

    model_config = ConfigDict(extra="forbid")

    label: str
    T_pad: Optional[float] = Field(default=None, gt=0.0)
    p_pad: Optional[float] = Field(default=None, gt=0.0)
    lapse: Optional[float] = None


def _list_field(key):
    """Which LIST payload this key's values live in, or None for plain floats.

    Three of the study keys vary something that is not a number: a canopy is
    four correlated vendor fields and a pad state is three correlated site
    fields. They are unswept by any grid -- see `StudyAxis._check` -- and each
    needs its own typed payload, because `List[float]` cannot hold either and
    a loosely-typed one would accept a canopy where a pad state belongs.
    """
    if key is StudyKey.canopy:
        return "canopies"
    if key in (StudyKey.pad_source, StudyKey.pad_month):
        return "pads"
    return None


class StudyAxis(BaseModel):
    """One variable of a design study, and the values it takes.

    Unlike `SweepParam` this is a *grid*, not a pair of corners, because the
    question is different: a corner sweep asks how bad it could be and the
    answer lives at the extremes, while a design study asks which choice is
    better and the answer is usually somewhere in between.
    """

    model_config = ConfigDict(extra="forbid")

    key: StudyKey
    # Required for a per-device key, forbidden for a vehicle one. By NAME, not
    # index: names are unique (see `Config._hard_errors`), they are what the
    # legend shows, and an index would silently retarget when a device is
    # removed. A rename breaks the axis loudly instead, which is the safe
    # direction to fail.
    device: Optional[str] = None
    enabled: bool = True

    mode: StudyMode
    # --- LINEAR ---
    start: Optional[float] = None
    stop: Optional[float] = None
    points: Optional[int] = Field(default=None, ge=1)
    # --- LIST ---
    values: Optional[List[float]] = None
    canopies: Optional[List[Canopy]] = None
    pads: Optional[List[PadState]] = None

    @model_validator(mode="after")
    def _check(self):
        from physics.study import SITE_KEYS, VEHICLE_KEYS

        listed = _list_field(self.key)
        if listed is not None and self.mode is not StudyMode.LIST:
            # There is no canopy halfway between a 48 and a 60, and no month
            # halfway between March and April. Interpolating either would
            # invent a design point that does not exist.
            raise ValueError("%s can only be swept as a list" % self.key.value)

        # Every LIST payload, so each branch below can name the one it wants
        # and reject the other two by exclusion rather than by a list that
        # needs extending every time a payload is added.
        payloads = ("values", "canopies", "pads")

        if self.mode is StudyMode.LINEAR:
            missing = [f for f in ("start", "stop", "points")
                       if getattr(self, f) is None]
            if missing:
                raise ValueError("linear sweep needs %s" % ", ".join(missing))
            if any(getattr(self, f) is not None for f in payloads):
                raise ValueError("linear sweep cannot also carry a value list")
        else:
            want = listed or "values"
            if not getattr(self, want):
                raise ValueError(
                    "%s sweep needs at least one %s"
                    % (self.key.value if listed else "list",
                       {"values": "value", "canopies": "canopy",
                        "pads": "pad state"}[want]))
            extra = [f for f in payloads
                     if f != want and getattr(self, f) is not None]
            if extra:
                raise ValueError("%s sweep carries %s, not %s"
                                 % (self.key.value, want, ", ".join(extra)))
            if any(f is not None for f in (self.start, self.stop, self.points)):
                raise ValueError("list sweep cannot also carry start/stop/points")

        # Three scopes, and only one of them takes a device. A site axis is
        # like a vehicle axis in that respect: there is one atmosphere over the
        # whole flight, so "which device" is not a question it can answer.
        per_device = self.key.value not in VEHICLE_KEYS + SITE_KEYS
        if not per_device and self.device is not None:
            raise ValueError(
                "%s is a %s parameter and takes no device"
                % (self.key.value,
                   "site" if self.key.value in SITE_KEYS else "vehicle"))
        if per_device and self.device is None:
            raise ValueError("%s is per-device -- name which device"
                             % self.key.value)
        return self

    @property
    def resolved(self):
        """The values this axis takes, in order. Empty when disabled."""
        from physics.study import axis_values

        return axis_values(self) if self.enabled else []


class Hardware(BaseModel):
    """Optional (§4.2). Without it the tool reports loads; with it, a verdict.

    Optional so a run is possible before hardware is chosen.
    """

    model_config = ConfigDict(extra="forbid")

    safety_factor: float = Field(default=1.5, gt=0.0)
    links: dict = Field(
        default_factory=dict,
        description="Rated strength per load-path element, N. One entry per "
        "element so the report can name WHICH link governs. It is rarely the "
        "shock cord -- quick links, eyebolt thread engagement and sewn-loop "
        "stitching are the usual governing items.",
    )

    @property
    def F_allow(self):
        """min_k R_k / SF. None when no links are declared."""
        if not self.links:
            return None
        return min(float(v) for v in self.links.values()) / self.safety_factor

    @property
    def governing_link(self):
        if not self.links:
            return None
        return min(self.links, key=lambda k: float(self.links[k]))

    @staticmethod
    def from_lbf(links_lbf, safety_factor=1.5):
        """Convenience: vendor ratings arrive in lbf."""
        return Hardware(
            safety_factor=safety_factor,
            links={k: v * LBF_TO_N for k, v in links_lbf.items()},
        )


class Config(BaseModel):
    """A complete run. This file is what the GUI saves and the CLI accepts."""

    model_config = ConfigDict(extra="forbid")

    vehicle: Vehicle
    site: Site = Field(default_factory=Site)
    devices: List[Device] = Field(min_length=1)
    hardware: Optional[Hardware] = None

    # Which corners the §11.9 sweep visits. Lives on the config rather than
    # being a separate request body for two reasons: the GUI saves this file
    # verbatim (§11.7), so the sweep setup survives a save/load like every
    # other input; and `/api/simulate` and `/api/sweep` keep one body schema
    # between them instead of two that can drift.
    #
    # None means the canonical set in `cases.DEFAULT_SWEEP` -- the bounds
    # §15.7 documents. Not an empty list: an explicit [] disables the sweep
    # entirely and is a different request.
    sweep: Optional[List[SweepParam]] = None

    # The design study (§11.9's sibling, not its extension). Rides here for the
    # same two reasons `sweep` does: the GUI saves this file verbatim, so a
    # trade study survives save/load; and /api/simulate, /api/sweep and
    # /api/study keep ONE body schema between them rather than three that can
    # drift.
    #
    # None and [] mean the same thing here, unlike `sweep`: there is no
    # canonical default study to fall back to, because which designs are worth
    # comparing is not something the tool can know.
    study: Optional[List[StudyAxis]] = None

    @model_validator(mode="after")
    def _hard_errors(self):
        """PLAN.md §11.7 hard errors -- these block the run.

        Warnings are deliberately NOT raised here: they are returned as data
        alongside the result so the run still happens and the user sees the
        numbers. Only genuinely un-runnable configurations raise.
        """
        h_a = self.vehicle.h_a
        z0 = self.vehicle.z0 if self.vehicle.z0 is not None else h_a

        # The ceiling is the highest point the vehicle reaches, not where it
        # starts: with v0 > 0 (§4.0's early-deployment case) it climbs above
        # z0, so a trigger between z0 and apogee is perfectly reachable on the
        # way back down.
        ceiling = max(h_a, z0)

        seen = set()
        for d in self.devices:
            if d.name in seen:
                raise ValueError("duplicate device name %r" % d.name)
            seen.add(d.name)
            if d.trigger.kind is TriggerKind.ALTITUDE and d.trigger.value > ceiling:
                raise ValueError(
                    "device %r deploys at %.1f m, above apogee %.1f m -- it "
                    "would never fire on a descending crossing"
                    % (d.name, d.trigger.value, ceiling)
                )

        if self.sweep is not None:
            # A repeated key is ambiguous rather than harmless: the two entries
            # can carry different bounds, and whichever the resolver happened
            # to see last would silently win.
            keys = [p.key for p in self.sweep]
            dupes = {k.value for k in keys if keys.count(k) > 1}
            if dupes:
                raise ValueError("duplicate sweep parameter(s): %s"
                                 % ", ".join(sorted(dupes)))

        if self.study:
            self._check_study(seen)
        return self

    def _check_study(self, device_names):
        """The four things a study can get wrong that the axis cannot see.

        `StudyAxis` validates itself in isolation; these need the rest of the
        config -- which devices exist, what the other axes are.
        """
        from physics.study import MAX_RUNS, SITE_KEYS

        pairs = []
        site_axes = []
        runs = 1
        for axis in self.study:
            if axis.device is not None and axis.device not in device_names:
                raise ValueError(
                    "study axis %s names device %r, which does not exist "
                    "(have: %s)" % (axis.key.value, axis.device,
                                    ", ".join(sorted(device_names))))
            if not axis.enabled:
                continue
            # A repeated target is ambiguous, not harmless: two axes on the
            # same device's CdS carry different grids and whichever the
            # resolver applied last would silently win. Same reasoning as the
            # duplicate-SweepKey check above.
            pair = (axis.key, axis.device)
            if pair in pairs:
                raise ValueError(
                    "duplicate study axis: %s%s appears twice"
                    % (axis.key.value,
                       " on %s" % axis.device if axis.device else ""))
            pairs.append(pair)
            if axis.key.value in SITE_KEYS:
                site_axes.append(axis.key.value)
            runs *= len(axis.resolved)

        # The duplicate check above is per (key, device), so it does not catch
        # this: pad_source and pad_month are different keys writing the same
        # three site fields. Crossing them is not a grid, it is a race -- the
        # resolver applies axes in order, so the second would overwrite the
        # first and every point would silently be one of the two axes only.
        if len(site_axes) > 1:
            raise ValueError(
                "%s both set the pad state -- they cannot be crossed, because "
                "the second would overwrite the first. Sweep one at a time."
                % " and ".join(site_axes))

        if runs > MAX_RUNS:
            # A cap, not a truncation. Silently running the first 20 of 24
            # would answer a question nobody asked and look like the one they
            # did -- and which 20 would depend on product order.
            raise ValueError(
                "study is %d runs, over the limit of %d -- drop an axis or "
                "use fewer points" % (runs, MAX_RUNS))

    def warnings(self):
        """Warnings. Returned as data; the run proceeds.

        One line each, and one line *per condition* rather than per device --
        four near-identical sentences read as noise and get skimmed, which
        defeats the point of a warning. Say the thing, name what it costs,
        stop.
        """
        out = []

        if not FAR_ELEV_CONFIRMED:
            out.append(
                "Pad elevation %.0f m is an unconfirmed estimate (%.1f%% in "
                "density per 10 m). A GPS fix at the pad retires it."
                % (FAR_ELEV_M, 0.12)
            )

        if self.site.T_pad is None:
            out.append(
                "Pad temperature is assumed, not measured — worth ~7% in "
                "density. Bring a thermometer."
            )
        if self.site.p_pad is None:
            out.append(
                "Pad pressure is the standard column — ~2% in density, and "
                "nothing at all in the main's opening load."
            )

        unmeasured = [d.name for d in self.devices if d.Cx == 1.8]
        if unmeasured:
            out.append(
                "Cx is the unmeasured 1.8 default on %s — ±20%%, the largest "
                "single uncertainty here." % ", ".join(unmeasured)
            )

        if len(self.devices) >= 2:
            biggest = max(self.devices, key=lambda d: d.CdS)
            first = min(
                self.devices,
                key=lambda d: (d.trigger.kind is TriggerKind.ALTITUDE,
                               -d.trigger.value if d.trigger.kind
                               is TriggerKind.ALTITUDE else d.trigger.value),
            )
            if first is biggest:
                out.append(
                    "%s deploys first and has the largest drag area — the "
                    "devices may be swapped." % first.name
                )
        return out

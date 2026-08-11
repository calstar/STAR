"""A motor as OpenRocket models it -- a port of ``ThrustCurveMotor`` (release-24.12).

A motor is not a solid; it is parallel ``time``/``thrust`` arrays plus a per-sample
centre-of-mass table (``cg_x`` = position from the motor's forward end, ``mass`` = total
motor mass at that instant). Mass and CG at an arbitrary time are linearly interpolated,
matching ``interpolateCenterOfMassAtIndex``/``getPseudoIndex`` exactly, so that:

    launch mass = mass[0]         burnout mass = mass[-1]
    propellant  = launch - burnout
    CG(t), mass(t)                interpolated

``quality`` records whether the CG data is real per-time data ("full", from a RockSim file)
or the mid-casing ``length/2`` assumption ("basic", RASP or auto-calc-cg). It carries no
physics -- it drives the "Full model" / "Basic model" label in the UI.
"""

from __future__ import annotations

from dataclasses import dataclass, field

_SNAP = 0.0001

# Delay sentinel matching Motor.PLUGGED_DELAY.
PLUGGED_DELAY = -1.0


@dataclass
class Motor:
    manufacturer: str
    designation: str
    diameter: float  # m
    length: float  # m
    delays: list[float]
    motor_type: str  # "SINGLE" | "RELOAD" | "HYBRID" | "UNKNOWN"
    time: list[float]
    thrust: list[float]
    cg_x: list[float]  # m, from the forward end
    mass: list[float]  # kg, total motor mass
    digest: str
    #: "full" when cg_x is real per-time data, "basic" when it is the length/2 assumption.
    quality: str = "basic"
    #: Source file format: "RASP" or "RockSim". Set by the loader/fetcher.
    file_format: str = ""
    comment: str = ""
    #: Set by the DB from thrustcurve.org metadata; not part of the file itself.
    common_name: str = ""
    impulse_class: str = ""
    motor_id: str = ""
    simfile_id: str = ""
    _delays: list[float] = field(default_factory=list, repr=False)

    # -- interpolation (ports of ThrustCurveMotor) ---------------------------

    def _pseudo_index(self, motor_time: float) -> float:
        if len(self.time) == 0 or motor_time < 0:
            return float("nan")
        lower = self._index(motor_time)
        return lower + self._index_fraction(motor_time, lower)

    def _index(self, motor_time: float) -> int:
        lower = 0
        upper = 0
        while upper < len(self.time) and motor_time >= self.time[upper]:
            lower = upper
            upper += 1
        return lower

    def _index_fraction(self, motor_time: float, index: int) -> float:
        upper = index + 1
        if upper == len(self.time):
            return 0.0
        lower_t = self.time[index]
        upper_t = self.time[upper]
        frac = (motor_time - lower_t) / (upper_t - lower_t)
        if frac < _SNAP:
            return 0.0
        if frac > 1 - _SNAP:
            return 1.0
        return frac

    def _com_at_index(self, pseudo: float) -> tuple[float, float]:
        """(cg_x, mass) at a pseudo-index, matching interpolateCenterOfMassAtIndex."""
        upper_frac = pseudo % 1
        lower_frac = 1 - upper_frac
        lower = int(pseudo)
        upper = lower + 1
        if 1 - lower_frac < _SNAP:
            return self.cg_x[lower], self.mass[lower]
        if upper_frac < _SNAP:
            return self.cg_x[upper], self.mass[upper]
        cgx = self.cg_x[lower] * lower_frac + self.cg_x[upper] * upper_frac
        m = self.mass[lower] * lower_frac + self.mass[upper] * upper_frac
        return cgx, m

    # -- public accessors ----------------------------------------------------

    def get_cmx(self, motor_time: float) -> float:
        return self._com_at_index(self._pseudo_index(motor_time))[0]

    def get_total_mass(self, motor_time: float) -> float:
        return self._com_at_index(self._pseudo_index(motor_time))[1]

    def get_propellant_mass(self, motor_time: float) -> float:
        return self.get_total_mass(motor_time) - self.burnout_mass

    @property
    def launch_mass(self) -> float:
        return self.mass[0]

    @property
    def burnout_mass(self) -> float:
        return self.mass[-1]

    @property
    def propellant_mass(self) -> float:
        return self.launch_mass - self.burnout_mass

    @property
    def launch_cgx(self) -> float:
        return self.cg_x[0]

    @property
    def burnout_cgx(self) -> float:
        return self.cg_x[-1]

    @property
    def burn_time(self) -> float:
        return self.time[-1]

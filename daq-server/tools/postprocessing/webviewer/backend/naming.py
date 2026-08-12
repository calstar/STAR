"""Classify exported component names into family/field/unit/kind.

A flattened Elodin export names each file `<Entity>.<field>` where Entity is like
`PT_Cal.Ox_Upstream`, `TC1.CH2`, `ACT4.CH5`, `CONTROLLER.diagnostics`,
`BOARD.HB_52`. The last dotted segment is the field (`pressure_psi`, `raw_adc`,
`to_state`, ...). A handful of components are genuinely unnamed and arrive as a
bare numeric hash — those are grouped as "Other".
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict

# Fields that are step/discrete (state enums, on/off, status) → step-draw, no
# min/max decimation, forward-fill when aligning to a shared time grid.
_DISCRETE_FIELDS = {
    "to_state",
    "from_state",
    "engine_state",
    "board_state",
    "current_state",
    "debug_mode",
    "actuator_state",
    "actuator_state_commanded",
    "fire_active",
    "cutoff_active",
    "safety_filtered",
    "valid",
    "cal_status",
    "reason",
    "channel_id",
}

# Plumbing fields hidden from the picker by default (still exportable via advanced).
_SECONDARY_FIELDS = {
    "cal_status",
    "channel_id",
    "timestamp_ns",
    "packet_ts_ms",
    "reason",
    "raw_adc",
}

# Explicit, hand-maintained unit per field. The axis grouping keys on unit
# (falling back to the field name when a field is unit-less), so getting these
# right is what puts e.g. pressures and ADC counts on separate y-axes. Any field
# not listed here is treated as unit-less. Keep this in sync with the fields the
# DAQ actually publishes (see naming test / `elodin-db info`).
_UNIT_BY_FIELD = {
    # pressures (raw PT + controller measurement/diagnostics)
    "pressure_psi": "psi",
    "p_ch": "psi", "p_ch_mp1": "psi", "p_ch_mp2": "psi",
    "p_copv": "psi", "p_reg": "psi",
    "p_u_ox": "psi", "p_u_fuel": "psi", "p_d_ox": "psi", "p_d_fuel": "psi",
    # temperature (TC / RTD calibrated)
    "temperature_c": "°C", "temp_c": "°C",
    # resistance (RTD raw)
    "raw_resistance": "Ω", "raw_resistance_counts": "counts",
    # force (load cells + thrust estimate/reference)
    "force_n": "N", "force_kg": "kg",
    "f_ref": "N", "f_estimated": "N",
    # current (actuator sense)
    "current_a": "A",
    # raw ADC counts
    "raw_adc": "counts", "raw_adc_counts": "counts",
    # encoder
    "raw_angle": "deg",
    # controller duty cycles
    "duty_f": "0-1", "duty_o": "0-1",
    # timestamps
    "timestamp_ns": "ns",
    "sample_ts_ms": "ms", "packet_ts_ms": "ms",
    # left unit-less on purpose (grouped by field name): channel_id, sensor_id,
    # board_id, board_type, status, result, cal_status, valid, *_state,
    # fire_active, debug_mode, allowed_bitmask, reason, cutoff_active,
    # safety_filtered, u_f_on, u_o_on, solver_iters, cost, mr_ref, mr_estimated.
}

_HASH_RE = re.compile(r"^\d{6,}$")


def _family(entity: str) -> str:
    """Coarse family for grouping in the UI, derived from the entity prefix."""
    head = entity.split(".", 1)[0]
    if _HASH_RE.match(head):
        return "Other"
    # Strip a trailing board/index number: PT1 -> PT, PT_Cal -> PT_Cal, ACT4 -> ACT.
    m = re.match(r"^([A-Za-z_]+?)\d*$", head)
    base = m.group(1).rstrip("_") if m else head
    return base or head


def _unit(field: str) -> str:
    return _UNIT_BY_FIELD.get(field.lower(), "")


@dataclass
class Component:
    name: str  # full "<Entity>.<field>", == parquet file stem
    entity: str  # "<Entity>" (may itself contain dots, e.g. PT_Cal.Ox_Upstream)
    field: str  # last dotted segment
    family: str  # coarse group for the UI
    unit: str
    discrete: bool  # step-draw / forward-fill
    primary: bool  # surfaced in the picker by default (vs plumbing)

    def as_dict(self) -> dict:
        return asdict(self)


def classify(name: str) -> Component:
    """Split a component name into (entity, field) and classify it."""
    if "." in name:
        entity, field = name.rsplit(".", 1)
    else:
        entity, field = name, ""
    fam = _family(entity)
    return Component(
        name=name,
        entity=entity,
        field=field,
        family=fam,
        unit=_unit(field),
        discrete=field.lower() in _DISCRETE_FIELDS,
        primary=fam != "Other" and field.lower() not in _SECONDARY_FIELDS,
    )

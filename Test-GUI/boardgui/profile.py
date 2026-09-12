"""
BoardProfile — the single object that turns the generic monitor into a
board-specific GUI.

To create a GUI for a new board you only write one of these (see LC-GUI/lc_gui.py
for the reference example). Nothing else in ``boardgui`` needs to change.

The values here come straight from the firmware and the DAQ server config:
  * firmware        : firmware/Hotfire_Code/<BOARD>_Hotfire/src/main.cpp
  * board id / ip   : daq-server/config/config.toml  ([boards.*])
  * ports           : server_port 5006 (boards -> us), control 5005 (us -> board)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

# reference_voltage byte (SENSOR_CONFIG) -> ADC full-scale volts, for code->volt.
# "VDD" is the ADS1262's *analog* supply AVDD (ADS126X_REF_POS_VDD in
# LC_Hotfire/src/main.cpp), not the ESP32's 3.3 V logic rail. AVDD is the 5 V
# analog rail — see daq-server/config/config.toml [adc] vdd_nominal_v = 5.0.
#
# NOTE: on a ratiometric board the reference IS the bridge excitation, so it
# cancels out of the real force conversion entirely (see
# daq-server/tools/calibration/sense_conversions.py code_to_force). The volts
# shown here are a bench-level sanity number, not a calibrated measurement.
REFERENCE_VOLTAGE_VOLTS: Dict[int, float] = {0: 2.5, 1: 5.0, 2: 5.0}
REFERENCE_VOLTAGE_LABELS: Dict[int, str] = {
    0: "Internal 2.5 V",
    1: "VDD / AVDD (5 V, ratiometric)",
    2: "5 V absolute",
}


@dataclass
class BoardProfile:
    # --- identity -------------------------------------------------------------
    board_type: str                 # "LC", "PT", "TC", "RTD", "ACT"
    title: str                      # window title, e.g. "LC Load Cell Board"
    board_id: int                   # label on the board; also low octet of its IP
    board_ip: str                   # static IP the firmware assigns itself
    server_ip: str = "192.168.2.20"  # IP the firmware sends heartbeats/data to

    # --- networking -----------------------------------------------------------
    listen_port: int = 5006         # we (the "server") bind this to receive
    control_port: int = 5005        # board listens here for our control packets

    # --- board kind -----------------------------------------------------------
    # "sensor" boards (LC/PT/TC/RTD) are configured with SENSOR_CONFIG and
    # stream signed ADC codes; "actuator" boards are configured with
    # ACTUATOR_CONFIG, take ACTUATOR_COMMAND / PWM_ACTUATOR_COMMAND, and
    # stream IEEE-754 float current-sense volts in the datapoint field.
    kind: str = "sensor"            # "sensor" | "actuator"
    value_encoding: str = "adc"     # "adc" (signed code -> volts) | "float"

    # --- sensors / channels ---------------------------------------------------
    # For actuator boards these are the actuator/current-sense channel IDs.
    all_connectors: List[int] = field(default_factory=list)   # physically wired
    active_connectors: List[int] = field(default_factory=list)  # plugged-in now
    connector_labels: Dict[int, str] = field(default_factory=dict)
    value_unit: str = "V"           # what a converted reading represents
    reading_name: str = "Reading"   # e.g. "Load", "Pressure", "Temperature"

    # --- board behaviour defaults (sent in SENSOR_CONFIG) ---------------------
    reference_voltage: int = 0      # 0/1/2 (see REFERENCE_VOLTAGE_* above)
    necessary_for_abort: bool = False
    enable_serial_printing: bool = True

    # --- actuator boards only (sent in ACTUATOR_CONFIG) -----------------------
    is_abort_controller: bool = False
    # Per-actuator vent/abort states for the abort config; anything missing
    # defaults to 0 (off) — the safe choice for a bench test.
    abort_vent_states: Dict[int, int] = field(default_factory=dict)
    abort_abort_states: Dict[int, int] = field(default_factory=dict)
    # PWM control defaults shown in the GUI's PWM row
    pwm_duration_ms: int = 1000
    pwm_duty_cycle: float = 0.5
    pwm_frequency_hz: float = 10.0

    # --- server-side cadence --------------------------------------------------
    server_heartbeat_interval_ms: int = 200  # matches config.toml server_heartbeat
    heartbeat_timeout_sec: float = 2.5       # "Disconnected" after this gap

    # --- serial (USB) link ----------------------------------------------------
    serial_baud: int = 115200                # firmware Serial.begin(115200)
    serial_silence_sec: float = 3.0          # "no data" if no serial line for this long

    def ref_voltage_volts(self) -> float:
        return REFERENCE_VOLTAGE_VOLTS.get(self.reference_voltage, 2.5)

    def connector_label(self, connector_id: int) -> str:
        return self.connector_labels.get(connector_id, f"Connector {connector_id}")

    def display_connectors(self) -> List[int]:
        """Connectors to show: active ones if given, else all wired ones."""
        return list(self.active_connectors) if self.active_connectors else list(self.all_connectors)

    def decode_value(self, raw_u32: int) -> float:
        """Wire u32 datapoint -> volts, per this board's encoding."""
        from . import protocol
        if self.value_encoding == "float":
            return protocol.raw_to_float(raw_u32)
        return protocol.raw_to_voltage(raw_u32, self.ref_voltage_volts())

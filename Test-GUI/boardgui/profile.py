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

# reference_voltage byte (SENSOR_CONFIG) -> ADC full-scale volts, for code->volt
# 0 = internal 2.5 V, 1 = VDD (~3.3 V ratiometric), 2 = 5 V absolute.
REFERENCE_VOLTAGE_VOLTS: Dict[int, float] = {0: 2.5, 1: 3.3, 2: 5.0}
REFERENCE_VOLTAGE_LABELS: Dict[int, str] = {
    0: "Internal 2.5 V",
    1: "VDD (~3.3 V, ratiometric)",
    2: "5 V absolute",
}


@dataclass
class BoardProfile:
    # --- identity -------------------------------------------------------------
    board_type: str                 # "LC", "PT", "TC", "RTD"
    title: str                      # window title, e.g. "LC Load Cell Board"
    board_id: int                   # label on the board; also low octet of its IP
    board_ip: str                   # static IP the firmware assigns itself
    server_ip: str = "192.168.2.20"  # IP the firmware sends heartbeats/data to

    # --- networking -----------------------------------------------------------
    listen_port: int = 5006         # we (the "server") bind this to receive
    control_port: int = 5005        # board listens here for our control packets

    # --- sensors / channels ---------------------------------------------------
    all_connectors: List[int] = field(default_factory=list)   # physically wired
    active_connectors: List[int] = field(default_factory=list)  # plugged-in now
    connector_labels: Dict[int, str] = field(default_factory=dict)
    value_unit: str = "V"           # what a converted reading represents
    reading_name: str = "Reading"   # e.g. "Load", "Pressure", "Temperature"

    # --- board behaviour defaults (sent in SENSOR_CONFIG) ---------------------
    reference_voltage: int = 0      # 0/1/2 (see REFERENCE_VOLTAGE_* above)
    necessary_for_abort: bool = False
    enable_serial_printing: bool = True

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

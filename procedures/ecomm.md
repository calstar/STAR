# ECOMM (Telemetry) Checklist

*Role: Ensure core avionics and daq is setup and functioning properly and communicating data properly.*

## Setup & DAQ Verification
- [ ] Connect and configure DAQ parameters.
- [ ] Ensure core avionics are correctly powered and active.
- [ ] Perform zero-point calibration of Pressure Transducers.
- [ ] Coordinate with GSE Manager to ensure GSE sensor telemetry is functional.
- [ ] **TELL AVIONICS MANAGER DAQ AND SENSORS ARE FUNCTIONAL.**

## Dry Run & Data Validation
- [ ] Trigger and verify failsafe modes (e.g., disconnecting server, emergency abort).
- [ ] Confirm accurate data is received (7 PTs, 3 HPTs, 3 LCs, 4 TCs, 4 RTDs) during the dry run.
- [ ] **BREAK HERE. WAIT FOR MISSION CONTROL MANAGER TO COMMENCE REMOTE OPERATIONS.**
- [ ] Monitor real-time telemetry from DAQ and Sensors closely.

## Active Operations
- [ ] Continuously monitor pressures, temperatures, and load cells during pressurization and hotfire.
- [ ] **TELL MISSION CONTROL MANAGER IF ANY TELEMETRY ANOMALY IS DETECTED.**
- [ ] Verify that all system data files are actively writing and saved after the test.
- [ ] **TELL AVIONICS MANAGER TELEMETRY RECORDING IS COMPLETE.**

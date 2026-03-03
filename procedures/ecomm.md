# ECOMM (Telemetry) Checklist

*Role: Ensure core avionics and DAQ are set up, functioning properly, and communicating data accurately.*

## Setup & DAQ Verification
- [ ] Power on DAQ and core avionics systems.
- [ ] Confirm DAQ is connected to operating and backup laptops.
- [ ] Connect and configure DAQ parameters per test configuration.
- [ ] Verify correct State Machine configuration loaded.
- [ ] Confirm live telemetry stream visible in Mission Control.
- [ ] Perform zero-point calibration of all Pressure Transducers.
- [ ] Verify calibration constants are applied correctly.
- [ ] Confirm reasonable ambient readings across:
      - [ ] 7 PTs
      - [ ] 3 HPTs
      - [ ] 3 LCs
      - [ ] 4 TCs
      - [ ] 4 RTDs
- [ ] Coordinate with GSE Manager to confirm GSE sensor telemetry is functional.
- [ ] Confirm no dropped packets or unstable communication.
- [ ] **TELL AVIONICS MANAGER DAQ AND SENSORS ARE FUNCTIONAL.**

## Dry Run & Data Validation
- [ ] Run full system dry run in DEBUG mode.
- [ ] Confirm state transitions reflect correctly in telemetry.
- [ ] Verify valve state indicators match ACTCOMM feedback.
- [ ] Trigger and verify failsafe modes:
      - [ ] Server disconnect
      - [ ] Board power disconnect
      - [ ] Emergency abort state
- [ ] Confirm telemetry updates properly during each triggered event.
- [ ] Confirm data logging is active during dry run.
- [ ] **BREAK HERE. WAIT FOR MISSION CONTROL MANAGER TO COMMENCE REMOTE OPERATIONS / HOTFIRE ATTEMPT.**
- [ ] Monitor real-time telemetry dashboard continuously.

## Active Operations
- [ ] Continuously monitor tank pressures during pressurization.
- [ ] Monitor regulator behavior and pressure stability.
- [ ] Monitor temperature sensors for abnormal rise.
- [ ] Monitor load cells during ignition and burn.
- [ ] Watch for sensor dropouts or frozen values.
- [ ] Watch for pressure oscillations or rapid deviations.
- [ ] **TELL MISSION CONTROL MANAGER IMMEDIATELY IF ANY TELEMETRY ANOMALY IS DETECTED.**
- [ ] Confirm telemetry remains synchronized throughout burn.
- [ ] Verify all system data files are actively writing during test.
- [ ] Confirm data files saved successfully after test completion.
- [ ] Backup data if required.
- [ ] **TELL AVIONICS MANAGER TELEMETRY RECORDING IS COMPLETE.**
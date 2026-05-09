# ECOMM (Telemetry) Checklist

*Role: Ensure core avionics and DAQ are set up, functioning properly, and communicating data accurately.*

## Setup
- [ ] Power on DAQ and core avionics systems.
- [ ] Confirm DAQ is connected to operating and backup laptops.
- [ ] Connect and configure DAQ parameters per test configuration.
- [ ] Verify correct State Machine configuration loaded.
- [ ] Confirm live telemetry stream visible in Mission Control.
- [ ] Perform zero-point calibration of all pressure transducers and verify the calibration constants are applied correctly.
- [ ] Confirm reasonable ambient readings across:
      - [ ] 7 PTs
      - [ ] 3 HPTs
      - [ ] 3 LCs
      - [ ] 4 TCs
      - [ ] 4 RTDs
- [ ] Coordinate with GSE Manager to confirm GSE sensor telemetry is functional.
- [ ] Confirm no dropped packets or unstable communication.
- [ ] Verify rocket-side and GSE-side sensor harnessing is not under tension and is routed away from sharp edges, hot surfaces, vents, and moving hardware.
- [ ] **TELL AVIONICS MANAGER DAQ AND SENSORS ARE FUNCTIONAL.**

## Dry Run & Testing
- [ ] Run full system dry run.
- [ ] Confirm state transitions reflect correctly in telemetry.
- [ ] Verify valve state indicators match ACTCOMM feedback.
- [ ] Trigger and verify failsafe modes:
      - [ ] Server disconnect
      - [ ] Board power disconnect
      - [ ] Emergency abort state
- [ ] Confirm telemetry updates properly during each triggered event.
- [ ] Confirm data logging is active during dry run.
- [ ] **BREAK HERE. WAIT FOR MISSION CONTROL MANAGER TO COMMENCE REMOTE OPERATIONS / HOTFIRE ATTEMPT.**
 - [ ] **TELL MISSION CONTROL MANAGER AND AVIONICS MANAGER THAT TELEMETRY AND LOGGING BEHAVED NOMINALLY DURING DRY RUN OR REPORT ANY ANOMALIES.**

## Press Proof
- [ ] Monitor real-time telemetry dashboard continuously.
- [ ] Continuously monitor tank pressures during pressurization.
- [ ] Monitor regulator behavior and pressure stability.
 - [ ] Confirm pressures and trends match expectations communicated by Mission Control Manager and GSE Manager.
 - [ ] **TELL MISSION CONTROL MANAGER IMMEDIATELY IF ANY TELEMETRY ANOMALY, SENSOR SATURATION, OR UNEXPECTED TREND IS DETECTED.**

## Fill
- [ ] Monitor temperature sensors for abnormal rise.
- [ ] Watch for sensor dropouts or frozen values.
- [ ] Watch for pressure oscillations or rapid deviations.
 - [ ] **TELL MISSION CONTROL MANAGER AND OPERATIONS MANAGER IF ANY SENSOR OR TELEMETRY ANOMALY IS OBSERVED DURING FUEL OR LOX FILL.**

## Hotfire
- [ ] Monitor load cells during ignition and burn.
- [ ] **TELL MISSION CONTROL MANAGER IMMEDIATELY IF ANY TELEMETRY ANOMALY IS DETECTED.**
- [ ] Confirm telemetry remains synchronized throughout burn.
- [ ] Verify all system data files are actively writing during test.
- [ ] Confirm data files saved successfully after test completion.
- [ ] Backup the data and upload immediately.
- [ ] **TELL AVIONICS MANAGER TELEMETRY RECORDING IS COMPLETE.**

# ACTCOMM (Actuator Communications) Checklist

*Role: In charge of actuator setup, pneumatic actuation testing, and ensuring correct NC/NO states.*

## Setup
- [ ] Coordinate with Avionics Manager to ensure all solenoids are correctly wired between the DAQ box and the solenoids.
- [ ] Verify all solenoids are properly mounted, secured, and use the correct hardware (screws, fittings, and brackets).
- [ ] Confirm pneumatic supply lines are correctly routed and labeled.
- [ ] Verify rocket-side and GSE-side pneumatic hoses and actuator harnesses are routed and restrained (no kinks, no abrasion, clear of pinch points, hot surfaces, vents, and moving hardware).
- [ ] Verify solenoid valve flow directions match P&ID.
- [ ] Confirm no binding or mechanical interference.
- [ ] Confirm electrical connectors to solenoids are secure.
- [ ] Confirm each actuator is tagged/identifiable.
- [ ] **TELL GSE MANAGER ACTUATORS ARE CONNECTED PROPERLY.**
- [ ] **TELL PAD MANAGER ACTCOMM HARDWARE IS READY.**

## Dry Run & Testing
- [ ] **BREAK HERE. WAIT FOR MISSION CONTROL MANAGER TO COMMENCE REMOTE OPERATIONS / HOTFIRE ATTEMPT.**
- [ ] **WAIT FOR PAD MANAGER TO ANNOUNCE START OF GSE LOW PRESS (~150 PSI) BEFORE INTRODUCING PNEUMATIC PRESSURE TO ACTUATORS.**
- [ ] During initial GSE low press, check for audible leaks, pressure decay, or fitting movement/backing out in coordination with GSE Manager.
- [ ] During initial GSE low press, monitor all pneumatic actuators for unintended motion or jitter; do not proceed to higher pressures until anomalies are resolved.
- [ ] Actively communicate with Mission Control Team to confirm all actuators are correctly mapped and respond to the intended commands.
- [ ] While confirming mapping, verify that each actuator’s commanded open/close state matches the intended Normally Closed (NC) / Normally Open (NO) configuration for its associated valve.
- [ ] Monitor solenoid actuation during dry run.
- [ ] For every command, verify the correct actuator responded and the actuator moved in the correct direction. 
- [ ] Confirm the resulting physical valve state matches the commanded state, including that all ball valves driven by pneumatic actuators rotate the full 90° between open and closed.
- [ ] Confirm that no uncommanded neighboring hardware moved.
- [ ] Verify actuation timing is nominal.
- [ ] Verify state transitions twice during dry run.
- [ ] Confirm abort state forces valves to correct safe positions.
- [ ] **TELL MISSION CONTROL / AVIONICS MANAGER OF ANY ACTUATOR ANOMALY.**

## Press Proof
- [ ] Verify all rocket-side solenoids remain physically connected.
- [ ] Verify all ground system solenoids remain physically connected.
- [ ] Support GSE team in connecting and verifying all pneumatic hose lines; confirm hoses are properly seated, secured, and clear of snag/heat/motion hazards.
- [ ] Perform final visual inspection with GSE Manager of fittings, manifolds, connectors, harness routing, brackets/mounts, and clearance around all moving hardware.
- [ ] Confirm no tools remain on actuator hardware.
- [ ] Verify all previously noted anomalies (if any) are fully resolved. 
- [ ] **TELL PAD MANAGER ACTCOMM IS SECURE FOR HOTFIRE.**

## Fill
- [ ] Coordinate with Mission Control Manager which states will be used during Fuel Fill and LOX Fill.
- [ ] Monitor actuators during each fill-related state transition to confirm:
  - [ ] Only the intended valves move.
  - [ ] All fill, vent, and isolation valves reach full open/closed positions as commanded.
- [ ] Call out any unexpected motion or failure to move immediately to Mission Control Manager and Pad Manager.

## Hotfire
- [ ] During hotfire sequence, monitor actuator indications and any visible hardware to confirm:
  - [ ] Main valves open and close as commanded.
  - [ ] Abort command drives valves to safe positions.
- [ ] **TELL MISSION CONTROL MANAGER IMMEDIATELY IF ANY ACTUATOR FAILS TO MEET COMMANDED STATE OR IF UNCOMMANDED MOTION IS OBSERVED.**

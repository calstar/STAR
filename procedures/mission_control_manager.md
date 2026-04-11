# Mission Control Manager Checklist

*Role: Main manager in the bunker. Controls state machine, monitors pressures, and directs launch operations.*

## Setup
- [ ] **BREAK HERE. WAIT FOR OPERATIONS MANAGER TO GIVE THE GO TO BEGIN.**
- [ ] Confirm State Machine configuration is loaded correctly.
- [ ] Confirm DAQ is streaming live data.
- [ ] Establish comms with Pad Manager.
- [ ] Establish comms with Avionics Manager.
- [ ] Confirm ECOMM telemetry is live and nominal.
- [ ] Confirm ACTCOMM reports valve control nominal.
- [ ] Command System to **Idle** (close vents) per master procedure.
- [ ] Perform initial Stable Pressure Check.
- [ ] Confirm ambient readings are nominal across all sensors.
- [ ] **WAIT FOR PAD MANAGER, ECOMM, ACTCOMM, GSE MANAGER, AND AVIONICS MANAGER TO CONFIRM SETUP COMPLETE BEFORE PROCEEDING TO DRY RUN & TESTING.**
- [ ] Confirm with Pad Manager, GSE Manager, Feed System Manager, Avionics Manager, ACTCOMM, and ECOMM that rocket-side and GSE-side harness/pipe/hose routing checks are reported complete.
- [ ] **TELL OPERATIONS MANAGER AND PAD MANAGER THAT MISSION CONTROL SETUP IS COMPLETE AND SYSTEM IS IN IDLE WITH NOMINAL AMBIENT READINGS.**

## Dry Run & Testing
- [ ] **TELL PAD MANAGER TO CONFIRM PAD CLEAR.**
- [ ] Confirm Operations Manager acknowledges clear zone.
- [ ] Command System to **Armed** state.
- [ ] Verify state change confirmation in telemetry.
- [ ] Confirm tank pressures within expected pre-press range.
- [ ] Run through planned state sequences (including ABORT) and verify:
  - [ ] All commanded states map to expected solenoid/valve actions (from ACTCOMM feedback).
  - [ ] Telemetry changes match expected state transitions (from ECOMM feedback).
  - [ ] No unexpected actuator movement or sensor spikes.
- [ ] **WAIT FOR ECOMM DRY RUN COMPLETION, ACTCOMM NOMINAL REPORT, AND AVIONICS MANAGER DRY RUN NOMINAL BEFORE PROCEEDING TO PRESS PROOF.**
- [ ] **TELL OPERATIONS MANAGER AND PAD MANAGER THAT DRY RUN IS COMPLETE AND REQUEST GO/NO-GO TO ENTER PRESS PROOF.**

## Press Proof
- [ ] Confirm with Operations Manager that clear zone and safety checks for pressurization are satisfied.
- [ ] Confirm with Pad Manager and GSE Manager that all pad-side press proof prep is complete.
- [ ] **TELL OPERATIONS MANAGER YOU ARE ARMING AND PRESSURIZING.**
- [ ] Command **Pressurize System**. Pressurize COPV tank first using medium pressure GSE, to 600 psi. Then pressurize both tanks to 600 psi.
- [ ] Monitor tank pressures continuously during pressurization.
- [ ] Watch for overpressure, instability, or unexpected sensor behavior.
- [ ] **BREAK HERE. WAIT FOR TANK PRESSURES TO STABILIZE (STABLE PRESSURE CHECK).**
- [ ] Confirm stabilization flag and nominal pressure values.
- [ ] **WAIT FOR GN2/HIGH PRESS FILL AND ECOMM TO CONFIRM NOMINAL PRESSURES.**
- [ ] Once confirmed all systems are leak-tight and all solenoids and ball valves work properly, command system to vent per master procedure.
- [ ] Monitor pressure decay back to near-ambient and confirm via telemetry.
- [ ] **TELL OPERATIONS MANAGER, PAD MANAGER, AND GSE MANAGER THAT PRESS PROOF IS COMPLETE AND SYSTEM HAS BEEN VENTED.**

## Fill
- [ ] Command state transitions to support Fuel Fill and LOX Fill per master procedure (e.g., **Fuel Fill**, **Armed**, and cryogen fill-related states).
- [ ] Coordinate timing with Pad Manager and Operations Manager for fuel and LOX fill authorizations.
- [ ] Monitor tank levels and pressures via telemetry during fill.
- [ ] **WAIT FOR ETHANOL FILL OPERATOR AND LOX FILL OPERATOR TO CONFIRM FILL COMPLETE BEFORE PROCEEDING TO FIRE.**
- [ ] During Fuel Fill:
  - [ ] Confirm transition to **Fuel Fill** state and verify correct valves/solenoids are actuated.
  - [ ] Monitor tank pressure and vent behavior; call ABORT to Operations Manager if off-nominal.
  - [ ] After Ethanol Fill Operator reports completion, command system back to **Armed** and confirm via telemetry.
- [ ] During LOX Fill:
  - [ ] Confirm cryo-related state transitions as required by master procedure.
  - [ ] Monitor LOX tank pressure and temperature trends; watch for rapid excursions.
  - [ ] Coordinate with Pad Manager and LOX Fill Operator for venting/level confirmation.
- [ ] After both fills complete and system is in the correct pre-hotfire state:
  - [ ] Confirm tanks are at target pressures/levels.
  - [ ] **TELL OPERATIONS MANAGER AND PAD MANAGER THAT FILL OPERATIONS ARE COMPLETE AND SYSTEM IS CONFIGURED FOR HOTFIRE SEQUENCE.**

## Hotfire
- [ ] **TELL AVIONICS MANAGER TO PERFORM IGNITION VERBAL CHECK.**
- [ ] Confirm igniter continuity and voltage verification.
- [ ] Conduct final GO/NO-GO poll in coordination with Operations Manager, requiring explicit GO from:
  - [ ] Pad Manager
  - [ ] GSE Manager
  - [ ] Avionics Manager
  - [ ] ECOMM
  - [ ] Feed System Manager
  - [ ] Safety Officer (via Operations Manager)
- [ ] **ONLY PROCEED TO IGNITION IF ALL REQUIRED ROLES REPORT GO.**
- [ ] **IGNITE.**
- [ ] Command System to FIRE (open main valves).
- [ ] Monitor system pressures continuously.
- [ ] Monitor thrust and load cell data.
- [ ] Monitor temperature sensors (TCs, RTDs).
- [ ] Confirm burn duration within expected window.
- [ ] **TELL OPERATIONS MANAGER IF ANOMALY DETECTED.**
- [ ] **EXECUTE ABORT IF NECESSARY.**
- [ ] Confirm system transitions out of burn state appropriately.
- [ ] Command System to VENT (remotely open vents).
- [ ] Monitor pressure decay.
- [ ] **BREAK HERE. WAIT FOR SYSTEM PRESSURE TO BE BELOW 25 PSI.**
- [ ] Confirm all tanks below threshold.
- [ ] **TELL PAD MANAGER SYSTEM IS SAFE TO APPROACH.**
- [ ] Command return to **Idle**.
- [ ] Confirm vents closed after safing complete.
- [ ] **TELL AVIONICS MANAGER TO DE-ENERGIZE POWER ELECTRONICS.**
- [ ] Confirm DAQ shutdown sequence complete.
- [ ] Check data file saves with ECOMM.
- [ ] Confirm redundant backups created if required.

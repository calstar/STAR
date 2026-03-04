# Mission Control Manager Checklist

*Role: Main manager in the bunker. Controls state machine, monitors pressures, and directs launch operations.*

## Setup and Initiation
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

## Remote Operations Phase
- [ ] **TELL PAD MANAGER TO CONFIRM PAD CLEAR.**
- [ ] Confirm Operations Manager acknowledges clear zone.
- [ ] Command System to **Armed** state.
- [ ] Verify state change confirmation in telemetry.
- [ ] Perform State Conformity Check based on Avionics/ECOMM readouts.
- [ ] Confirm tank pressures within expected pre-press range.
- [ ] **TELL OPERATIONS MANAGER YOU ARE ARMING AND PRESSURIZING PER HOTFIRE ATTEMPT PROCEDURE.**
- [ ] Command **Pressurize System**.
- [ ] Monitor tank pressures continuously during pressurization.
- [ ] Watch for overpressure, instability, or unexpected sensor behavior.
- [ ] **BREAK HERE. WAIT FOR TANK PRESSURES TO STABILIZE (STABLE PRESSURE CHECK).**
- [ ] Confirm stabilization flag and nominal pressure values.
- [ ] Command Quick-Disconnect (QD).
- [ ] Perform Stable Pressure Check post-QD.
- [ ] Confirm pressures remain within tolerance.
- [ ] **TELL AVIONICS MANAGER TO PERFORM IGNITION VERBAL CHECK.**
- [ ] Confirm igniter continuity and voltage verification.
- [ ] **IGNITE.**

## Hotfire Phase
- [ ] Command System to FIRE (open main valves).
- [ ] Monitor system pressures continuously.
- [ ] Monitor thrust and load cell data.
- [ ] Monitor temperature sensors (TCs, RTDs).
- [ ] Confirm burn duration within expected window.
- [ ] **TELL OPERATIONS MANAGER IF ANOMALY DETECTED.**
- [ ] **EXECUTE ABORT IF NECESSARY.**
- [ ] Confirm system transitions out of burn state appropriately.

## System Safing
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

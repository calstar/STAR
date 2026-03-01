# Mission Control Manager Checklist

*Role: Main manager in the bunker, where states are set, pressures read, etc. Main manager of launch operations.*

## Setup and Initiation
- [ ] **BREAK HERE. WAIT FOR OPERATIONS MANAGER TO GIVE THE GO TO BEGIN.**
- [ ] Confirm State Machine configuration is loaded and bunker is secure.
- [ ] Establish comms with Pad Manager and Avionics Manager.
- [ ] Command System to Idle (close vents).
- [ ] Stable Pressure Check.

## Remote Operations Phase
- [ ] **TELL PAD MANAGER TO CONFIRM PAD CLEAR.**
- [ ] Command System to Armed State.
- [ ] State Conformity Check based on Avionics/ECOMM readouts.
- [ ] **TELL OPERATIONS MANAGER TO ARM AND PRESSURIZE.**
- [ ] Remote Pressurization: Monitor Tank pressures.
- [ ] **BREAK HERE. WAIT FOR TANK PRESSURES TO STABILIZE.**
- [ ] Command Quick-Disconnect (QD).
- [ ] Stable Pressure Check.
- [ ] **TELL AVIONICS MANAGER TO PERFORM IGNITION VERBAL CHECK.**
- [ ] **IGNITE.**

## Hotfire Phase
- [ ] Open Main Valves.
- [ ] Monitor System Pressures continuously.
- [ ] **TELL OPERATIONS MANAGER IF ANOMALY DETECTED.**
- [ ] **EXECUTE ABORT IF NECESSARY.**

## System Safing
- [ ] Command System to ABORT to remotely open vents.
- [ ] **BREAK HERE. WAIT FOR SYSTEM PRESSURE TO BE BELOW 25 PSI.**
- [ ] **TELL PAD MANAGER SYSTEM IS SAFE TO APPROACH.**
- [ ] Command return to Idle.
- [ ] **TELL AVIONICS MANAGER TO DE-ENERGIZE POWER ELECTRONICS.**
- [ ] Check data file saves with ECOMM.

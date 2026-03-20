# Avionics Manager Checklist

*Role: Main manager of all electrical systems. Oversees power systems, DAQ, and maintains coordination with Mission Control Manager.*

## Setup
- [ ] Verify DAQ system is physically secured and powered correctly.
- [ ] Ensure DAQ system is protected from environmental and system constraints.
- [ ] Confirm power supplies are set to correct voltage/current limits.
- [ ] Connect DAQ box to power.
- [ ] Ensure breaker clicks and all boards are displaying LEDs to ensure power is on.
- [ ] Turn DAQ system off and plug in all harnessing.
- [ ] Route all avionics harnessing to the right connections (boardside).
- [ ] Route all harnessing to be clear of system.
- [ ] Verify rocket-side and GSE-side avionics harnesses are supported and tied down (no tension, no sharp bends, clear of hot surfaces, vents, moving hardware, and walk paths).
- [ ] Check in on Mission Control Manager to ensure calibrated data is coming in accurately.
- [ ] Check with Mission Control Manager to ensure no free-hanging connectors on system.
- [ ] Communicate with Actuator Control Manager on actuator mapping.
- [ ] Confirm reasonable ambient readings across: - [ ] 7 PTs - [ ] 3 HPTs - [ ] 3 LCs - [ ] 4 TCs - [ ] 4 RTDs
- [ ] Confirm that the 12 volt solenoids are plugged into the 12 volt board.
- [ ] Confirm that the 24 volt solenoids are plugged into the 24 volt board. 
- [ ] Ensure DAQ POWER harness is disconnected prior to energizing supply.
- [ ] Ensure telemetry is connected. 
- [ ] Ensure actuator control wiring is secure and correctly wired. Limit exposure of wires to the environment using sheathing.
- [ ] Confirm grounding and environmental protection of harnessing.
- [ ] Establish direct communication line with Mission Control Manager.
- [ ] Confirm backup laptops and power sources are available.
- [ ] **TELL MISSION CONTROL MANAGER ALL ELECTRICAL SYSTEMS ARE SET UP.**
- [ ] **BREAK HERE. WAIT FOR OPERATIONS MANAGER TO GIVE THE GO TO BEGIN.**
- [ ] Turn on DAQ power upon command. 
- [ ] Verify DAQ boots up correctly and connects to the telemetry interface.
- [ ] Confirm the power supply is operating in constant voltage mode.
- [ ] Ensure the DAQ briefcase is operating properly.
- [ ] Confirm the valve actuation commands register properly.
- [ ] Connect the RTD to the RTD harness.
- [ ] Visually verify that TCs in the chamber are secure.
 - [ ] **TELL ECOMM THAT AVIONICS POWER-UP AND BASIC HEALTH CHECKS ARE COMPLETE.**

## Dry Run & Testing  
- [ ] Ensure that no harnessing is under tension and all harnessing tensions are solid.
- [ ] Coordinate dry run with ECOMM and ACTCOMM.
- [ ] Communicate board status and performance with Mission Control Manager.
- [ ] Ensure data rates and sensors are all reading appropriate values with no spikes.
- [ ] Monitor power consumption during fill and pressurization.
- [ ] Ensure that all states actuate the proper solenoids and ball valves.
- [ ] Confirm that all valve actuation commands register properly.
- [ ] Confirm that the **ABORT SYSTEM** opens the tank vents.
- [ ] Confirm no unexpected current spikes.
- [ ] **TELL MISSION CONTROL MANAGER AVIONICS SIGNAL IS NOMINAL.**

## Press Proof
- [ ] Communicate with Mission Control Manager and Actuator Control Manager to ensure that the actuators are registering the controls accurately and nominal behavior is seen across boards. 
- [ ] Ensure that the board temperature and system behavior are nominal during press proof.
- [ ] Confirm that all valve actuation commands register properly.
- [ ] Confirm the pressure is at an acceptable value at 600 psi.
- [ ] Ensure that all sensors are operating appropriately.
 - [ ] **TELL OPERATIONS MANAGER AND MISSION CONTROL MANAGER IF ANY AVIONICS OR SENSOR ANOMALY IS OBSERVED DURING PRESS PROOF.**

## Fill 
- [ ] Communicate with Mission Control Manager on board status. 
- [ ] Monitor all current and voltage levels of the system during fill. Ensure all states are actuating correctly.
- [ ] Monitor temperature sensors for abnormal rise.
- [ ] Watch for sensor dropouts or frozen values.
- [ ] Watch for pressure oscillations or rapid deviations.
 - [ ] **CALL OUT TO MISSION CONTROL MANAGER AND OPERATIONS MANAGER IF ANY ELECTRICAL OR SENSOR ANOMALY OCCURS DURING FILL.**

## Hotfire  
- [ ] **TELL MISSION CONTROL MANAGER AVIONICS IS STEADY FOR IGNITION.**
- [ ] Remain prepared to de-energize immediately upon ABORT call.
- [ ] **BREAK HERE. WAIT FOR MISSION CONTROL MANAGER TO TELL YOU TO DE-ENERGIZE WHEN SAFE.**
- [ ] De-energize power electronics upon command from Mission Control/Pad Manager.
- [ ] Confirm voltage drops to zero.
- [ ] Verify DAQ shutdown sequence is completed properly.
- [ ] Confirm system data files saved with ECOMM.
- [ ] Secure power supplies.
- [ ] **TELL MISSION CONTROL MANAGER AVIONICS ARE DE-ENERGIZED AND DATA SAVED.**

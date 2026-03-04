# Avionics Manager Checklist

*Role: Main manager of all electrical systems. Oversees power systems, DAQ, and maintains coordination with Mission Control Manager.*

## Electrical Setup & Overview
- [ ] Inspect overall setup of electrical power systems.
- [ ] Verify DAQ system is physically secured and powered correctly.
- [ ] Confirm power supplies are set to correct voltage/current limits.
- [ ] Ensure DAQ POWER harness is disconnected prior to energizing supply.
- [ ] Coordinate with ECOMM to verify telemetry connections.
- [ ] Coordinate with ACTCOMM to verify actuator control wiring.
- [ ] Confirm grounding and environmental protection of harnessing.
- [ ] Establish direct communication line with Mission Control Manager.
- [ ] Confirm backup laptops and power sources are available.
- [ ] **TELL MISSION CONTROL MANAGER ALL ELECTRICAL SYSTEMS ARE SET UP.**

## Pre-Test Procedures
- [ ] **BREAK HERE. WAIT FOR OPERATIONS MANAGER TO GIVE THE GO TO BEGIN.**
- [ ] Energize DAQ SENSE power upon command.
- [ ] Verify DAQ boots correctly and connects to telemetry interface.
- [ ] Confirm power supply operating in constant voltage mode.
- [ ] Conduct dry run in coordination with ECOMM and ACTCOMM.
- [ ] Verify **ABORT SYSTEM** opens tank vents during dry run (matches System Safing procedure).
- [ ] Perform Remote Signal Check after Pad team clears.
- [ ] Confirm all valve actuation commands register properly.
- [ ] Confirm no unexpected current spikes.
- [ ] **TELL MISSION CONTROL MANAGER AVIONICS SIGNAL IS NOMINAL.**

## Hotfire Operations
- [ ] Enforce standby protocol across ECOMM and ACTCOMM.
- [ ] Monitor DAQ stability and communication link.
- [ ] Monitor power consumption during pressurization.
- [ ] Watch for voltage sag or regulator instability.
- [ ] **TELL MISSION CONTROL MANAGER AVIONICS IS STEADY FOR IGNITION.**
- [ ] Remain prepared to de-energize immediately upon ABORT call.
- [ ] **BREAK HERE. WAIT FOR MISSION CONTROL MANAGER TO TELL YOU TO DE-ENERGIZE WHEN SAFE.**

## System Safing
- [ ] De-energize Power Electronics upon command from Mission Control / Pad Manager.
- [ ] Confirm voltage drops to zero.
- [ ] Verify DAQ shutdown sequence is completed properly.
- [ ] Confirm system data files saved with ECOMM.
- [ ] Secure power supplies.
- [ ] **TELL MISSION CONTROL MANAGER AVIONICS ARE DE-ENERGIZED AND DATA SAVED.**

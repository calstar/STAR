------DIABLO HOTFIRE Full System Test Procedures  
This is intended to be a continuously revised document to document our most up-to-date procedure for the liquid propulsion system.

**\----------------- Please do not write test results here\! \-----------------**

# Guidelines and Authority

### Terminology

| Term | Meaning |
| ----- | ----- |
| PPE | Personal Protective Equipment |
| GN2 | Gaseous Nitrogen |
| LN2 | Liquid Nitrogen. Stored at 22psi |
| Cold Flow | Test performed with inert cryogenic liquid to simulate combustible propellants |
| Water Flow | Test performed with inert water to simulate combustible propellants |
| P\&ID | Piping and Instrumentation Diagram |
| MEOP | Maximum expected operating pressure |
| GSE | Ground Support Equipment |
| Pad | Location where hazards and system are located |
| Control Station | Location where the system is remotely monitored and remote actuation is commanded.  |
| LOS | Line of Sight |
| DAQ | Data Acquisition Electronics |
| POC | Point of Contact |

### Specialty SOPs/Resources:

* [Cold Flow Testing General SOP](https://docs.google.com/document/d/1XnxqNbEzNIPNOihPGaqJO14DFMuT1Ah-5mZAGA49moM/edit?usp=sharing)  
* [SOP High Power Electronics](https://docs.google.com/document/d/1w0iDp9VUk4Fa6atTOvtFkl7dCZz56mlH296-Kvzskio/edit?usp=sharing)  
* OSHA electrical PPE guidelines: [1910.334(c)(1)](https://www.osha.gov/laws-regs/interlinking/standards/1910.334\(c\)\(1\))   
* [Propulsion Component Testing](https://docs.google.com/document/d/1M4eYA6mkK5fjjnXySZyB5Q7p7ztks4nl5jO5qEWhwdI/edit?usp=sharing)

#

# Responsibilities:

| Role | Description | PPE Required |
| :---- | :---- | :---- |
| **Operations Manager** | Ensures all procedures are up to date, personnel are trained/on task, and safety resources are available | \-Safety goggles for splash protection \-Close-toed shoes, pants |
| **Pad Team: Safety Officer** | Regular and Pre-Test safety inspections, including maintenance tasks | \-Safety Goggles; face shield required at pad \-Close-toed shoes, pants \-Cryogenic apron and gloves \-O2 sensor(placed at system) |
| **Pad Team: Fluid System Technician (2x)** | Fluid system operation and manual instrumentation | \-Safety Goggles \+ Face Shield \-Close-toed shoes, pants \-Cryogenic apron and gloves |
| **Control Team: Instrumentation Technician** | Electrical Power System and Instrument Checkoffs | \-Safety goggles \-Dry clothing \-Rubber-soled shoes \-Insulated Probes |
| **Control Team:  Avionics Control Officer** | Main POC for control system, including sensor interface and remote operation authority | \-Safety glasses on hand \-Dry clothing |

### Personal Protective Equipment (PPE): 

**Pressurized Systems:**

1. Face shield and safety goggles for splash protection  
2. Close-toed shoes, pants  
3. Hearing protection  
     
   **Cryogenic Nitrogen Systems**:  
1. ANSI Z97 rated Face shield and safety goggles for splash protection.  
2. Cryogenic gloves resistant to extremely low temperatures.  
3. Insulated, waterproof cryogenic apron.  
4. Safety shoes meeting ASTM F2413 standards for impact and compression.  
     
   **Electrical Power Systems:**  
1. Dry clothing, Rubber-soled shoes  
2. Insulation Requirements for Testing Equipment: Probes used in testing equipment must be insulated according to the voltage they will encounter. Refer to 1910.334(c) for more details.  
3. Conditions for Using Rubber Insulating Gloves with Test Equipment:  
   1. Design of probe handles: Whether the design prevents the employee's hand from slipping off the insulated handle.   
   2. Risk of Contact with Energized Parts: Whether there are other exposed energized parts that the employee might touch during testing.

### Trainings:

All responsible personnel must complete the following training:  
1\. Hazard recognition and PPE use.  
2\. Proper handling, storage, and transportation of cryogenic nitrogen.  
3\. Maintenance and emergency response.  
4\. Periodic refresher courses as required.  
5\. Mandatory training by the UC Learning Center

#

# [**Packing List**](https://docs.google.com/spreadsheets/d/16C1kz_BpvP8wkC0Ce93b_k6i_3LQanvKAyopLm0bDVQ/edit?usp=sharing) **\- MAKE SURE DATE MATCHES**

| Avionics  | Misc. / Shared | Propulsion |
| ----- | ----- | ----- |
| Avionics Systems PCBs \- bagged and bubble wrapped MOSFET x2 HX711 x2 TC x2 Core Sense x2 Core Power x2 COM x2 Harnessing \- wrapped on foam board TC LC PT MOSFET COM \+ Switchboard Power Supply x2 Power Supply Leads x2 PC Case x2 Duct Tape \+ Bags for waterproofing COM Box  Extra GPIO Expanders x5 Extra ESP32 x5 Power Bank with MicroUSB x2 I\&C Solenoids x7 (attached to prop) Solenoid backshells x7 PT x6 (attached to HEX)  TC x4 (attached to harness) LC x3 Parts 15-pin DSUB M/F x4 20 AWG DSub Pins Breadboarding Wire Protoboards Header pins M/F Wagos Extra 20 AWG wire\!\! JST Crimps \+ Housing Tools & Materials Power strips x1 Crimping tools (JST \+ Dsub)  Wire Cutters  | Zipties xHELLA Sharpies x5 (min) Scissors x5 (min) Make sure they are sharp Box Cutter Masking/ Painters Tape Duct Tape Hot glue gun Super glue |  PPE Cryo Gear\!\! Face shields  Safety goggles  Gloves  Ear Plugs Tools   Propulsion Toolbox Ladder A table Wrenches  All kit  Adjustable  Hex keys  Metric  Imperial (x2)  Drills (check bits are in all hardware cases)  Charger  Extra batteries  Dremel \+ all bits PTFE Tape All tool kits  Screw drivers  Pliers  Vice Clamps Light Light Stand \+ Extra Bulbs Flashlights  Headlamps  Battery run night lights  Duct tape RTV Vice clamp  Large Black Zipties Small zipties  |

#  **Hotfire Pre-Procedures \-  RFS**

## **Fluid System Diagnostics**

Goals:

* Ensure fluid system will operate as predicted

Procedure:

1. Check that no extraneous fittings are present  
2. Ensure that check valves are mounted in the correct orientation.  
3. Ensure that regulators are mounted in the correct orientation.  
   1. HP should lead to high pressure  
   2. LP should lead to low pressure  
4. Double check *all* fittings and tighten as necessary  
   1. **Ensure that fittings are not overtightened**  
      1. A swage is overtightened if the pyramid shaped ferrule is deformed or if the two parts to the ferrule are so close that a fingernail can not fit between them.   
   2. To re-tighten swagelok fittings  
      1. Tighten to fingertight the swage nut onto the fitting  
      2. Using a wrench, tighten the fitting **1/12th of a turn only**  
      3. Any more turning that this will break the swagelok ferrule and require replacement of the ferrule. Tighter does not equal less leaky.   
   3. To redo any NPT fittings or pressure transducers  
      1. Make sure to use at least three full rotations of the teflon tape around the connection (anti-rotation \- clockwise looking at threads)  
5. Ensure everybody has the appropriate personal protective equipment (PPE).  
   1. This includes earplugs, safety glasses, and face shields   
   2. When necessary, gloves should be used.

## ---

## **Sensor Calibration/I\&C**

1. Pressure Transducer Calibration  
2. Thermocouple Calibration  
3. Actuator Checkoffs    
   1. Check the solenoid valve flow directions and starting positions. 

### 

## **Hotfire System Harness Prep**

- [ ] Test ALL wire connections. You should not be able to separate or damage any connections by pulling them very hard by hand.   
      - [ ] Wires/ crimps shouldn’t start fraying  
- [ ] Cable Management  
      - [ ] The harnesses should be bundled together by function (PT, LC, TC, Solenoid should each have their own harness). The cables that are a part of each bundle should be tied or zip tied together. Cable sheath recommended.  
      - [ ] Labels with the name of the **component from the P\&ID diagram** should be attached on **both ends** of each cable in the harness. 

## **Software/Communication Checks**

- [ ] System Operating Parameters(pressure thresholds, etc) updated for specific test operation   
- [ ] Operating computer and two backup computers have the updated code from Github. All computers can run the code successfully with all sensors and servos.   
- [ ] Perform zero-point calibration of Pressure Transducers.   
      - [ ] Connect sensors to PCBs. Ensure that reasonable values are being collected with the calibration constants we have found.   
- [ ] Complete one dry run: running through state and manually actuating valves according to procedures. Verify states and proper actuation twice.  
      - [ ] Data received from (7 Pressure Transducers, 3 High Pressure Transducers, 3 Load Cells, 4 Thermocouples, and 4 RTDs)  
      - [ ] Solenoid actuation and communication  
      - [ ] Trigger all failsafe modes like disconnecting server, disconnecting power to board, and emergency abort state

## ---

# Preparation Procedures 

(Completed in advance of Operating Test Day) AKA FRIDAY AT FAR 

## General Overview: 

- [ ] ### Place DAQ briefcase in position and place ground system in position 

- [ ] Plug in power to DAQ, ensuring 24V PSU is connected last, monitoring boot verifying that the correct server and state machine configurations are loaded.  
      - [ ] Plugs should be connected to Bunker Power rather than PAD to maintain access to cord to disconnect in case redundant emergency abort is required.  
- [ ] Setup harnessing/test communication   
      - [ ] Harnessing: safely tuck behind I Beam (think about anchoring and fireproof)  
- [ ] Organize DAQ in casings/Check off fluid system/Initiate Command Acquisition (parallel)  
- [ ] Dry run (parallel)  
      

## Night Before Procedures

- [ ] Mount TCs  
- [ ] Attach thrust frame assembly to I-beam  
- [ ] Anchor Tarp over Rocket and GSE Table  
- [ ] Pack boards away into the trailer, and anchor loose components  
- [ ] Clean tables:   
      - [ ] Put all laptops and power supplies and other avionics components away

## Ground Control Station Preparation Procedures

- [ ] ### DAQ Communication Verification

      - [ ] Make sure 2 backup laptops are ready to go  
- [ ] Solenoid Actuation Testing  
- [ ] Harnessing Check: Instrument labeling, as per Appendix A1.1 P\&ID  
- [ ] Software Check  
      - [ ] Operating Parameter Updates  
- [ ] Power System Check  
      - [ ] Charge Portable Battery  
      - [ ] Plug Portable battery into DAQ SENSE esp  
      - [ ] Turn on DAQ POWER Power Supply. LABEL PS “POWER”  
- [ ] Control system run through   
      - [ ] Setup full avionics instrumentation system.   
      - [ ] Run through states.   
            - [ ] Ambient-state accurate readings are being received. Pressure transducers, load cells, thermocouples  
            - [ ] Solenoids are being activated. 

##   Fluid System Prep Procedures

- [ ] Layout materials and unpack trailer  
      - [ ] Wheel out ground system  
      - [ ] Setup tables  
      - [ ] Grab wrenches, prop toolbox  
- [ ] Check relief valves pressures are appropriate  
- [ ] Check regulators to make sure they are outputting the expected pressure  
- [ ] Ensure that check valves are mounted in the correct orientation.  
- [ ] Ensure that regulators are mounted in the correct orientation.  
- [ ] Check that all valves are mounted as per P\&ID  
- [ ] Check fitting tightness with wrench throughout system (Careful as not to loosen any fittings)

      # Operating Procedures:

## Gear Up

### Location Setup

- [ ] Tested system is placed sufficiently far away or out of line of sight

# **Task Assignments**

| Aidan Rickert | DAQ setup |
| :---- | :---- |
| Gabe Guerrero | Ground system/instrumentation setup |
| Aahil Syed | ACTCOMM (Actuator Communications) |
| Aidan Rickert | ECOMM (Telemetry) |
| Theo Parker | VIDCOMM (Video) |
| Theo Parker | Media Ops |
| Carlos Bautista | LOx Fill |
| Carlos Bautista | Feed system/load cell calibration |
| Kush Mahajan | Control system setup |
| Adnan Kapadia | Valves/harnessing setup |
| Gabe Guerrero | GN2/High Press Fill |
| Gary Romero | Ethanol Fill |
| Manank Doshi | Operations Manager |

### Review System Assignments

- [ ] **Operations Manager**: Confirm Responsibilities

      ### Notify Site Officials \- Operations Manager, Safety Officer

- [ ] Review Procedure. Special Attention:  
      - [ ] Fluid Fill: Personnel Retreat  
      - [ ] Point of Contact during Hotfire Procedures:   
            - [ ] Procedures: Alec Miyashita  
            - [ ] Feed System: Carlos Bautista  
            - [ ] Fluid Fill: Gabe Guerrero, Carlos Bautista  
      - [ ] Avionics Event Procedures  
            - [ ] Aidan Rickert  
      - [ ] Abort Scenarios  
            - [ ] Adnan Kapadia

      ### Put On PPE

- [ ] All personnel present reference PPE requirements by role.  
- [ ] Comms Check: Safety Officer \- Operations Manager

## Pad Procedures Start

### Safety Officer Checkoffs

- [ ] Extraneous materials, personnel cleared   
- [ ] Secure items and fittings not essential to testing.   
      - [ ] Include but are not limited to gauges, hose lines, and avionics harnessing.   
- [ ] Confirm the tested system is properly fixed in the event of a pressurized gas decompression hazard. This refers to team system hardware, like strapping down of propellant tanks, diversion of relief valve outlets away from personnel and property, and torquing mounting bolts in place.  
- [ ] Confirm GSE (Ground Station Equipment) is set up safely.  
      - [ ] Pressurized bottles are secured or strapped down.  
      - [ ] Appropriate fluid lines are attached to the hardware system and secured.  
      - [ ] All electrical equipment and harnessing is grounded and environmentally proofed.  
      - [ ] Both System and GSE valves are in a safe state for beginning of operations  
      - [ ] All necessary control elements (valves, solenoids) are actuated and easily controllable by pad team, or control station team.   
- [ ] Ensure everybody has the appropriate personal protective equipment (PPE).  
      - [ ] Reference PPE requirements by role as stated previously.  
      - [ ] Any personnel remaining present must don safety glasses at a minimum and remain outside the minimum safe distance if not actively conducting operations.

### Ground Control Station Setup

Checkoffs by Instrumentation Technician

- [ ] ### Setup before testing: Sensor Calibration: 

      - [ ] Begin pressure transducer calibration procedure. Use ground system Hex with a COPV  
      - [ ] Pressure Transducers calibrated  
- [ ] COM Harnessing Check (reference Appendix diagrams)

- [ ] ### Harnessing

      - [ ] Ground System first (DAQ, solenoids)  
            - [ ] Build Upwards from the thruster to the ethanol tank  
                  - [ ] Make sure to shield everything  
            - [ ] Make sure all wires are connected and wagos/crimps are secure\!

- [ ] ### Software Setup: Appendix [A3.3: Communication & Software](#heading=h.lqdj7nz4xvyf)

      - [ ] Updated Software uploaded to DAQ  
      - [ ] Updated Software uploaded to COM  
      - [ ] GUI Run Check

- [ ] ### Power Setup

      - [ ] Plug Power Supply into DAQ POWER  
      - [ ] Power Electronics Setup  
            - [ ] Power Supply Placed, Corded   
            - [ ] Power DAQ power harness DISCONNECTED  
            - [ ] DAQ POWER: Supply Operating Parameters Set: **VOLTAGE LIMIT: 12V**  
                  - [ ] Power supply is in constant voltage mode  
      - [ ] Dry Runthrough  
            - [ ] DAQ power harness CONNECTED  
            - [ ] Energize DAQ POWER \- Call out ‘ENERGIZED’  
                  - [ ] Run through DAQ code on DEBUG mode  
            - [ ] Actuate states: check appropriate valve action

### Fluid System Set-Up

- [ ] ETH Main Valve  
      - [ ] Using a wrench, ensure that pneumatic valves fully open and close main valve  
      - [ ] Set pneumatic valve to closed position, marked with a marker on the pneumatic valve  
      - [ ] Connect pneumatic hose line to pneumatic valve in correct orientation determined by hose markings  
      - [ ] Ensure pneumatic hose connects back to the correct solenoid on the solenoid manifold (all labeled)  
- [ ] LOX Main Valve  
      - [ ] Using a wrench, ensure that pneumatic valves fully open and close main valve  
      - [ ] Set pneumatic valve to closed position, marked with a marker on the pneumatic valve  
      - [ ] Connect pneumatic hose line to pneumatic valve in correct orientation determined by hose markings  
      - [ ] Ensure pneumatic hose connects back to the correct solenoid on the solenoid manifold (all labeled)  
- [ ] Quick Disconnects:  
      - [ ] QDs connected (Female side on system, male side on fill)  
      - [ ] \*IF EXISTS\* Attach piston QD disconnect assembly and test assembly  
- [ ] ***SEAL ALL EXPOSED PORTS WITH TAPE IF TO BE LEFT OVERNIGHT***  
      

## Fluids Fill

### Fuel Fill \- Ref. A1.1 & A1.4

- [ ] Ensure system is in Armed state  
- [ ] Connect Fuel Fill Line between Fuel Tank and Transfer Tank  
- [ ] Open the Fuel Fill Valve and the Fuel Transfer Tank Vent   
- [ ] Pour a measured volume of 10 Liters into the transfer tank using a funnel  
- [ ] Close the Fuel Fill Valve and Fuel Transfer Tank Vent  
- [ ] Go to Fuel Fill State, pressurizing tank with 400 PSIG  
- [ ] Once venting gas is spotted from the Fuel Tank, disconnect QD, return system to Armed state, and open Fuel Fill Valve and Fuel Transfer Tank Vent

### Cryogen Fill 

- [ ] **CLEAR AREA.** Non-essential personnel are out of LOS  
      - [ ] Carlos Bautista, Safety Officer: **Don PPE**  
- [ ] **PREP SIGNAL**  
      - [ ] **Safety Officer: DAQ SENSE power energize check. (Make sure power supply ON)**  
      - [ ] **Control System Officer: Signal Continuity, Comms Check**  
- [ ] Connect GSE LOx fill JIC to LOx dewar  
      - [ ] Ensure all fill line connections are fully tightened (once met with significant resistance when using wrench to tighten, inspection required)  
- [ ] Connect GSE LOx fill QD to LOx tank  
- [ ] Turn valves to correct starting positions  
      - [ ] Fill line vent valve \- CLOSED  
      - [ ] Tank fill valve on feed system \- OPEN  
      - [ ] Tank vent valve \- OPEN  
      - [ ] Emergency vent valve \- CLOSED  
- [ ] Visually inspect valves for safety inspection.  
- [ ] Begin Fill  
      - [ ] Slowly open LOx Dewar liquid valve  
      - [ ] Monitor pressure gauges  
      - [ ] In case of leaks:   
            - [ ] If wrench accessible: Close LOx Dewar valve. Tighten fitting until leak stops. Open valve to continue filling.  
            - [ ] If tightening not resolving leak:   
                  - [ ] Close Cryo cylinder valve  
                  - [ ] Close Tank Fill Valve and simultaneously open hose vent valve.   
                        - [ ] Open transfer line vent valve  
                  - [ ] Disconnect fill line from tank fill valve.  
                  - [ ] Drain tank through connected GSE dump valve. Tighten fittings and re-attempt fill.  
      - [ ] LOx Dip Tube  
            - [ ] Once LOx reaches the holes in the dip tube, LOx cannot reach above that level and will vent out. Visually confirm fill through this mechanism.  
- [ ] Close LOx dewar Valve  
- [ ] Close the tank fill valve and simultaneously open transfer line vent valve.    
- [ ] \*IF EXISTS\* Disconnect LOx QD using QD Disconnect Piston

## Pad Closeout

- [ ] **Stow tools**: safely leave tools at ground system.   
      - [ ] Fluid System Technician: Remove gloves, grab Multimeter  
- [ ] **Power, Signal Check**  
      - [ ] Safety Officer: DAQ POWER Energize. Monitor Current Draw. IF CURRENT: Troubleshoot MOSFET Connection  
      - [ ] **Avionics Control Officer**: Remote Signal Check  
      - [ ] Safety Officer: De-Energize Ground System  
- [ ] **High Pressure Supply Set**: Fluid System Technician  
      - [ ] Connect high-pressure K-bottle to GSE system, set regulator to 4500 psi  
- [ ] Low Pressure Supply Set: Fluid System Technician  
      - [ ] Connect low-pressure K-bottle to GSE system, set regulator to 150 psi  
- [ ] **Power, Ignition Closeout**:  
      - [ ] All rocket-side solenoids connected. Pneumatic hoses all connected.  
      - [ ] All ground system solenoids and pneumatic hoses connected.  
      - [ ] Test Igniter Voltage  
      - [ ] Hook up igniter  
- [ ] **Isolate Tanks, Clear Pad**  
      - [ ] **Safety Officer:** Energize System  
      - [ ] **Avionics Control Officer**: **ABORT SYSTEM** to open tank vents  
      - [ ] **Pad Team: Clear Pad**  
            

## HOTFIRE ATTEMPT

### Remote Pressurization

- [ ] **Safety Officer**: Clear Pad Confirmation  
- [ ] **Isolate Tank**: Command to Idle (close vents)  
      - [ ] Stable Pressure Check  
- [ ] **Arm System**  
      - [ ] State Conformity Check  
- [ ] **Pressurize System**  
      - [ ] Tank Pressures Stabilized: Indicator Flag  
      - [ ] OVERPRESSURE: ABORT SYSTEM  
      - [ ] Pressures Below Nominal: Return to Idle. Attempt Press.  
- [ ] **Quick-Disconnect**  
      - [ ] Stable Pressure Check  
- [ ] **IGNITE**  
      - [ ] IGNITION VERBAL CHECK \- Instrumentation Technician  
- [ ] **HOTFIRE: MAIN VALVES OPEN**  
      - [ ] Control System Technician: Monitor System Pressures  
      - [ ] ANOMALY: ABORT SYSTEM  
- [ ] Safe System: See Below

### ABORT EVENT

- Cases:  
  * Sensor Connectivity Loss  
  * Pressurization fails to complete  
  * Unintended Actuation of Valves/ MOSFETs occurs   
  * Failed Actuation of Valves/MOSFETs  
  * Passive Relief Valve Actuates

- Procedure:   
  * Allow system to vent tanks to threshold safe pressure  
  * To return to ‘Idle’ State once tanks vented  
    * Flip all state switches to OFF   
    * Turn off Abort  
  * Fluid System Technicians: Don PPE  
    * Approach and switch tanks to manual venting.  
    * Drain manually through GSE dumps.

### System Safing

- [ ] Command System to **ABORT** to remotely open vents  
- [ ] System below 25psi: Safe to approach  
      - [ ] Fluid System Technician: Open manual vents  
      - [ ] Avionics Control Officer: Command return to Idle  
      - [ ] Safety Officer: De-Energize Power Electronics  
- [ ] Inspect System  
      - [ ] Check data file saves  
      - [ ] Examine fluid system components  
- [ ] Debrief  
      - [ ] Team Meeting: Test Result Analysis/Debrief  
      - [ ] Prepare for subsequent test/disassembly

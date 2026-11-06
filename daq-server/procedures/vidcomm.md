# VIDCOMM (Video) Checklist

*Role: Ensure video cameras are set up and connected to server properly. Work with Mission Control Manager to confirm angles and provide live visual oversight of pad operations.*

## Setup
- [ ] Setup camera monitoring stations focusing on pad, engine, tanks, and GSE. We have 4 cameras from RFS, 2 DGI cameras, and our insta 360. One person must also be on the drone.
- [ ] Verify clear line of sight to chamber/injector, vents, and GSE.
- [ ] Ensure cameras are connected to a central server (the video gateway):
  - Workspace: the gateway starts with the stack (`sensor-video`); nothing to do.
  - Desert: on the media Mac run `daq-server/scripts/media-laptop.sh` (lid open, charger in). On the DAQ laptop: Video view > Edit > Gateway = the name it prints, plus the gateway password.
  - HiDes link: in HiDes Viewer press Start and turn on Send to UDP (`localhost:5600` on the media Mac).
  - Wired LAN for the media Mac and the bunker screens wherever possible.
- [ ] Verify live stream feed is visible in Mission Control: Video view, every tile **LIVE** (green). Amber **STALE** = frozen picture; grey **OFFLINE** says why.
- [ ] **TELL MISSION CONTROL MANAGER TO CONFIRM CAMERA ANGLES.**
- [ ] Adjust angles per Mission Control feedback.
- [ ] Check camera batteries.
- [ ] Confirm backup power sources available or if they need to be charged.
- [ ] Confirm weatherproofing and cable protection.
- [ ] Confirm every critical camera is marked "include in recording" (Edit), so it is in the 5-minute buffer.
- [ ] Check disk left on the Recording controls panel (Record is refused below 20 GB free).
- [ ] Press **Record**; confirm the white **REC** on each critical tile before proceeding.

## Dry Run & Testing
- [ ] Confirm with Mission Control Manager which camera views are critical for dry run (pad overview, engine close-up, tanks, vents, GSE).
- [ ] Verify that all requested views are visible and labeled correctly in Mission Control.
- [ ] Perform a brief motion test (pan/tilt/zoom or drone repositioning) to confirm:
  - [ ] No blind spots on critical hardware.
  - [ ] No major glare or occlusion.
- [ ] **TELL MISSION CONTROL MANAGER WHEN VIDEO COVERAGE IS VERIFIED FOR DRY RUN AND PRESS PROOF.**

## Press Proof
- [ ] Maintain live visual on pressurized hardware (tanks, lines, regulators, vents) during press proof.
- [ ] Watch specifically for:
  - [ ] Leaks or unexpected frost.
  - [ ] Uncommanded motion of lines, valves, or structures.
  - [ ] Unsafe proximity of personnel to vents or pressurized hardware.
- [ ] **TELL OPERATIONS MANAGER AND PAD MANAGER IMMEDIATELY IF ANY VISUAL ANOMALY IS OBSERVED DURING PRESS PROOF.**

## Fill
- [ ] Real-time monitoring for physical anomalies (e.g., leaks, venting locations, hardware movement).
- [ ] **TELL LOX FILL OPERATOR UPON VISUAL CONFIRMATION OF LOX FILL.**
- [ ] Ensure continuous recording.
 - [ ] **TELL OPERATIONS MANAGER AND PAD MANAGER IF ANY LEAK, ABNORMAL FROST, OR HARDWARE MOTION IS OBSERVED DURING FUEL OR LOX FILL.**

## Hotfire
- [ ] **BREAK HERE. WAIT FOR HOTFIRE ATTEMPT / IGNITION SEQUENCE FROM MISSION CONTROL.**
- [ ] Monitor ignition spark and flame establishment.
- [ ] Monitor main valves opening.
- [ ] Watch for structural movement or hardware failure.
- [ ] Continue recording until system is safed.
- [ ] Maintain recording through safing and venting.
- [ ] Press **Stop**; confirm the note names every stream and shows no gaps (files land in `daq-server/video/recordings/` on the gateway machine). Missed the moment? **Save last 5 min** keeps the buffer.
- [ ] Back up video files if required: copy the recording's folder off the gateway machine.
- [ ] **TELL OPERATIONS MANAGER OF ANY VISUAL ANOMALY ENCOUNTERED BEFORE, DURING, OR AFTER TEST.**

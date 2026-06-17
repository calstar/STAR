# ADC Distortion & Messages Not Reaching Elodin — Diagnostics

## Problem Summary

1. **Zero point reading 200–300 PSI** — When the sensor is at 0 PSI (vented/atmospheric), the system displays ~200–300 PSI. On "femboy" (reference), ADC codes and calibration behave correctly.
2. **Messages not reaching Elodin** — Data appears to be lost; the relay subscribes to the DB but the DB doesn't have everything.
3. **Spikes** — Symptom of the above rather than a separate issue.

---

## Pipeline Overview

```
PT Board (DiabloAvionics) → UDP :5006 → daq_bridge
  → DiabloBoardPacketParser (plain, NO encryption)
  → SensorRouter.route_pt_samples (raw to Elodin)
  → SensorRouter.route_pt_samples_calibrated (daq_bridge inline calibration)
  → Elodin DB (if elodin_client connected)
  → Relay (single subscriber) → Backend → Frontend
```

**Important:** The daq_bridge uses **DiabloBoardPacketParser** — plain DiabloAvionics format. It does **not** use EncryptedFrame / XOR decryption. If your boards send encrypted packets (different protocol), the daq_bridge will fail to parse them and nothing reaches Elodin.

---

## Likely Causes of 0 PSI → 200–300 PSI

### 1. **Calibration coefficient / format mismatch**

The daq_bridge C++ `PTCalibrationManager` uses:
```
psi = A*adc³ + B*adc² + C*adc + D
```
with **raw ADC** (e.g. 500M–1.1B range).

- **Femboy** may use a different formula (e.g. normalized x in [0,1], or polynomial in different variable).
- If femboy’s calibration GUI produces coefficients for normalized ADC but daq_bridge uses raw ADC, results will be wrong.
- **Check:** Compare the calibration formula in femboy vs. daq_bridge C++ `PTCalibration.cpp` and backend `calibration.ts`.

### 2. **Calibration source mismatch**

daq_bridge loads calibration from:
1. `scripts/calibration/calibrations/*.json` (JSON from calibration GUI)
2. `firmware/PT_Board/Calibration/PT Calibration Attempt 2026-02-04_test2.csv`

The backend loads from `config.calibration.pt.json_path` (e.g. `scripts/calibration/calibrations/...`).

- If daq_bridge and backend use different calibration files/coefficients, they can disagree.
- If the C++ calibration was created on femboy and copied here, but the **ADC scale or format** differs (e.g. 24‑bit vs 32‑bit, or different reference), the same coefficients will produce wrong PSI.

### 3. **Channel ID / unique ID mapping**

- daq_bridge / Elodin packet low byte: **local** connector id **1–10** per board slot (`(board_number-1)*0x20 + channel`).
- PTCalibration JSON keys: `"1"`, `"2"`, … — typically per-board connector.
- The GUI’s `sensor_roles_pt2` reverse map adds **+10** to keys only so HP PT role lookups don’t collide with board 1 in that legacy map (hardcoded in TypeScript; not a config.toml knob).

### 4. **ADC byte order or interpretation**

- DiabloBoardPacketParser: `read_le_u32` for the datapoint value.
- Boards (ESP32/Arduino) are usually little-endian.
- If a board sends big-endian or a different layout, ADC values will be misinterpreted and produce large errors.

---

## Likely Causes of Messages Not Reaching Elodin

### 1. **Packet format mismatch**

daq_bridge expects DiabloAvionics SENSOR_DATA:
- Header: `packet_type(1)=3`, `version(1)`, `timestamp(4 LE)`
- Body: `num_chunks(1)`, `num_sensors(1)`, then per chunk: `timestamp(4 LE)` + per sensor: `sensor_id(1)`, `data(4 LE)`.

If the board firmware:
- Uses encryption (e.g. XOR) — parsing will fail.
- Uses a different packet type or layout — `parse_packet_type` or `parse_sensor_data` returns null and the packet is dropped.
- Sends a different packet type first — only type 3 (SENSOR_DATA) and 1 (BOARD_HEARTBEAT) are handled; others are ignored.

### 2. **Parse failure = no publish**

When `parse_sensor_data` returns null or invalid, the daq_bridge does not publish. Packets are dropped with no log. There is no per-packet parse-failure logging in the C++ path.

### 3. **Publish allowlist**

Config `[daq_bridge] publish = ["pt_raw", "pt_calibrated", ...]` and `[routing.*]` control what gets published. If a packet_id is not in the allowlist, it is not sent to Elodin.

### 4. **Elodin single-subscriber behavior**

Elodin streams to the first subscriber only. If the relay connects after another client, or the relay disconnects, data flow can stop or go to the wrong client.

### 5. **daq_bridge not connected to Elodin**

If `elodin_client.is_connected()` is false, `publishing` is false and no data is written to the DB. Check daq_bridge logs for connection status.

---

## Debugging Steps

### Step 1: Confirm packet format

Run with a known-good source (e.g. board_simulator) that sends plain DiabloAvionics:

```bash
./scripts/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006
```

If the simulator produces correct-looking data in the GUI but real boards do not, the real boards are likely sending a different format.

### Step 2: Capture and inspect raw UDP

```bash
sudo tcpdump -i any -X udp port 5006 -w /tmp/pt_capture.pcap
# Run for a few seconds with boards sending, then:
tcpdump -r /tmp/pt_capture.pcap -X | head -100
```

Check:
- First byte = 3 (SENSOR_DATA)?
- Is the payload readable, or does it look XORed/garbled?
- Byte order of the 4-byte ADC value in each datapoint.

### Step 3: Add daq_bridge parse-failure logging

In `SensorFramePipeline.cpp`, when `parse_sensor_data` returns null, log the packet type and size so you can see what is being dropped.

### Step 4: Compare calibration formulas

- Femboy: which formula (raw ADC vs normalized, which variable)?
- daq_bridge PTCalibration: `psi = A*adc³ + B*adc² + C*adc + D` with raw `adc`.
- Backend calibration.ts: supports both raw and normalized; ensure the same convention is used end-to-end.

### Step 5: Verify zero-point ADC

With the sensor at 0 PSI (vented):
- What ADC value does femboy show?
- What ADC value does this system show (raw_adc_counts in the UI or logs)?
- If the ADC values match but PSI differs, the issue is calibration. If the ADC values differ, the issue is packet parsing or a different board firmware.

---

## Quick Checks

| Check | Command / Location |
|-------|--------------------|
| daq_bridge receiving | Look for "Frames decoded" or packet stats in daq_bridge stdout |
| Elodin connected | daq_bridge startup: "Elodin connected" |
| Relay connected | Backend: "[Relay] packets received" |
| Parse failures | Backend: `ELODIN_DEBUG=1` for more "[Relay] TABLE packet not parsed" logs |
| Calibration loaded | daq_bridge: "[PTCalibration] Loaded N calibrations" |
| Packet format | tcpdump raw UDP; first byte = 3 for SENSOR_DATA |

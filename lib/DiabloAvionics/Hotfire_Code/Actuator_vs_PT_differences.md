# Actuator vs PT: differences that could explain config received only on actuator

## 1. **Same hardcoded board ID → IP conflict (most likely)**

- **Config:** Both use `hotfire_config.h`. You must define `BOARD_ID` appropriately for each board at compile time.
- **Actuator:** `staticIP = 192.168.2.22` (when hardcoded).
- **PT (SensorHotfireCore):** `s.staticIP = 192.168.2.22` (same).

If both boards are flashed with this config, **both try to use 192.168.2.22**. Only one can own that IP on the LAN. The other either fails to get link or shares the IP and only one receives traffic. So when the server sends to “PT” at 192.168.2.22, that might be the same IP as the actuator; the actuator gets the packet and the PT never does.

**Fix:** Give PT and actuator different board IDs (e.g. actuator 21, PT 22), by defining `BOARD_ID` via their respective platformio.ini files or build scripts.

---

## 2. **SPI initialization**

| Board   | Code |
|--------|------|
| Actuator | `SPI.begin(ETH_SCLK, ETH_MISO, ETH_MOSI, ETH_CS);` then `Ethernet.init(ETH_CS);` |
| PT      | `SPI.begin(ETH_SCLK, ETH_MISO, ETH_MOSI);` then `Ethernet.init(ETH_CS);` — do not use 4-arg on PT (crashes; PSRAM/ESP32-S3 conflict) |

Actuator passes `ETH_CS` into `SPI.begin()`; PT does not. On ESP32, `Ethernet.init(ETH_CS)` is what matters for the W5500 CS. So this is a small difference and less likely to be the cause, but if the PT’s Ethernet is flaky, trying the 4-arg `SPI.begin(..., ETH_CS)` in the sense core is worth a try.

---

## 3. **Loop structure**

- **Actuator:** `updateLedNonBlocking()` → `updatePWM()` → `udp.parsePacket()` → state switch (e.g. `run_WaitingForServer()`) → heartbeat check → `delay(LOOP_DELAY_MS)`.
- **PT:** `s.udp.parsePacket()` first → then state work → `updateStateLed()` → heartbeat check → `delay(LOOP_DELAY_MS)`.

Both check UDP early; neither blocks in `WaitingForServer`. So loop order does not explain “actuator sees packet, PT never does.”

---

## 4. **UDP port and packet type**

- Both listen on **5005**.
- Actuator expects **ACTUATOR_CONFIG (type 6)**; PT expects **SENSOR_CONFIG (type 5)**.
- If the server sends the right packet type to the right IP, the only way the actuator sees a packet and the PT does not is that the packet is sent to the actuator’s IP, not the PT’s. That is consistent with an IP conflict where both think they are 192.168.2.22 and only the actuator is actually receiving for that IP.

---

## 5. **Summary**

| Item              | Actuator              | PT                    |
|-------------------|-----------------------|------------------------|
| Port              | 5005                  | 5005                   |
| Config packet     | ACTUATOR_CONFIG (6)   | SENSOR_CONFIG (5)      |
| Board ID source   | hotfire_config.h      | hotfire_config.h       |
| TEMP_HARDCODE_ID  | 22 → 192.168.2.22     | 22 → 192.168.2.22      |
| SPI.begin         | 4 args (incl. CS)     | 3 args                 |
| Loop delay        | 10 ms                 | 10 ms                  |

The only difference that clearly explains “actuator gets config, PT never prints” is **both using 192.168.2.22** when both are running. Fix by giving the PT a different board ID (and thus IP) than the actuator.

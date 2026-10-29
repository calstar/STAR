# Datasheet-backed self-test checks

Reviewed October 29, 2026 against `inez/flight_computer` at `f8e110d5`. [Inez's answers in #137](https://github.com/calstar/STAR/issues/137#issuecomment-6486161496) confirm the first-spin components and intended behavior. Commit `550e5483` updates the CubeMX configuration but explicitly leaves generated C regeneration outstanding. Board arrival is expected around November 6; these checks have only been exercised on a host.

The [component page](https://starberkeley.notion.site/Flight-Computer-components-3be50d7304ab806498d3cb20449516c2), manufacturer datasheets, and Inez's board review establish the map below. Routing is recorded in [`firmware.ioc`](../firmware.ioc). Generated [`main.c`](Src/main.c) still has old defaults.

## Component map

| Component in supplied documentation | Branch connection | Implemented check / remaining gap |
| --- | --- | --- |
| STM32H723VET6 | CubeMX target; CMSIS-RTOS v2 scaffold | Portable coordinator and device protocols. Target build and task integration remain. |
| ISM330DHCX IMU | SPI3, `IMU_CS` PD7 | Read WHO_AM_I, require `0x6B`. |
| H3LIS331DLTR high-g accelerometer | SPI3, `ACCEL_CS` PD6 | Read WHO_AM_I, require `0x32`. One high-g accelerometer confirmed. |
| MS5611-01BA03 barometer | SPI3, `BARO_CS` PD5 | Read all eight PROM words; reject blank contents and verify CRC4. |
| W5500 Ethernet | SPI2, `ETH_CS` PE14, reset PE13, interrupt PE15 | Read VERSIONR, require `0x04`. No cable/IP/network test. |
| Seeed Wio-SX1262 LoRa module | SPI1, CS PC4, BUSY PC5, reset PB0, RF switch PB1, DIO1 PB2 | GetStatus and GetDeviceErrors; validate modes and reject reported faults. No RF transmission or link test. |
| MAX-M10S-00B GNSS | UART9 PD14 RX / PD15 TX, configured 38400 baud | Valid checksum UBX/NMEA frame is sufficient, no fix needed. UART adapter/parser remain. I2C4 is spare J4. |
| Zetta ZDSD01GLGEAG SD NAND | SPI4 PE2 SCK / PE5 MISO / PE6 MOSI; CS PE4 | SD-card protocol, not raw SPI NAND. Read-only initialization/CID driver remains. |
| THGBMTG5D1LBAIL 4 GB eMMC | SDMMC1 PC8–PC12 / PD2, reset PA8 | Read CID/EXT_CSD; write and read back the actual report. Driver and record allocation remain. |
| 2S 7.4 V nominal / 8.4 V full, 2000 mAh battery | PA0, ADC1 INP16, 16-bit, measures VDD after ORing | Raw-count interface exists. Battery adapter must distinguish USB using PE10 SW_ST before interpreting counts. |

SPI1 routes PA5/PA6/PA7 (SCK/MISO/MOSI), SPI2 PB10/PC2_C/PC3_C, and SPI3 PB3/PB4/PB5. These are firmware pin assignments, not independent verification of board traces.

## Implemented transactions

[`self_test_devices.c`](Src/self_test_devices.c) uses an injected SPI exchange callback. Tests inspect the wire bytes and inject replies. All frames use eight-bit, MSB-first transfers. The clock values below are ceilings, not recommended board operating rates.

| Device | Transmit bytes | Read / acceptance | Requested mode; maximum clock |
| --- | --- | --- | --- |
| ISM330DHCX | `8F 00` | Second byte `6B` | 3; 10 MHz |
| H3LIS331DL | `8F 00` | Second byte `32` | 3; 10 MHz |
| MS5611 | Eight separate frames, `A0 00 00` through `AE 00 00` | Last two bytes of each frame, high byte first; CRC4 | 3; 20 MHz |
| W5500 | `00 39 00 00` | Fourth byte `04`; common register block, read, variable-length mode | 0; 80 MHz |
| SX1262 | `C0 00`, then `17 00 00 00` | Status in second byte of both frames; error word in last two bytes of second frame | 0; 16 MHz |

The barometer check clears the entire low byte of PROM word 7 for CRC calculation and compares against its original low nibble. It rejects all-zero and all-ones PROM contents even if a checksum could match. A matching checksum establishes readable calibration data, not valid pressure measurements.

The radio check accepts documented chip modes 2–6 and rejects command timeout, processing error, and execution failure status codes. It preserves the error register and fails on any nonzero error word, including unknown bits. Unused command-status values do not establish identity. This is a status check for an assumed SX1262 binding, not a unique chip identifier. Existing latched faults remain visible until the application diagnoses them.

Sensor identity reads do not exercise built-in mechanical self-test, measure noise, or establish sensor accuracy. Model selection still comes from the assembly BOM.

## Adapter requirements

Initialize `self_test_devices_t` with an exchange callback and its context. Enable only verified devices in `configured_mask` using `SELF_TEST_DEVICE_ENABLED(id)`. The probe function matches `self_test_port_t.probe`; use a board-context wrapper when combining it with battery/publication callbacks. Device IDs are declared in [`self_test_devices.h`](Inc/self_test_devices.h). Unsupported GNSS/NAND/eMMC IDs return `NOT_IMPLEMENTED`; disabled bindings return `NOT_CONFIGURED`.

The exchange callback must select the correct bus/CS, enforce mode and clock ceiling, and use eight-bit transfers. Assert and release CS separately for each frame. Respect datasheet CS setup/hold and inter-command timing. The entire batch shares one deadline, including lock acquisition, BUSY waits, transfers and cleanup. Return `PASS` only after receiving every byte; propagate failures and partial transfers. The adapter must release CS, locks and transfers before returning. Check SX1262 BUSY before each command and return a bounded timeout if it stays high.

The board must complete power/reset initialization before enabling checks. MS5611 requires its startup reset and at least 2.8 ms for PROM reload. SX1262 must already be awake. These probes do not reset devices, change sensor settings, write storage, transmit radio packets, or clear faults. Static caller-owned scratch avoids large allocations on the default task's 512-byte stack. Measure stack and execution time on the target before enabling the task.

## Confirmed integration requirements

- Configure SPI1/2/3/4 for eight-bit frames. Intended mode/prescaler pairs are 0/16, 0/8, 3/16, and 0/256 respectively. SPI3 is shared and serialized under the seam. Its operating rate is about 8 MHz even though the barometer alone permits 20 MHz. SPI4 starts at 250 kHz for SD initialization.
- Board initialization owns HAL handles, rails and resets. Enable GPS PE11, wait for its rail, then release its open-drain reset. Keep GPS_INT PD10 an input. Release radio/Ethernet/eMMC reset through their drivers. Initialize the Wio module's DIO3 TCXO before calibration; bound every BUSY wait. Keep SWO disabled because PB3 is SPI3 SCK.
- Self-test runs once at boot and always advances to Idle, including on failure, within 30 seconds. Set `probe_max_attempts = 3` and use 500–1000 ms heartbeats. The coordinator's `probes_complete` flag includes optional devices and is independent of `probes_outcome`. Its default 29-second probe deadline leaves time for the caller's handoff; it does not guarantee report storage/transmission within the remaining second.
- Heartbeats and the self-test report go to the ground station over LoRa. Publication succeeds only on bounded TxDone, with no ground-station ACK. Sleep, RTC/LSI wakeups, PLL restoration, and the roughly ten-second Idle heartbeat belong to the state machine.
- PA0 reads post-ORing VDD through 22k/10k (factor 0.3125), buffered by TLV9004. Nominal conversion is `counts / 65535 * 3.32 / 0.3125` volts. Inez assigns conversion and thresholds to the battery adapter. The updated `.ioc` selects 387.5-cycle sampling. USB power must not be reported as battery health.
- SD NAND uses at least 74 clocks with CS high, then CMD0, CMD8, ACMD41, CMD58 and CID at the initialization rate. eMMC uses SDMMC1 four-bit mode. Its write test is the persisted self-test report followed by readback. Neither storage driver exists in this module.

## Remaining work and pointed questions

1. **Target generation (Inez/board layer):** regenerate with CubeMX 6.18.1, FW_H7 V1.13.0, CMake and arm-none-eabi-gcc, and commit HAL/CMSIS/RTOS, startup, linker and build dependencies. The current `.ioc` still selects EWARM and needs the agreed HSE/PLL, RTC/LSI and USB device-only changes. Generated C still uses four-bit SPI, 115200 UART and 1.5-cycle ADC sampling. Do not run the scaffold as if it matches the corrected `.ioc`.
2. **Radio (Ryan):** what exact byte layout, sequence width and checksum represent heartbeat and report packets? Implement bounded TxDone transport and the C coordinator adapter. The C++ radio header remains declarations only. Define how its driver service owns asynchronous transmissions while callbacks remain bounded.
3. **Report storage:** who owns the eMMC report record schema, allocation and write/readback interface? The state machine must bound both storage and report delivery without waiting forever before Idle. `probes_complete` only completes the inventory scan; it does not claim those jobs succeeded. Per-device measurements and pass/warn/fail presentation also need the report schema; the present SPI probes report identity/CRC/status diagnostics, not calibrated sensor measurements.
4. **Battery:** which SW_ST logic level identifies battery versus USB, and what calibrated reference should the adapter use? The 7.0 V warning / 6.6 V failure levels are proposals, not approved thresholds.
5. **GNSS:** verify the module's actual startup baud. Inez selected 38400; the supplied MAX-M10S R03 datasheet lists 9600. A 9600 fallback was proposed but is not yet an agreed startup policy. UART-only routing and no-fix acceptance are settled.
6. **Arm policy:** approve required versus warning-only devices. Self-test-to-Idle behavior is settled; the proposed required list must not become an arming gate without a team decision. Pyro continuity remains a separate bench-validated check with eFuses off; this module never enables or fires outputs.

## Evidence

Page numbers below are printed PDF pages. Attached files were retrieved through the Notion component page; the broken radio link required a mirror of the manufacturer's document.

- STM32 attachment: **DS13313 Rev 5**, May 2025, STM32H723VE/VG/ZE/ZG. Confirms the MCU family and peripheral capabilities; pin routing above comes from the branch.
- ISM330DHCX attachment: **DS13012 Rev 7**, p. 15 SPI timing, pp. 21–22 SPI framing, p. 48 WHO_AM_I.
- [ST H3LIS331DL datasheet](https://www.st.com/resource/en/datasheet/h3lis331dl.pdf), **DS9012 Rev 5**, p. 6 clock limit, pp. 14–16 SPI protocol, p. 18 identity (`0x32`). The existing identity transaction applies to the confirmed model.
- [TE MS5611-01BA03 datasheet](https://www.te.com/commerce/DocumentDelivery/DDEController?Action=srchrtrv&DocNm=MS5611-01BA03&DocType=Data%20Sheet&DocLang=English&DocFormat=pdf&PartCntxt=MS561101BA03-50), pp. 10–12 reset/PROM protocol. [Measurement Specialties AN520](https://www.amsys-sensor.com/downloads/notes/MS5XXX-C-code-example-for-MS56xx-MS57xx-MS58xx-AMSYS-an520e.pdf), **AN520_004**, pp. 4 and 12 CRC algorithm and independent `0xB` test vector.
- [WIZnet W5500 datasheet](https://docs.wiznet.io/img/products/w5500/W5500_ds_v110e.pdf), **v1.1.0**, pp. 14–17 framing/control, p. 43 VERSIONR, p. 61 SPI timing.
- [Semtech SX1261/2 datasheet, manufacturer document hosted by Heltec](https://resource.heltec.cn/download/WiFi_LoRa_32_V4/datasheet/SX1261_2%20V2-2.pdf), **Rev 2.2, December 2024**, pp. 52–54 SPI/BUSY timing, pp. 100–101 status/error commands.
- GNSS attachment: **MAX-M10S Data sheet, UBX-20035208 R03**, p. 15 default interfaces. Inez confirms this model; its default-baud statement differs from the selected board configuration.
- [Attached battery specification](https://cdn-shop.adafruit.com/product-files/328/LP785060+2500mAh+3.7V+20190510.pdf), **LP785060, 2019-05-10**, pack ratings. Compare with the [LE4 power spreadsheet](https://docs.google.com/spreadsheets/d/1tyYbt6XD5iS_GJZ6tv6fDYZUHLUtJRz1r1y-2zEd8c4/edit?gid=304511797#gid=304511797).

## Validation

The host suite compiles the production coordinator and device-check sources with warnings as errors. Protocol tests cover exact commands/modes/clock ceilings, response byte positions, wrong identities, blank PROM, the manufacturer's CRC vector, single-bit calibration corruption, radio status/error handling, unconfigured devices, transport errors, and coordinator reset. Run the commands in [README.md](README.md) with sanitizers and in Release configuration. Hardware timing, electrical behavior and target integration remain unverified.

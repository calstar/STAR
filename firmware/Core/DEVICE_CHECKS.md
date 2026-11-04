# Datasheet-backed self-test checks

Reviewed on October 19, 2026 against `origin/inez/flight_computer` at `d8c5c06ae5bfecc1a927a044371915037cf9a025`. Work lives on `pranay/self-test-driver-seam`.

The [component page](https://starberkeley.notion.site/Flight-Computer-components-3be50d7304ab806498d3cb20449516c2) supplies component candidates and datasheets. The branch supplies routing in [`main.h`](Inc/main.h), [`stm32h7xx_hal_msp.c`](Src/stm32h7xx_hal_msp.c), [`main.c`](Src/main.c), and [`firmware.ioc`](../firmware.ioc). Combining these sources gives the map below; a schematic or confirmed assembly BOM must establish the actual populated parts.

## Repository follow-up: October 28, 2026

Inez merged [self-test PR #138](https://github.com/calstar/STAR/pull/138) into `inez/flight_computer` on October 26 as `88ca4c0d`. The hardware questions in [issue #137](https://github.com/calstar/STAR/issues/137) remain unanswered. The following related work exists on other branches; it does not establish board wiring or replace the missing target build.

| Related work | What it establishes | Self-test integration decision |
| --- | --- | --- |
| [Radio API #139](https://github.com/calstar/STAR/pull/139), merged into `main` as `333d3332` | C++11 `radio_link::radio_probe`, `radio_receive`, and `radio_send` declarations in `firmware/Flight_Computer/src/radio.h`; SX1262 command-link intent | Share the eventual radio driver through a C-compatible adapter. Do not provide another competing radio implementation. The header has no implementation, deadline argument or delivery guarantee. |
| [ISM330DHCX driver #140](https://github.com/calstar/STAR/pull/140), open at `02656fc2` | Register-level read/write callbacks and WHO_AM_I `0x6B`, consistent with our identity check | Reuse the eventual bus owner, but retain a read-only identity probe. Do not call `ism330dhcx_init` from self-test: it resets and reconfigures the sensor. This proposed driver is not yet a dependency of the flight-computer branch. |

The current radio header explicitly permits `radio_send` to do nothing and return `Ok`. Therefore an adapter must not translate that return value into `publish_status = PASS`. Keep publication unsupported until the driver actually sends and the team defines its delivery criterion. Likewise, `radio_probe()` has no execution-time contract; calling it inside a bounded coordinator callback requires a driver deadline guarantee or a separate service that owns the operation and exposes a cached result.

The proposed IMU read callback also has no budget argument. Its adapter must enforce the coordinator's remaining deadline at the bus layer and serialize access with acquisition/MLC operations. Raw SPI identity reads assume the main register bank is selected; ownership must prevent them from racing with register-bank changes.

A host reproducer against #140 at `02656fc2` held the reset bit high for every read. `ism330dhcx_software_reset` returned `0` (success), instead of `ISM330DHCX_ERR_TIMEOUT` (`-4`): the unsigned `while (timeout--)` counter wraps when exhausted. The reset loop also ignores read errors. Before using that initializer, its owner should fix timeout/error handling and add stuck-reset, last-poll-success and read-failure tests. This finding concerns the proposed IMU driver; our existing read-only identity check does not call that function.

Next integration work remains: supply a complete STM32 build, confirm the populated parts and startup settings, implement bounded bus/ADC adapters, define heartbeat delivery and required-device policy, then validate on hardware. A merged portable-check PR is not evidence that these steps are complete.

## Component map

| Component in supplied documentation | Branch connection | Implemented check / remaining gap |
| --- | --- | --- |
| STM32H723VET6 | CubeMX target; CMSIS-RTOS v2 scaffold | Portable coordinator and device protocols. Target build and task integration remain. |
| ISM330DHCX IMU | SPI3, `IMU_CS` PD7 | Read WHO_AM_I, require `0x6B`. |
| H3LIS100DL high-g accelerometer | SPI3, `ACCEL_CS` PD6 | Read WHO_AM_I, require `0x32`. Confirm model: purchase link names H3LIS331DL. |
| MS5611-01BA03 barometer | SPI3, `BARO_CS` PD5 | Read all eight PROM words; reject blank contents and verify CRC4. |
| W5500 Ethernet | SPI2, `ETH_CS` PE14, reset PE13, interrupt PE15 | Read VERSIONR, require `0x04`. No cable/IP/network test. |
| SX1262 LoRa radio | SPI1, CS PC4, BUSY PC5, reset PB0, RF switch PB1, DIO1 PB2 | GetStatus and GetDeviceErrors; validate modes and reject reported faults. No RF transmission or link test. |
| GNSS: SAM-M10S heading, MAX-M10S-00B attachment | Candidate UART9 PD14 RX / PD15 TX; I2C4 PD12 SCL / PD13 SDA | Peer wiring unconfirmed. No probe implemented. |
| NAND, model unspecified | SPI4 PE2 SCK / PE5 MISO / PE6 MOSI; CS PE4 | Need exact part and datasheet. No generic JEDEC command assumed. |
| THGBMTG5D1LBAIL eMMC | SDMMC1 PC8–PC12 / PD2, reset PA8 | Document link points to another person's local C: drive. No accessible datasheet or driver. |
| Battery | VBAT PA0, ADC1 channel 16, 16-bit | Raw-count coordinator interface exists. Need acquisition adapter, divider, reference and pack specification. |

SPI1 routes PA5/PA6/PA7 (SCK/MISO/MOSI), SPI2 PB10/PC2_C/PC3_C, and SPI3 PB3/PB4/PB5. These are firmware pin assignments, not independent verification of board traces.

## Implemented transactions

[`self_test_devices.c`](Src/self_test_devices.c) uses an injected SPI exchange callback. Tests inspect the wire bytes and inject replies. All frames use eight-bit, MSB-first transfers. The clock values below are ceilings, not recommended board operating rates.

| Device | Transmit bytes | Read / acceptance | Requested mode; maximum clock |
| --- | --- | --- | --- |
| ISM330DHCX | `8F 00` | Second byte `6B` | 3; 10 MHz |
| H3LIS100DL | `8F 00` | Second byte `32` | 3; 10 MHz |
| MS5611 | Eight separate frames, `A0 00 00` through `AE 00 00` | Last two bytes of each frame, high byte first; CRC4 | 0; 20 MHz |
| W5500 | `00 39 00 00` | Fourth byte `04`; common register block, read, variable-length mode | 0; 80 MHz |
| SX1262 | `C0 00`, then `17 00 00 00` | Status in second byte of both frames; error word in last two bytes of second frame | 0; 16 MHz |

The barometer check clears the entire low byte of PROM word 7 for CRC calculation and compares against its original low nibble. It rejects all-zero and all-ones PROM contents even if a checksum could match. A matching checksum establishes readable calibration data, not valid pressure measurements.

The radio check accepts documented chip modes 2–6 and rejects command timeout, processing error, and execution failure status codes. It preserves the error register and fails on any nonzero error word, including unknown bits. Unused command-status values do not establish identity. This is a status check for an assumed SX1262 binding, not a unique chip identifier. Existing latched faults remain visible until the application diagnoses them.

Sensor identity reads do not exercise built-in mechanical self-test, measure noise, or establish sensor accuracy. Model selection still comes from the assembly BOM.

## Adapter requirements

Initialize `self_test_devices_t` with an exchange callback and its context. Enable only verified devices in `configured_mask` using `SELF_TEST_DEVICE_ENABLED(id)`. The probe function matches `self_test_port_t.probe`; use a board-context wrapper when combining it with battery/publication callbacks. Device IDs are declared in [`self_test_devices.h`](Inc/self_test_devices.h). Unsupported GNSS/NAND/eMMC IDs return `NOT_IMPLEMENTED`; disabled bindings return `NOT_CONFIGURED`.

The exchange callback must select the correct bus/CS, enforce mode and clock ceiling, and use eight-bit transfers. Assert and release CS separately for each frame. Respect datasheet CS setup/hold and inter-command timing. The entire batch shares one deadline, including lock acquisition, BUSY waits, transfers and cleanup. Return `PASS` only after receiving every byte; propagate failures and partial transfers. The adapter must release CS, locks and transfers before returning. Check SX1262 BUSY before each command and return a bounded timeout if it stays high.

The board must complete power/reset initialization before enabling checks. MS5611 requires its startup reset and at least 2.8 ms for PROM reload. SX1262 must already be awake. These probes do not reset devices, change sensor settings, write storage, transmit radio packets, or clear faults. Static caller-owned scratch avoids large allocations on the default task's 512-byte stack. Measure stack and execution time on the target before enabling the task.

## Integration blockers and questions

1. **Assembly revision and BOM:** confirm H3LIS100DL versus H3LIS331DL, SAM-M10S versus MAX-M10S, and the NAND model. The current component page contains one separate accelerometer; an older page listed another low-g part. Do not add a second binding without a CS/wiring assignment.
2. **SPI/startup configuration:** all four generated SPI initializers use four-bit frames and mode 0. SPI1–3 select prescaler 2 with a 129 MHz kernel clock in `.ioc`, implying 64.5 MHz. That exceeds sensor and radio limits. The shared sensor bus also needs compatible mode management. Sensor, Ethernet and NAND CS pins start low; radio, Ethernet and GPS reset pins start low. Confirm power sequencing and regenerate consistent settings before hardware tests.
3. **GNSS communication:** the attached MAX-M10S datasheet gives default UART 9600 8N1 and seven-bit I2C address `0x42`; the branch sets UART9 to 115200. Confirm interface, module configuration, and whether self-test requires communication, a valid navigation message, or a satellite fix. The product datasheet alone does not define the intended health exchange.
4. **Battery:** the component page and attached pack sheet describe 1S 3.7 V / 2500 mAh, while the linked power spreadsheet lists 2S 7.4 V / 2000 mAh. Confirm the actual pack, divider, ADC reference/calibration, source impedance/sampling time, and warning thresholds. ADC counts alone are not battery percentage.
5. **Storage:** supply the accessible eMMC datasheet and NAND part number. Define whether presence/status is sufficient or whether a reserved scratch area may be tested. No destructive storage test is included.
6. **Heartbeat and state policy:** confirm required versus optional devices, packet format, destination, transport and delivery acknowledgement. Meeting notes call for 1–2 Hz in self-test and roughly ten seconds in idle; the coordinator supports configurable active intervals, while sleep/wake/RTC ownership remains outside this module. Define behavior after a failed check before connecting state transitions.
7. **STM32 build:** restore/generated HAL, CMSIS, RTOS, startup/system sources, linker setup and target project. The checkout records Cube FW_H7 V1.13.0 and EWARM V8.50 but lacks the corresponding build. Confirm the team's toolchain. Host tests cannot substitute for a target compile or hardware validation.

## Evidence

Page numbers below are printed PDF pages. Attached files were retrieved through the Notion component page; the broken radio link required a mirror of the manufacturer's document.

- STM32 attachment: **DS13313 Rev 5**, May 2025, STM32H723VE/VG/ZE/ZG. Confirms the MCU family and peripheral capabilities; pin routing above comes from the branch.
- ISM330DHCX attachment: **DS13012 Rev 7**, p. 15 SPI timing, pp. 21–22 SPI framing, p. 48 WHO_AM_I.
- [ST H3LIS100DL datasheet](https://www.st.com/resource/en/datasheet/h3lis100dl.pdf), **DocID027504 Rev 2**, p. 11 clock limit, pp. 20–21 SPI protocol, p. 25 identity.
- [TE MS5611-01BA03 datasheet](https://www.te.com/commerce/DocumentDelivery/DDEController?Action=srchrtrv&DocNm=MS5611-01BA03&DocType=Data%20Sheet&DocLang=English&DocFormat=pdf&PartCntxt=MS561101BA03-50), pp. 10–12 reset/PROM protocol. [Measurement Specialties AN520](https://www.amsys-sensor.com/downloads/notes/MS5XXX-C-code-example-for-MS56xx-MS57xx-MS58xx-AMSYS-an520e.pdf), **AN520_004**, pp. 4 and 12 CRC algorithm and independent `0xB` test vector.
- [WIZnet W5500 datasheet](https://docs.wiznet.io/img/products/w5500/W5500_ds_v110e.pdf), **v1.1.0**, pp. 14–17 framing/control, p. 43 VERSIONR, p. 61 SPI timing.
- [Semtech SX1261/2 datasheet, manufacturer document hosted by Heltec](https://resource.heltec.cn/download/WiFi_LoRa_32_V4/datasheet/SX1261_2%20V2-2.pdf), **Rev 2.2, December 2024**, pp. 52–54 SPI/BUSY timing, pp. 100–101 status/error commands.
- GNSS attachment: **MAX-M10S Data sheet, UBX-20035208 R03**, p. 15 default interfaces. Its model differs from the Notion heading.
- [Attached battery specification](https://cdn-shop.adafruit.com/product-files/328/LP785060+2500mAh+3.7V+20190510.pdf), **LP785060, 2019-05-10**, pack ratings. Compare with the [LE4 power spreadsheet](https://docs.google.com/spreadsheets/d/1tyYbt6XD5iS_GJZ6tv6fDYZUHLUtJRz1r1y-2zEd8c4/edit?gid=304511797#gid=304511797).

## Validation

The host suite compiles the production coordinator and device-check sources with warnings as errors. Protocol tests cover exact commands/modes/clock ceilings, response byte positions, wrong identities, blank PROM, the manufacturer's CRC vector, single-bit calibration corruption, radio status/error handling, unconfigured devices, transport errors, and coordinator reset. Run the commands in [README.md](README.md) with sanitizers and in Release configuration. Hardware timing, electrical behavior and target integration remain unverified.

# HV-320 / UT-130 Windows stack: findings for a macOS port

Written from static analysis of the vendor software on 2026-10-31, then checked on hardware: one UT-130 (board `0x35`) and one HV-320. Where a hardware result settles a question, the text says so. The vendor software itself (QIGs, driver, GUI, viewer) is HiDes's download and is not in this repo.

Confidence labels:

- **Confirmed**: read directly from the vendor binaries or docs.
- **Reference**: from third-party source for the same chip family. Not yet checked against a UT-130.
- **Inferred**: my reasoning, unverified.

## The system

```
HDMI/CVBS -> HV-320 (H.264 + AAC/MPEG audio, DVB-T or ISDB-T modulator) -> RF
                ^ config over 3-wire UART via PL2303 USB dongle
RF -> UT-130 (USB receiver) -> MPEG-TS over USB -> Windows BDA driver
   -> DirectShow filters -> BDAViewerPlus
```

The two halves share only the RF link and the MPEG-TS format. They need separate work and have very different difficulty.

## Transmitter: AVSenderUARTGUI (easy)

The GUI is mixed-mode C++/CLI and decompiled almost completely. No Windows driver is involved beyond a COM port. macOS 26 ships `com.apple.DriverKit-AppleUSBPLCOM.dext`, and its Info.plist matches `067B:2303` and `067B:2304`, the IDs Prolific lists for PL2303 chips. No install should be needed if the supplied dongle uses those IDs, which is untested.

**Confirmed serial settings:** 38400 baud by default, or 57600 (the GUI's Auto mode tries both). The QIG gives 38400/8/none/1/none for the serial defaults; the exact DCB string in the GUI was not decoded.

**Confirmed frame format:**

| Offset | Field |
|---|---|
| 0 | `0x23` (`#`) start byte |
| 1 | Length: total frame size minus 3 |
| 2 | Sequence number, incremented per command |
| 3 | Command. Replies use `command \| 0x80` |
| 4 | `0` on requests, return code on replies |
| 5.. | Payload, multi-byte fields big-endian |
| n-2 | Checksum: byte sum of offsets 1 to n-3, mod 256 |
| n-1 | `0x0D` terminator |

Example, get transmission config: `23 04 <seq> 00 00 <sum> 0D`.

**Confirmed command IDs:**

| Function | Get | Set |
|---|---|---|
| Transmission (frequency, BW, modulation) | 0 | 64 |
| Media (encoder) | 1 | 65 |
| TS info (PIDs, service name) | 2 | 66 |
| HW registers | 3 | 67 |
| System info / date-time | 4 | 79 / 68 |
| Source info | 5 | - |
| EIT | 6 | 70 |
| Raw data (DC and OFS calibration tables) | 7 | 71 |
| Network | 8 | 72 |
| Web page | 9 | 73 |
| Serial port config | 10 | 74 |
| Encryption | 11 | 75 |
| Reboot / clean buffer | - | 69 / 80 |

Field layouts are in `Cmd_set*` and `Cmd_get*Reply` of the decompiled `-Module-.cs`. Reproduce the decompile with `ilspycmd -p` on `AVSenderUARTGUI.exe`.

**Quirks:**

- In IT9919 mode, the GUI splits writes into 64-byte chunks with a 200 ms sleep between them.
- Each HV-320 has a unique DC calibration table in NOR flash. A firmware update can corrupt it, so any new tool should offer backup. A bad raw-data write could harm RF quality, so writes need guarding.
- Firmware is updated by SD card (`jedi.img`), not over serial. The port does not need to do this.
- High-gain units can burn out the PA with no antenna attached (QIG p.5).

**Open risk:** the GUI is dated July 2019 but the bundled firmware is August 2026, and the release notes mention `(9528)` and an IT9303 chip ID check. The vendor still ships this GUI, so it should work, but field layouts may have drifted.

## Receiver: IT9300BDA.sys (the hard part)

**Confirmed:** x64 WDM/KS BDA driver, version 24.10.07.1, 6.4 MB. INF lists these USB IDs: `048D:9306`, `9305`, `9307`, `9302`, `1D19:0100`, `07CA:0891`. The tested UT-130 enumerates as `048D:9306` ("TS Aggregator").

**Confirmed:** the driver is a generic IT9300 bridge driver supporting many front ends (Si2168, Si2183, MxL, DiBcom, Sony CXD, ...). Most of its size is firmware and front-end code the UT-130 does not use. Strings refer to `IT9133`, `Omega`, `Endeavour`, TPS decryption, PID filters, EEPROM config, and the mixers `ADRF6655` and `RFFC2071/2072`.

**Inferred:** UT-130 is IT9303 bridge + IT9133 demod. The docs do not name the parts.

**Confirmed from `DRV_SetFreqBw` and `DRV_GetEEPROMConfig` disassembly (`.sys` 24.10.07.1):**

- Band limits are 950 MHz (`0xE7EF0` kHz) and 1.9 GHz (`0x1CFDE0` kHz), matching the three antenna ports.
- EEPROM board ID (`0x4994 + 0x54`) selects the mixer: `0x31` ADRF6655, `0x32` RFFC2072, `0x35` RFFC2071. The tested UT-130 reads `0x35`, RFFC2071.
- LO frequencies are at EEPROM `0x49D4-0x49D9`, two 3-byte big-endian kHz values. `0x49DA` is the SupportBW flag.
- ADRF6655 path: at or below 950 MHz, GPIOH7 = 0 and the demod tunes RF directly. Above it, program the LO, `setCpRefSource(0)`, `setCpCurrentMultiplier(3)`, GPIOH7 = 1, and `0xD8E3` = 1 for LO1 (up to 1.9 GHz) or 0 for LO2. The demod then tunes to `|RF - LO|`.
- The ADRF6655 routines use the same register masks as `ADRF6655.c` in the reference source (checked on `setCpRefSource` and `setCpCurrentMultiplier`).
- Bandwidths under 5 MHz take an extra "Extend BW" GPIO sequence that has not been decoded. The RFFC207x routines (`0x63D68`, `0x633E8`) have no reference source.

**Reference:** USB layout (`nns779/px4_drv`, `soralis0912/it930x_driver_native`):

- Bulk OUT `0x02`: commands. Bulk IN `0x81`: replies. Bulk IN `0x84`: TS data.
- Frame: length, 16-bit command, sequence, payload, inverted 16-bit checksum. Commands include register read/write `0x00/0x01`, query info `0x22`, boot `0x23`, firmware scatter write `0x29`, I2C `0x2A/0x2B`.
- Firmware is downloaded to the bridge at startup when its version reads 0.

`it930x_driver_native` looks like ITE's own API code with Linux glue added. It includes `IT9133.c`, `omega.c`, `standard.c`, `ADRF6655.c`, and firmware headers.

**Confirmed against the driver binary:** sampled byte runs from that repo's Omega firmware headers (`firmware*.h`) all occur in `.sys` around `0x5EE490`-`0x5F55D9`. The repo's bridge firmware `brfirmware.h` matches only in its first 32 bytes (`0x196260`), so the driver carries a different bridge firmware version. The repo's version boots and streams on the tested UT-130, so this project uses it.

**Gaps that need the driver or a device:**

- **RFFC2072:** not implemented. The tested UT-130 has board ID `0x35`, RFFC2071, which is implemented from `0x63480`, `0x63D68` and `0x63F9C` in the `.sys`.
- **Narrow bandwidth:** the Extend BW GPIO sequence runs only on ADRF6655 boards, so it is unimplemented there. RFFC2071 boards skip it and rely on the demod, whose code handles 2 to 4 MHz. Untested.
- **Tuner script:** read from EEPROM `0x49DB`. Windows selects it only when tuning at or below 950 MHz on RFFC2071 boards; this port does not select it yet, so that band uses the default script.

**Licensing:** `it930x-core.c` declares GPL, but that repo has no licence file and the API code and firmware headers are ITE's. This project carries unmodified copies of the files it builds, in `Sources/CIT930x/vendor` (see the README there).

## BDAViewerPlus features

MFC/DirectShow app with bundled filters for decode. On macOS, VideoToolbox and FFmpeg replace all of the filters.

| Feature | How it works | Port effort |
|---|---|---|
| Tune + play | Set frequency/BW, demux TS, decode H.264 + AAC/MPEG audio | Core |
| Scan | Country tables and frequency ranges, lock check, parse PAT/PMT/SDT | Small |
| Spectrum view | Signal strength per frequency | Small |
| Signal stats | Lock, strength, quality, packet loss, TPS | Small |
| Record TS | Write stream to file, with time/size limits and schedule | Small |
| PID filter | Bridge or demod hardware filter | Small |
| RF decrypt | 32-bit key; `Demodulator_setDecrypt` in reference source. Requires demod firmware support | Small, if chip matches |
| TS decrypt | Class `CAesDecrypt`, 16-byte key, partial-packet skip (QIG: 4-172, multiples of 4). **AES mode not determined** | Needs RE + test |
| UART demux | Confirmed format: PID `0x1FED`, length byte (0-183), then data. Text window, serial out, NMEA GPS decode | Small |
| Virtual COM port | Forwards demuxed serial to other apps. A PTY does this on macOS with no driver | Small |
| PIP, stress tests, DUAL mode | Niche | Skip unless wanted |

## Latency

The QIG says the player is the major source of latency and reports 130-250 ms for 1080p with a special low-latency VLC build on Linux. A custom VideoToolbox pipeline can avoid the large player buffers. Stock VLC and OBS will be noticeably slower.

## macOS approach

- No kernel driver or dext is required. A user-space process can claim the device with libusb or IOKit `IOUSBLib`, since no Apple driver should match the UT-130's IDs. **Confirmed** with libusb on the tested unit. This avoids Apple's DriverKit entitlement process.
- USB 2.0 bulk throughput is ample: the top DVB-T rate is about 32 Mbit/s.
- Tx: POSIX termios on `/dev/cu.*`.
- Output: H.264 and audio through VideoToolbox/AudioToolbox, plus a local UDP TS output so VLC, OBS and ffmpeg can consume the stream.

## Sources

- <https://github.com/soralis0912/it930x_driver_native>
- <https://github.com/nns779/px4_drv>
- <https://patchwork.linuxtv.org/comment/52617>
- <https://github.com/tsduck/hides-drivers>
- HiDes vendor download for the HV-320 and UT-130 (QIGs, specs, driver, GUI, viewer)

## HV-320 table on PID 0x77 (from over-the-air captures, 2026-11-02)

Every capture carries a constant 21-byte section with table ID `0x77` on PID `0x77`, a few times a second. Body after the long section header: `CF 05 00 02 D0 00 08 F0 00 00 BB 80`. **Inferred:** bytes 1-2 are the input width (1280), 3-4 the height (720), and 8-11 the audio sample rate (48000). Bytes 0 and 5-7 are unknown. It does not carry the bitrate-vs-capacity state the firmware notes mention. Confirming the layout needs a capture with a different input resolution.

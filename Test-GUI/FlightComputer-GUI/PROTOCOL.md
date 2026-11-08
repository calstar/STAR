# Flight computer USB protocol (v1)

What the STM32 firmware must implement for the bench GUI. The reference
implementation is `src/protocol.rs`; `src/fake_board.rs` is a working
board-side example, and their unit tests pin both. **Nothing here runs on
the board yet.** Proposed 2026-11-06; change it here and in `protocol.rs`
together.

## 1. Transport

- USB full-speed **CDC-ACM** on USB_OTG_HS in its FS device role (`firmware.ioc`).
  A CDC device needs no driver on macOS or Windows 10/11; it shows up as
  `/dev/cu.usbmodem…` or `COMn`. The line-coding baud rate means nothing and is ignored.
- Binary only, both ways. No printf on this port (debug text goes in `TEXT` frames).

## 2. Framing

```
decoded:  type u8 | seq u8 | payload (0..~600 B) | crc16 u16 LE
on wire:  COBS(decoded) 0x00
```

- CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), over type, seq and payload. It's the
  radio link's CRC (`src/frame.h`, `crc16("123456789") == 0x29B1`).
- COBS removes every 0x00 from the frame, so 0x00 always marks a frame boundary,
  and a host that opens the port mid-frame resyncs at the next 0x00.
- A frame that fails COBS, length or CRC is dropped silently (no NAK). The
  host times out and retries.
- All integers are little-endian, and all structs are packed.

## 3. Requests and replies

The host numbers requests `seq` 1..255. The board answers with the same `seq`.
The board sends its own messages (`STATUS` heartbeat, `SAMPLE`, `TEXT`) with
`seq` 0.

| type | name | payload (host → board) | board answers |
|---|---|---|---|
| 0x01 | HELLO | — | INFO |
| 0x02 | GET_STATUS | — | STATUS |
| 0x03 | SET_STREAM | `u16 rate_hz, u8 mask` (bit 0 IMU, 1 high-g, 2 baro, 3 GNSS) | ACK |
| 0x10 | CONFIG_GET | `u8 slot` (0 active/RAM, 1 saved/flash, 2 firmware defaults) | CONFIG, or ACK FLASH_ERROR if slot 1 is empty |
| 0x11 | CONFIG_SET | config blob (§5) | ACK. Validated and applied to RAM, **not** saved |
| 0x12 | CONFIG_SAVE | — | ACK. Writes the RAM config to flash |
| 0x13 | CONFIG_REVERT | — | ACK. Reloads RAM from flash (or defaults) |
| 0x20 | LOG_INFO | — | LOG_INFO_REPLY |
| 0x21 | LOG_SESSIONS | `u16 start` | SESSIONS |
| 0x22 | LOG_READ | `u32 first_block, u32 count` | `count` × LOG_BLOCK, then ACK |
| 0x23 | LOG_ABORT | — | ACK (and the running LOG_READ ends with ACK OK, detail 1) |
| 0x24 | LOG_WIPE | `u32 0x45504957` ("WIPE") | ACK |
| 0x30 | REBOOT | `u32 0x544F4F42` ("BOOT") | ACK, then reset |

| type | name (board → host) | payload |
|---|---|---|
| 0x7F | ACK | `u8 for_type, u8 result, u16 detail` |
| 0x81 | INFO | `u8 protocol_version (1), u8 config_version, u16 config_size, u32 uptime_ms, u8 uid[12], char fw_git[16], u32 build_unix` |
| 0x82 | STATUS | see below; also sent unsolicited at 1 Hz |
| 0x90 | CONFIG | `u8 slot, blob` |
| 0xA0 | LOG_INFO_REPLY | `u8 disk_state, u32 epoch, u32 data_start_lba, u32 capacity_blocks, u32 blocks_used, u32 sessions` |
| 0xA1 | SESSIONS | `u16 total, u8 n, n × {u32 session, u32 first_block, u32 blocks, u32 duration_ms, u32 utc_start}`, n ≤ 24 |
| 0xA2 | LOG_BLOCK | `u32 block_index, u8 raw[512]` |
| 0xB0 | SAMPLE | `u8 record_type, record bytes` (`app/records.h` structs as-is) |
| 0xB1 | TEXT | UTF-8 debug line |

**ACK results:** 0 OK · 1 BAD_FRAME (wrong payload size) · 2 UNKNOWN_TYPE ·
3 BAD_VALUE (detail = config field id, or the bad number) · 4 WRONG_STATE (detail =
flight state) · 5 BUSY · 6 FLASH_ERROR · 7 STORAGE_ERROR · 8 NOT_IMPLEMENTED ·
9 BAD_MAGIC.

**STATUS** (`<BBIHB8sBBBIII2B2HIH`, 44 B): `u8 state` (flight_state_t), `u8 flags`,
`u32 uptime_ms`, `u16 battery_mv`, `u8 battery_state`, `u8 self_test[8]`
(self_test result per device ID, `self_test_devices.h` order), `u8 gnss_fix`
(UBX fixType), `u8 gnss_sv`, `u8 disk_state` (emmc_disk_state_t),
`u32 log_blocks_used`, `u32 log_blocks_total`, `u32 log_dropped`,
`u8 pyro_state[2]`, `u16 pyro_mohm[2]`, `u32 sensor_errors`, `u16 stream_rate_hz`.
Flags: bit 0 on USB power (TPS2121 `SW_ST`), bit 1 RAM config differs from flash,
bit 2 streaming, bit 3 flash held no valid config (running defaults).

**The board converts and judges its own analog readings.** It knows its divider
resistors, ADC reference, sense circuit and battery; the app knows none of them
and shows what STATUS says, unchanged. No raw ADC counts go over USB.

- `battery_mv`: battery voltage in mV, after the divider and ADC reference are
  accounted for. 0 when `battery_state` is NOT_MEASURED.
- `battery_state`: 0 NOT_MEASURED (no reading yet, or the battery cannot be read
  in this power state) · 1 OK · 2 LOW · 3 CRITICAL. The thresholds are the
  firmware's, set for the battery the board is built for.
- `pyro_state[ch]`: 0 NOT_MEASURED · 1 OPEN · 2 CONTINUITY · 3 SHORT, from the
  board's own continuity thresholds for the e-match it is built for.
- `pyro_mohm[ch]`: the measured bridge resistance in mΩ; `0xFFFF` when it is above
  what the sense circuit can measure (an open channel). Shown next to the verdict
  so a marginal e-match is visible, never used by the app to decide anything.

## 4. When the board talks: the DTR gate

The board sends **nothing unsolicited** (no STATUS heartbeat, no SAMPLE) unless all of these hold:

1. USB is *configured* (enumerated by a host), **and**
2. the bus is not *suspended*. A host stops sending SOF packets within 3 ms
   when the cable is pulled or the laptop sleeps, and the USB core raises a
   suspend interrupt. With no VBUS-sense pin (PA9 is unused), this is how the
   board detects that the cable is gone, **and**
3. the host holds **DTR** (CDC `SET_CONTROL_LINE_STATE`, bit 0). DTR is set when a
   program opens the port and cleared when it closes it. pyserial sets it on
   macOS and Windows; the app also sets it explicitly.

`SAMPLE`s also need `rate_hz > 0` from SET_STREAM. Do not use `SW_ST`
for this: it reports which supply powers the board, and on a battery it reads
"battery" even with a laptop plugged in.

Streaming is the lowest-priority work on the board. Each SAMPLE is the newest
copy of each sensor (`sensors_core_t.*_latest`), sent at `rate_hz` (≤ 200). If
the CDC IN endpoint is busy, the board **drops** the sample. It never waits, and
it never delays a sensor task or the log writer.

## 5. Config blob (version 1, 42 B)

Header `u8 version (1), u8 reserved, u16 size (42)`, then the fields below in
order, then `u32 CRC-32` (IEEE, the same function as `emmc_log_crc32`) over
everything before it. Values are in physical units; the firmware maps them to
register codes. The GUI's allowed sets (and their datasheet citations) are
`src/config.rs` `fields()`.

| id | field | type | allowed | default |
|---|---|---|---|---|
| 1 | radio_freq_hz | u32 | 902 000 000 … 928 000 000, and the whole signal (± bw/2) inside it | 915 000 000 |
| 2 | radio_sf | u8 | 5 … 12 | 9 |
| 3 | radio_bw_hz | u32 | 7810, 10420, 15630, 20830, 31250, 41670, 62500, 125000, 250000, 500000 | 125000 |
| 4 | radio_cr | u8 | 5 … 8 (= 4/5 … 4/8) | 5 |
| 5 | radio_tx_dbm | i8 | −9 … 22 | 14 |
| 6 | radio_preamble | u16 | 6 … 1024 | 12 |
| 7 | radio_sync_word | u16 | 0x1424, 0x3444 | 0x1424 |
| 8 | hb_self_test_ms | u16 | 100 … 60000 | 500 |
| 9 | hb_idle_ms | u16 | 100 … 60000 | 10000 |
| 10 | hb_flight_ms | u16 | 100 … 60000 | 500 |
| 11 | gnss_rate_ms | u16 | 100, 125, 200, 250, 500, 1000 | 100 |
| 12 | gnss_dyn_model | u8 | 0, 2 … 8 (CFG-NAVSPG-DYNMODEL) | 8 (airborne <4g) |
| 13 | gnss_constellations | u8 | bits: 0 GPS, 1 SBAS, 2 Galileo, 3 BeiDou, 4 QZSS, 5 GLONASS; GPS required | 0x1F |
| 14 | imu_odr_hz | u16 | 26, 52, 104, 208, 416, 833, 1666, 3332, 6667 | 833 |
| 15 | imu_accel_fs_g | u8 | 2, 4, 8, 16 | 16 |
| 16 | imu_gyro_fs_dps | u16 | 125, 250, 500, 1000, 2000, 4000 | 4000 |
| 17 | highg_odr_hz | u16 | 50, 100, 400, 1000 | 400 |
| 18 | baro_osr | u16 | 256, 512, 1024, 2048, 4096 | 4096 |

Defaults reproduce what the firmware does today with constants: CTRL1_XL 0x74 and
CTRL2_G 0x71, 400 Hz high-g, 10 Hz airborne-4g GNSS, the MS5611 10 ms step. **The
radio defaults are placeholders.** No one has picked the frequency, SF or power yet.

### Amateur (ham) operation

The radio link runs under a US amateur licence in the 33 cm band (902–928 MHz,
47 CFR 97.301), not as an unlicensed ISM device. So any fixed frequency is
allowed at full power (the SX1262 tops out at +22 dBm), and **the whole signal
stays in the band**: `radio_freq_hz ± radio_bw_hz / 2` must be inside
902–928 MHz. CONFIG_SET refuses it otherwise (BAD_VALUE, detail = 1).

### Rules the board enforces (the GUI's checks are only a convenience)

- **CONFIG_SET checks every field** against the table and refuses with
  BAD_VALUE (detail = id) on the first bad one. It also refuses a wrong version,
  size or CRC (BAD_FRAME). The board never stores a value it would refuse.
- **CONFIG_SET, CONFIG_SAVE, CONFIG_REVERT and LOG_WIPE refuse outside SELF_TEST/IDLE**
  (WRONG_STATE). Nothing about the rocket changes once it is armed.
- **Applying.** The board reconfigures the chips from the new values: the SX1262
  through SetModulationParams/SetPacketParams/SetTxParams, the sensors through their
  CTRL registers, and the GNSS through UBX-CFG-VALSET to the **RAM layer only**. It
  never writes the GPS module's own flash or BBR; the board pushes its config on
  every boot. Sensor periods (`SENSORS_IMU_PERIOD_US` etc.) become runtime values
  derived from the ODRs.
- **Storage:** the last 128 KB sector of internal flash (`0x08060000`, sector 3 of
  the H723VE's four). Each save appends a new record at the next free 32-byte
  flash word: `u32 magic "FCCF", u32 sequence, blob`, padded to whole flash words.
  At boot the board takes the valid record with the highest sequence. When the
  sector is full it is erased and the current config is written first. The
  sector is erased only in IDLE, because erasing stalls the CPU. A torn write or
  a blank sector falls back to defaults and sets STATUS flag bit 3. The linker
  script's FLASH length becomes 384K.
- **The config goes in every flight log.** On ARMED, right after
  SESSION_START, the board appends record **0x16 REC_CONFIG** carrying the active
  blob (42 B). Without it a downloaded flight cannot know its accel and gyro LSB
  sizes, so the GUI falls back to the defaults and labels the flight that way.

## 6. eMMC log access (the Flights tab)

The eMMC format is `Core/Inc/emmc_log.h`. Over USB the board only finds and
sends raw blocks. **The GUI checks every block itself** (magic, epoch, position,
CRC-32), so a board-side bug cannot vouch for its own data.

- **Mounting from IDLE.** `EMMC-ARCHITECTURE.md` §3 keeps the card untouched before
  ARMED. The first LOG_INFO, LOG_SESSIONS or LOG_READ in IDLE brings the card up
  and mounts it, as Arm would. The card is still started at most once per power-up
  (no repeated CMD0/CMD1: datasheet p.28). Reads never write anything. A failed
  start returns STORAGE_ERROR, and the disk state goes to FAULT as on Arm.
- **LOG_INFO** `blocks_used` = `emmc_log_t.head - data_start`. `head` is an LBA, not
  a count.
- **LOG_SESSIONS.** A session number never decreases along the log, so the board
  finds each session's first block by binary search on the block header's
  `session` field: ~23 reads per session for 4 GB, without reading the data.
  `duration_ms` = last record's `t_ms` − first record's `t_ms`, from the first
  and last block. `utc_start` = Unix seconds of the first GNSS fix in the session
  (from NAV-PVT's date and time), 0 if there was none. Sessions are listed
  oldest first, `SESSIONS_PER_FRAME` = 24 per page.
- **LOG_READ** streams `LOG_BLOCK` frames as fast as the CDC endpoint takes them.
  USB flow control does the pacing, so no host acks are needed. A finished read ends
  with `ACK OK detail 0`, an aborted one with `ACK OK detail 1`. One read runs at a
  time (otherwise BUSY). Blocks past the end of the log are not sent. Reads run in
  the log writer's task, between chunk writes, never while recording.
- **LOG_WIPE** writes a new superblock with a higher epoch (`format()` in
  `emmc_log.c`). Old blocks become invalid; nothing is erased. IDLE only.

At USB full speed (12 Mbit/s, ~0.8–1 MB/s of payload in practice), a 10-minute
flight at ~50 kB/s (~30 MB) downloads in about 30–40 s.

## 7. Record types in SAMPLE and in the log

`app/records.h`: 0x10 IMU (18 B), 0x11 high-g (7 B), 0x12 baro (12 B), 0x13 GNSS
(49 B), 0x14 health and 0x15 event (layouts not defined yet), plus the proposed
0x16 config (§5). The log's own records are 0x01–0x04 (`emmc_log.h`). One
decoder (`src/records.rs`) serves both the live plots and downloaded flights.

# LabJack T7 over Ethernet — reference for the DAQ integration

Status: `t7_bridge` (section 7) streams T7 inputs into Elodin; it has not yet run against
a real T7. Sections 1-6 are the device reference it was built from.

## Where these facts come from

| Tag | Source | Version |
|---|---|---|
| **[MAP]** | `labjack/ljm_constants` → `LabJack/LJM/ljm_constants.json` (LabJack's machine-readable Modbus map + error table) | 2026.05.11.A (commit 482d58d) |
| **[H]** | `labjack/ljm_constants` → `LabJackM.h` (the LJM C API header) | `LJM_VERSION 1.2200` |
| **[EX]** | `labjack/C_CPP_LJM` → `more/stream/stream_basic.c`, `more/ethernet/*.c`, `more/watchdog/*.c` | commit 7a0f270 (2026-10-20) |
| **[DS]** | support.labjack.com: the T-series datasheet, the LJM User's Guide and app notes. Section numbers are the datasheet's (e.g. [DS 18.0] = "18.0 Internal Temp Sensor", [DS A-1-1] = "A-1-1 Stream Data Rates") | read 2026-11-03 |

Everything first written as [WEB?] (search snippets, when support.labjack.com was blocked)
has since been checked against [DS]. The few things the documentation does not settle are
in "Still to verify on the bench" at the end; they need the real unit, not more reading.

---

## 1. Two ways to talk to it

1. **LJM** (`libLabJackM.so` + `LabJackM.h`). LabJack's library: closed source,
   C API, runs on Linux. It handles Modbus TCP, stream framing, raw→volts calibration,
   auto-recovery and reconnects. LabJack recommends it for everything except
   platforms that can't run it.
2. **Direct Modbus TCP.** Port 502 carries command-response traffic; spontaneous stream
   data arrives on a separate TCP socket on port 702. It needs no vendor library, but
   then we would have to parse the stream frames, apply calibration constants and
   handle auto-recovery ourselves.

**Recommendation:** use LJM. The DAQ host is a regular Linux PC, which LJM supports.
Every fact below is in LJM terms first.

## 2. Network facts

| Item | Value | Source |
|---|---|---|
| Modbus TCP port | 502 (`TCP_PORT`) | [H]/Python constants |
| UDP discovery port | 52362 (`ETHERNET_UDP_PORT`) | [H] |
| Spontaneous stream port | 702 (`STREAM_AUTO_TARGET` bit 0 = "Send to Ethernet 702 sockets") | [MAP] |
| Simultaneous TCP connections | 502 (Modbus): 2, 702 (stream): 1, UDP 52362: unlimited | [DS 6.0] |
| Max packet | TCP 1040 B, UDP 64 B | [DS 6.0] |
| Concurrent streams | 1 per device: "A LabJack device cannot run more than one stream session at any given time" | [DS 3.2] |
| Command-response latency | ~1.1 ms per LJM call over Ethernet with no I/O, plus each AIN's conversion time | [DS A-1] |
| LJM Ethernet open timeout | 1000 ms default (`LJM_ETHERNET_OPEN_TIMEOUT_MS`) | [H] |
| LJM Ethernet send/receive timeout | 2600 ms default (`LJM_ETHERNET_SEND_RECEIVE_TIMEOUT_MS`); since LJM 1.2100 it also bounds `eStreamRead` over Ethernet | [H], [DS LJM] |

Two consequences:
- **Only one stream client at a time.** A Kipling session left open on the stand
  laptop will break our stream (or ours breaks theirs). Close Kipling before a test.
- **No command-response AIN reads while streaming.** "Streaming needs exclusive control of
  the analog input system, so analog inputs (including the internal temperature sensor) cannot
  be read via command-response while a stream is active" [DS 3.2]. Every AIN we want must be
  in the scan list, and `TEMPERATURE_DEVICE_K` has to be read before the stream starts (the
  bridge does). Other registers still answer, more slowly.

**Stale connections.** The datasheet does not say whether or when a T7 drops a dead TCP
socket (a `kill -9`'d client), and there is no keepalive or idle-timeout register. With one
702 slot that matters: LJM normally stops the stream and closes cleanly (including on
SIGTERM/SIGINT, below), but after a SIGKILL see "Still to verify on the bench".

### Static IP (our 192.168.2.0/24 convention)
Registers [MAP]; the write sequence is in `C_CPP_LJM/more/ethernet/write_ethernet_config.c` [EX]:

| Register | Addr | Type | Notes |
|---|---|---|---|
| `ETHERNET_IP_DEFAULT` | 49150 | UINT32 RW | applies after power-cycle / apply |
| `ETHERNET_SUBNET_DEFAULT` | 49152 | UINT32 RW | |
| `ETHERNET_GATEWAY_DEFAULT` | 49154 | UINT32 RW | |
| `ETHERNET_DHCP_ENABLE_DEFAULT` | 49160 | UINT16 RW | write 0 for static |
| `ETHERNET_APPLY_SETTINGS` | 49190 | UINT32 W | write 1: waits 1 s, Ethernet off, 500 ms, on |
| `ETHERNET_IP` / `_SUBNET` / `_GATEWAY` / `_DHCP_ENABLE` | 49100/49102/49104/49110 | R | current values |
| `ETHERNET_MAC` | 60020 | UINT64 R | |
| `POWER_ETHERNET_DEFAULT` | 48053 | UINT16 RW | make sure this stays on |

**On the stand, use DHCP rather than a static IP.** The DAQ host runs `star-dhcp`
(dnsmasq, `deploy/dhcp/`). It hands out MAC-keyed static reservations generated from
every `[boards.*]` entry that has `ip` + `mac`. `generate_dhcp_config.py` ignores the
board's `type`, so a T7 entry gets a reservation like any ESP32. To onboard:
1. Leave `ETHERNET_DHCP_ENABLE_DEFAULT` = 1. "The default is DHCP enabled" [DS 6.0]; check
   it in Kipling over USB if the unit isn't fresh. **There is no fallback address:** "If DHCP
   is enabled on a device and you connect it to a network that does not have a DHCP server,
   that device will not get assigned a valid IP address" (Ethernet Troubleshooting app note).
   So a T7 on the board LAN with `star-dhcp` down is unreachable until DHCP is back. The
   recovery paths are USB, or the SPC-to-AIN3 jumper, which forces a temporary static
   192.168.1.x / 255.255.255.0 without touching the `_DEFAULT` settings (LabJack's pages
   disagree on .207 vs .217; [DS 11.0] says .217 for firmware 1.0291+).
2. Plug it into the board LAN. It takes a pool lease (`.200`–`.250`), and the MAC appears
   in `/var/lib/misc/star-dhcp.leases`. The MAC is also on the T7's label and in
   the `ETHERNET_MAC` register.
3. Add `mac` to its `[boards.*]` entry, then `sudo deploy/dhcp/reload_dhcp.sh`, then
   power-cycle the T7. It comes back at its reserved IP.

Static registers (above) are the fallback for a bench with no DAQ host.

**Assigned address:** the first T7 is `192.168.2.81`, `board_id = 81`, following the
convention that the IP's last octet equals `board_id`. `.81` lies outside the pool
(`.200`–`.250`) and the discovery range (`.100`–`.150`). `board_number = board_id % 10`
gives slot 1, which does not collide with anything because the T7 is a new board type with its own slots.

Since IP addresses are stored as UINT32, LJM provides `LJM_IPToNumber` / `LJM_NumberToIP` [H].

### Device watchdog
`WATCHDOG_ENABLE_DEFAULT` (61600) and `WATCHDOG_TIMEOUT_S_DEFAULT` (61604) [MAP].
A successful command-response exchange clears the timer, but **"normal spontaneous stream data
does not reset the Watchdog timeout"** [DS 23.0], so a stream-only client would see the T7
reboot mid-stream if the watchdog's reset action were on. The bridge does not enable it, and
for inputs only it should stay off. It matters if the T7 ever drives DIO/DAC for actuation:
on loss of the server it can force outputs to a safe state. Then the server has to send
periodic command-response traffic during the stream. LabJack recommends timeouts no shorter
than 2-3 s, and the watchdog registers are all `_DEFAULT` (flash), so write them only when
they differ, never on every start. `more/watchdog/write_watchdog_config.c` [EX] has the setup.

## 3. LJM C API we would use  [H]

```c
int LJM_OpenS(const char *DeviceType,      // "T7"
              const char *ConnectionType,  // "ETHERNET" (LJM_ctETHERNET = 3); "TCP" = 2 also allows WiFi
              const char *Identifier,      // "192.168.2.81" — open by IP, never "ANY" on the stand
              int *Handle);
int LJM_Close(int Handle);

int LJM_eWriteNames(int Handle, int NumFrames, const char **aNames, const double *aValues, int *ErrorAddress);
int LJM_eReadNames (int Handle, int NumFrames, const char **aNames, double *aValues, int *ErrorAddress);
int LJM_NamesToAddresses(...);   // build the int scan list from names

int LJM_eStreamStart(int Handle, int ScansPerRead, int NumAddresses,
                     const int *aScanList, double *ScanRate /* in: requested, out: actual */);
int LJM_eStreamRead (int Handle, double *aData /* ScansPerRead*NumAddresses, interleaved */,
                     int *DeviceScanBacklog, int *LJMScanBacklog);
int LJM_eStreamStop (int Handle);
typedef void (*LJM_StreamReadCallback)(void *);
int LJM_SetStreamCallback(int Handle, LJM_StreamReadCallback cb, void *arg); // call after eStreamStart
int LJM_GetStreamTCPReceiveBufferStatus(int Handle, unsigned *size, unsigned *backlog);

int LJM_WriteLibraryConfigS(const char *Parameter, double Value);
```

- `DeviceScanBacklog` and `LJMScanBacklog` should sit "near zero and not growing" for a
  healthy stream [H]. Publish both as health telemetry.
- Demo mode: identifier `LJM_DEMO_MODE = "-2"` opens a fake device, which is useful for
  CI or the simulator without hardware [H].
- `LJM_DUMMY_VALUE = -9999` is what LJM puts in scans lost to auto-recovery [H].

### Library configs worth setting  [H]

| Config | Default | Why we care |
|---|---|---|
| `LJM_STREAM_SCANS_RETURN` | `ALL` (1): eStreamRead blocks until ScansPerRead | `ALL_OR_NONE` (2) never blocks and returns `LJME_NO_SCANS_RETURNED` (1309) instead, which fits a poll loop. The bridge keeps the default |
| `LJM_STREAM_RECEIVE_TIMEOUT_MODE` / `_MS` | 1 = calculated; `_MS` 20000 | LabJack: calculated "is almost always better". Since 1.2100 the Ethernet read timeout follows `LJM_ETHERNET_SEND_RECEIVE_TIMEOUT_MS` (2600 ms); the exact formula is not published |
| `LJM_STREAM_AIN_BINARY` | 0 = calibrated volts (float) | 1 = raw uncalibrated binary, which matches our raw→cal split but means applying LabJack cal constants ourselves. **Keep 0.** |
| `LJM_STREAM_TCP_RECEIVE_BUFFER_SIZE` | 0 = OS default, auto-tuned | "appropriate for most use cases"; Linux may silently cap a larger value. Watch `LJM_GetStreamTCPReceiveBufferStatus` instead: a backlog/size ratio that keeps rising predicts auto-recovery |
| `LJM_STREAM_THREADS_PRIORITY_MODE` | auto-elevated: collector thread SCHED_FIFO 90, others SCHED_RR 50 | Linux needs CAP_SYS_NICE or an RLIMIT_RTPRIO for this, which LabJack does not mention. Without it the threads run at normal priority, and the only sign is a line in LJM's debug log, which is off by default. `sensor-t7` is a `systemctl --user` unit and cannot raise its own hard rtprio limit; if the stand ever shows auto-recovery under load, grant it via `/etc/security/limits.d` (`rtprio`) |
| `LJM_AUTO_RECONNECT_STICKY_CONNECTION` / `_SERIAL` | 1 / 1 | reconnect stays on Ethernet and on the same serial number. Reconnect is always on, but nothing documents a *stream* resuming after one: assume the bridge restarts it |
| `LJM_AUTO_RECONNECT_WAIT_MS` | 500 | |
| `LJM_AUTO_IPS` | 1: caches discovered IPs in `/usr/local/share/LabJack/LJM/ljm_auto_ips.json` | only consulted for "ANY" opens; LabJack suggests turning it off in a sandboxed deployment. **`LjmT7Device` writes 0** once per process |

**Signals.** LJM installs handlers for the terminal signals (SIGHUP, SIGINT, SIGQUIT, SIGTERM,
SIGPIPE, SIGSEGV, ...). Each handler stops every stream, closes every device and re-raises
the signal. It skips a signal that already has a handler when LJM initialises ("Does LJM
handle signals?"). `t7_bridge` sets its own SIGINT/SIGTERM handlers (a clean stop, then
`LJM_Close`, which stops the stream) and ignores SIGPIPE, so a dropped Elodin socket cannot
take the bridge down through LJM's handler. SIGKILL and a power cut are the cases nobody
cleans up, and the startup takeover (section 7) exists for them.

**Warnings.** LJM's warning range is 200-399. Of its warnings, 203 `LJME_USING_DEFAULT_CALIBRATION`
is the one that matters: every volt is on nominal constants. `LjmT7Device` logs each warning
instead of dropping it.

## 4. Stream configuration registers  [MAP]

| Register | Addr | Type | Meaning |
|---|---|---|---|
| `STREAM_SCANRATE_HZ` | 4002 | F32 | scans/s; sample rate = NumChannels × ScanRate |
| `STREAM_NUM_ADDRESSES` | 4004 | U32 | scan-list length |
| `STREAM_SAMPLES_PER_PACKET` | 4006 | U32 | spontaneous mode only |
| `STREAM_SETTLING_US` | 4008 | F32 | µs; < 1 = auto ("based on resolution and gain"; ~5 µs above 60 kHz); max 4400. Not applied to the first scan entry, whose settling is the scan period |
| `STREAM_RESOLUTION_INDEX` | 4010 | U32 | 0-8 (9-12 are command-response only, error 2606); **0 = index 1 in stream**, on the T7 and T7-Pro alike [DS A-3-2-2]. Higher = quieter but slower |
| `STREAM_BUFFER_SIZE_BYTES` | 4012 | U32 | power of 2; 0 = default 4096; T7 max 32768; scans = bytes/2/NumAddresses |
| `STREAM_CLOCK_SOURCE` | 4014 | U32 | 0 internal, 2 external, 4/8 ESS |
| `STREAM_AUTO_TARGET` | 4016 | U32 | bit0 Ethernet 702, bit1 USB, bit4 command-response (LJM sets this) |
| `STREAM_NUM_SCANS` | 4020 | U32 | 0 = continuous |
| `STREAM_TRIGGER_INDEX` | 4024 | U32 | 0 = start now; 2000/2001 = DIO_EF0/1 edge |
| `STREAM_START_TIME_STAMP` | 4026 | U32 R | `CORE_TIMER` at first scan (one scan period after enable) |
| `STREAM_AUTORECOVER_DISABLE` | 4028 | U32 | 1 = stop on full buffer instead of auto-recovering |
| `STREAM_SCANLIST_ADDRESS#(0:127)` | 4100+ | U32 | up to 128 entries |
| `STREAM_DATA_CR` | 4500 | U32 R | command-response stream data |
| `STREAM_DATA_CAPTURE_16` | 4899 | U16 R | upper 16 bits of a 32-bit channel read in the previous slot |
| `STREAM_ENABLE` | 4990 | U32 | 1 start / 0 stop |
| `*_ACTUAL` | 4490/4492/4494 | R | what the device actually chose |

The per-channel analog setup is written before `eStreamStart` [MAP]:
`AIN#_RANGE` (40000+2n, F32), `AIN#_NEGATIVE_CH` (41000+n, U16, 199 = single-ended),
and the global `AIN_ALL_RANGE` (43900) / `AIN_ALL_NEGATIVE_CH` (43902, 199 SE / 1 diff).
**Stream ignores `AIN#_RESOLUTION_INDEX` and `AIN_ALL_SETTLING_US`** (those are for
command-response and AIN_EF); stream uses `STREAM_RESOLUTION_INDEX`/`STREAM_SETTLING_US`.
`LJM_eStreamStart` writes `STREAM_SCANRATE_HZ`, `_NUM_ADDRESSES`, `_SAMPLES_PER_PACKET`,
`_AUTO_TARGET`, the scan list and `STREAM_ENABLE` itself. It leaves the resolution and settling
we wrote alone, and hands back the actual rate (above 152.588 Hz the scan interval is a
multiple of 100 ns). LabJack suggests ScansPerRead = ScanRate/2. The bridge's 50 ms block is
lower latency, which LJM allows.

**Analog input facts** [DS 14.3.0, A-3-2-1]: AIN0-13. AIN0-3 are on the screw terminals *and*
the DB37 (wire one or the other, not both), AIN4-13 on the DB37 only. AIN14 is the internal
temperature sensor and AIN15 is GND. Input impedance is 1 GΩ, bias current 20 nA, and the max
source impedance is **1 kΩ** at auto settling (more needs extra settling). Every line has a 2.2 kΩ
series resistor. A differential pair is an even AIN and the odd one above it, and the negative
channel's own settings are ignored. Absolute accuracy is ±2000 µV at ±10 V, ±200 µV at ±1 V
and ±20 µV at ±0.1 / ±0.01 V.

### Stream rate limits, and what the config refuses  [DS A-1-1]

The T7 does 100 kS/s only at ±10 V and resolution index 0/1. Any other multi-channel stream
is limited by each channel's settle-and-convert time (Table A.1.8, µs per channel):

| Range | res 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| ±10 V | 15 (8 above 60 kS/s) | 25 | 45 | 90 | 170 | 335 | 670 | 1335 |
| ±1 V | 210 | 220 | 545 | 585 | 1200 | 2415 | 2750 | 3415 |
| ±0.1 V | 1040 | 2105 | N.S. | N.S. | N.S. | N.S. | N.S. | N.S. |
| ±0.01 V | N.S. | N.S. | N.S. | N.S. | N.S. | N.S. | N.S. | N.S. |

N.S. = not supported in a multi-channel stream. A single-address stream reaches 100k / 48k /
22k / 11k / 5500 / 2500 / 1200 / 600 scans/s at res 1-8 on any range (Table A.1.7).

`T7Config.cpp` (and `shared/config-validation.ts`, so the editor agrees) therefore refuses:
- **±0.01 V in any multi-channel stream**, and **±0.1 V above resolution index 2**. A
  thermocouple board always streams AIN14 too, so a TC is never single-address;
- a scan rate above 1 / Σ(each address's delay, or `settling_us` if larger), AIN14 at ±10 V
  included. This errs fast: at high resolution Table A.1.7's measured maxima are lower still.
  It only refuses what the T7 certainly cannot do, and anything past the real limit
  stops the stream with `STREAM_SCAN_OVERLAP` (2942), which the bridge logs and retries;
- one address faster than Table A.1.7 allows.

The stand's mix (PT ±10 V, TC ±0.1 V, LC ±0.1 V diff, RTD ±10 V, AIN14) at res 0 allows about
470 scans/s against the configured 100. LJM's error 2631, "temperature sensor ... above 250Hz",
is a **T8** limit ([DS 18.0]; T8 sub-stream) and is not applied to a T7.

**Noise** [DS A-3-2-2], RMS, which stream sees at res 1 unless set higher: ±0.1 V 21 µV (res 2:
11 µV), ±0.01 V 11 µV. A type K at ±0.1 V, res 1 is therefore about ±0.5 °C RMS. A 2 mV/V load
cell on 10 V excitation (20 mV full scale) does not fit ±0.01 V (span about ±10.1 mV), so it
goes on ±0.1 V at about 0.1 % of full scale RMS. Average or raise the resolution index if that
is too coarse.

**Clock** [DS A-5]: the T7's crystal is good to ±20 ppm at 25 °C, ±50 ppm over −10…60 °C and ±100 ppm
over −40…85 °C. At 50 ppm that is 3 ms per minute, which `BoardClockSync` corrects for (section 7).

### Thermocouples and other AIN_EF values
`AIN#_EF_INDEX` (9000+) / `AIN#_EF_READ_A` (7000+) give thermocouple and other
extended-feature values computed on the device. The register map marks them
`streamable: false` [MAP], and `TEMPERATURE_DEVICE_K` (60052) is not streamable either.
So a stream carries raw volts only, and t7_bridge does the thermocouple math itself
(section 7):
- **Cold junction:** AIN14 (the internal sensor, an LM94021 under the PCB between the AIN0/1 and
  AIN2/3 terminals) is appended to the scan of any board with a TC. LabJack's recipe for TCs in
  stream is exactly this: AIN14 in the scan list, converted by "Device temperature K = volts *
  -92.6 + 467.6" [DS 18.0]. The bridge uses that slope, **−92.6 K/V**. Each unit's own slope and
  offset are factory constants in flash [DS 20.0.1]. The offset is not taken as the nominal
  467.6 K: before each stream (it cannot be read during one), t7_bridge reads the device's own
  `TEMPERATURE_DEVICE_K` beside AIN14 and solves for it. (The −92.379 / 465.129 used before were
  the U6's nominal constants, which Kipling reuses only as a sanity range.) The sensor itself is
  ±1.5 °C over 20-40 °C and ±2.0 °C over −20-50 °C.
- **Terminal offset, `cjc_offset_k`, default −3.0 K.** LabJack: "The value from TEMPERATURE_DEVICE_K
  best reflects the temperature of the built-in screw-terminals AIN0-AIN3 ... expect the returned
  value minus 3 °C to reflect the temperature of the built-in screw-terminals with an accuracy of
  ±2.5 °C" [DS 18.0]. A TC wired through a **CB37** (any of AIN4-13) is at air temperature instead:
  `TEMPERATURE_AIR_K` = device − 4.3 K on USB, − 4.9 K on USB + Ethernet (the old default). For
  better than ±2 °C, LabJack suggests a dedicated sensor (LM34CAZ, ±0.5 °C). Measure the offset on
  the stand (below) either way. Note that LabJack's own AIN_EF thermocouple mode applies no
  terminal offset at all (CJC slope 1, offset 0 on `TEMPERATURE_DEVICE_K`).
- **Range.** LabJack's tutorial suggests ±0.01 V "when possible" (type K to 249 °C), but
  ±0.01 V is not supported in a multi-channel stream, and a TC board's stream always has AIN14
  in it. So it is **±0.1 V** (the default), at resolution index 0-2 (section 4, rate limits).
- **Differential wiring** needs a bias path: "Thermocouple+ to AIN0. Thermocouple- to AIN1.
  Wire a ≈100 kΩ resistor between AIN1 and GND." Differential "should always be used" on a
  CB37; on the screw terminals single-ended is fine.
- **Curve:** type K only. It is the NIST ITS-90 inverse the calibration service already
  used, moved unchanged to `lib/calibration/TypeK`. C→mV, needed for the junction, is that
  same inverse solved numerically, so no second set of coefficients exists.

### Timestamps
- `CORE_TIMER` (61520) is a U32 at ½ core clock; `SYSTEM_TIMER_20HZ` is at 61522 [MAP].
- To timestamp scans, put `CORE_TIMER` followed by `STREAM_DATA_CAPTURE_16` in the scan
  list (low 16 bits, then high 16 bits), or count scans from `STREAM_START_TIME_STAMP` at
  the known scan rate. Either one feeds `fsw::time::BoardClockSync` the way the ESP32
  board millis do.

## 5. Overflow, auto-recovery, and the codes to log  [MAP][H]

| Code | Name | Meaning |
|---|---|---|
| 2940 | `STREAM_AUTO_RECOVER_ACTIVE` | device buffer full; new samples dropped until space frees |
| 2941 | `STREAM_AUTO_RECOVER_END` | recovered; LJM inserts `-9999` for the skipped scans |
| 2942 | `STREAM_SCAN_OVERLAP` | ScanRate > MaxSampleRate/NumChannels (range/resolution/settling dependent) |
| 2943 | `STREAM_AUTO_RECOVER_END_OVERFLOW` | skipped-scan counter overflowed: the gap length is unknown |
| 2944 | `STREAM_BURST_COMPLETE` | `STREAM_NUM_SCANS` reached |
| 2945 | `STREAM_BUFFER_FULL` | buffer full with auto-recover disabled; stream stopped |
| 1306 | `LJME_SYNCHRONIZATION_TIMEOUT` | no data for `LJM_STREAM_RECEIVE_TIMEOUT_MS` (link loss) |
| 1309 | `LJME_NO_SCANS_RETURNED` | not an error in `ALL_OR_NONE` mode |
| 1225 | `LJME_STREAM_NOT_INITIALIZED` | |

Auto-recovery marks a gap with a border scan of all 0xFFFF, and LJM finds it by watching the
**first** channel only. So **the first scan-list entry must be an AIN or a `*_STATE`
register** (not `FIO_EIO_STATE`). Anything that can itself read 0xFFFF (counters, `CORE_TIMER`,
DIO_EF) makes LJM stop the stream with 1320 `LJME_DIGITAL_AUTO_RECOVERY_ERROR_DETECTED`
unless `LJM_STREAM_DIGITAL_AUTO_RECOVERY_ERROR_DETECTION_DISABLED=1`.
**Never put `CORE_TIMER` first.**

**What `eStreamRead` returns** [DS LJM eStreamStart/eStreamRead, 3.2.1]:
- *Recoverable* auto-recovery (2940/2941) is **not** returned. LJM absorbs it and "inserts the
  proper number of dummy scans, filled with all -9999". Counting `-9999` is the only signal.
- 2942 (scan overlap), 2943 (recover overflow), 1301 (LJM buffer full), 1306 (no data before the
  timeout) and 1320 come back as errors. **The stream is already stopped** by then: "If
  LJM_eStreamRead returns an error, LJM nearly always attempts to command the device to stop
  streaming." So the bridge's rule (any non-warning error → stop, close, back off, restart) is
  the right one.
- On Ethernet link loss, expect 1306, or 1239 `LJME_RECONNECT_FAILED`. Which one, and after how
  long, is a bench check.

Treat any `-9999` as missing data. Never calibrate it into a pressure.

## 6. Reference sequence (from `stream_basic.c` [EX])

```
LJM_OpenS("T7", "ETHERNET", "192.168.2.81", &h)
eWriteNames: AIN_ALL_NEGATIVE_CH=199, AINn_RANGE=..., STREAM_TRIGGER_INDEX=0,
             STREAM_CLOCK_SOURCE=0, STREAM_RESOLUTION_INDEX=0, STREAM_SETTLING_US=0
LJM_NamesToAddresses(scan names) -> aScanList
LJM_eStreamStart(h, scansPerRead, n, aScanList, &rate)   // read back actual rate
loop: LJM_eStreamRead(h, aData, &devBacklog, &ljmBacklog)
      count -9999 (skipped scans); LJM_GetStreamTCPReceiveBufferStatus for health
LJM_eStreamStop(h); LJM_Close(h)
```

## 7. What is built: `t7_bridge`

**Inputs only.** The only things written to a T7 are the stream setup registers in
`fsw::t7::plan_stream()`: `STREAM_TRIGGER_INDEX`, `STREAM_CLOCK_SOURCE`,
`STREAM_RESOLUTION_INDEX`, `STREAM_SETTLING_US`, and per channel `AIN#_RANGE`,
`AIN#_NEGATIVE_CH`, `AIN#_EF_INDEX = 0`. No DIO, FIO/EIO/CIO/MIO or DAC is ever written, and
`test_t7` checks that. Nothing is sent to the ESP32 boards or the sequencer.

| Piece | Where |
|---|---|
| Config parse + validation | `lib/include/config/T7Config.hpp`, `lib/src/config/T7Config.cpp` → `Config::t7_boards`, `Config::t7_errors` |
| Stream logic (device seam, setup plan, block decode, timestamps, `FakeT7Device`) | `lib/include/t7/T7Stream.hpp`, `lib/src/t7/T7Stream.cpp` |
| LJM device | `services/t7_bridge/LjmT7Device.{hpp,cpp}` (built only when LJM is found) |
| Executable | `services/t7_bridge/t7_bridge_main.cpp` → `build/bin/t7_bridge` |
| Elodin tables | `DatabaseConfig::register_t7_tables`, message `T7RawMessage` |
| Tests | `lib/test/test_t7.cpp` (ctest `t7`), `backend/src/__tests__/board-channels.test.ts` |

### Config
A T7 is a `[boards.<name>]` with `type = "T7"`, plus one `[[boards.<name>.channels]]` per
input. The default profile has `boards.labjack_1` at `192.168.2.81`, disabled, with placeholder
channels.

| Board key | Default | |
|---|---|---|
| `ip`, `board_id`, `mac`, `enabled` | — | same meaning as for the ESP32 boards; `mac` drives the DHCP reservation |
| `serial` | 0 (no check) | when set, t7_bridge refuses a T7 whose serial differs |
| `scan_rate_hz` | 100 | scans/s; each channel is sampled once per scan |
| `resolution_index` | 0 | `STREAM_RESOLUTION_INDEX`, 0-8 |
| `settling_us` | 0 (auto) | `STREAM_SETTLING_US` |
| `scans_per_read` | rate/20 | scans per `LJM_eStreamRead` (a 50 ms block) |
| `cjc_offset_k` | −3.0 | TC boards: terminals vs the internal sensor (section 4, Thermocouples) |

| Channel key | Default | |
|---|---|---|
| `ain` | required | 0-13, as printed on the T7 |
| `kind` | required | `PT` \| `TC` \| `LC` \| `VOLTAGE` |
| `role` | "" | operator name, metadata only |
| `range` | 10 (TC: 0.1) | ±V: 10, 1, 0.1, 0.01. ±0.01 V only on a single-channel board, ±0.1 V only at `resolution_index` 0-2 (section 4) |
| `differential` | false | AIN(n) − AIN(n+1); n must be even, and n+1 is then taken |
| `tc_type` | — | required for `TC`: B E J K N R S T |

Any mistake (a duplicate or paired AIN, a range the T7 lacks, a range or rate the stream
cannot do, a TC with no type, two T7s on one Elodin slot, ...) makes t7_bridge exit 2 and list
every problem. Every other service
skips type `"T7"`.

### Elodin
Table `{0x26, (slot-1)*0x20 + ain}`, entity `T7<slot>.AIN<ain>` (board 81 → slot 1, so AIN3 is
`T71.AIN3` at `{0x26, 0x03}`). Fields: `timestamp_ns`, `channel_id` (the AIN), `volts` (f32),
`sample_ts_ms` (ms since stream start), `status` (0).

**Timestamps.** The T7 scans on its own crystal, so scan *k* is at *k*/rate after the start.
That device time goes through the same `BoardClockSync` as the ESP32 boards (keyed by the
board section, `[time_sync]` applies). The newest scan of each block is anchored that way,
the rest are spaced back from it at the exact period, and nothing is stamped after it arrived.

**Lost data.** Scans lost to stream auto-recovery (`-9999`) are counted and logged and **not
published**, so a gap in the plot is a real gap.

### Running it
```bash
build/bin/t7_bridge                       # every enabled T7 in config/config.toml
build/bin/t7_bridge --board boards.labjack_1
build/bin/t7_bridge --fake                # stand-in T7s, no hardware or LJM needed
build/bin/t7_bridge --fake --fake-state /tmp/t7   # ... that remember a stream across restarts
```
Exit codes: 0 = no enabled T7, 2 = config problems, 3 = built without LJM and no `--fake`.
On a lost link or stream error it retries with backoff (1 s up to 10 s). If Elodin is down it
keeps streaming, so the T7 buffer never backs up, and retries the connection every 2 s.

### State scripts can read a T7 PT

`pressure(<slug>)` in a state script resolves a PT on a T7 the same way it resolves one on an
ESP32 board: `fsw::config::pt_role_tables` / `find_pt_role` list every PT channel of every enabled
T7 (none while the T7 config has errors, since t7_bridge then streams nothing), and the
sequencer's `PressureFeed` subscribes to its calibrated table `{0x26, (slot-1)*0x20 + 0x10 + ain}`.
calibration_service publishes that table in the ESP32 `CalibratedPTMessage` layout, with the same
calibrated/uncalibrated status, so staleness and "uncalibrated" refusals behave identically. The
config editor offers the slug in the state-script name list. A T7 PT is still not an abort PT
(`config_broadcast` skips it): no board can trip on it.

### Startup, and a stream left running

Each start, for each T7, `T7Session::start()`:
1. opens it by IP and reads `SERIAL_NUMBER`, checking it against `serial` when the config sets one;
2. **stops any stream already running** (`LJM_eStreamStop` on the new handle);
3. writes every stream and AIN setup register (section 4), so nothing is inherited from the last
   run, an edited config, or Kipling;
4. reads `TEMPERATURE_DEVICE_K` beside AIN14 on a TC board (command-response, so before the stream);
5. starts the stream.

Step 2 exists because **a T7 keeps streaming after the process that started the stream dies**: a
bridge killed with `-9`, a server torn down or power-cut mid-run, or Kipling left open. LabJack
says so: "LJM automatically commands the LabJack to stop streaming when it closes the device ...
However, sometimes the process crashes before LJM is able to send the command to stop stream ...
you can power-cycle the device. Alternately, eStreamStop stops stream" (LJM eStreamStart). And
the device side: it streams "until STREAM_ENABLE is written with the value 0" [DS 3.2.4]. Until
that stream stops, the T7 rejects stream and AIN setup writes with `STREAM_IS_ACTIVE` (2605: "The
requested operation can not be performed while stream is running"; the eStreamStart page lists
the AIN registers among them). LJM 1.1803's changelog: eStreamStop "now works when the stream had
not been started by the current LJM instance". synnaxlabs/synnax#4142 hit exactly this on a T7
(firmware 1.0292, LJM 1.23.2) and found that `eStreamStop` from a new handle clears it, and that a
device with no stream answers "not running". LabJack's own `DisableStreamIfEnabled()`
(`C_CPP_LJM/LJM_StreamUtilities.h`) does the same: it reads `STREAM_ENABLE`, stops if it reads 1,
and tolerates 2620. So:
- "not running" in any of its forms (LJM 1225 `LJME_STREAM_NOT_INITIALIZED`, 1303
  `LJME_STREAM_NOT_RUNNING`, device 2620 `STREAM_NOT_RUNNING`) is the normal answer;
- a stop that fails for another reason (the link dropped, say) stops the start and goes into the
  retry loop instead of being ignored;
- if the setup write still hits `STREAM_IS_ACTIVE`, for example because an LJM version answers a
  new handle's stop without telling the device, the bridge writes `STREAM_ENABLE = 0` and
  configures again;
- a successful takeover is logged: `stopped a stream already running on 192.168.2.81 ...`.

Even without step 2 the bridge would recover, because the retry loop's own `stop()` clears the
leftover stream. It would take one failed start first, though, plus about a second with no data.

**Two bridges on one T7** (an old server still running beside a new one) take the stream from
each other on every retry, since a stop from any connection stops the device. Each side then logs
a takeover or a 1306 timeout. Shut one down.

Simulated, this is all real behaviour. `FakeT7Unit` is the device, separate from any connection
to it. It keeps its stream and registers when a handle goes away without a stop, and it answers
with the codes above. With `--fake-state DIR` it is a file, so separate bridge processes share
one stand-in T7. `start_tmux_dev.sh` (`/tmp/gui_logs/t7_fake`) and `sensor-t7` under
`USE_SIM=1` (`/tmp/star-t7-fake`) both use it, so the dev stack's `pkill -9` before every start
leaves the stand-in streaming, and the next start has to take it over. A reboot clears `/tmp`,
which is the power cycle. Tests:
- `ctest -R ^t7$`, "restart": kill, take over with an edited config, the `STREAM_ENABLE`
  fallback, two bridges, and a stop that genuinely fails;
- `ctest -R t7_integration`, "restart": `kill -9` the real binary and start another on the same
  state file.

**On the stand,** check this once against the real unit. With no run active, start
`t7_bridge --board boards.labjack_1`, `kill -9` it, start it again, and expect the takeover line
with no `retrying` line before it.

**LJM is needed on the DAQ host.** CMake looks for `LabJackM.h` and `libLabJackM`. Without them
t7_bridge still builds (and CI's ctest runs `test_t7`), but it only runs with `--fake`. Install
LJM from LabJack's Linux installer, then re-run cmake: it prints
`t7_bridge: LabJack LJM found`.

- **Installer** (support.labjack.com "LJM Software Installer: Linux x64", read 2026-11-03): stable
  is LJM 1.2304 (constants 2025.05.06.A), `files.labjack.com/installers/LJM/Linux/x64/release/LabJack-LJM_2025-05-07.zip`.
  The release candidate, LJM 1.2308, ships constants 2026.05.11.A, the [MAP] version above. Unzip, then `sudo ./labjack_ljm_installer.run -- --without-kipling`. In a container,
  add `--no-restart-device-rules`. Ethernet needs no udev rule (it is for USB).
- **Paths:** `/usr/local/lib/libLabJackM*`, `/usr/local/include/LabJackM.h` (where CMake looks),
  `/usr/local/share/LabJack/LJM/` (the constants file and, with auto IPs on, the IP cache).
- **Licence:** "All closed and open source software ... provided by LabJack are licensed under the
  permissive MIT, unless otherwise stated in the download package, and can be redistributed
  freely". LJM's licence also includes Boost, gRPC and libusb (LGPL 2.1 on Linux). So
  `libLabJackM.so` can go in a deploy image, as long as those notices ship with it. Whether
  libusb is linked statically, which would bring in the LGPL relinking terms, is not stated:
  read the licence file in the installer zip before shipping an image.

### Calibration: the same as an ESP32 sensor
Where the data comes from is the only difference. t7_bridge publishes raw volts per AIN.
A TC board also gets the cold junction, which only the bridge can compute (it reads the
device at stream start). **calibration_service** does everything else, through the same
code paths as an ESP32 PT / LC / TC:

| | table | entity | written by |
|---|---|---|---|
| raw | `{0x26, (slot-1)*0x20 + ain}` | `T7<slot>.AIN<n>.volts` | t7_bridge |
| cold junction | `{0x26, (slot-1)*0x20 + 0x0F}` | `T7<slot>.CJC.temperature_c` | t7_bridge (TC boards) |
| calibrated | `{0x26, (slot-1)*0x20 + 0x10 + ain}` | `T7<slot>_Cal.AIN<n>.pressure_psi` / `temperature_c` / `force_kg`, + `raw_uv` | calibration_service |

- **Identity.** uid is `board_id*100 + AIN` and the role is the channel's `role`. The model comes
  from `[calibration_model_<t7 board>]` by role, exactly as for an ESP32 board:
  cubic / robust / blend / physics for a PT, cubic / physics for an LC. With no model set, a
  T7 input defaults to **physics**, the datasheet conversion from its channel row.
- **Calibration code.** The "ADC code" is the reading in **microvolts** (`t7::t7_counts`).
  Captures, Zero / Zero-All, clear, profile reload, the robust learner and LC tare all work
  on it unchanged. The GUI reads it as `raw_adc_counts`.
- **Logical channels.** T7 inputs use 128 + (slot-1)·16 + ain, clear of the ESP32 boards' 1–80.
- **Units never cross.** The cubic store tags each channel `adc` or `uV`. A role that moves
  between an ESP32 board and a T7 does not take its fit along: its points stay, as an orphan
  at the old uid, and the new channel starts uncalibrated. The robust adjustments file
  has no unit tag, so T7 inputs are filed there by uid, not role.
- **Thermocouples.** Type K against the latest cold junction for that T7. A TC sample that
  arrives before any cold-junction reading is not published.
- **Abort thresholds.** `[abort_pts]` is unused by the firmware today and hidden in the config
  editor (see `docs/CONFIGURATION_GUIDE.md`); a T7 role there resolves to no board, as before.

The GUI shows each PT / TC / LC input under its role on every role-driven page, and the
Calibration page includes T7 PT / LC inputs. Capture, zero and tare work as for ESP32
sensors, and the "ADC" column is µV. The config editor's T7 channel table has a Model column.

The session pipeline runs t7_bridge as `sensor-t7` (`deploy/systemd/sensor-t7.service`;
re-run `install_services.sh` once to add it). A simulated run uses `--fake`. With no enabled
T7 it exits 0 and stays down.

### Bringing up the first real T7 (on the stand)

Everything below runs on `star-rfs`, so `daq-server/CLAUDE.md` applies. The T7 itself only
streams inputs and t7_bridge writes only stream/AIN setup registers, but restarting pipeline
units still bounces a live run. Do it between runs, with the operator.

1. **LJM on the DAQ host.** Install LabJack's Linux LJM package, then `bash scripts/build.sh`.
   The configure log must say `t7_bridge: LabJack LJM found`. If it says `--fake only`, the
   binary exits 3 on real hardware.
2. **Network.** Follow "Static IP" above: plug the T7 into the board LAN, read its MAC from the
   lease file or label, put it in `[boards.labjack_1] mac`, `sudo deploy/dhcp/reload_dhcp.sh`,
   then power-cycle it. `ping 192.168.2.81` must answer.
3. **Config.** `[boards.labjack_1] enabled = true`, and one channel row per wired input with the
   sensor's real datasheet numbers (`full_scale`, `signal`/`shunt_ohms`, `sensitivity_mv_per_v`,
   `excitation_v`). The config editor's T7 card flags anything t7_bridge would refuse. Deploy it.
4. **First stream, by hand, with no run active** (`systemctl --user is-active sensor-t7` is not
   `active`; the T7 serves one stream at a time):
   `build/bin/t7_bridge --board boards.labjack_1`. It logs the serial, the scan list and the rate.
   Leave it streaming for a minute: there should be no auto-recovery or skipped-scan lines.
   Then Ctrl-C it.
5. **Start a run** from the Session screen. `sensor-t7` comes up with the pipeline, and each
   input shows under its role. Check each one against a known state: a vented PT reads ~0 psi,
   an unloaded LC ~0 kg (then tare it), and a TC reads room temperature.
6. **Cold junction** (TC boards only), below.
7. **Calibrate** PTs and LCs on the Calibration page as for any ESP32 sensor, if `physics`
   is not good enough.

### RTDs through an LJTick-Resistance

`kind = "RTD"` reads a platinum RTD through a LabJack LJTick-Resistance (LJTR) plugged into the
T7's AIN screw terminals. The tick is a divider from its own 2.5 V reference through the RTD and a
fixed precision resistor, read across the fixed one:

    Vout = Vref * R_fixed / (R_fixed + R_rtd)        R_rtd = R_fixed * (Vref - Vout) / Vout

(LabJack, LJTick-Resistance datasheet and "Measuring Resistance" app note: Vref 2.500 V ±0.04 %,
1.5 ppm/°C typical, 10 mA typical output current; R_fixed is 1k, 10k, 100k or 1M ±0.05 % by model.
LabJack: "best to simply assume a constant of 2.500 V".)

**Wiring.** The tick plugs into a screw-terminal AIN block and uses both inputs, so it measures two
resistances: VINA on the even AIN and VINB on the odd one (AIN0/1 or AIN2/3; only those four are on
screw terminals). That is two ticks and four RTDs per T7 without a CB37. Single-ended only. VS must
be above 4.0 V for a 2.5 V output.

**Settling.** The divider is buffered (an OPA2335), so the T7 sees an op-amp output, not 1 kΩ-1 MΩ.
The 1 kΩ source-impedance limit and the high-impedance rows of the settling app note do not apply,
and no extra `settling_us` is needed for any model. The only filter is the tick's 100 pF input cap
with R_unknown: −3 dB at about 1.6 kHz for 1 MΩ, far above any scan rate here. (LabJack documents
the buffer and the cap; that this makes extra settling unnecessary is our inference.)

```toml
[[boards.labjack_1.channels]]
ain = 3
kind = "RTD"
role = "LOX RTD"
r0_ohms = 1000.0     # Pt1000 (100.0 for a Pt100)
ljtr_ohms = 1000.0   # LJTick-Resistance-1k
# vref_v = 2.5       # optional: the tick's reference as measured, if you have measured it
```

- **Conversion** (calibration_service, physics only, like a T7 TC): volts → ohms by the formula
  above → °C on the IEC 60751 Callendar–Van Dusen curve, **including the C term below 0 °C**
  (`resistance_to_temp_cvd_full`). Published as `T7<n>_Cal.AIN<a>.temperature_c`, so the GUI shows
  it beside the ESP32 RTDs. An open (0 V) or shorted (≥ Vref) element publishes nothing.
- **Range** must be 10 V: the divider swings up to Vref. At 22 °C a Pt100 on an LJTR-1k reads
  2.255 V and a Pt1000 reads 1.199 V, both above the ±1 V range's 1.01 V.
- **Pairing.** LabJack: "choose the version that most closely matches your typical resistance
  value", and for RTDs "We typically recommend using our LJTick-Resistance-1k". The RTD app note
  puts the Vref-limited error at about ±1.1 °C for a Pt100 and ±0.21 °C for a Pt1000 on the 1k
  tick. So use a **Pt1000 + LJTR-1k**. It swings about 6.7 mV/°C near −183 °C (2.4 mV/°C at
  0 °C); a Pt100 on an LJTR-1k only about 1.0 mV/°C there.
- **Two-wire.** Lead resistance adds straight to R_rtd: about 2.6 °C per ohm on a Pt100, 0.26 °C per
  ohm on a Pt1000. Keep leads short or use a Pt1000.
- **Self-heating.** 2.5 V across 2 kΩ puts 1.25 mA (1.6 mW) through a Pt1000 at 0 °C. In a liquid that
  barely matters; in still gas it reads slightly warm. That's the tick's design, not ours.
- **Not done:** no per-sensor calibration (offset or cubic) for a T7 RTD. The ESP32 RTD boards use
  the same full curve (`rtd_board_adc_to_temp_c`); they used to drop the C term and read 1.76 °C
  cold at −183 °C.

### Measuring `cjc_offset_k`

The bridge estimates the screw-terminal temperature from the T7's internal sensor plus
`cjc_offset_k` (default −3.0 K, LabJack's figure for AIN0-3; LabJack quotes it as ±2.5 °C). Any
error in that estimate goes nearly 1:1 into every TC reading on that T7, so measure it once per
unit, on the terminals the TCs actually use:

1. Let the T7 sit powered in its enclosure for 30 minutes to reach thermal steady state
   (LabJack measured a ~12 minute time constant for the box).
2. Put a type K probe on an input in an ice bath (crushed ice and water, stirred), or beside
   a reference thermometer at a known temperature.
3. Average `T71_Cal.AIN<n>.temperature_c` over a minute; call it `reading`.
4. New `cjc_offset_k` = old `cjc_offset_k` + (`reference` − `reading`). For an ice bath,
   `reference` is 0.0 °C.
5. Save it in the config editor (it shows once the T7 has a TC), start a new run, and check
   the bath reads within ±1 °C.

Re-measure if the T7 moves to a different enclosure or the terminal block is changed.

### Not done yet
- **Hardware.** Nothing has run against a real T7. The LJM path compiles against LabJack's
  real `LabJackM.h` only. The rest is covered without one: `ctest -R t7` (unit and end to end,
  including a mixed ESP32 + T7 rig on the real `elodin-db`), `test/test_integration.sh`, the
  Playwright spec `e2e/labjack-t7.spec.ts`, and `test/test_session.sh`. The simulated config
  `config_base.toml` carries a T7 (PT on AIN1, TC on AIN2, RTD on AIN3, LC on AIN4) that `--fake` streams.
- **Aborts.** A T7 has no on-board logic, so nothing aborts on its own when a T7 input crosses
  a limit; only the server (state scripts) can act on one.
- **Thermocouple types other than K**, and the `cjc_offset_k` measurement on the stand.

## Answered from LabJack's documentation (2026-11-03)

What used to be open here, and where the answer now lives in this doc:

| Question | Answer | Where |
|---|---|---|
| Stream rate vs resolution, range, channels; command-response latency | Tables A.1.7/A.1.8; ~1.1 ms. Now enforced by config validation | §4 rate limits, §2 |
| Connection limits, packet sizes | 502: 2, 702: 1; TCP 1040 B, UDP 64 B | §2 |
| DHCP default and fallback | DHCP on; **no** fallback address | §2 Static IP |
| LJM installer, paths, licence | 1.2304 stable; `/usr/local/...`; MIT + Boost/gRPC/LGPL notices | §7 LJM |
| `LJM_Close` on a running stream | LJM stops it on close, best effort; a crash leaves it running | §7 Startup |
| AIN14 formula | −92.6 K/V + 467.6 K (the old −92.379 was the U6's) | §4 Thermocouples |
| Terminal CJC offset | −3 K for AIN0-3 (default changed from −4.9) | §4, `cjc_offset_k` |
| Which LJTR for an RTD; settling behind one | LJTR-1k; buffered, no extra settling | RTDs |
| T7 clock accuracy | ±20 ppm at 25 °C, ±50 ppm over −10…60 °C | §4 |
| 250 Hz temperature-sensor limit (LJM 2631) | T8 only; not applied | §4 rate limits |
| Watchdog | stream traffic does not feed it; leave it off for inputs | §2 watchdog |
| Port-702 frame layout | 16-byte header (status at 12-13, skipped scans at 14-15), then u16 samples MSB-first; [DS 3.2.4]. Only needed without LJM | — |

## Still to verify on the bench

These the documentation does not settle; each is a few minutes with the real unit.

- **Takeover after `kill -9`** (§7): expect the `stopped a stream already running` line and no
  `retrying` before it. This also tells us whether a SIGKILL'd client's stream socket (the one
  port-702 slot) is released at once or blocks the next stream until it times out. The datasheet
  has no timeout for stale sockets. If it blocks, power-cycle the T7, or write
  `ETHERNET_APPLY_SETTINGS = 1`, which power-cycles its Ethernet.
- **`STREAM_ENABLE = 0` from a second connection** stops another client's stream (the fallback
  path in §7). It is one register map, so it almost certainly does, but this is undocumented.
- **AIN setup writes mid-stream return 2605.** The LJM docs list the AIN registers under
  `STREAM_IS_ACTIVE` but never show the read/write case explicitly; the fake assumes 2605.
- **Pull the Ethernet cable mid-stream:** record the code (1306 or 1239) and how long it takes,
  and check that the bridge comes back on its own when the cable goes back in.
- **Warning 203** (`LJME_USING_DEFAULT_CALIBRATION`) should never appear in the bridge log on
  a real unit.
- **`cjc_offset_k`**, measured as above.
- **Licence file** in the installer zip, before LJM goes into a deploy image.

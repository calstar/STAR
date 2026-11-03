# LabJack T7 over Ethernet — reference for the DAQ integration

Status: research notes for the `daq-labjack-t7` branch. Nothing here is wired into
the pipeline yet.

## Where these facts come from

| Tag | Source | Version |
|---|---|---|
| **[MAP]** | `labjack/ljm_constants` → `LabJack/LJM/ljm_constants.json` (LabJack's machine-readable Modbus map + error table) | 2026.05.11.A (commit 482d58d) |
| **[H]** | `labjack/ljm_constants` → `LabJackM.h` (the LJM C API header) | `LJM_VERSION 1.2200` |
| **[EX]** | `labjack/C_CPP_LJM` → `more/stream/stream_basic.c`, `more/ethernet/*.c`, `more/watchdog/*.c` | commit 7a0f270 (2026-10-20) |
| **[WEB?]** | Search-result snippets of support.labjack.com. The pages themselves could not be opened from the build environment, so **verify these before relying on them** | — |

The datasheet pages on support.labjack.com (Ethernet, stream mode, low-level stream,
data rates) still need reading by someone with normal web access, and so does the
LJM Linux installer page. Those pages are the open items listed at the end.

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
| Simultaneous TCP connections | 502: 2, 702: 1 | [WEB?] |
| Max packet | TCP 1040 B, UDP 64 B | [WEB?] |
| Concurrent streams | 1 per device. Command-response still works mid-stream, except AIN reads | [WEB?] |
| LJM Ethernet open timeout | 1000 ms default (`LJM_ETHERNET_OPEN_TIMEOUT_MS`) | [H] |
| LJM Ethernet send/receive timeout | 2600 ms default (`LJM_ETHERNET_SEND_RECEIVE_TIMEOUT_MS`) | [H] |

Two consequences:
- **Only one stream client at a time.** A Kipling session left open on the stand
  laptop will break our stream (or ours breaks theirs). Close Kipling before a test.
- **Command-response AIN reads fail while streaming.** Every AIN we want must be in
  the scan list.

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
1. Leave `ETHERNET_DHCP_ENABLE_DEFAULT` = 1. The shipping default is believed to be
   DHCP-on [unverified]; check it in Kipling over USB if the unit isn't fresh.
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
Any USB/Ethernet traffic clears the timer. The watchdog matters if the T7 ever drives
DIO/DAC for actuation: on loss of the server it can force outputs to a safe state.
`more/watchdog/write_watchdog_config.c` [EX] has the setup.

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
| `LJM_STREAM_SCANS_RETURN` | `ALL` (1): eStreamRead blocks until ScansPerRead | `ALL_OR_NONE` (2) never blocks and returns `LJME_NO_SCANS_RETURNED` (1309) instead, which fits a poll loop |
| `LJM_STREAM_RECEIVE_TIMEOUT_MODE` / `_MS` | calculated from scan rate | with a manual value we decide when a dead link is declared |
| `LJM_STREAM_AIN_BINARY` | 0 = calibrated volts (float) | 1 = raw uncalibrated binary, which matches our raw→cal split but means applying LabJack cal constants ourselves. **Keep 0.** |
| `LJM_STREAM_TCP_RECEIVE_BUFFER_SIZE` | OS default | raise it if the DAQ host drops data under load |
| `LJM_STREAM_THREADS_PRIORITY_MODE` | auto-elevated: collector thread SCHED_FIFO 90, callbacks SCHED_RR 50 | needs CAP_SYS_NICE / rtprio under systemd, otherwise only a debug log line |
| `LJM_AUTO_RECONNECT_STICKY_CONNECTION` / `_SERIAL` | 1 / 1 | reconnect stays on Ethernet and on the same serial number |
| `LJM_AUTO_RECONNECT_WAIT_MS` | 500 | |
| `LJM_AUTO_IPS` | 1 (caches IPs in a file) | turn off: we always open by explicit IP |

## 4. Stream configuration registers  [MAP]

| Register | Addr | Type | Meaning |
|---|---|---|---|
| `STREAM_SCANRATE_HZ` | 4002 | F32 | scans/s; sample rate = NumChannels × ScanRate |
| `STREAM_NUM_ADDRESSES` | 4004 | U32 | scan-list length |
| `STREAM_SAMPLES_PER_PACKET` | 4006 | U32 | spontaneous mode only |
| `STREAM_SETTLING_US` | 4008 | F32 | 0 = auto |
| `STREAM_RESOLUTION_INDEX` | 4010 | U32 | 0 = default; higher = quieter but slower (caps max rate) |
| `STREAM_BUFFER_SIZE_BYTES` | 4012 | U32 | power of 2; 0 = default; scans = bytes/2/NumAddresses |
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

### Thermocouples and other AIN_EF values
`AIN#_EF_INDEX` (9000+) / `AIN#_EF_READ_A` (7000+) give thermocouple and other
extended-feature values computed on the device. Stream returns raw volts per AIN, not
EF results. So TCs either go in the scan list as volts, with CJC and the TC polynomial
done in our calibration service, or are read by command-response, which **cannot** run
while the stream holds the AINs. Plan TCs as streamed volts plus `TEMPERATURE_DEVICE_K`
for the CJC, unless the datasheet says otherwise. (EF results being unstreamable is my
reading of the register descriptions: **[unverified]**.)

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

Auto-recovery marks a gap by writing 0xFFFF into the **first** channel of the scan, so
**the first scan-list entry must be an AIN or `FIO_STATE`/`EIO_STATE`/`CIO_STATE`/...**.
Any other digital channel first gives `LJME_DIGITAL_AUTO_RECOVERY_ERROR_DETECTED`
unless `LJM_STREAM_DIGITAL_AUTO_RECOVERY_ERROR_DETECTION_DISABLED=1` [H].
**Never put `CORE_TIMER` first.**

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

## 7. How this maps onto daq-server (from reading the code, Nov 2026)

- **No data-source abstraction exists.** `daq_bridge_main.cpp` is a single UDP
  `SensorFramePipeline` that infers the board from the source IP, and board kinds are a
  closed enum (`ActiveBoardKind`, `lib/include/config/LoadActiveBoards.hpp`).
- **Elodin tables** are `[type_hi, (slot-1)*0x20 + ch]` (raw) / `+0x10` (calibrated),
  holding the 21-byte `RawPTMessage` with a `u32 raw_adc_counts`. T7 data arrives
  as float volts, so it needs either fixed-point scaling into u32 or a new message/vtable.
- **Calibration** (`services/calibration/calibration_main.cpp`) filters on `type_hi`
  0x20–0x24/0x30, so a new T7 `type_hi` has to be added there.
- **Suggested shape:** a separate `t7_bridge` executable (the bridge is single-threaded
  and polls UDP every 500 µs). It runs the LJM stream thread, reuses `ElodinClient`,
  `BoardClockSync` and the table-id scheme, and is configured from a
  `[boards.<name>] type = "T7"` entry plus a channel table. Build it behind a CMake
  `option(WITH_LABJACK_LJM ...)` with `find_library(LabJackM)`, so CI and dev boxes
  without LJM still build. Use `LJM_DEMO_MODE` for tests.
- **Actuation (later):** `ActuatorCommander` only sends UDP today. For T7 DIO it
  would need a transport seam, plus the T7 watchdog as the fail-safe.

## Still to verify (needs support.labjack.com / labjack.com, blocked here)

- Max stream rate vs `STREAM_RESOLUTION_INDEX`, range and channel count over Ethernet
  (datasheet appendix A-1), plus typical command-response latency.
- Connection limits per port and max packet sizes (marked [WEB?] above).
- T7 shipping default for DHCP, and what it falls back to if no server answers.
- The current LJM Linux installer name and version, plus
  LJM's redistribution licence (whether `libLabJackM.so` can go in our deploy image).
- Low-level port-702 frame layout (only needed if we skip LJM).
- Whether any AIN_EF (thermocouple) result can be streamed.

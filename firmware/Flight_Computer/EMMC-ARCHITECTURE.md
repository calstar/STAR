# eMMC flight log: architecture

How the flight computer records flight data to its eMMC, and why it is built
this way. Written 2026-11-04 (updated 2026-11-05) against the KIOXIA datasheet
and the STM32H723 datasheet (DS13313), before the Rev 1 board arrived.
**Nothing here has run on hardware yet.** The portable parts are host-tested.
The board adapter (`emmc_stm32.c`) has **not been compiled**: the STM32 build
(PlatformIO `env:flight`) comes with PR #165, which this branch does not
include. See §7 for what integration still needs.

Words used below:

- **eMMC**: a flash memory chip with its own controller inside. It does wear
  levelling and error correction itself, and the MCU sees it as a numbered
  list of 512-byte blocks.
- **LBA** (logical block address): a block's number in that list.
- **SDMMC1**: the STM32 peripheral that talks to the eMMC. **IDMA** is its
  built-in DMA engine, which moves data between RAM and the card without
  the CPU.
- **Chunk**: 16 KB (32 blocks). The unit the log writes in.
- **Session**: everything recorded from one Arm to the matching Un-arm (or to
  power-off).

---

## 1. The part

U9 is a **KIOXIA THGBMTG5D1LBAIL**, 4 GB. Datasheet: rev 1.0, 2021-10-07, 30
pages. Accessible copy (from LCSC's product page, C5197299):
<https://datasheet.lcsc.com/datasheet/pdf/ea386c834ed06c7e4629df6606f52741.pdf>.
The Mouser link in #137 blocks scripted downloads. **This answers the #137
storage question asking for an accessible datasheet; post the link there.**

| Fact | Value | Datasheet | What it means for us |
|---|---|---|---|
| Interface | JEDEC eMMC **5.0** (not 5.1), 1/4/8-bit | p. 1 | Standard commands. We use 4-bit |
| User area | 3,959,422,976 B = 0x760000 blocks of 512 B | p. 5 | ~3.95 GB for the log |
| VCC / VCCQ | 2.7–3.6 V / 1.7–1.95 V or 2.7–3.6 V | p. 12 | The board runs both at 3V3 |
| Bus speed at 3.3 V VCCQ | 52 MHz SDR/DDR max. HS200/HS400 need 1.8 V | pp. 2, 15–16 | **52 MHz is the ceiling on this board** |
| Legacy timing (power-up default) | ≤ 26 MHz data, ≤ 400 kHz identification | p. 17 | We stay here. See §5 |
| Typical speed (×8, sequential) | read 46 MB/s, **write 14 MB/s** at 52 MHz | p. 2 | ~250× what we need |
| Write current | ≤ 55 mA ICCQ + 25 mA ICC at 3.3 V | p. 13 | ~80 mA while writing |
| Sleep current | 100 µA typ (ICCQ), 120 µA with ICC | p. 3 | Worth using in Idle later (§9) |
| Temperature | −25 to +85 °C operating | p. 2 | |
| `RST_n_FUNCTION` (EXT_CSD[162]) | **0x00: hardware reset pin ignored** | p. 10 | PA8 (EMMC_RST) does nothing until a one-time bit is set. We don't set it |
| `WR_REL_SET` (EXT_CSD[167]) | 0x1F: reliable write on in the user area | p. 10 | On power loss a 512 B sector holds either its old or its new data, never a mix |
| `CACHE_CTRL` (EXT_CSD[33]) | 0x00: the 512 KB volatile cache is off | pp. 7, 10 | Keep it off: with it on, a power cut can lose acknowledged writes |
| `OPTIMAL_WRITE_SIZE` (EXT_CSD[265]) | 4 × 4 KB = **16 KB** | p. 7 | The chunk size |
| `HC_ERASE_GRP_SIZE` (EXT_CSD[224]) | 8 × 512 KB = 4 MB | p. 8 | Where the log's data starts (LBA 8192) |
| `PRE_EOL_INFO`, `LIFE_TIME_EST_A/B` | wear indicators | p. 7 | Checked at bring-up (`emmc_card_check`) |
| Read-disturb warning | avoid repeated CMD0/CMD1 init loops | p. 28 | The card is brought up **once** per power-up |

The datasheet's legal page says the part is "neither intended nor warranted"
for aerospace use. That's standard consumer-part boilerplate. It means we test
it ourselves rather than lean on the vendor.

## 2. How it is wired (from #137)

```
STM32H723 SDMMC1                 U9 eMMC
  PC8..PC11  D0..D3  ──10k pull-ups──  DAT0..DAT3   (4-bit bus)
  PC12       CK      ─────────────────  CLK
  PD2        CMD     ──10k pull-up────  CMD
  PA8        GPIO    ─────────────────  RST_n        (ignored as shipped, see §1)
  3V3 (always on)  ───────────────────  VCC, VCCQ
```

The eMMC is on the always-on 3V3 rail, so it stays powered through Idle and
Stop mode.

## 3. When the eMMC is used: from ARMED

The state machine (`src/app/flight_state.h`, from `Flight_computer.drawio`):

```
power on ─► SELF_TEST ─(done)─► IDLE ─(Arm)─► ARMED ─(launch)─► LAUNCHED ─(apogee)─► RECOVERY
                                  ▲             │
                                  └─(Un-arm)────┘
```

| State | eMMC |
|---|---|
| SELF_TEST | **untouched** |
| IDLE | **untouched** (Stop mode between heartbeats) |
| ARMED | **recording starts.** The first Arm after power-up brings the card up and finds the end of the log |
| LAUNCHED | recording (a STATE record marks the change) |
| RECOVERY | recording, until power-off |
| Un-arm (ARMED → IDLE) | SESSION_END record, partial chunk flushed, recording stops |

**Why ARMED and not LAUNCHED:** launch and apogee detection don't exist yet.
A log that waited for "launch detected" would never start. Starting at ARMED
records the whole flight now. Even once detection exists it's the safer
choice: the pad seconds before liftoff are some of the most useful data, and
a missed detection can't cost the flight.

This is one function, `flight_state_logs_to_emmc()`. Moving the start later
is a one-line change, and its test pins the current choice.

Un-arm after launch is ignored (the diagram draws Un-arm only from ARMED).
`test_flight_state` checks every state/event pair against the diagram.

## 4. Layers

```
 sensor tasks, state machine            ← call emmc_log_append(), emmc_log_on_state()
          │   (copy into RAM, never wait on the card)
          ▼
 emmc_log.c   portable: session logic, chunk queue, on-card format, mount
          │   (only through emmc_port_t)
          ▼
 emmc_port.h  the seam: start / read / write / lock / unlock
          │
          ├──► emmc_stm32.c   board: SDMMC1 + IDMA via ST HAL, FreeRTOS, D-cache
          └──► RAM disk       laptop: tests/emmc/test_emmc_log.c
```

This is the same seam pattern as `self_test_port.h` and `radio.h`: nothing
above the port calls HAL, so the logic runs and is tested on a laptop.
`emmc_card.c` parses the card's ID registers against the datasheet (pure
functions). The adapter calls it at bring-up.

## 5. Decisions and why

### 5.1 Raw blocks, no filesystem

**Choice:** an append-only run of self-describing 512 B blocks, not FAT/FatFs.

**Why:** a filesystem rewrites the same few blocks constantly: the FAT
table, the directory entry, the file size. A power cut in the middle of one of
those writes (landing, a battery connector bouncing) can corrupt the whole
volume. An append-only log never rewrites anything. The worst a power cut can
do is lose the chunk that was in flight. It's also less code and RAM than
FatFs, and nothing blocks while a FAT is updated.

**Trade-off:** you can't plug the card into a laptop and see files. Getting
data off needs a dump path (USB or Ethernet) plus a small decoder script.
Neither exists yet (§9). The format is fully specified in `emmc_log.h`, so the
decoder is short; the test file already contains one in C.

### 5.2 Every block checks itself

Each block (layout in `emmc_log.h`):

```
 0  magic "SLG1"   4  epoch   8  seq (its own position)   12  session
16  kind (DATA/PAD)  18  bytes used   20  payload (488 B)   508  CRC-32
```

A block is "valid" only if the magic, epoch, position and CRC all match. That
one rule handles everything:

- **Finding the end of the log at mount:** valid blocks form one run from the
  start, so a binary search finds the first invalid one: about 23 reads for
  4 GB (log₂ 7.7M ≈ 23). No directory or "write pointer" block exists, so none
  can wear out or tear.
- **Torn writes:** reliable write (§1) means each sector lands whole or not at
  all, so a cut-off chunk just ends the run early. Sectors might land out of
  order, leaving a hole with valid blocks after it. Resuming at the hole would
  overwrite those, so mount checks the next 32 blocks past the end and keeps
  searching if any are valid (`test_torn_write_hole`).
- **Wiping the log ("format"):** don't erase 4 GB. Write a new superblock
  (LBA 0) with a higher **epoch** number. Every old block carries the old
  epoch, so it reads as invalid. If the superblock itself is unreadable, the
  new epoch is taken above both the old superblock's and the first log
  block's, so stale data can never come back (`test_stale_epoch`).

**Records** sit inside the payload as `type, length, t_ms, data` (6 B + data,
≤ 255 B of data) and never straddle blocks. Types below 0x10 belong to the log
(SESSION_START, STATE, SESSION_END, DROPPED). Sensors use 0x10 and up.

### 5.3 Two sides that never wait on each other

```
sensor tasks ──append──► [chunk 0][chunk 1][chunk 2][chunk 3] ──writer task──► eMMC
               (memcpy,    filling   sealed   sealed   free       (16 KB per
                ~µs)                                               write)
```

- `emmc_log_append()` copies one record into the current chunk under a mutex
  held for microseconds, then returns. **It never touches the card.**
- `emmc_stm32_writer_task` (low priority) calls `emmc_log_service()` in a
  loop. That function does **all** card I/O, including bring-up and mount,
  one chunk per call, with no lock held during the transfer. The test disk
  fails the test if any transfer runs with the lock held.
- If the card stalls (eMMCs pause for internal garbage collection) and all
  chunks fill up, new records are **dropped and counted**, and the next record
  that fits is preceded by a DROPPED record saying how many were lost. Flight
  code never waits on storage. Losing a few samples is better than missing a
  control deadline.
- A partly filled chunk is sealed (padded with PAD blocks) after
  `flush_interval_ms` (default 1 s), on Un-arm, or on `emmc_log_flush()`.
  That bounds how much a power cut can lose to ~1 s plus the chunk in flight.

### 5.4 Sizing (assumed data rates; replace with the real sensor configs)

```
IMU        1.66 kHz × (6 B header + 12 B) ≈ 30 kB/s
high-g     1 kHz    × (6 + 6)             ≈ 12 kB/s
baro       100 Hz   × (6 + 8)             ≈  1.4 kB/s
GNSS       10 Hz    × (6 + ~40)           ≈  0.5 kB/s
block overhead 24/512 ≈ 5 %               → ≈ 46 kB/s, call it 50 kB/s
```

| Quantity | Arithmetic | Result |
|---|---|---|
| RAM for the log | 4 chunks × 16 KB + 512 B scratch | ≈ 65 KB of the 320 KB AXI SRAM |
| Card stall it rides out | 64 KB ÷ 50 kB/s | ≈ 1.3 s |
| Bus time per chunk | 16 KB ÷ (21.5 MHz × 4 bit ÷ 8) ≈ 16 KB ÷ 10.75 MB/s | ≈ 1.5 ms |
| Recording time on 4 GB | 3.95 GB ÷ 50 kB/s | ≈ 79,000 s ≈ 22 h of armed time |
| Padding cost at a 1 s flush when nearly idle | ≤ 16 KB/s | still days of capacity |

When the card fills, recording stops (FULL) instead of wrapping around. 22 h
is many flights, and the log is wiped deliberately with a new epoch, not by
overwriting.

### 5.5 Clock: legacy timing at 21.5 MHz

The kernel clock is 129 MHz. The adapter runs the card at 129 ÷ (2 × 3) =
**21.5 MHz**, inside the 26 MHz legacy limit, so no CMD6 switch to
high-speed timing is needed. That's ~10 MB/s, 200× the need, with fewer
things to go wrong. At this speed the datasheet's falling-edge output note
(p. 17) leaves plenty of setup margin: tWL ≈ 23 ns against tODLY ≤ 8 ns.

### 5.6 STM32 specifics (DS13313)

- **Buffers in AXI SRAM, not DTCM.** SDMMC1's IDMA is a master on the AXI bus
  (DS13313 Figure 3). The fast 128 KB DTCM isn't on that bus, so IDMA can't
  reach it. `start()` checks the buffer addresses and refuses (EMMC_ERR_PARAM)
  rather than DMA into the void. **This does not happen by default:** the
  CubeMX-generated `STM32H723xx_FLASH.ld` puts `.data`, `.bss`, heap and stack
  all in DTCMRAM (0x2000_0000). The three DMA buffers in `emmc_stm32.c`
  (`chunks`, `scratch`, `ext_csd`) need a dedicated AXI SRAM section (§7).
  `NOLOAD` (not zeroed at boot) is fine for all three: the log zeroes a chunk
  when it starts filling it, and scratch and `ext_csd` are always written
  before they are read.
- **D-cache.** The Cortex-M7 caches RAM, and DMA bypasses the cache. Before a
  DMA write the adapter **cleans** the buffer (pushes cached data to RAM).
  After a DMA read it **invalidates** it (drops stale cached copies). Both
  work on 32-byte lines, which is why buffers are 32-byte aligned and transfers
  are whole 512 B blocks.
- **Completion** comes from the SDMMC1 interrupt → HAL callback → a FreeRTOS
  semaphore. Then the adapter waits until the card is back in TRANSFER state:
  a write isn't done until the card finishes programming, not just when the
  bus goes quiet.

## 6. What is tested (host, `tests/emmc`, sanitizers on)

| Suite | Checks |
|---|---|
| `test_flight_state` | every state × event against the diagram; which states record |
| `test_emmc_log` (14 groups) | no card I/O before ARMED; round trip; sessions across re-arm and power cycles; launch/recovery keep recording; flush interval; back-pressure and DROPPED; torn write; torn write with a hole; stale epoch; bring-up failure (and no retry loop); write retry then FAULT; FULL; bad init; never a transfer under the lock |
| `test_emmc_card` | CID/EXT_CSD parsing against the datasheet's own register values; each issue flag |

The decoder inside `test_emmc_log.c` re-reads the disk image with its own
CRC, so a format bug can't hide by being decoded by the same code.

**Each guard was confirmed to fail when broken** (repo rule: a test that can't
fail isn't a test):

| Deliberate break | Caught by |
|---|---|
| mount doesn't look past a hole | `test_torn_write_hole` |
| IDLE records too | `test_flight_state`, `test_no_io_before_arm` |
| lock held across a write | the RAM disk's lock check |
| format reuses epoch 1 | `test_stale_epoch` |
| no DROPPED record | `test_backpressure` |

**Not tested:** anything on the board. `emmc_stm32.c` hasn't been compiled
(the build is in PR #165). Verify on the first build that
`HAL_MMC_GetCardExtCSD()` exists in FW_H7 V1.13.0, and that `hmmc1.CID` holds
the raw CID words in the order `emmc_card_parse` expects (cid[0] = bits
127..96).

## 7. Integration: what the board build needs (status 2026-11-05)

The board-side changes live on other branches: PR #165 (`inez/stm32-setup`:
the CubeMX project in `Flight_Computer/` and the PlatformIO build) and
`inez/flight/bus_code` (the RTOS communication layer, which reuses this log).
Change pins, clocks and NVIC in CubeMX, never by hand.

| # | Change | Why | Status |
|---|---|---|---|
| 1 | SDMMC1 clock divide factor **0 → 3** | 0 means *bypass*: SDMMC_CK = the full 129 MHz, 5× the 26 MHz legacy limit. 3 gives 21.5 MHz. The adapter also clamps CLKDIV as a backstop | done on `inez/flight/bus_code` |
| 2 | `MX_SDMMC1_MMC_Init` → **"Do Not Generate Function Call"** | if `main()` inits the card and it's dead, `HAL_MMC_Init` falls into `Error_Handler()` and the board hangs before self-test (breaks #137 §7) | done on `inez/flight/bus_code`: `board_soft_init()` calls it once, non-fatal |
| 3 | NVIC: enable **SDMMC1 global interrupt**; `SDMMC1_IRQHandler` calls `HAL_MMC_IRQHandler(&hmmc1)` | without it, IDMA never reports completion and every transfer times out | planned on `inez/flight/bus_code` |
| 4 | Linker: a `NOLOAD` section in **RAM_D1** (AXI SRAM) | CubeMX's script puts `.bss` in DTCM, which IDMA can't reach (§5.6) | planned on `inez/flight/bus_code` |
| 5 | Put `chunks`, `scratch`, `ext_csd` in `emmc_stm32.c` into that section (keep `aligned(32)`) | today they would land in DTCM and `start()` returns EMMC_ERR_PARAM | **to do** once #4 exists; attribute goes in board code only, not the portable files |
| 6 | FreeRTOS task `emmcWriter` → `emmc_stm32_writer_task`, below normal priority, ~1 KB stack; `emmc_stm32_init()` after `osKernelInitialize()` | the writer does all card I/O | to do at integration |
| 7 | Init the card **once** per power-up | datasheet p. 28: repeated CMD0/CMD1 cause read disturb | `inez/flight/bus_code`'s self-test probe is being changed to init once and leave `hmmc1` READY; the adapter then uses it as is |
| 8 | Only `emmc_stm32.c` defines `HAL_MMC_TxCpltCallback`, `RxCpltCallback`, `ErrorCallback` | one owner for transfer completion | agreed with `inez/flight/bus_code` |

**Note on "start at ARMED":** with #2 done the bus_code way, the boot
self-test identifies the card once (CMD0/1/2/3) but reads and writes nothing.
All log reads and writes still start at ARMED.

## 8. Wiring it to the state machine

```c
/* after osKernelInitialize() */
emmc_stm32_init();

/* wherever the state machine applies an event */
flight_state_t next = flight_state_next(state, event);
if (next != state) {
    emmc_log_on_state(emmc_stm32_log(), state, next, osKernelGetTickCount());
    state = next;
}

/* in each sensor task, at full rate while armed (returns false otherwise) */
emmc_log_append(emmc_stm32_log(), REC_IMU, t_ms, &sample, sizeof sample);
```

`emmc_log_on_state()` does no I/O, so it's safe in the radio command path.
`emmc_log_append()` returns false outside ARMED/LAUNCHED/RECOVERY, so sensor
tasks can call it unconditionally.

## 9. Open questions for the team

1. **Failure policy (#137 §7):** if the eMMC fails to come up on Arm, the log
   goes to FAULT, and the Arm still happens. Should an eMMC fault refuse Arm
   instead? #137's proposal lists the eMMC as *required*. If so, the arm path
   needs to wait for the first mount, and Arm becomes "mount, then arm".
2. **Self-test report on eMMC:** #137 §5 planned to write the self-test report
   to the eMMC as its write test. Starting at ARMED means self-test doesn't
   touch the card. Suggested: put the self-test summary in the first record of
   each session (one `emmc_log_append` right after Arm), and let self-test
   only report "eMMC not yet checked".
3. **Getting data off:** a USB-CDC or Ethernet dump command plus a Python
   decoder (`tools/`). Needed before the first flight.
4. **Record types:** a registry of sensor record types (0x10+) and their
   payload layouts, shared with the decoder.
5. **Time base:** records carry a ms tick. Tie it to GPS time with a periodic
   record (TIMEPULSE on PB11).
6. **Idle power:** the card idles at mA level. CMD5 sleep (100 µA, datasheet
   p. 3) in Idle and wake on Arm would help the battery. Not done yet.
7. **Second copy:** the SD NAND (U10, 1 Gbit) could hold a decimated copy of
   the log as a backup.

## Files

| File | What |
|---|---|
| `src/app/flight_state.h`, `src/app/flight_state.c` | the diagram's transition table |
| `src/app/emmc_port.h` | the seam |
| `src/app/emmc_log.h`, `src/app/emmc_log.c` | the log: format, queue, mount |
| `src/chips/emmc_card.h`, `src/chips/emmc_card.c` | CID/EXT_CSD checks against the datasheet |
| `src/board/emmc_stm32.h`, `src/board/emmc_stm32.c` | board adapter (not yet compiled; buffers need the RAM_D1 section, §7) |
| `tests/emmc/` | host tests; CI job `stm32-emmc-host` |

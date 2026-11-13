# Health task, watchdog, and the start-up SelfTest frame

STAR Project #521 (health task + IWDG that survives Idle sleep) and #522
(send the start-up self-test report over the radio).

## Health task (`health_task.c`, `health_core.c`, `health_board.c`)

One low-priority task, every 100 ms:

1. **Check-ins.** The sensors task, the GNSS task and the eMMC writer each call
   `health_task_beat()` once per loop. A worker that has not checked in for
   5 s latches its fault bit until reboot. Only when no bit is set does the
   task refresh IWDG1. One hung task means no refresh, then a reset.
2. **Analog sample.** All seven ADC1 inputs (`board_adc.h`) go into one
   `REC_HEALTH` record (`records.h`, 25 bytes, size pinned): battery mV and
   state through `battery.c`, main current in mA (PC1, 1 V/A), raw counts for
   everything else, a valid bit per input, and the check-in fault bits. 10 Hz
   in ARMED and later; in Idle once per wake. The record goes to the eMMC log
   (which only accepts it from ARMED on), and `health_task_latest()` keeps the
   newest one for the radio and Ethernet to read.

Continuity (PA2/PA3) is read only. Nothing here drives a pyro output.

**Parked workers.** In Idle the mode stops the sensors and GNSS tasks
(`mode_core`). They call `health_task_set_active(id, false)` before they
block and `true` when they start again, so a parked worker is not a stall,
and the time it was parked does not count against it. Every worker starts
active, so one that never runs faults. If the eMMC fails to start there is
no writer to check in; `app_start()` parks it so a dead card does not become
a reset loop.

The altimeter-battery current (PC0) scale is not known yet; it is logged as
raw counts. Battery thresholds are `battery.h`'s and will move with the 4S
rework (#510). The SD NAND copy of the log (#518) is not wired here.

## Watchdog through Idle sleep (`board_watchdog.c`, `idle_task.c`)

IWDG1 runs from LSI and keeps counting in Stop (RM0468 p.206). Of the two
options in #521 this takes **(a): a timeout longer than the longest sleep**,
and leaves the `IWDG_FZ_STOP` option byte alone. Reasons: it needs no
option-byte step on every board, and a board that never wakes from Stop
still resets.

- Prescaler 256, reload 4095: 32.8 s at the nominal 32 kHz, 17.47 s at a
  deliberately pessimistic 60 kHz. The Idle sleep is capped at 10 s.
- The Idle loop leases each Stop sleep to the health task:
  `health_task_prepare_sleep(ms)` refreshes IWDG1 and stops counting worker
  ages, `board_sleep()` runs, and `health_task_resume()` gets the real
  elapsed time (HAL time awake plus the Stop time `board_sleep()` reports).
  A wake later than the lease plus 1 s latches every fault bit. The lease is
  only taken when Stop is allowed (`board_sleep_info()`); when the board
  waits awake instead, the workers keep checking in as usual.
- `DBGMCU APB4FZ1.DBG_IWDG1` is set, so the counter stops while a debugger
  halts the core. A breakpoint does not reset the board.
- The watchdog starts last in `app_start()`. It does not cover the start-up
  probes.
- **Reset cause.** `bringup_task` reads `RCC_RSR` first thing, clears it,
  and adds a line to the boot report: `reset  IWDG watchdog (RSR 0x04400000)`.
  The value is also in `g_bringup_report.report.reset_flags`.

IWDG1 is started from registers in `src/board/board_watchdog.c`, not enabled
in the `.ioc`. CubeMX's generated `MX_IWDG1_Init` would start it inside
`main()`, before the RTOS and the self-test, and nothing would be refreshing
it during the up-to-29 s probe session. This needs a team decision if the
.ioc route is preferred.

## SelfTest frame at start-up (`selftest_radio.c`, `selftest_radio_board.c`)

Of the two orders in #522 this takes **(a)**: `app_start()` sends the report
right after the radio task starts and before the Idle loop starts. That
makes it the first frame after boot, ahead of the first heartbeat, and keeps
"nothing transmits during bring-up" true.

- Payload: Ryan's SelfTest frame, `result_bits` u16 and `battery_mV` u16,
  little-endian. `radio_task_send_frame()` adds the header, sequence number
  and CRC, so the report shares the heartbeat's sequence space.
- `battery_mV` is 0 on USB or an unread ADC, the heartbeat's rule.
- Up to 3 attempts, 500 ms apart. Only `RADIO_SEND_OK` (SX1262 TxDone) is
  success; a timeout or a radio that is not set up yet is retried, then
  reported. Worst case adds about 2.2 s to start-up (3 x ~0.4 s at SF9 plus
  two gaps).
- The outcome is in `g_bringup_report.selftest_tx` (`attempts`, `result`).

Not done: repeating the report on request or until the ground has seen it
(step 3, to agree with Ryan), and decoding it on the ground station (step 4,
Ryan / ground-station owner).

## Tests

`tests/health_radio` (in `./flight_test`, ASan/UBSan):

- monitor: stalls, late check-ins, parked and restarted workers, sleep
  leases, early and late wakes, tick wrap
- `health_core`: record layout and conversions, valid bits, USB, rate
- adapter (`health_task.c` against fake CMSIS/watchdog/ADC): a missing
  check-in withholds the refresh, parked workers keep it going
- SelfTest: payload through Ryan's `encode_frame`/`decode_frame`, the USB
  rule, retries bounded, every `radio_send_result_t` mapped, TxDone only

`tests/app/test_boot_report.c` covers the reset-cause line.

Each guarded behaviour was broken on purpose and a test went red.

**Not tested yet (needs the board):** a forced hang resetting the board and
the boot report then saying `IWDG watchdog`; a full Idle night of 10 s
sleeps with no reset; the SelfTest frame received on the ground station;
`flight_test --board` checks for both.

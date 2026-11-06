# Task health and startup radio report

This change implements application-task monitoring, the STM32H723 IWDG1 adapter, a bounded Idle sleep interface, and a startup SelfTest frame worker. **The two assignments still need board integration:** main has no RTC/Stop owner and no shared SX1262 transmitter. The default radio transport reports `SELFTEST_TX_UNAVAILABLE`; it does not transmit or claim delivery.

## Health task

After startup probes, `app_start()` initializes the monitor, creates the sensor/GNSS/eMMC workers, starts IWDG1, and creates a low-priority health task. Each worker reports progress after servicing its loop. A failed sensor read still counts as task progress; sensor health remains in the existing diagnostics. The watchdog measures execution progress.

The health task checks every 250 ms. A worker that has not progressed for five seconds latches its fault bit. Late heartbeats cannot clear a fault, including when workers resume before the health task after a scheduling stall. Only a healthy monitor refreshes IWDG1. A missing worker, failed health-task allocation, or scheduler starvation therefore stops refreshes. `health_task_faults()` exposes the latched sensor/GNSS/log bitmap. This watchdog starts after self-test; it does not protect a hang in early boot or the probes.

IWDG1 uses prescaler 256 and reload 4095, with windowing disabled. The nominal timeout at 32 kHz is 32.768 seconds; a deliberately conservative 60 kHz design bound gives 17.47 seconds. The five-second software threshold and subsequent hardware countdown are separate: a reset is not guaranteed exactly five seconds after a fault. The runtime adapter uses the existing CMSIS register definitions; no generated initialization, pin assignment, or clock-tree configuration changes. Starting IWDG activates its LSI clock. Review the target's option bytes and debug-freeze settings during bench validation.

References: ST RM0468, Independent watchdog chapter; [STM32H723 datasheet](https://www.st.com/resource/en/datasheet/stm32h723vg.pdf), LSI characteristics; [AN5419](https://www.st.com/resource/en/application_note/dm00663674.pdf), LSI and Stop operation. The 60 kHz bound is a conservative software design choice, not a claim that the datasheet specifies that frequency.

## Idle integration contract

The future state-machine/Stop owner must:

1. Quiesce all monitored workers and configure a reliable RTC wakeup. Sleep must not be entered while a transfer is active.
2. Call `health_task_prepare_sleep(duration_ms)` before suspending the scheduler/tick. Accept only a successful return. Durations must be 1–10,000 ms and the monitor must already be healthy. This call refreshes IWDG immediately before the sleep allowance begins.
3. Enter Stop, retaining IWDG operation. Restore required clocks on wake.
4. Before releasing workers, call `health_task_resume(actual_rtc_elapsed_ms)`, including on early DIO1/other interrupt wake. Use measured elapsed time, never the requested duration. The adapter subtracts any HAL-tick advancement to avoid double counting, then excludes the actual sleep interval from worker ages. Time already spent awake still counts against their deadlines.

A wake later than the requested duration plus 1,000 ms latches a fault. A wake that never occurs leaves the watchdog running without refreshes. Polling while a sleep allowance is active cannot feed the watchdog. Nested preparation and resume without preparation fail. The allowance does not program the RTC, enter Stop, suspend peripherals, or change the flight state. Aaron's portable Idle PR #162 also delegates those operations to the state-machine owner. Until that integration exists, the firmware runs awake and the sleep tests use simulated elapsed time.

## Startup report

After `boot_report_build()`, bring-up starts a separate worker with a copy of the final result bitmap and supply voltage. Application acquisition starts independently. The worker uses the existing C++ `encode_frame()` implementation from `src/frame.cpp`, now included in the board build. The frame is 11 bytes: version 1, SelfTest type 2, sequence 0, four payload bytes, and CRC-16/CCITT-FALSE. Payload fields are little-endian `result_bits` and `battery_mV`; bit positions come from the existing boot report. The first boot report reserves sequence 0; a future shared link owner must coordinate later heartbeat sequence numbers.

The existing wire protocol has no verdict, battery-valid, USB-power, or per-device diagnostic fields. The voltage field carries the existing boot report's supply reading, including USB supply when USB-powered; unavailable samples are zero. Failed checks still produce a report. Delivery failure never changes the original self-test result or blocks application startup.

There are at most three attempts, each with a 1,000 ms transport budget and at least 500 ms between a budget-compliant attempt's completion and the next start. Retries keep identical bytes and sequence. Only `SELFTEST_TX_DONE` is success; queued, timeout, error and unavailable states cannot become success. Inspect `g_selftest_radio` after its worker finishes or halt all threads in the debugger. `g_bringup_report.radio_task_started` only means thread creation succeeded.

To transmit, the shared radio owner must supply a strong `flight_radio_send()` implementation that returns within the supplied budget, serializes SPI/radio state with RX and heartbeat traffic, configures the reviewed frequency/modulation/power/sync-word settings, waits for SX1262 TxDone, and restores continuous receive. The current `radio_send()` declaration has no board implementation, and the existing `Sx1262` class only implements receive. Inventing a separate transmitter configuration here would bypass that shared ownership. If the approved modem settings need more than one second of airtime, revise the budget and retry tests together. There is no ground-station acknowledgment in this contract.

## Verification and remaining work

`tests/health_radio` compiles the actual health logic, existing frame codec, report delivery logic and production RTOS adapters against fake CMSIS/watchdog/time functions. It checks task stalls and late progress, sleep deadlines/early wake/wraparound, frozen and advancing HAL time, allocation failure, packet fields/CRC, retries, and the unavailable production transport. It runs under ASan/UBSan in Firmware CI and in `./flight_test`.

Before closing the assignments, obtain the full STAR Project acceptance criteria; connect the RTC/Stop owner and shared transmitter; bench-test a normal ten-second sleep, early radio wake, deliberately stalled worker and missing wakeup; decode the final report on the ground station and confirm TxDone/timeout behavior. None of those hardware checks have been performed in this change. No arming or pyro-output behavior changes.

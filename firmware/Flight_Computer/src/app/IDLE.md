# Idle state

Portable C logic for the flight computer's Idle state: a heartbeat over LoRa
about every 10 s, a battery reading with each heartbeat, and listening for
Arm/Disarm, with the MCU in Stop mode in between. Requirements are from
[#137](https://github.com/calstar/STAR/issues/137) as recorded in `DEVICE_CHECKS.md` on
`pranay/self-test-confirmed-requirements`. Host-tested only; no board adapter yet.

## Overview

The state machine calls `idle_enter()` once on the hand-off from self-test,
then `idle_on_wake(now_ms)` every time the MCU wakes (calling it before
`idle_enter()` returns `IDLE_EVENT_ERROR`), whether from the RTC
wakeup timer or from the radio's DIO1 interrupt. Idle answers with one of:

- `IDLE_EVENT_SLEEP` with `sleep_s`: schedule the RTC for that many seconds
  and enter Stop mode.
- `IDLE_EVENT_ARM_REQUESTED`: an Arm command arrived. The state machine
  applies the arm policy. Idle has not changed state or touched any output.

Idle never calls STM32 HAL, never sleeps, never schedules the RTC, and never
touches pyro outputs. It reaches hardware only through `idle_port.h`.

## Architecture

```text
state machine (owns Stop mode, RTC wakeup, clock restore, arm policy)
        |  idle_enter() / idle_on_wake(now_ms) -> SLEEP n s | ARM_REQUESTED
        v
     idle.c                       portable: no HAL, RTOS or heap
        |
   idle_port.h                    read_battery, on_usb_power,
        |                         send_heartbeat, poll_command
       / \
  host fakes   STM32 adapters     adapters: after the board arrives
```

`read_battery` reuses the self-test type `self_test_battery_t`, so one PA0
adapter serves both modules.

## What happens on each wake

1. Drain up to `IDLE_MAX_COMMANDS_PER_WAKE` (4) commands. Arm returns
   `ARM_REQUESTED` at once, without a heartbeat. Disarm is ignored, since
   Idle is already disarmed.
2. If a heartbeat is due, or due within `wake_tolerance_ms`:
   1. Read the battery, **before** transmitting, so LoRa TX current does not
      sag the reading.
   2. Check `on_usb_power` (SW_ST, PE10). On USB the status is `USB`, never
      OK/WARN/FAIL.
   3. Send the heartbeat. Success means TxDone within the callback budget.
3. Return `SLEEP` with the seconds until the next heartbeat, rounded up.

Heartbeats are scheduled by time, not by wake source. A radio wake at 7.3 s
sleeps 3 s, not 10, so commands never delay a heartbeat. An LSI wake up to
`wake_tolerance_ms` early still counts as on time. After a long gap, one
heartbeat goes out and the schedule restarts; missed ones are not replayed.
A failed send is not retried within Idle. It is counted
(`consecutive_send_failures`, saturating at 255) and reported in the next
heartbeat, which also carries the previous send result.

## Battery

PA0 reads the post-ORing supply through a 22k/10k divider (0.3125) with a
3.32 V reference, so `mV = counts × 10624 / 65535` in integer math. For
example, 40712 counts = 6600 mV and 51818 counts = 8400 mV (a full 2S pack).

| Status | Meaning |
| --- | --- |
| OK / WARN / FAIL | On battery; below `battery_warn_mv` is WARN, below `battery_fail_mv` is FAIL |
| USB | SW_ST says USB power; the reading is USB voltage, not pack health |
| INVALID | Read failed, timed out, unsupported, or above 16-bit range |
| UNKNOWN | No reading yet |

Getting worse is immediate. Getting better needs the reading to clear the
threshold by `battery_hysteresis_mv`, so a pack near 7.0 V does not flip
OK/WARN on every heartbeat.

## Configuration

| Field | Proposed | Status |
| --- | --- | --- |
| `heartbeat_interval_ms` | 10000 | Confirmed (~10 s, #137) |
| `wake_tolerance_ms` | 500 | Proposal; absorbs LSI drift |
| `callback_budget_ms` | 50 | Proposal; must cover SX1262 TxDone at the chosen LoRa settings |
| `battery_warn_mv` | 7000 | **Proposal, not approved** |
| `battery_fail_mv` | 6600 | **Proposal, not approved** |
| `battery_hysteresis_mv` | 100 | Proposal |

## Quick start

From the repository root, with CMake 3.16+ and a C99 compiler:

```sh
cmake -S firmware/Flight_Computer/tests/idle -B /tmp/star-idle -DIDLE_SANITIZERS=ON
cmake --build /tmp/star-idle
ctest --test-dir /tmp/star-idle --output-on-failure
```

Builds with `-Wall -Wextra -Wpedantic -Wconversion -Werror`. Each guarded
behavior (USB check, thresholds, hysteresis, TxDone failure counting, radio
wake scheduling, Arm) was checked by breaking it on purpose and confirming a
test fails.

## Not done yet

- **Board adapters** (board expected ~Nov 6): PA0 ADC read, PE10 SW_ST read,
  SX1262 send with bounded TxDone (with Ryan), and command decoding from
  `radio_receive()`.
- **State machine side**: RTC wakeup on LSI, Stop entry, HSE/PLL restore after
  wake, PB2 DIO1 EXTI wakeup with the SX1262 left in RX.
- **Clock through Stop**: `now_ms` must keep counting while the MCU is in
  Stop. The HAL tick (TIM6) and SysTick both stop there, so the state machine
  must advance its clock by the time slept, for example from the RTC.
- **Watchdog**: done in [HEALTH-RADIO.md](HEALTH-RADIO.md): IWDG1 outlasts
  the 10 s sleep and the Idle loop leases each sleep to the health task.

## Open questions

1. SW_ST (PE10) polarity: which level means battery vs USB?
2. Approve or change the 7.0 V / 6.6 V thresholds.
3. Heartbeat byte layout, sequence width and checksum (Ryan). `idle_heartbeat_t`
   is the content; the radio adapter owns the encoding.
4. Arm policy: what the state machine checks before honoring `ARM_REQUESTED`.
5. Should a WARN or FAIL battery change behavior in Idle, or only be reported?

## Assumptions

- Idle lives in `Core/` as C, tested with CMake like self-test.
- Idle owns its heartbeat and battery logic rather than re-running
  the self-test coordinator after each wake.
- Arm is report-only: Idle hands the decision to the state machine.

## Documentation

- [`idle_port.h`](idle_port.h): seam callbacks and their contracts.
- [`idle.h`](idle.h): configuration, events and API.
- [`test_idle.c`](../../tests/idle/test_idle.c): executable examples with fakes.
- `DEVICE_CHECKS.md` (on `pranay/self-test-confirmed-requirements`): component map
  and confirmed requirements.

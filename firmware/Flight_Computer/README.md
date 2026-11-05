# Flight_Computer

The software that runs on the rocket's flight computer (an STM32H723 chip).
So far: the list of radio functions, a pretend radio, and tests for them.

## Overview

The rocket gets commands from the ground over a radio (a LoRa radio chip
called the SX1262). The rest of the code never talks to that chip directly.
It only uses the three functions listed in `src/radio.h`:

- `radio_probe()` checks that the radio chip is there and answering.
- `radio_receive()` checks whether a message has arrived, without waiting.
- `radio_send()` transmits heartbeats and self-test reports to the ground station. Success requires SX1262 TxDone within a bounded timeout. No ground-station ACK is required.

Because everything goes through these three functions, we can later swap in a
pretend radio and test the code on a laptop with no hardware.

What exists now: `src/radio.h`, a pretend radio, and 14 tests for it.
CI runs the tests on every PR that touches `firmware/` (`.github/workflows/firmware-ci.yml`).
The real radio driver and the message format come in later PRs.

## Architecture

```text
 flight code (arming safety, state machine, ...)     <- later PRs
        |
        |  only uses these three functions
        v
  radio_probe()  radio_send()  radio_receive()       <- src/radio.h
        |
        +--> real radio driver (talks to the chip)   <- later PR
        +--> pretend radio (for laptop tests)        <- test/test_radio_seam/
```

## Directory structure

```text
Flight_Computer/
├── README.md
├── platformio.ini            # setup for running the tests on a laptop
├── src/
│   └── radio.h               # the three radio functions and their answers
└── test/
    └── test_radio_seam/
        ├── test_main.cpp     # 14 tests for what radio.h promises
        ├── radio_fake.h      # the pretend radio
        └── radio_fake.cpp    # test only, never built into the rocket
```

Written in C++ (C++11). Everything lives in `namespace radio_link`.

## Quick start

```bash
cd firmware/Flight_Computer
pio test -e native
```

You should see 14 tests pass. If `pio` is missing, install PlatformIO with
`pipx install platformio`.

## Documentation

- [`src/radio.h`](src/radio.h): the radio functions. The comment above each
  one says what it promises.
- [`test/test_radio_seam/test_main.cpp`](test/test_radio_seam/test_main.cpp):
  the tests. They run against the pretend radio, and the promises they check
  are the ones the real radio driver must also keep.

## Radio link status

What exists, and what has been tested where.

| Piece | File | Tested |
|-------|------|--------|
| Frame format and CRC-16 | `src/frame.*` | host tests (`test_frame`) |
| ARM safety gate | `src/arm_gate.*` | host tests (`test_arm_gate`) |
| Receive, decode, ARM gate glue | `src/link.*` | host tests with the fake radio (`test_link`) |
| SX1262 receive path (4 SPI exchanges) | `src/sx1262.*` | host tests against a pretend chip (`test_sx1262_receive`) |

Run all of them on a laptop: `cd firmware/Flight_Computer && pio test -e native`

### Not done yet

Nothing here has run on a real radio or on the STM32.

- Chip start-up: `radio_probe()`, frequency, LoRa settings, TCXO, DC-DC, RF switch.
- The real `SpiBus` (STM32 HAL SPI plus the BUSY pin) and the pin map.
- A function that defines `radio_probe` / `radio_receive` / `radio_send` on top of `Sx1262`.
- A board build environment for the STM32H723.
- The send path (`radio_send`) on the real chip.
- Hardware bring-up: first packet over the air.
- Decisions for the lead: frequency (915 MHz fits the Wio module; 137 MHz does not), the real ARM key, the confirm window, the target id, whether ARM needs a real secret.
- Decision for the lead: what happens when the ground station reboots. Its sequence counter restarts, and every ARM is rejected as stale until the rocket reboots (pinned by `test_ground_reboot_rejects_arm_until_rocket_reboots`). Options: the ground saves its counter and keeps counting, or ARM carries a session number that resets the rocket's window.

### Known limits of the message format

- ARM protects against accidents and noise, not an attacker: there is no secret, so a recorded ARM pair can be replayed once the rocket reboots.
- There is no acknowledgement; the ground cannot tell whether ARM arrived.
- The sequence number is forgotten on reboot.
- The key, window and target id in `arm_gate.h` are placeholders.

## Self-test integration

[Inez confirmed the radio requirements in #137](https://github.com/calstar/STAR/issues/137#issuecomment-6486161496). Heartbeats run at 1–2 Hz during self-test and roughly once every ten seconds in Idle. Messages carry a type, sequence number and checksum; Ryan still owns their exact byte layout. `ErrTimeout` and `NotImplemented` distinguish an expired transmission from an absent driver. A no-op or queued packet must never return `Ok` from `radio_send()`.

The portable C coordinator lives in [`../Core`](../Core/README.md). A C++ adapter must translate its status snapshot into the agreed packet and map radio outcomes to the C callback contract. If a transmission exceeds the callback budget, a separate driver service must own it while the callback polls bounded state. The current header supplies no implementation, timeout value, packet encoder or such service.

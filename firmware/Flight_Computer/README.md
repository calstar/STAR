# Flight_Computer

The software that runs on the rocket's flight computer (an STM32H723 chip).
So far there is only one small piece: the list of radio functions.

## Overview

The rocket gets commands from the ground over a radio (a LoRa radio chip
called the SX1262). The rest of the code never talks to that chip directly.
It only uses the three functions listed in `src/radio.h`:

- `radio_probe()` checks that the radio chip is there and answering.
- `radio_receive()` checks whether a message has arrived, without waiting.
- `radio_send()` transmits heartbeats and self-test reports to the ground station. Success requires SX1262 TxDone within a bounded timeout. No ground-station ACK is required.

Because everything goes through these three functions, we can later swap in a
pretend radio and test the code on a laptop with no hardware.

What exists now: only `src/radio.h`. The real radio driver, the pretend radio,
the tests, and the message format come in later PRs.

## Architecture

```text
 flight code (arming safety, state machine, ...)     <- later PRs
        |
        |  only uses these three functions
        v
  radio_probe()  radio_send()  radio_receive()       <- src/radio.h (this PR)
        |
        +--> real radio driver (talks to the chip)   <- later PR
        +--> pretend radio (for laptop tests)        <- later PR
```

## Directory structure

```text
Flight_Computer/
├── README.md
└── src/
    └── radio.h      # the three radio functions and their possible answers
```

Written in C++ (C++11). Everything lives in `namespace radio_link`.

## Quick start

Nothing to run yet. To check that the header has no typos, run this from the
top folder of the repo:

```bash
g++ -std=c++11 -fsyntax-only -x c++ firmware/Flight_Computer/src/radio.h
```

If it prints nothing, it is fine.

## Documentation

- [`src/radio.h`](src/radio.h): the radio functions. The comment above each
  one says what it promises.

## Self-test integration

[Inez confirmed the radio requirements in #137](https://github.com/calstar/STAR/issues/137#issuecomment-6486161496). Heartbeats run at 1–2 Hz during self-test and roughly once every ten seconds in Idle. Messages carry a type, sequence number and checksum; Ryan still owns their exact byte layout. `ErrTimeout` and `NotImplemented` distinguish an expired transmission from an absent driver. A no-op or queued packet must never return `Ok` from `radio_send()`.

The portable C coordinator lives in [`../Core`](../Core/README.md). A C++ adapter must translate its status snapshot into the agreed packet and map radio outcomes to the C callback contract. If a transmission exceeds the callback budget, a separate driver service must own it while the callback polls bounded state. The current header supplies no implementation, timeout value, packet encoder or such service.

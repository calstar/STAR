# Flight_Computer

The software that runs on the rocket's flight computer (an STM32H723 chip).
So far: the list of radio functions, a pretend radio, and tests for them.

## Overview

The rocket gets commands from the ground over a radio (a LoRa radio chip
called the SX1262). The rest of the code never talks to that chip directly.
It only uses the three functions listed in `src/radio.h`:

- `radio_probe()` checks that the radio chip is there and answering.
- `radio_receive()` checks whether a message has arrived, without waiting.
- `radio_send()` sends a message (not used yet, the rocket only listens).

Because everything goes through these three functions, we can later swap in a
pretend radio and test the code on a laptop with no hardware.

What exists now: `src/radio.h`, a pretend radio, and 7 tests for it.
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
        ├── test_main.cpp     # 7 tests for what radio.h promises
        ├── radio_fake.h      # the pretend radio
        └── radio_fake.cpp    # test only, never built into the rocket
```

Written in C++ (C++11). Everything lives in `namespace radio_link`.

## Quick start

```bash
cd firmware/Flight_Computer
pio test -e native
```

You should see 7 tests pass. If `pio` is missing, install PlatformIO with
`pipx install platformio`.

## Documentation

- [`src/radio.h`](src/radio.h): the radio functions. The comment above each
  one says what it promises.
- [`test/test_radio_seam/test_main.cpp`](test/test_radio_seam/test_main.cpp):
  the tests. They show what any radio driver has to do.

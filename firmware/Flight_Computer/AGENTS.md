# Flight_Computer: notes for agents

Before you build, flash, regenerate CubeMX code or touch `firmware.ioc`, read
[`STM32-UPLOAD-REQUIREMENTS.md`](STM32-UPLOAD-REQUIREMENTS.md). It lists the
toolchain, the ST-Link wiring, and the rules that keep the build matched to the
STM32H723VET6 (512 KB flash) on the board. Hardware facts (pins, power, parts,
datasheets) are in GitHub issue #137.

**Before every commit here, run `./flight_test` and keep it green.** It builds
the firmware, runs every unit suite, flies a scripted flight through the real
drivers, task cores and eMMC log (tests/e2e/flight_e2e.c), and checks that a
deliberately broken build fails. `./flight_test --board` adds the on-board
checks over the ST-Link. A new feature adds its own check ids: unit tests in
tests/<area>/, end-to-end checks in flight_e2e.c's `checks[]` table.

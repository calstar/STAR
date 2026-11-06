# Requirements and dependencies for STM32 uploading

**Read this before you build, flash or regenerate anything for the flight
computer.** This applies to people and to coding agents (Claude, Codex, ...).
It lists what has to be installed, how the board is wired for programming,
and the rules that keep the build matched to the chip that is actually on the
board.

Status as of 2026-11-04: tools installed and checked on Inez's Mac (Apple
Silicon). The firmware builds with PlatformIO (`[env:flight]`, see
[How the build works](#how-the-build-works)). Rev 1 board arriving ~2026-11-05.
**No firmware has been flashed to real hardware yet.**

---

## 1. The chip: get this right first

| | |
|---|---|
| MCU | **STM32H723VET6**: LQFP100 package, **512 KB flash**, 564 KB RAM, Cortex-M7 up to 550 MHz |
| Datasheet | ST DS13313 covers VE/VG/ZE/ZG in one document (on Inez's Mac: `~/Downloads/Berkeley/datasheets/DS_stm32h723ve.pdf`) |
| CubeMX project | [`firmware.ioc`](firmware.ioc), target `STM32H723VETx` |
| Debug port | SWD on header **P1** (PA13 SWDIO, PA14 SWCLK) |
| Board facts | pins, power tree, every chip: GitHub issue [#137](https://github.com/calstar/STAR/issues/137), Inez's comment of 2026-10-29 |

**Verified 2026-11-04 against the rev 1 schematic** (`Flight_Computer_Schematic.PDF`,
MCU sheet 2/12): U1 is the STM32H723VET6, its pin numbers fit LQFP100, and every
routed pin's net matches the pin's assignment in `firmware.ioc` (GPS UART checked
end to end: GPS TXD → PD14 UART9_RX, GPS RXD ← PD15 UART9_TX). The only `.ioc`
differences are the open TODOs: HSE off on PH0/PH1, PA10 set as USB ID but not
connected, PA15 set as JTDI (unused, SWD only).

**Where the assembled board differs from the schematic:**

| Ref | Schematic / BOM says | Board actually has | Consequence |
|---|---|---|---|
| U3 | H3LIS331DLTR | **H3LIS100DLTR** (Inez, 2026-11-04) | Use the H3LIS100DL datasheet (ST DocID027504 Rev 2, `flight_computer_documents/en.DM00162193.pdf`), not DS9012 (the H3LIS331DL's). See the facts below. |

H3LIS100DL facts the driver depends on (DocID027504 Rev 2, checked 2026-11-04):

| | Value | Page |
|---|---|---|
| Range | ±100 g, **fixed** (no full-scale bits; CTRL_REG4 0x23 holds only `SIM`) | 9, 28 |
| Output | **8-bit**, two's complement, one register per axis: OUT_X 0x29, OUT_Y 0x2B, OUT_Z 0x2D | 30 |
| Sensitivity | **780 mg/digit** typ. (so g = raw × 0.78) | 9 |
| Zero-g offset | ±1.5 g typ. | 9 |
| WHO_AM_I (0x0F) | 0x32 (same as the H3LIS331DL, so the ID check can't tell them apart) | 25 |
| Power-on state | CTRL_REG1 (0x20) = 0x07: **power-down**. Write PM = 001 (normal) to measure. | 24, 25 |
| Normal-mode ODR | DR1:DR0 = 00/01/10 → 50/100/400 Hz (11 not allowed) | 26 |
| SPI | mode 3 (clock idles high, sample on rising edge), ≤ 10 MHz, first byte = RW(bit 7) MS(bit 6, auto-increment) + 6-bit address | 11, 20 |
| Supply | 2.16–3.6 V; turn-on 1/ODR + 1 ms | 1, 10 |

At 0.78 g per count, this part reads impacts and boost, not small accelerations;
low-g motion belongs to the ISM330DHCX.

Why it matters: PlatformIO has no board definition for the VET6. The closest
one, `nucleo_h723zg`, is a **ZG part with 1 MB of flash** and 144 pins. If you
borrow it without overriding the flash size, a build can pass the size check
and then fail to flash, or flash into memory that isn't there. Always state
512 KB (`board_upload.maximum_size = 524288`) and use the linker script
CubeMX generates for the VET6.

---

## 2. Hardware you need

1. **An ST-Link programmer.** An STLINK-V3MINIE (~$12, DigiKey/Mouser) or an
   ST-Link V2 (a clone is fine). It is the USB stick that lets the Mac write
   to the chip's flash and pause it in a debugger. The board's own USB-C port
   can't do this as wired.
2. **Wiring to P1:**

   | ST-Link | Board (P1) | Why |
   |---|---|---|
   | SWDIO | PA13 | data line of the debug port |
   | SWCLK | PA14 | clock of the debug port |
   | GND | GND | common reference, always required |
   | NRST | NRST | lets the tool reset the chip; needed to "connect under reset" |
   | VTref (T_VCC) | 3V3 | the ST-Link reads the board voltage from this; it does **not** power the board |

3. **Power the board on its own**, from USB-C or the 2S battery (XT30). Most
   ST-Links do not supply power.

---

## 3. Software

| Tool | Version checked | What it's for | Install | Check |
|---|---|---|---|---|
| STM32CubeMX | 6.18 | edits `firmware.ioc` and generates the startup, HAL and FreeRTOS code | already in `/Applications/STMicroelectronics/` | open the app |
| STM32Cube FW_H7 package | V1.13.0 (what the `.ioc` records) | ST's HAL drivers for the H7 | CubeMX downloads it on first Generate Code | `~/STM32Cube/Repository/STM32Cube_FW_H7_V1.13.0` exists |
| Arm GNU toolchain (`arm-none-eabi-gcc`) | 15.3.rel2 | **optional**: only for the plain CMake build. The PlatformIO build downloads its own GCC 14.2. | `brew install --cask gcc-arm-embedded` (**asks for your password**) | `arm-none-eabi-gcc --version` |
| CMake + Ninja | 4.4.3 / 1.13.2 | build system CubeMX's CMake output uses | `brew install cmake ninja` | `cmake --version`, `ninja --version` |
| PlatformIO Core (`pio`) | 6.2.0 | team's build/upload tool on the other boards; runs the radio host tests | installed under `~/.platformio`; put `~/.platformio/penv/bin` on PATH (below) | `pio --version` |
| PlatformIO `ststm32` platform + tools | ststm32 20.0.0, openocd 3.1200.7, gcc 7.2.1 | STM32 builds and uploads through `pio` | `pio pkg install -g -p platformio/ststm32` | `pio pkg list -g` |
| OpenOCD | 0.12.0 | flashes and debugs over the ST-Link (`target/stm32h7x.cfg`) | `brew install open-ocd` | `openocd --version` |
| stlink tools (`st-flash`, `st-info`) | 1.9.0 | quick probe and flash; supports H72x/H73x | `brew install stlink` | `st-info --probe` with the ST-Link plugged in |
| STM32CubeProgrammer | latest | ST's official flasher; also updates the ST-Link's own firmware | manual download from st.com (needs a free myST login) | open the app |
| clang-format | 23.1.4 | C/C++ formatting (`./format.sh`) | `brew install clang-format` | `./format.sh --check` |
| black | 26.10.1 | Python formatting (`./format.sh`) | `brew install pipx && pipx install black` | `black --version` |

macOS needs **no USB driver** for the ST-Link.

**PATH lines** (add to `~/.zshrc`, then open a new terminal):

```bash
export PATH="$HOME/.platformio/penv/bin:$PATH"   # pio
export PATH="$HOME/.local/bin:$PATH"             # black (pipx)
```

**The compiler must be GCC 11 or newer.** `[env:flight]` pins GCC 14.2 (`platform_packages`), and the plain CMake build uses Arm GNU 15.3 from PATH. PlatformIO's
`ststm32` ships its own GCC 7.2 (2017), and it **cannot link this project**:
CubeMX's `STM32H723xx_FLASH.ld` uses the `READONLY` keyword (GCC 11+), and the
old linker stops with `non constant or forward reference address expression
for section .ARM.extab`. Checked 2026-11-04: with GCC 7.2 all 54 sources
compiled and only the link failed. CubeMX's CMake files call whatever
`arm-none-eabi-gcc` is on PATH, so the CMake build needs 15.3 installed.
Don't mix compilers in one build, and never remove the `platform_packages` pin
from `[env:flight]`. Do not "fix" a link error by deleting
`READONLY` from the linker script. CubeMX rewrites that file on every
generate.

---

## 4. First connection: check before you flash

With the board powered and the ST-Link wired:

```bash
st-info --probe        # should print: chipid 0x483, flash 524288 (512 KB), "H72x/H73x"
```

If the flash size says 1048576 you are talking to a different chip (a Nucleo
board?), not the flight computer.

Then a read-only OpenOCD connect:

```bash
openocd -f interface/stlink.cfg -f target/stm32h7x.cfg -c "init; halt; exit"
```

If it fails with `unable to connect to the target`, check in this order:
power, GND, the SWDIO/SWCLK pair (swapped is common), then try connecting
under reset:

```bash
openocd -f interface/stlink.cfg -f target/stm32h7x.cfg \
  -c "reset_config srst_only srst_nogate connect_assert_srst" -c "init; halt; exit"
```

---

## 5. Uploading

**The one command** (from the repo root; `-d` names the project folder):

```bash
pio run -d firmware/Flight_Computer -e flight -t upload
```

It builds the firmware, then flashes it over the ST-Link with OpenOCD. Drop
`-t upload` to only build. The first build downloads GCC 14.2 into
`~/.platformio` (no password needed). The image is
`firmware/Flight_Computer/.pio/build/flight/firmware.elf` (and `.bin`).

**From VS Code** (PlatformIO IDE extension):

1. **File → Open Folder… → `firmware/Flight_Computer`.** Open this folder
   itself, not the repo root: PlatformIO only finds a project whose
   `platformio.ini` is at the top of an opened folder. (Or: PlatformIO Home →
   Projects → Open Project.)
2. Wait for "PlatformIO: Rebuilding IntelliSense Index" to finish (first time
   only; it also downloads GCC 14.2).
3. Check the environment in the bottom status bar reads **`env:flight`**, which
   is the default. Switch it there if it says `native`.
4. Board powered, ST-Link plugged in → click **→ (Upload)** in the status bar.
   ✓ only builds.

VS Code's generated `.vscode/` folder is gitignored; don't commit it.

Without PlatformIO, the same image can be flashed directly:

```bash
cd firmware/Flight_Computer
openocd -f interface/stlink.cfg -f target/stm32h7x.cfg \
  -c "program .pio/build/flight/firmware.elf verify reset exit"
st-flash --reset write .pio/build/flight/firmware.bin 0x08000000
```

---

## How the build works

`[env:flight]` in `platformio.ini` (checked 2026-11-04: builds, 40 KB of
512 KB flash, hard-float ABI, vector table at 0x08000000):

- `platform = ststm32@20.0.0`, `board = star_fc_h723ve`, defined in
  [`boards/star_fc_h723ve.json`](boards/star_fc_h723ve.json) (MCU
  stm32h723vet6, 512 KB flash, OpenOCD target stm32h7x), because PlatformIO
  ships no VET6 board. **Do not switch it to `nucleo_h723zg`.**
- `platform_packages = toolchain-gccarmnoneeabi@1.140201.0` (GCC 14.2). The
  platform default (GCC 7.2) cannot link CubeMX's linker script.
- No `framework`. It compiles CubeMX's own files: `Core/Src/*.c`, the startup
  `.s`, `Drivers/STM32H7xx_HAL_Driver/Src/*.c` and the FreeRTOS sources, with
  CubeMX's defines and include paths (mirrors
  `cmake/stm32cubemx/CMakeLists.txt`) and `STM32H723xx_FLASH.ld`.
- `scripts/fpu_link_flags.py` passes the hard-float flags to the linker too;
  without it the link mixes float ABIs.
- `default_envs = flight`, so VS Code's Build/Upload buttons and a bare
  `pio run` target the board. `test_ignore = *` keeps the laptop tests off the
  board; run them with `pio test -e native` (CI always names `-e native`).

CubeMX also wrote `CMakeLists.txt`/`CMakePresets.json`, so a plain CMake build
works too, with Arm GNU on PATH:
`cmake --preset Debug && cmake --build --preset Debug`.

**After every CubeMX Generate Code:** run `pio run -d firmware/Flight_Computer
-e flight` before committing. A newly enabled peripheral's HAL file lands in
`Drivers/.../Src` and is picked up automatically. A new middleware folder
needs a `build_src_filter` line. Still open in the `.ioc`: HSE (25 MHz Y1) +
PLL (SYSCLK is 64 MHz from HSI), RTC on LSI with the wakeup timer, USB
device-only.

---

## Rules for agents and people

- **Never enable SWO trace.** PB3 is both SWO and the SPI3 clock for the
  baro/IMU/high-g accel; trace would corrupt the sensor bus. Use SWD only.
- **Bring-up code never enables a pyro output** (TPS25974 eFuses U12/U13;
  pyro 1's EN/PG are PC14/PC15, check #137 for pyro 2).
  Continuity is measured with the eFuse off (#137 §7).
- **The target is the VET6 with 512 KB.** Do not use the `nucleo_h723zg`
  defaults or a ZG linker script.
- **`firmware.ioc`, `.mxproject` and `Core/` stay in the same folder.** CubeMX
  writes `Core/` next to the `.ioc` on every Generate Code.
- **In generated files, write only between `/* USER CODE BEGIN ... */` and
  `/* USER CODE END ... */`.** CubeMX keeps those blocks and overwrites
  everything else on the next generate. Put real logic in hand-written files
  (`self_test*.c` style), not in `main.c`.
- **Change pins and clocks in the `.ioc` through CubeMX**, never by hand-editing
  generated init code. The `.ioc` is the source of truth.
- **DMA cannot reach DTCM.** The linker script puts `.data`, `.bss`, heap and
  stack in DTCMRAM (128 KB at 0x20000000). DMA1/DMA2/BDMA and the SDMMC IDMA
  can't access it, so DMA buffers must be placed in RAM_D1/RAM_D2 with a
  section attribute. The board file's `maximum_ram_size` is DTCM's 128 KB for
  the same reason.
- **Clock:** `f_cpu` in the board file is 64 MHz because SYSCLK runs from HSI
  until HSE + PLL is configured in the `.ioc`. Update both together.
- **Generated and vendored code is not formatted.** `format.sh` skips the
  CubeMX files listed in its prune list; keep that list in step with what
  CubeMX generates.
- **Don't install a different toolchain or HAL version without updating this
  file.** If a version in the table changes, change the table.
- Pin and part questions are answered in #137. When the schematic and code
  disagree, the schematic wins; say so in the PR.

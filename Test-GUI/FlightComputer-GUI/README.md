# FlightComputer-GUI

A desktop app (macOS and Windows; Linux works too) for the STM32 flight computer
on the bench over USB: read its health, plot its sensors live, change its
settings without reflashing, and download recorded flights off the eMMC as
files. Rust with [Tauri](https://tauri.app): the logic is Rust, the window is a
web page drawn by the OS's own webview (WebView2 on Windows, WebKit on macOS),
so the installer is a few MB and needs no runtime.

**The firmware side does not exist yet.** The app talks to a built-in
simulated flight computer until the board implements [PROTOCOL.md](PROTOCOL.md).

## Quick start

Install Rust (<https://rustup.rs>) and Node 20+ once, then:

```bash
cd Test-GUI/FlightComputer-GUI
npm ci
npm run tauri dev -- -- --sim   # the window, live-reloading, on the simulated board
npm run tauri build             # an installer in target/release/bundle/
```

Build the app with `npm run tauri build` (or `npx tauri build --no-bundle`
for just the executable), not `cargo build`: only the Tauri CLI embeds the
window's files, and a plain cargo build opens a window pointing at the dev
server, which says "can't reach this page".

On Linux the webview needs `libwebkit2gtk-4.1-dev` (see the CI workflow for
the full list). `--sim` connects to the simulated board at start; without it,
pick the board's port and press Connect. `--sim-flash FILE` keeps the simulated
board's "flash" in a file of your choice (default: the temp folder), so saved
settings survive restarts.

Plug the board in with USB. It shows up with no driver as `/dev/cu.usbmodem…` on
a Mac or `COMn` on Windows, and the port list puts ST's USB IDs first.

## The tabs

| Tab | What it does |
|---|---|
| **Status** | The board's value table (firmware `src/app/gui_map.c`), shown as sent: flight state, battery, self-test per chip, GNSS, eMMC and whatever else the table lists. A row added there appears here with no app change. Every row arrives once a second. |
| **Live** | The board sends its newest sample of each sensor at 1–100 Hz; plots of accel, gyro, high-g, baro altitude and GNSS altitude, last 30 s. A debug view: the full-rate data goes to the eMMC. |
| **Config** | Every setting with the value on the board next to it: LoRa (frequency, SF, bandwidth, coding rate, power, preamble, sync word, heartbeat intervals), GNSS (rate, dynamic model, constellations), IMU (ODR, accel and gyro range), high-g ODR, baro oversampling. *Apply* runs it, *Save to flash* makes the board boot with it. Shows LoRa time on air, duty and sensitivity as you edit. Import/export as JSON. |
| **Flights** | The eMMC as a file list: one row per flight (Arm to Un-arm) with start time (UTC, if GPS had a fix), length and size. *Download* saves a folder per flight under `Documents/STAR Flights/` with the raw blocks, CSVs per sensor and an events file, then plots it. *Wipe card* needs you to type WIPE. |
| **Ground** | Only on a board whose Role is Receiver. The rocket as the receiver hears it: state, signal, last Status report (each chip's value read back vs expected, every ADC count with volts), the frames heard newest first, and **Arm / Un-arm**, sent again until the rocket's own frames show the new state (there is no radio ACK). The rocket's telemetry draws the Live tab. PROTOCOL.md section 8. |

## How it works

```text
 window (ui/, TypeScript)    renders the View; sends Commands. Decides nothing.
        │  Tauri IPC: invoke("send" | "view" | "flight_plot" | "pick"), events "view" + "live"
 src-tauri/                  joins the two; native file dialogs
        │
 backend (src/backend/)      controller thread: every rule and every sentence on screen;
        │                    publishes a View when it changes, live samples in batches
   link::Client              requests numbered by seq, replies matched, 1.5 s timeouts;
        │                    each reply comes back tagged with the Purpose it was sent for
   link thread               owns the port; COBS frames + CRC-16 (protocol.rs)
        │
   ┌────┴─────────────────┐
 SerialTransport        SimTransport ── fake_board::FakeBoard (protocol-faithful stand-in)
 (serialport, DTR on)
```

**Front and back.** The backend owns everything that matters: whether Apply or
Save may be sent (connected, board IDLE, every check passing), what a reply
means, parsing what was typed (a frequency in MHz, a whole number of ms), the
WIPE confirmation, every status sentence and colour. The window shows what the
`View` says and sends `Command`s; a stale or skipped window cannot get around a
rule, because a command that is not allowed comes back as a notice, not a frame
to the board. The window keeps only screen state: the open tab, the highlighted
flight row, Live paused, the text in the wipe dialog.

- **Settings live on the board**, not in the app. The board keeps them in its
  internal flash, checks every value itself, and refuses any change once armed.
  See PROTOCOL.md §5.
- **The board streams only while a program has the port open** (USB DTR) and
  the bus isn't suspended, so it spends nothing on USB in flight. PROTOCOL.md §4.
- **Downloads are checked here, not on the board.** Every 512 B block's magic,
  epoch, position and CRC-32 are verified by `src/emmc.rs`, a second
  implementation of the `emmc_log.h` reader. A test checks it against disk
  images written by the firmware's own `emmc_log.c`.
- **Units come from the config the data was recorded with.** Accel and gyro
  LSB sizes depend on the configured range. A downloaded flight is scaled with
  the config recorded in it (record 0x16). If there is none it falls back to
  the defaults and says so.
- **No callbacks.** A request carries a `Purpose` value; its reply comes back
  from `Client::poll()` as `Event::Reply(purpose, result)` and the part of the
  controller that asked handles it with plain `&mut self`.
- **Plots are decimated, files are not.** A downloaded flight's lines are cut
  to 8000 points each (the min and max of each slice, so spikes survive)
  before they go to the window. The CSVs hold every sample.

## Files

```text
PROTOCOL.md          the contract the firmware implements
src/protocol.rs      framing, message types, payload structs
src/config.rs        config fields, allowed values with datasheet sources, blob layout
src/lora.rs          time on air, sensitivity estimate
src/records.rs       records.h structs -> units (one decoder for live and logs)
src/emmc.rs          eMMC log block checks, sessions, CSV export
src/fake_board.rs    simulated board
src/transport.rs     serial port / simulator, port listing
src/link.rs          link thread + request/reply client
src/backend/         controller thread, Command, View; status, live, config, flights
src-tauri/           the Tauri app: main.rs (entry point, --sim, --sim-flash), config, icons (made from icons/source.png with `npx tauri icon`)
ui/                  the window: main.ts (layout), plots.ts (uPlot), api.ts, types.ts, style.css
tests/backend.rs     the whole app minus the window, against the simulator
tests/firmware_writer.rs + tests/c/write_image.c   decoder vs the firmware's emmc_log.c
e2e/app.spec.ts      the window in Chromium against the real backend (Playwright)
examples/serve.rs    the backend over a WebSocket, for e2e/
```

## Tests

```bash
cargo test        # Rust: needs no webview
npm run e2e       # the window in Chromium (npx playwright install chromium, once)
```

Unit tests sit next to the code they check (CRC check value, COBS vectors,
payload sizes against PROTOCOL.md, config ranges, LoRa time on air against
published values, ISA altitude, block rejection, plot decimation, the simulated
board's DTR gate and armed refusals). `tests/backend.rs` drives the backend the
way the window does, against the simulated board: connect, live stream scaled
with the board's config, download a flight to disk, save a config and read it
back from the board's flash after a power cycle, Apply refused with a bad value
even when sent anyway, wipe refused without the word.

`e2e/app.spec.ts` (Playwright) loads the real window in Chromium, connected to
the real backend over a WebSocket (`examples/serve.rs`, a fresh simulated board
per page), and presses its buttons by name: the same flows, plus Apply greying
out and a number being typed key by key not getting overwritten.

`tests/firmware_writer.rs` compiles `firmware/Flight_Computer/src/app/emmc_log.c`
with the machine's C compiler, writes a disk image with the real writer, and
decodes it here. Without a compiler it is skipped, unless
`FC_REQUIRE_FIRMWARE_TEST=1`, which CI sets on Linux and macOS.

CI (`.github/workflows/flight-computer-gui-ci.yml`) runs fmt, clippy, the
TypeScript check and the Rust tests on Ubuntu, macOS and Windows, the browser
tests on Ubuntu, and keeps each OS's installer (`.exe` setup, `.dmg`, `.deb`)
for 14 days.

## Packaging

`npm run tauri build` makes the installer for the OS it runs on. They are not
signed: Windows SmartScreen asks once ("More info" → "Run anyway"), and macOS
needs right-click → Open the first time. Signing needs an Apple Developer ID
and a Windows code-signing certificate.

# Live Video (live-video)

macOS software for the **HiDes HV-320** DVB-T video transmitter and the **UT-130** USB receiver,
replacing HiDes's Windows-only tools: a viewer app with a receive-only link dashboard, a CLI, and
a library both build on.

## Overview

The HV-320 encodes HDMI to H.264 and transmits it as DVB-T on the 1.2 GHz amateur band. The
UT-130 receives it and hands the MPEG transport stream (TS) to the host over USB. HiDes ships
Windows drivers and tools only; this project talks to both devices directly:

- **Receiver.** The UT-130 is an ITE IT9303 USB bridge with an IT9133 demodulator and, on the tested
  board (EEPROM board ID `0x35`), an RFFC2071 mixer for the bands above 950 MHz. A user-space process
  drives it through libusb. There is no kernel driver or dext. The ITE API in
  `Sources/CIT930x/vendor` does bring-up and demod control. `hides_rx.c` adds the USB transport,
  the tuning plan, and the RFFC2071 mixer, which the vendor API lacks. Those parts were rebuilt
  from the Windows driver.
- **Transmitter.** The HV-320's settings port is a 3-wire UART through a PL2303 USB dongle, which
  macOS supports out of the box. The framing and commands were rebuilt from the vendor's
  configuration tool. In the field the cable is usually unplugged, so nothing in receiving
  depends on it.
- **Media.** The TS is demuxed in Swift. Video is decoded by VideoToolbox and shown frame by frame, as
  soon as each frame is complete, rather than buffered to timestamps. That is what keeps latency low.
  Audio goes to AudioQueue. The raw TS can also be forwarded over UDP to OBS, VLC or ffmpeg.

Confirmed on one UT-130 (board `0x35`) and one HV-320 at 1280 MHz, 8 MHz, 16QAM, 2K, FEC 2/3, GI 1/32.
The transport stream ran with no errors, and the callsign was decoded over the air.

**Not yet tested on hardware:**
- automatic recovery;
- SNR and bit error readings;
- band scan against non-DVB-T signals;
- end-to-end latency, measured with `hides-latency`;
- audio;
- 2.4 GHz;
- channels narrower than 5 MHz.

## Architecture

```
 HDMI ─▶ HV-320 ─ DVB-T, 1.2 GHz ─▶ UT-130 ─USB─▶ libusb ─▶ hides_rx.c + ITE API  (CIT930x)
           ▲                                                     │
           │ UART (PL2303)                                       │ raw TS bytes
 AVSenderClient ◀── Bench setup only                             ▼
                                         LinkSession ── polls status 1/s, LinkMonitor decides recovery
                                               │
                                         LivePipeline: TSAligner → TSDemuxer ─┬─▶ H264Packetizer → display layer
                                                                              ├─▶ AudioPlayer
                                                                              ├─▶ UDPOutput (OBS, VLC, ffmpeg)
                                                                              └─▶ service name, source info, counters
                                                                                         │
                                                       HiDesViewer dashboard, hides rx-watch, CSV log
```

`LinkMonitor` is pure logic with an injected clock. It sorts the link into one of these states:

| State | Meaning |
|---|---|
| no device | the UT-130 is unplugged or USB failed |
| no signal | no DVB-T signal found |
| signal, can't decode | a signal is present but too weak or noisy to decode |
| locked, no data | the demod is locked but no TS arrives over USB |
| locked, no video | TS arrives but no video frames come out of it |
| healthy | receiving video |

It also decides when to retune, restart the stream, resynchronize or reopen the device. `LinkSession`
carries those actions out on its own queue, through the `ReceiverDevice` protocol, so every recovery
path is tested against a simulated receiver.

## Directory structure

```
live-video/
├── Package.swift
├── Sources/
│   ├── CLibUSB/            # module map for Homebrew libusb
│   ├── CIT930x/            # C target: the receiver
│   │   ├── hides_rx.c      #   bring-up, tuning plan, RFFC2071 mixer, status, streaming
│   │   ├── include/        #   hides_rx.h, the C API the Swift side calls
│   │   ├── shim/           #   stand-ins for the Linux kernel headers the vendor code includes
│   │   └── vendor/         #   ITE API + firmware headers, unmodified (see its README)
│   ├── HiDesKit/           # library: transmitter protocol, USB receiver, TS demux, decode, audio,
│   │                       #   UDP, link monitor/session/logger, band scan, latency pattern
│   ├── HiDesViewer/        # SwiftUI app: video, link dashboard, band scan, bench setup
│   ├── hides/              # CLI
│   └── hides-latency/      # HDMI loopback latency tool
├── Tests/HiDesKitTests/    # framing, tuning, TS, link monitor/session, media (optional fixtures)
├── scripts/make-app.sh     # release .app + CLI with libusb bundled
└── docs/windows-stack-findings.md   # how the vendor stack works, from reverse engineering
```

## Quick start

Needs macOS 14+, Xcode Command Line Tools and Homebrew `libusb` (`brew install libusb`).

```sh
cd live-video
swift build
swift test
swift run HiDesViewer          # the app
swift run hides                # CLI usage
```

The app opens at 1280 MHz, 8 MHz. Press **Start**. **Open TS file…** plays a recorded stream with no
hardware attached.

### First run on hardware

Attach an antenna or dummy load before powering the HV-320, because the PA can burn out without one.
Keep the UT-130's input below about −25 dBm, since it overloads when the transmitter is close.
Go in this order, because each step checks something the next depends on. `HIDES_TRACE=1` logs
every control transfer.

1. `swift run hides rx-info`: read-only EEPROM dump. Expect board `0x35`, RFFC2071, LO1 1800000 kHz.
2. `swift run hides rx-init`: loads firmware into RAM and sets up the demod and mixer. The mixer readback should be `0x4064`.
3. `swift run hides ports`, then `swift run hides tx-get /dev/cu.usbserial-…`: read-only. The port name changes on replug.
4. `swift run hides rx-watch --freq 1280000 --bw 8000`: link status once a second.

### CLI

| Command | Does |
|---|---|
| `hides rx-info`, `rx-init` | Read the receiver EEPROM; load firmware and init |
| `hides rx-watch --freq KHZ --bw KHZ [--csv]` | Receive-only link status with automatic recovery |
| `hides rx-stream --freq KHZ --bw KHZ --udp HOST:PORT` | Forward the TS over UDP, e.g. to `ffplay udp://127.0.0.1:5000` |
| `hides rx-scan --from KHZ --to KHZ [--step KHZ]` | Step across a range and print signal strength |
| `hides tx-get PORT`, `tx-set PORT --freq KHZ …` | Read or change the transmitter's RF settings |
| `hides tx-name PORT --service CALLSIGN` | Set the broadcast service name (16 characters max) |
| `hides file-stream FILE --udp HOST:PORT` | Send a recorded TS over UDP |
| `hides-latency --freq KHZ --bw KHZ` | Glass-to-decode latency, with the Mac's HDMI out (Extended mode) feeding the HV-320 |

Transmitter writes take several seconds to be acknowledged. They go out in 64-byte chunks 200 ms
apart, as the vendor tool sends them. An unpaced write hangs the settings port until the HV-320 is
power cycled.

### Link dashboard

Everything in the app's **Link** section comes from the receiver alone, so it works with no transmitter cable:

| Group | Shows |
|---|---|
| State | One of the states in the table above, shown with an icon and a label |
| Signal | Strength, quality, SNR, bit errors after Viterbi, uncorrected packets |
| Channel | Modulation read from the signal itself, and the channel capacity that gives |
| Stream | Video and audio bitrate against capacity, spare capacity, frame rate, TS errors |
| Source | Service name (callsign), and input resolution and audio rate from the HV-320's table on PID `0x77` |

Recovery runs automatically:

| Condition | Action |
|---|---|
| No lock | Retune after 8 s, then every 15 s |
| Data stops | Restart the stream; reopen the device after three tries |
| Video stops but data flows | Resynchronize the demuxer, then restart the stream |
| USB dropout | Reopen the device, backing off up to 10 s |

**Log link to CSV** writes one row a second to `~/Library/Logs/HiDesViewer/`. The transmitter controls
are under **Bench setup**.

### Sharing a build

`scripts/make-app.sh` builds `dist/HiDes Viewer.app` and `dist/cli/hides` in release mode with libusb
bundled, so other Macs need no Homebrew. It builds for Apple silicon only. The app is ad-hoc signed;
after copying it to another Mac, run `xattr -dr com.apple.quarantine "HiDes Viewer.app"` once.

### Tests with recorded streams

Two tests run only when given a stream file:

- `HIDES_TEST_TS` takes an ffmpeg test stream, and checks demux and hardware decode. The ffmpeg command is in `MediaPipelineTests.swift`.
- `HIDES_TEST_RX` takes a capture from the receiver (`rx-stream`'s UDP output saved to a file), and checks that each frame is passed on as soon as it is complete.

## Documentation

- [`docs/windows-stack-findings.md`](docs/windows-stack-findings.md): the vendor stack, the transmitter's
  serial protocol, the receiver's USB layout and tuning, and the PID `0x77` table.
- [`Sources/CIT930x/vendor/README.md`](Sources/CIT930x/vendor/README.md): where the ITE code comes from.

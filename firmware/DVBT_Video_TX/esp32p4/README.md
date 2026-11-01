# DVBT_Video_TX/esp32p4 — the transmitter's ESP32-P4 firmware (ESP-IDF)

The transmitter's processor: it clocks the board, configures the FPGA and
the DAC, and (next) turns camera video into the MPEG transport stream the
FPGA modulates. ESP-IDF v5.5.1, plain C, no Arduino/PlatformIO.

```bash
tools/install-idf.sh            # once per machine: ESP-IDF + RISC-V toolchain into /opt/esp
tools/fetch-video-deps.sh       # Espressif camera + H.264 components from GitHub (pinned)
. tools/env.sh
idf.py set-target esp32p4 build
idf.py -p /dev/ttyUSB0 flash monitor
tools/make_fpga_image.py ../gateware/build/dvbt_tx_top/dvbt_tx.bit build/fpga.img
esptool.py --chip esp32p4 -p /dev/ttyUSB0 write_flash 0x310000 build/fpga.img   # "fpga" partition
/usr/bin/python3.12 -m pytest -q test/host     # host tests, no hardware
```

## Layout

| component | what |
|---|---|
| `spi_bus_if` | a generic SPI transaction interface (4-wire or 3-wire with turnaround), so chip drivers don't care what bus they're on |
| `fpga_link` | the SPI link to the FPGA (SPI2): register read/write, TS packets paced by DREQ. `dvbt_regs.h` mirrors `gateware/rtl/dvbt_host.v`; `fpga_proto.c` is the frame encoding, pure C |
| `spi_bus_esp` | `spi_bus_if` on the P4's second SPI host (SPI3), the setup bus: AD9116 (3-wire, half duplex) and ADRF6755 (4-wire, its SDO back) share SCLK and the data line; chip selects are GPIOs so CS-only pulses work. `spi_bus_pack.c` is the bit packing, pure C |
| `ecp5_cfg` | loads the FPGA at boot over its slave-SPI configuration port from the `fpga` partition (`tools/make_fpga_image.py` wraps the `.bit` with a CRC-checked header); if the image is missing, corrupt, for the wrong part, or the load fails, it releases the CFG pins to the board straps and pulses PROGRAMN so the FPGA boots from its own W25Q32 |
| `ts_mux` | MPEG-TS multiplexer at exactly the DVB-T channel rate (`ts_dvbt_rate`): PAT/PMT every 100 ms, an SDT naming the service after the callsign, PCR every 20 ms derived from the packet count, H.264 access units as PES with PTS, nulls in the gaps. Pure C, no allocation |
| `video_src` | OV5647 over MIPI CSI → ISP → YUV420 → the P4's hardware H.264 encoder (Espressif `esp_video`, V4L2), each access unit to a callback with its capture time and key-frame flag; `main` stamps it on the mux clock (+ decoder delay) and queues it in `ts_mux`, dropping frames the channel cannot carry. Without `third_party/` the firmware builds without video |
| `si5351` | Si5351A frequency planning (exact rationals, AN619 encoding) and I²C programming; CLK0 = 192/7 MHz for the FPGA and DAC |
| `ad9116` | AD9114/5/6/7 setup over any `spi_bus_if`: reset, data format, retimer lock (datasheet Rev. F) |
| `adrf6755` | ADRF6755 modulator + PLL over any `spi_bus_if`: SPI-mode lock (3 CS pulses), LO planning (Equations 1-5, Table 6), the datasheet's power-up sequence (Rev. B p. 35), modulator power |
| `main` | bring-up, then a placeholder TS of null packets (the modulator and DAC run; a receiver sees a signal with no services) until the muxer exists; pins in `menuconfig` → *DVB-T transmitter* |

## Bring-up order (main.c)

1. Si5351A CLK0 (FPGA) and CLK1 (AD9116 CLKIN) = 27.428571 MHz.
2. FPGA configured: slave SPI from the P4's `fpga` partition, or the
   W25Q32 fallback; then the stream link, whose ID register must read
   `D7B70003`.
3. TXDIS high (RF off). ADRF6755 locked into SPI mode (three CS pulses):
   it powers up in I²C mode on the same SCLK/SDIO lines as the AD9116 (at
   address 0x60, the Si5351A's too -- so it must not share the Si5351A's
   I²C bus), so this comes before any other setup-bus traffic.
4. AD9116 on the same bus: RESET/PINMD pulse (a P4 GPIO; board pull-down),
   Data Control = two's complement | I first | I on rising | DCLKIO input,
   read back, wait for the retimer (CLKMODE Searching = 0).
5. ADRF6755: the 32-step register sequence for the carrier (1279 MHz from
   the 40 MHz TCXO: PFD 40 MHz, INT 31, FRAC 32715571, divide-by-1; within
   0.3 Hz), modulator still off; wait for LDET.
6. FPGA CTRL: 2K, QPSK 1/2, guard 1/8, two's complement; prime the TS FIFO
   until DREQ falls; tx_en. Then the ADRF6755's modulator on (CR29 = 0x81,
   only once locked, as the datasheet asks) and TXDIS low: RF out.
7. Stream the muxer's TS, two packets per frame whenever DREQ is high:
   for now the service with no video (the receiver lists it by callsign).

## Tests

`test/host` compiles the components' pure C (frame encoding, Si5351A
planning, the AD9116 and ADRF6755 drivers, the SPI bit packing) for the host and checks them: Si5351A plans by
decoding the register bytes with AN619's equations in exact fractions (the
27.428571 MHz plan is exact: 25 MHz × (35 + 19/175) / 32); the AD9116 driver
against a model of its SPI port; the ADRF6755 planner against the
datasheet's three worked examples (1875, 2000 and 925 MHz) and its driver
against an SPI-port model that refuses traffic before the SPI-mode lock;
the FPGA loader against an emulated ECP5 configuration port (command order,
SRAM-erase operand, the bitstream delivered intact, CFG released after) and
every fallback to the W25Q32: empty or corrupt image, wrong device, INITN
stuck, DONE never rising. The muxer: real H.264 from x264 (1080p30,
3.3 Mbit/s, no B-frames) through it, then ffprobe (program, service name,
all 120 frames) and ffmpeg's decoder (no errors or warnings), plus a parse
of the stream: PAT/PMT gaps <= 100 ms, PCR <= 40 ms and within 1 tick of
the channel-rate timeline, every PTS ahead of the clock, continuity
counters right (including adaptation-only packets), and the channel rate
against EN 300 744's table. The gateware's cocotb host test builds its
SPI frames with this same `fpga_proto.c`, so firmware and RTL are checked
against each other.

## Not done yet

- **Confirm against Lattice TN1260 on the first board:** the CFG codes
  (`CONFIG_DVBT_CFG_SSPI_CODE`) and the slave-SPI command sequence; both
  come from open-source loaders (ecpprog, openFPGALoader), and a wrong
  guess falls back to the W25Q32 rather than bricking the board.

- **Video on hardware:** the camera → H.264 → mux chain compiles and links
  (OV5647 driver and hardware encoder in the binary) but has only run in
  host tests of its pure parts. Settings to tune on the bench: bit rate
  (3.3 Mbit/s of the channel's 4.15), GOP, QP range, decoder delay, ISP
  pipeline controller (auto exposure/white balance).
- **Third-party components** come from GitHub at pinned commits
  (`tools/fetch-video-deps.sh`): esp_video 2.5.0, esp_cam_sensor 2.6.0,
  esp_ipa 2.4.0, esp_sccb_intf 1.0.0, esp_h264 1.5.0, cmake_utilities
  1.3.0. Their DVP camera driver needs a newer ESP-IDF than 5.5.1 and is
  switched off (MIPI CSI only).
- Board pinout: the GPIO numbers in Kconfig are placeholders until the
  schematic exists.

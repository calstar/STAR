# DVBT_Video_TX/esp32p4 — the transmitter's ESP32-P4 firmware (ESP-IDF)

The transmitter's processor: it clocks the board, loads the FPGA, sets up
the DAC and the RF chip, and turns camera video into the MPEG transport
stream the FPGA modulates. ESP-IDF v5.5.1, plain C, no Arduino/PlatformIO.

```bash
tools/install-idf.sh            # once per machine: ESP-IDF + RISC-V toolchain into /opt/esp
tools/fetch-video-deps.sh       # Espressif camera + H.264 components from GitHub (pinned)
. tools/env.sh
idf.py set-target esp32p4 build
idf.py -p /dev/ttyUSB0 flash monitor
tools/make_fpga_image.py ../gateware/build/dvbt_tx_top/dvbt_tx.bit build/fpga.img
esptool.py --chip esp32p4 -p /dev/ttyUSB0 write_flash 0x310000 build/fpga.img   # "fpga" partition
tools/fpga_update.py /dev/ttyACM0 build/fpga.img   # or: a new FPGA image over USB, later
python3 -m pytest -q test/host                  # host tests, no hardware
```

## Layout

| component | what |
|---|---|
| `tx_app` | **the application**: bring-up, the TS pump, frame intake and the health watchdog, in plain C over a board HAL (`tx_board_t`). `main` binds it to the P4's drivers; the end-to-end test (`../test/e2e`) binds it to the FPGA's RTL and chip models, so the sequence that flies is the one that is tested |
| `spi_bus_if` | generic SPI (`spi_bus_if.h`: 4-wire or 3-wire with turnaround, CS-only pulses) and I²C (`i2c_bus_if.h`) interfaces, so chip drivers don't care what bus they're on |
| `fpga_link` | the SPI link to the FPGA: register read/write, ID check, TS packets paced by DREQ, over a frame callback + DREQ (`fpga_link.c`, pure); `fpga_link_esp.c` binds it to SPI2 with DMA and a DREQ interrupt. `dvbt_regs.h` mirrors `gateware/rtl/dvbt_host.v` |
| `spi_bus_esp` | the bus interfaces on the P4: SPI3 as the setup bus (AD9116 3-wire, ADRF6755 4-wire, shared SCLK/data, GPIO chip selects) and the I²C master for the Si5351A. `spi_bus_pack.c` is the bit packing, pure C |
| `ecp5_cfg` | loads the FPGA over its slave-SPI configuration port from the `fpga` partition (`tools/make_fpga_image.py` wraps the `.bit` with a CRC-checked header); if the image is missing, corrupt, for the wrong part, rejected (status FAIL) or DONE never rises, it releases the CFG pins to the board straps and pulses PROGRAMN so the FPGA boots from its own W25Q32. `ecp5_esp_open/close` lend it SPI2 |
| `ts_mux` | MPEG-TS multiplexer at exactly the DVB-T channel rate: PAT/PMT every 100 ms, an SDT naming the service after the callsign, PCR every 20 ms from the packet count, H.264 access units as PES with PTS (access-unit delimiters added if missing), nulls in the gaps. Pure C, no allocation |
| `fc_link` | the flight computer's command link: NMEA-style lines (`$HOP,<seq>,<kHz>*HH`, `$CH?*HH`) parsed byte by byte, checksums, reply formatting. Pure C |
| `video_src` | OV5647 (MIPI CSI → ISP) or an HDMI source through a TC358743 bridge → YUV420 → the P4's hardware H.264 encoder (Espressif `esp_video`, V4L2), each access unit to a callback with its capture time. Without `third_party/` the firmware builds without video |
| `recorder` | records the transmitted TS to a microSD card (SDMMC slot 1, 1-bit, FAT, `/sdcard/TXnnnn.TS`), through a lock-free ring (`rec_ring.c`, pure) and a low-priority task: a lost link still leaves the flight's video |
| `fpga_update` | new FPGA images over the USB Serial/JTAG port (`tools/fpga_update.py`), RF off while it writes, CRC-checked; a bad transfer leaves an image the boot check rejects, so the W25Q32 takes over. Parser `fpga_update.c` is pure |
| `si5351` | Si5351A frequency planning (exact rationals, AN619 encoding) and programming over any `i2c_bus_if`; CLK0/CLK1 = 192/7 MHz for the FPGA and DAC |
| `ad9116` | AD9114/5/6/7 setup over any `spi_bus_if`: reset, data format, retimer lock (datasheet Rev. F) |
| `adrf6755` | ADRF6755 modulator + PLL over any `spi_bus_if`: SPI-mode lock (3 CS pulses), LO planning (Equations 1-5, Table 6), the datasheet's power-up sequence (Rev. B p. 35), modulator power |
| `main` | the P4 bindings (pins from `menuconfig` → *DVB-T transmitter*), then the camera, recorder and updater around `tx_app` |

## Channel switching (the flight computer's UART)

UART1, 115200 8N1, GPIO11 (P4 TX) and GPIO12 (P4 RX) by default. The
carrier can be anywhere from 1243.5 to 1296.5 MHz (the 5.7 MHz signal
inside the 1240-1300 MHz band; every 125 kHz step has a PLL plan, tested).
The flight computer decides and tells the ground; the P4 checks and switches:

```
FC  -> P4   $HOP,7,1255000*4C          switch to 1255.000 MHz (command #7)
P4  -> FC   $DONE,7,1255000,OK*HH      on air at 1255 MHz (RF dark ~0.3 ms)
```

Refusals change nothing: `$NAK,<seq>,RANGE|NOPLAN|SEQ`, `$ERR,CSUM|SYNTAX`.
A resend with the same seq is a retry and gets the same answer -- never a
second switch -- so the flight computer can repeat a command until it hears
back. A channel this board's PLL will not lock gives `$DONE,...,FAIL` with
the transmitter back on the old channel. `$CH?` answers `$CH,<kHz>`.
Protocol: `components/fc_link/include/fc_link.h`; sequence:
`components/tx_app/include/tx_app.h`. The P4 boots on `CONFIG_DVBT_LO_KHZ`.

**Per-channel calibration is not done yet:** the LO-feedthrough and I/Q
trims are one set, measured at one frequency. Check the carrier null on the
analyser at each channel you plan to use; if it moves, the trims become a
table per channel.

Pins: GPIO24/25 (USB Serial/JTAG: flashing, console, FPGA updates) and
GPIO26/27 (USB OTG) are left free, and nothing sits on the strapping pins
GPIO34-38 (the defaults once put DREQ/LDET on the USB pins and the
AD9116's pulled-down RESET on a strapping pin).

## Bring-up order (`tx_app.h`)

1. Si5351A CLK0 (FPGA) and CLK1 (AD9116 CLKIN) = 27.428571 MHz.
2. FPGA configured: slave SPI from the P4's `fpga` partition, or the
   W25Q32 fallback; 10 ms for its PLL and reset; then the stream link,
   whose ID register must read `D7B70003`.
3. TXDIS high (RF off). ADRF6755 locked into SPI mode (three CS pulses):
   it powers up in I²C mode on the same SCLK/SDIO lines as the AD9116, so
   this comes before any other setup-bus traffic.
4. AD9116: RESET/PINMD pulse, Data Control = two's complement | I first |
   I on rising | DCLKIO input, read back, wait for the retimer (it needs
   CLKIN and the FPGA's DCLKIO, hence after 1 and 2).
5. ADRF6755: the 32-step register sequence for the carrier (1279 MHz from
   the 40 MHz TCXO: PFD 40 MHz, INT 31, FRAC 32715571), modulator off;
   wait for LDET.
6. FPGA CTRL (QPSK 1/2, guard 1/8, two's complement); prime the TS FIFO
   while the DREQ pin is high; tx_en. Then the modulator on (CR29 = 0x81,
   only once locked) and TXDIS low: RF out.
7. Stream: two packets per DREQ; the health check every 100 ms reads the
   FPGA's STATUS and ID, LDET and the AD9116's retimer. LDET lost: RF off,
   relock, RF on. FPGA ID wrong (it lost its configuration): RF off, reload
   it, re-sync the DAC, re-prime, RF on. Null packets the FPGA had to
   insert are counted.

## Tests

`test/host` (`python3 -m pytest -q test/host`) compiles the components'
pure C for the host: Si5351A plans decoded with AN619's equations in exact
fractions; the AD9116 and ADRF6755 drivers against SPI-port models; the
ADRF6755 planner against the datasheet's worked examples; the FPGA loader
against an emulated ECP5 configuration port and every fallback (empty,
corrupt or wrong-device image, bitstream rejected, no wake-up, INITN
stuck), including that it never trusts a status read after the wake-up;
the muxer with real x264 1080p30 through ffprobe and ffmpeg; the flight
computer protocol (`test_hop.py`: bad and missing checksums, malformed and
oversize lines, noise, a line cut off by a reset) and a PLL plan for every
125 kHz of the band; the
recorder's ring across wrap-around and drops; the updater's parser
(noise before the header, corrupt and cut-short transfers, wrong FPGA,
oversize).

`../test/e2e` runs all of it together -- `tx_app` and every driver against
the FPGA's Verilated RTL and datasheet models of the Si5351A, ECP5, AD9116
and ADRF6755, then a gr-dtv DVB-T receiver and ffmpeg -- see its README.

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
  schematic exists (keep GPIO24-27 and 34-38 clear, as above).
- Intra refresh (smoother bit rate, faster recovery after a dropout) is not
  offered by the P4's hardware H.264 encoder (esp_h264 1.5.0 has only GOP,
  QP and ROI controls); the GOP length is the knob.

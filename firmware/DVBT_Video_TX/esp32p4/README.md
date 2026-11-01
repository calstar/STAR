# DVBT_Video_TX/esp32p4 — the transmitter's ESP32-P4 firmware (ESP-IDF)

The transmitter's processor: it clocks the board, configures the FPGA and
the DAC, and (next) turns camera video into the MPEG transport stream the
FPGA modulates. ESP-IDF v5.5.1, plain C, no Arduino/PlatformIO.

```bash
tools/install-idf.sh            # once per machine: ESP-IDF + RISC-V toolchain into /opt/esp
. tools/env.sh
idf.py set-target esp32p4 build
idf.py -p /dev/ttyUSB0 flash monitor
/usr/bin/python3.12 -m pytest -q test/host     # host tests, no hardware
```

## Layout

| component | what |
|---|---|
| `spi_bus_if` | a generic SPI transaction interface (4-wire or 3-wire with turnaround), so chip drivers don't care what bus they're on |
| `fpga_link` | the SPI link to the FPGA: register read/write, TS packets paced by DREQ, and the FPGA's setup-bus master exposed as a `spi_bus_if`. `dvbt_regs.h` mirrors `gateware/rtl/dvbt_host.v`; `fpga_proto.c` is the frame encoding, pure C |
| `si5351` | Si5351A frequency planning (exact rationals, AN619 encoding) and I²C programming; CLK0 = 192/7 MHz for the FPGA and DAC |
| `ad9116` | AD9114/5/6/7 setup over any `spi_bus_if`: reset, data format, retimer lock (datasheet Rev. F) |
| `adrf6755` | ADRF6755 modulator + PLL over any `spi_bus_if`: SPI-mode lock (3 CS pulses), LO planning (Equations 1-5, Table 6), the datasheet's power-up sequence (Rev. B p. 35), modulator power |
| `main` | bring-up, then a placeholder TS of null packets (the modulator and DAC run; a receiver sees a signal with no services) until the muxer exists; pins in `menuconfig` → *DVB-T transmitter* |

## Bring-up order (main.c)

1. Si5351A CLK0 = 27.428571 MHz (the FPGA has no clock before this).
2. FPGA link: ID register must read `D7B70002`.
3. TXDIS high (RF off). ADRF6755 locked into SPI mode: it powers up in
   I²C mode on the same SCLK/SDIO lines as the AD9116 (at address 0x60, the
   Si5351A's too), so this comes before any other setup-bus traffic.
4. AD9116 through the FPGA's setup bus: RESET/PINMD pulse (FPGA GPIO 0),
   Data Control = two's complement | I first | I on rising | DCLKIO input,
   read back, wait for the retimer (CLKMODE Searching = 0).
5. ADRF6755: the 32-step register sequence for the carrier (1279 MHz from
   the 40 MHz TCXO: PFD 40 MHz, INT 31, FRAC 32715571, divide-by-1; within
   0.3 Hz), modulator still off; wait for LDET.
6. FPGA CTRL: 2K, QPSK 1/2, guard 1/8, two's complement; prime the TS FIFO
   until DREQ falls; tx_en. Then the ADRF6755's modulator on (CR29 = 0x81,
   only once locked, as the datasheet asks) and TXDIS low: RF out.
7. Stream TS, two packets per frame whenever DREQ is high.

## Tests

`test/host` compiles the components' pure C (frame encoding, Si5351A
planning, the AD9116 and ADRF6755 drivers) for the host and checks them: Si5351A plans by
decoding the register bytes with AN619's equations in exact fractions (the
27.428571 MHz plan is exact: 25 MHz × (35 + 19/175) / 32); the AD9116 driver
against a model of its SPI port; the ADRF6755 planner against the
datasheet's three worked examples (1875, 2000 and 925 MHz) and its driver
against an SPI-port model that refuses traffic before the SPI-mode lock. The gateware's cocotb host test builds its
SPI frames with this same `fpga_proto.c`, so firmware and RTL are checked
against each other.

## Not done yet

- **Video:** MIPI-CSI camera → ISP → hardware H.264 encoder → MPEG-TS muxer
  at a constant 4.15 Mbit/s (PCR from the byte count, nulls for stuffing).
- Board pinout: the GPIO numbers in Kconfig are placeholders until the
  schematic exists.

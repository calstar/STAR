# DVBT_Video_TX — the rocket video transmitter (DVB-T at 1.28 GHz)

FPGA gateware for the DIY 1.28 GHz DVB-T transmitter (design doc: *DIY 1.28 GHz
DVB-T Rocket Video Transmitter — Design & BOM*). An **ESP32-P4** encodes H.264
into an MPEG transport stream (chosen over the Pi Zero 2W, 2026-11-01: boots in
under a second instead of ~20 s, lower power, hardware ISP and H.264 encoder);
this gateware turns that stream into DVB-T baseband I/Q for the AD9116 DAC,
per ETSI EN 300 744.

Interfaces: ESP32-P4 → FPGA is SPI (FPGA slave, mode 0, up to ~20 MHz)
carrying TS bytes at the channel rate, paced by a DREQ line from the FPGA's
input FIFO, plus register commands on the same bus. FPGA → AD9116 is a
12-bit DDR bus with I and Q interleaved (27.43 MS/s each) and a forwarded
data clock. The AD9116's and ADRF6755's setup buses (SPI), the AD9116's
RESET and the ADRF6755's TXDIS and LDET go straight to the ESP32-P4: the
FPGA only carries the stream, and the RF chips can be set up without it.
(Their drivers are in `esp32p4/`.)

### The ESP32-P4's view (full detail in `rtl/dvbt_host.v`)

| SPI frame (CS low…high) | meaning |
|---|---|
| `00`, then whole 188-byte packets | transport stream; send a packet only while DREQ is high |
| `80\|a`, 4 bytes | write register *a* (MSB first) |
| `40\|a`, 1 dummy byte, 4 bytes | read register *a* |

MISO during every command byte returns a status byte
`{dreq, tx_en, underflow, err_align, ts_bad, ts_overflow, 0, 0}`.

| reg | name | contents |
|---|---|---|
| 0 | CTRL | tx_en, constellation, code rate, guard, DAC data format (resets to unsigned, as the AD9116 does), I/Q edge swap |
| 1 | GAIN | I and Q gain (Q2.14; reset 2.5 → DAC RMS about −13.5 dBFS) |
| 2 | PHASE | I-into-Q phase trim |
| 3 | DCOFF | DC offsets I and Q (DAC LSBs) |
| 4, 5 | — | reserved |
| 6 | STATUS | sticky flags (write 1 to clear), null packets inserted |
| 7 | ID | `D7B70003` |

Bring-up (`esp32p4/main/main.c`; the steps and register values are in
`esp32p4/README.md`): program the Si5351A over I²C (the FPGA has no clock
until it runs); set up the ADRF6755 and AD9116 on the P4's own SPI bus;
write CTRL with tx_en low (two's complement, to match the AD9116's Data
Control write); send TS until DREQ falls; set tx_en. CTRL resets to
unsigned binary, the AD9116's own power-up format, so the two agree even
before any setup.

A TS packet enters the
FIFO only once all 188 bytes have arrived starting 0x47, so a packet cut
short by CS or with a bad sync byte is dropped whole, and the stream is
never misaligned; if the FIFO ever runs dry the FPGA sends null packets.

Flight mode: 2K, QPSK, code rate 1/2, guard 1/8, 6 MHz channel → 4.15 Mbit/s.

## Why the encoder is not in the FPGA

H.264 needs motion search over stored frames (a 1080p frame is 25 Mbit; the
ECP5-25F has ~1 Mbit of block RAM), an ISP for the raw Bayer camera, and
commercial encoder IP several times the size of this part. The ESP32-P4 does
all of that in hardened silicon. DVB-T modulation is the
opposite: fixed-rate, deterministic streaming DSP, which is what the FPGA is
for. The interface between them is just TS bytes over SPI.

## Layout

```
esp32p4/             ESP32-P4 firmware (ESP-IDF v5.5): bring-up, TS mux, health watchdog, SD recording,
                     channel hops on the flight computer's command (UART; see its README)
ground/              the ground station's side of a hop: reads the channel table from the received stream
test/e2e/            end-to-end: the firmware against the Verilated RTL and chip models,
                     then a gr-dtv DVB-T receiver and ffmpeg (see its README)
gateware/rtl/        Verilog-2005, one file per EN 300 744 stage
gateware/tb/         cocotb testbenches (stream driver with random stalls)
gateware/test_rtl.py pytest entry: builds each top in Icarus, runs its test
gateware/synth.sh    Yosys + nextpnr-ecp5 (YoWASP): utilisation, Fmax, bitstream config
gateware/board/      pin constraints for the TQFP144
model/golden.py      golden vectors from GNU Radio gr-dtv
model/dvbt_rx.py     a gr-dtv DVB-T receiver (for the end-to-end test)
scripts/             table generators (RS generator, mapper levels, twiddles,
                     half-band filters) and mutation_check.py
```

## Verification: against gr-dtv, never against ourselves

Every stage is checked **bit for bit against GNU Radio's gr-dtv DVB-T
transmitter**, an independent implementation that real receivers lock to.
Each stage's test feeds it gr-dtv's own output from the stage before, so a
failure names one block; `fec_chain` then runs the whole chain from raw TS.
Every test runs with random input stalls and random output backpressure, for
two seeds.

Current state: 84 test cases pass (42 cases × 2 seeds), and all 45 planted bugs are caught.

On top of the per-block tests, `test/e2e` runs the firmware that flies
against the whole FPGA top level and datasheet models of the Si5351A,
ECP5, AD9116 and ADRF6755, demodulates the DAC output with gr-dtv's
receiver and decodes the 1080p video with ffmpeg, in twenty scenarios from a
clean boot to the FPGA losing its configuration mid-flight, a channel hop
the flight computer orders mid-flight and the ground follows, and a full
15 km flight profile with every realistic impairment (`test/e2e/IMPAIRMENTS.md`
says what breaks the link and what was fixed); its own
`mutation_check.py` plants integration bugs (firmware and RTL) and
requires a scenario to go red for each.

The tests are broken on purpose to prove they can fail:
`scripts/mutation_check.py` copies `rtl/`, plants one plausible bug per stage
(wrong PRBS seed, one RS coefficient off, a branch one byte short, a wrong
code tap, a reversed puncture pattern, an interleaver offset off by one, the
even/odd direction swapped...) and requires the stage's test to go red. (The first version of the runner passed every test while
running none of them: cocotb's runner doesn't fail on an empty filter. The
runner now asserts exactly one test ran and none failed.)

## Running

Tooling (Ubuntu 24.04):

```bash
sudo apt-get install iverilog verilator yosys nextpnr-ecp5 fpga-trellis gnuradio
/usr/bin/python3.12 -m pip install --break-system-packages cocotb pytest pytest-xdist yowasp-nextpnr-ecp5
```

Ubuntu's gnuradio bindings are built for the system `python3.12`, and cocotb
embeds the interpreter pytest runs under, so use that interpreter:

```bash
cd firmware/DVBT_Video_TX/gateware
/usr/bin/python3.12 -m pytest -q -n auto test_rtl.py     # every block + the whole transmitter, ~7 min on 4 cores
/usr/bin/python3.12 ../scripts/mutation_check.py         # every planted bug must be caught
./synth.sh                                               # board top: utilisation, Fmax (~5 min)
yowasp-ecppack build/dvbt_tx_top/dvbt_tx_top.config build/dvbt_tx_top/dvbt_tx.bit
verilator --lint-only -Wall -Wno-DECLFILENAME --top-module dvbt_fec_chain rtl/*.v
cd ../test/e2e
/usr/bin/python3.12 -m pytest -q -n 4 test_e2e.py         # end to end, ~2 min on 4 cores
/usr/bin/python3.12 mutation_check.py                     # every planted integration bug must be caught
cd ../../model/tests
/usr/bin/python3.12 -m pytest -q                          # RF link budget: 15 km margin, rx coax and NF dB for dB (~3 s)
```

CI (`.github/workflows/dvbt-video-tx-ci.yml`, on any change under this folder)
runs all of these: host firmware tests, the link budget, the RTL regression and
its mutation check, synthesis, the end-to-end scenarios and their mutation
check (after the scenarios pass), and the ESP-IDF build. It sets
`DVBT_REQUIRE_TOOLS=1`, so a test whose tool is missing fails instead of
skipping green; set it locally to get the same behaviour.

## Status

| Stage (EN 300 744) | RTL | Checked against gr-dtv |
|---|---|---|
| §4.3.1 energy dispersal | `dvbt_energy_dispersal.v` | yes |
| §4.3.2 RS(204,188) | `dvbt_rs_encoder.v` | yes |
| §4.3.3 outer interleaver (I=12, M=17) | `dvbt_outer_interleaver.v` | yes |
| §4.3.4 inner coder + puncturing, all 5 rates | `dvbt_inner_coder.v` | yes, QPSK/16QAM/64QAM × 1/2…7/8 |
| §4.3.4.1 bit interleaver | `dvbt_bit_interleaver.v` | yes, QPSK/16QAM/64QAM |
| §4.3.4.2 symbol interleaver (2K) | `dvbt_symbol_interleaver.v` | yes |
| chain of the above | `dvbt_fec_chain.v` | yes |
| §4.3.5 mapping | `dvbt_mapper.v` | yes, within 1 LSB, all constellations |
| §4.4–4.6 frame: continual/scattered pilots, TPS (DBPSK, BCH) | `dvbt_frame_builder.v` | yes, > 2 frames, via FFT of gr-dtv output |
| TS → carriers | `dvbt_carrier_chain.v` | yes, QPSK 1/2 and 64QAM 2/3 |
| 2048-point FFT (R2²SDF, used as IFFT) | `dvbt_fft2048.v` | vs numpy: 71 dB SNR |
| carrier → bin reorder, guard interval | `dvbt_ifft_in.v`, `dvbt_gi_insert.v` | in the modulator test |
| **whole modulator, TS → baseband OFDM** | `dvbt_modulator.v` | vs gr-dtv sample by sample: 70 dB SNR, MER 71 dB |
| gain / I/Q trims, 4× interpolation (two half-band stages) | `dvbt_iq_corr.v`, `dvbt_halfband.v`, `dvbt_interp.v` | vs scipy `upfirdn` with the design coefficients, within 1.5 LSB; 75 dB image rejection measured |
| AD9116 data port (12-bit DDR, offsets, format, underflow) | `dvbt_dac_out.v` | pins sampled in each half clock vs the definition |
| TS input: SPI slave, packet-atomic FIFO, DREQ, null packets | `dvbt_spi_slave.v`, `dvbt_fifo.v`, `dvbt_host.v`, `dvbt_ts_source.v` | ESP32-side SPI model on an unrelated 20 MHz clock |
| register file | `dvbt_host.v` | same test |
| **whole transmitter, SPI in → DAC pins out** | `dvbt_tx_core.v` | vs gr-dtv: DAC samples decimated and FFT'd as a receiver would, MER ≥ 50 dB every symbol (12-bit limit ~53 dB at unity gain) |
| board top: PLL, 90° forwarded DAC clock, reset | `dvbt_tx_top.v`, `dvbt_pll.v`, `board/dvbt_tx.lpf` | places, routes and packs a bitstream on TQFP144 |

Synthesis and place-and-route of the whole board top (`./synth.sh`) on the
LFE5U-25F-7TG144C with the provisional pinout:

| resource | used | of | |
|---|---|---|---|
| logic cells (LUT4 + carry) | 16.0k | 24,288 | 65% |
| flip-flops | 7.7k | 24,288 | 31% |
| block RAM (DP16KD) | 32 | 56 | 57% |
| multipliers (MULT18X18D) | 23 | 28 | 82% |
| I/O | 20 | 98 on TQFP144 | |
| Fmax, system clock | 64.5 MHz | needs 27.43 | 2.4× margin |
| Fmax, SPI clock domain | 75 MHz | needs 20 | |

The FFT takes 20 multipliers and most of the RAM; the interpolation filters
use none (shift-and-add constants), the trims three. The interpolator is
the second-largest block (about 3k LUT4 + 1k carry, 3.2k flip-flops, mostly
delay lines; moving those into block RAM would roughly halve it if room is
ever needed). The LFE5U-12F would not fit (12k LUTs, 32 block RAMs).

Output level: carriers at 1.0 = 8192 leave the IFFT as their sum / 32, RMS
about 11k with peaks under 40k of the 18-bit range (PAPR ~11 dB) in steady
state. The one exception is the first ~5 symbols after reset: the outer
interleaver powers up zeroed (as gr-dtv's does), zeros bypass the energy
dispersal, and the identical cells they produce add up at t = 0 beyond full
scale; the RTL clips those few samples, and the test pins that down.

## Notes for the next stages

- gr-dtv 3.10's `dvbt_reference_signals` already includes the 2048-point IFFT:
  its output is time-domain. The frame builder is checked against the FFT of
  it (carrier k in bin (k - 852) mod 2048, scale from the k = 0 continual
  pilot), and the modulator against gr-dtv's carriers put back through an
  exact IFFT at the RTL's scale with the cyclic prefix in front.
- The symbol interleaver's `m_sos` marks OFDM symbol starts; symbol parity and
  the frame's 68-symbol count both start at reset, as gr-dtv's do.

## Open items

- **AD9116, checked against its datasheet (Rev. F):** I is latched on
  DCLKIO's rising edge and paired first by default, which is what the FPGA
  sends; it powers up expecting unsigned binary, so CTRL now resets to
  that. DCLKIO is the data clock input (from the FPGA's 90° clock) and
  CLKIN the sampling clock (the Si5351A); the on-chip retimer bridges them.
  Its SPI is 3-wire only (SDIO); it and RESET/PINMD are driven by the
  ESP32-P4 (`esp32p4/components/ad9116`, `spi_bus_esp`).
- **Design doc correction:** the doc powers the AD9116's DVDD from an
  AP2112K-1.8 LDO. Per the datasheet DVDD is the *output* of the AD9116's
  own 1.8 V LDO when DVDDIO > 1.8 V: bypass it with 1 µF and connect
  nothing else (pin table; the text on p. 33 says 0.1 µF). The external
  1.8 V regulator is not needed for the DAC. Also CVDD must be ≥ DVDD
  (3.3 V is fine), and RESET/PINMD needs a board pull-down so the DAC stays
  in SPI mode while the FPGA is unconfigured.
- **Pinout** in `board/dvbt_tx.lpf` is provisional, chosen from the
  TQFP144 pin data (clock on the right PLL input, DAC bus on the same bank,
  ESP32 SCK on a clock-capable pin, configuration-flash bank untouched).
  Re-run `./synth.sh` after any change; it checks timing against the real
  pins.
- **Package (resolved).** Ubuntu's Trellis lacks TQFP144 for this die;
  upstream has it, and `synth.sh` uses YoWASP's nextpnr build for it.
- **Outer interleaver after reset.** Its RAM is zeroed at power-up (matching
  gr-dtv) but not by a reset, so the first 1122 bytes after a warm reset are
  stale. A receiver sees one burst error and locks; harmless, but known.

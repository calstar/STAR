# dvbt-tx — the rocket video transmitter's DVB-T modulator

FPGA gateware for the DIY 1.28 GHz DVB-T transmitter (design doc: *DIY 1.28 GHz
DVB-T Rocket Video Transmitter — Design & BOM*). An **ESP32-P4** encodes H.264
into an MPEG transport stream (chosen over the Pi Zero 2W, 2026-11-01: boots in
under a second instead of ~20 s, lower power, hardware ISP and H.264 encoder);
this gateware turns that stream into DVB-T baseband I/Q for the AD9116 DAC,
per ETSI EN 300 744.

Interfaces: ESP32-P4 → FPGA is SPI (FPGA slave) carrying TS bytes at the
channel rate, paced by a DREQ line from the FPGA's input FIFO, plus register
commands on the same bus. FPGA → AD9116 is a 12-bit DDR bus with I and Q
interleaved (27.43 MS/s each) and a 3-wire SPI for setup.

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
gateware/rtl/        Verilog-2005, one file per EN 300 744 stage
gateware/tb/         cocotb testbenches (stream driver with random stalls)
gateware/test_rtl.py pytest entry: builds each top in Icarus, runs its test
gateware/synth.sh    Yosys + nextpnr-ecp5 utilisation / Fmax for the LFE5U-25F
model/golden.py      golden vectors from GNU Radio gr-dtv
scripts/             table generators (RS generator polynomial)
```

## Verification: against gr-dtv, never against ourselves

Every stage is checked **bit for bit against GNU Radio's gr-dtv DVB-T
transmitter**, an independent implementation that real receivers lock to.
Each stage's test feeds it gr-dtv's own output from the stage before, so a
failure names one block; `fec_chain` then runs the whole chain from raw TS.
Every test runs with random input stalls and random output backpressure, for
two seeds.

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
/usr/bin/python3.12 -m pip install --break-system-packages cocotb pytest pytest-xdist
```

Ubuntu's gnuradio bindings are built for the system `python3.12`, and cocotb
embeds the interpreter pytest runs under, so use that interpreter:

```bash
cd dvbt-tx/gateware
/usr/bin/python3.12 -m pytest -q -n auto test_rtl.py     # all stages, ~2 min on 4 cores
/usr/bin/python3.12 ../scripts/mutation_check.py         # every planted bug must be caught
./synth.sh                                               # utilisation + Fmax
verilator --lint-only -Wall -Wno-DECLFILENAME --top-module dvbt_fec_chain rtl/*.v
```

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
| 4× interpolation, I/Q trims, AD9116 DDR bus | — | next |
| TS input (SPI slave, sync lock, null-packet rate matching) | — | |
| control: SPI masters for ADRF6755/AD9116, register file | — | |

Synthesis of the whole `dvbt_modulator` on LFE5U-25F (speed 7): about 5.2k
LUT4 (21%), 30 of 56 block RAMs, 20 of 28 multipliers (the FFT's five complex
multipliers), Fmax about 62 MHz against the 27.43 MHz sample clock. The 8
multipliers left are for the interpolation filters, which can time-share them
(each runs at 4+ clocks per sample).

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

- **Package.** The design doc picks the TQFP144. Ubuntu's Project Trellis
  database has pin data only for CABGA256/381 and CSFBGA285 on this die;
  `synth.sh` sizes on CABGA256 (same die, same resources and timing). Confirm
  the open flow supports the TQFP144 pinout before the board is laid out on it.
- **Outer interleaver after reset.** Its RAM is zeroed at power-up (matching
  gr-dtv) but not by a reset, so the first 1122 bytes after a warm reset are
  stale. A receiver sees one burst error and locks; harmless, but known.

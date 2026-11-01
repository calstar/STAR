# What real-world imperfections do to the link

`impairments.py` runs the end-to-end harness with realistic imperfections in
every part that has them, then the analog chain and the air
(`model/rf_chain.py`), then gr-dtv's receiver, and reports MER, packet
errors, losses, the worst 50 ms, decoded frames and ffmpeg errors. Each
parameter carries its source (datasheet table, design doc, or "assumption"
where nothing better exists: the PA at 1.28 GHz, the receiver's noise
figure and tuner crystal, the rocket antenna's pattern).

```bash
/usr/bin/python3.12 test/e2e/impairments.py /tmp/imp            # ~45 min on 4 cores
/usr/bin/python3.12 test/e2e/impairments.py /tmp/imp "range"    # a subset
```

**Modelled**: Si5351A crystal ppm and edge jitter (the FPGA clock and the
DAC's CLKIN); ECP5 PLL 90° phase error and jitter; DAC data-bus pin skew,
checked against the AD9116's setup/hold (a violated latch corrupts the bits
that were changing); P4 SPI clock ppm and jitter, frame gaps, DREQ
interrupt latency and preemption stalls; camera frame clock and encoder
latency jitter; TCXO ppm; DAC gain, offset, INL, noise and aperture
jitter; reconstruction-filter tolerance per rail; ADRF6755 quadrature
error, LO feedthrough, phase noise (its datasheet curve), compression and
noise floor; driver and PA compression (Rapp) and AM-PM; path loss, roll
ripple of the rocket antenna, ground reflection, Doppler and its rate,
receiver noise figure, tuner frequency error, sample-clock error and ADC.

## What broke, and what was done

| finding | what happened | status |
|---|---|---|
| TCXO a few ppm fast | the ADRF6755's PFD (40 MHz REFIN, undivided) went past its 40 MHz maximum: the PLL never locked, nothing transmitted | **fixed**: the planner sizes the reference divider for REFIN + tolerance (`CONFIG_DVBT_ADRF_REFIN_TOL_PPM`, 5): 20 MHz PFD, LDET count adjusted |
| P4 held off > 3.6 ms | the 2 KB TS FIFO ran dry, the FPGA inserted 47 nulls, every later PCR was 2.9 ms late (receiver clock recovery), a frame lost | **fixed**: 16 KB FIFO (~29 ms; +7 BRAM); the health check moves the mux's clock on by the FPGA's null count; console logging moved off the TS task (a blocked USB console would stall it) |
| LO feedthrough (-43 dBc of nominal) | at our 12 dB back-off it is stronger than a single carrier; every 4th symbol (scattered pilot on the centre carrier) the receiver's channel estimate is corrupted | **fixed in firmware**: per-board DC-offset/gain/phase calibration into the FPGA's trims (`menuconfig` → RF calibration); bench step: null the carrier on a spectrum analyser |
| reconstruction filter I/Q mismatch | 4.5 MHz Butterworth close to the 2.85 MHz signal edge: 5 % parts give MER 21 dB, 10 % give 15 dB (QPSK fine; 16QAM would not be) | **board change**: 8 MHz cutoff (DAC images at 24.6 MHz still -49 dB + sinc) and 2 % parts: MER 30 dB |
| PA P1dB at 1.28 GHz unknown | P1dB 32.8 → 26 dBm takes MER 31 → 14 dB; still decodes | **measure** on the bench; back off with the attenuator if low |
| rocket antenna pointing its tail at the station | -15 dBi toward the station at 15 km: SNR 2.6 dB, **link lost** (-10 dBi still clean) | **antenna/placement**: aft coverage, or the station off to the side of the pad |
| deep roll nulls | 20 dB nulls at 2 rev/s: clean at 15 km, at 30 km whole 50 ms bursts lost (DVB-T's interleaving is far shorter than a fade) | **antenna**: keep roll ripple well under 10 dB |
| receiver frequency error | gr-dtv locks to 25 kHz, not 30 kHz; a tuner crystal at 20-30 ppm is 25-38 kHz at 1.28 GHz, plus 3 kHz TCXO and 3 kHz Doppler | **bench**: sweep the UT-130B's offset tolerance; trim the LO in 1 kHz steps to its crystal if needed |
| noise | clean down to SNR 9 dB (40 km), errors at 5.5 dB (60 km), lost at 3 dB | 12 dB of margin at 15 km with an average rocket antenna, the helix straight into the UT-130B (no LNA, NF 6 dB assumed). Coax between them comes off that margin dB for dB (`rx_cable_loss_db`; 1 m of RG316 is about 1.2 dB at 1.28 GHz) |
| receiver model | gr-dtv crashed (heap corruption) at +50 ppm receiver clock | a bug in the reference receiver, not the transmitter |

Not breaking anything: DAC errors (MER 33 → 29 dB worst case), phase noise
even 20 dB above the datasheet curve, 8-bit receiver ADC, Doppler of
680 m/s with 10-30 g, 30-100 ps clock jitter, DAC-bus timing (8.5 ns
setup / 7.2 ns hold margin against -0.2 / 1.6 ns required, 6.2 / 6.3 ns
in the worst profile), Si5351A ±50 ppm.

## All cases (last run)

"digital worst only" ran before the FIFO fix; "flight, worst digital (fixed)" is the same profile after it.

| case | result | MER median / 5th pct (dB) | SNR (dB) | wrong pkts | lost pkts | worst 50 ms | frames | ffmpeg errors |
|---|---|---|---|---|---|---|---|---|
| ideal | ok | 32.7 / 31.0 |  | 0 | 0 | 0 | 33 | 0 |
| dac typical | ok | 31.3 / 30.0 |  | 0 | 0 | 0 | 33 | 0 |
| dac worst | ok | 28.7 / 26.7 |  | 0 | 0 | 0 | 33 | 0 |
| lpf 5% I/Q mismatch | ok | 21.0 / 20.5 |  | 0 | 0 | 0 | 33 | 0 |
| lpf 10% mismatch | ok | 15.1 / 14.6 |  | 0 | 0 | 0 | 33 | 0 |
| phase noise +10 dB | ok | 27.1 / -6.5 |  | 0 | 0 | 0 | 33 | 0 |
| phase noise +20 dB | ok | 24.7 / -7.0 |  | 0 | 0 | 0 | 33 | 0 |
| PA P1dB 32.8 dBm | ok | 30.8 / 29.5 |  | 0 | 0 | 0 | 33 | 0 |
| PA P1dB 30 dBm | ok | 23.9 / 22.9 |  | 0 | 0 | 0 | 33 | 0 |
| PA P1dB 28 dBm | ok | 19.4 / 18.7 |  | 0 | 0 | 0 | 33 | 0 |
| PA P1dB 26 dBm | ok | 14.4 / 13.8 |  | 0 | 0 | 0 | 33 | 0 |
| CFO 5 kHz (TCXO+Doppler) | ok | 32.7 / 31.0 |  | 0 | 0 | 0 | 33 | 0 |
| CFO 15 kHz | ok | 32.7 / 31.0 |  | 0 | 0 | 0 | 33 | 0 |
| CFO 20 kHz | ok | 32.7 / 31.0 |  | 0 | 0 | 0 | 33 | 0 |
| CFO 25 kHz (rx tuner 20 ppm) | ok | 32.7 / 31.0 |  | 0 | 0 | 0 | 33 | 0 |
| Doppler 680 m/s, 10 g | ok | 32.7 / 31.0 |  | 0 | 0 | 0 | 33 | 0 |
| Doppler rate 30 g | ok | 32.7 / 31.0 |  | 0 | 0 | 0 | 33 | 0 |
| rx clock 50 ppm | gr-dtv crashed |  |  |  |  |  |  |  |
| range 10 km | ok | 19.2 / 18.9 | 21.1 | 0 | 0 | 0 | 33 | 0 |
| range 15 km | ok | 15.7 / 15.5 | 17.6 | 0 | 0 | 0 | 33 | 0 |
| range 20 km | ok | 13.2 / 13.0 | 15.1 | 0 | 0 | 0 | 33 | 0 |
| range 30 km | ok | 9.6 / 9.3 | 11.6 | 0 | 0 | 0 | 33 | 0 |
| range 40 km | ok | 7.1 / 6.6 | 9.1 | 0 | 0 | 0 | 33 | 0 |
| 15 km, roll 10 dB ripple | ok | 15.8 / 10.8 | 17.6 | 0 | 0 | 0 | 33 | 0 |
| 15 km, roll 20 dB nulls | ok | 15.8 / 5.8 | 17.6 | 0 | 0 | 0 | 33 | 0 |
| 15 km, tx antenna -10 dBi (tail-on) | ok | 5.6 / 5.0 | 7.6 | 0 | 0 | 0 | 33 | 0 |
| 15 km, linear tx (3 dB pol) | ok | 12.7 / 12.4 | 14.6 | 0 | 0 | 0 | 33 | 0 |
| rx ADC 8 bit | ok | 31.3 / 30.1 |  | 0 | 0 | 0 | 33 | 0 |
| flight 15 km (typical everything) | ok | 13.9 / 10.8 | 17.6 | 0 | 0 | 0 | 33 | 0 |
| flight 15 km, LNA (NF 1.5; not planned, for comparison) | ok | 16.6 / 14.1 | 22.1 | 0 | 0 | 0 | 33 | 0 |
| TCXO +2 ppm (firmware) | ok | 32.7 / 31.0 |  | 0 | 0 | 0 | 33 | 0 |
| digital typical only | ok | 29.9 / 28.4 |  | 0 | 0 | 0 | 33 | 0 |
| digital worst only | degraded | 24.6 / 24.1 |  | 0 | 0 | 0 | 32 | 0 |
| range 60 km | degraded | 3.7 / 1.9 | 5.5 | 30 | 30 | 13 | 32 | 6 |
| range 80 km | broken | 1.4 / -3.9 | 3.0 | 1843 |  |  | 0 |  |
| range 100 km | broken | 0.0 / 0.0 | 1.1 | 0 |  |  | 0 |  |
| 30 km, roll 20 dB nulls | degraded | 9.8 / -1.0 | 11.6 | 474 | 628 | 137 | 24 | 4 |
| 15 km tail-on -15 dBi | broken | 0.9 / -4.7 | 2.6 | 1527 |  |  | 0 |  |
| 15 km tail-on -15 dBi + roll 10 dB | broken | 2.1 / -4.8 | 2.6 | 365 | 1848 | 137 | 0 | 56 |
| CFO 30 kHz | broken | 0.0 / 0.0 |  | 0 |  |  | 0 |  |
| CFO 35 kHz | broken | 0.0 / 0.0 |  | 0 |  |  | 0 |  |
| modulator typical, calibrated | ok | 27.9 / 26.9 |  | 0 | 0 | 0 | 32 | 0 |
| modulator typical, uncalibrated | ok | 25.7 / 18.2 |  | 0 | 0 | 0 | 33 | 0 |
| lpf 8 MHz, 5% mismatch | ok | 25.6 / 24.8 |  | 0 | 0 | 0 | 33 | 0 |
| lpf 8 MHz, 2% mismatch | ok | 30.2 / 28.3 |  | 0 | 0 | 0 | 33 | 0 |
| flight, worst digital (fixed) | ok | 13.3 / 10.4 | 17.6 | 0 | 0 | 0 | 32 | 0 |

## How good each model is

Graded by what it can catch. "Exact": the code that flies. "Behavioural": a model written from the datasheet's rules and numbers. "First-order": the effect is there, its size comes from one or two numbers.

| part | model | detail and accuracy | not modelled |
|---|---|---|---|
| ESP32-P4 firmware | **exact**: tx_app and every driver, built for the host | bit-for-bit the logic that flies; ESP-IDF calls replaced by HAL bindings that advance simulated time | FreeRTOS scheduling and SPI DMA, which stand in as delays, ISR latency and stalls (`p4_gap_us`, `isr_us`, `stall_*`) |
| H.264 source | ffmpeg x264 1080p30 at the mux rate, camera ppm, encoder jitter | right bitrate and timing; the content and the encoder are stand-ins | the P4 hardware encoder's own rate control and GOP behaviour |
| FPGA | **exact RTL**, Verilated, cycle-accurate, GSR zero-init | every flop, FIFO, filter and DDR edge | post-place-and-route timing (nextpnr says 64.1 MHz separately); the PLL is a behavioural model with phase and jitter |
| Si5351A | behavioural: registers, SYS_INIT, reg 183, multisynth arithmetic | output frequencies exact to the programmed ratios; ppm exact | jitter is a number (about 12 ps RMS, assumed; the datasheet figure isn't in hand); start-up glitches |
| ECP5 sysCONFIG | protocol state machine: commands, status bits, DONE, quiet port after wake-up | catches order, status and fallback bugs | erase and program times (the control mutant survives on purpose) |
| AD9116 digital | registers, 3-wire SPI, RESET width, retimer 128-cycle lock, setup/hold check on every DCLKIO edge | datasheet rules, checked every sample | IBIS-level edges and ringing on the bus (6 ns of margin makes it moot) |
| AD9116 analog | first-order: gain, offset, INL bow, NSD, aperture jitter (Table 1 numbers) | min/max datasheet numbers | SFDR harmonic structure; **output compliance and common-mode into the filter** |
| reconstruction filter | **first-order**: ideal 5th-order Butterworth, tolerance as a cutoff shift per rail | right shape and I/Q mismatch trend | real source/load terminations, inductor Q and SRF, layout parasitics: **the weakest analog model** |
| ADRF6755 digital | behavioural: I²C→SPI, every register rule, Eq. 1–3, VCO range, Table 7 LDET timing | catches every planner and sequencing bug found so far | PLL lock transient and frequency settling (LDET is a delay, not a loop) |
| ADRF6755 RF | first-order: quadrature error, LO feedthrough, datasheet phase-noise curve, Rapp compression, noise floor | typical values; phase noise from the 1.8 GHz table (pessimistic at 1.28 GHz) | spurs, baseband input impedance, temperature |
| driver + PA | memoryless Rapp AM-AM plus AM-PM | gain and P1dB from datasheets at **other frequencies**; PA at 1.28 GHz assumed | memory effects, heating over the flight, antenna mismatch (VSWR) |
| LFCN-1400+ | flat 1 dB loss | | harmonics (don't reach the receiver; they matter for emissions) |
| air | free-space loss, antenna gains as numbers, roll ripple as a sinusoid, two-ray ground fade, Doppler and its rate | the link budget is as good as the antenna numbers, which are assumed | real antenna patterns, **motor plume attenuation**, airframe shadowing, multipath at the pad |
| receiver | gr-dtv's DVB-T receiver, NF 6 dB, no LNA, ideal AGC, 8-16 bit ADC | a full real demodulator (sync, channel estimate, Viterbi, RS) | the UT-130B's own demodulator chip: its offset and sync tolerance differ (bench item) |

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
| noise | clean down to SNR 9 dB (40 km), errors at 5.5 dB (60 km), lost at 3 dB | 12 dB of margin at 15 km with an average antenna; an LNA adds ~4.5 dB |
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
| flight 15 km, LNA (NF 1.5) | ok | 16.6 / 14.1 | 22.1 | 0 | 0 | 0 | 33 | 0 |
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

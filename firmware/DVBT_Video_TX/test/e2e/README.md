# End-to-end test: firmware + FPGA + chips + receiver

```bash
cd firmware/DVBT_Video_TX/test/e2e
/usr/bin/python3.12 -m pytest -q -n 4 test_e2e.py        # all scenarios, a few minutes
/usr/bin/python3.12 -m pytest -q test_e2e.py -m "not slow" # the quick ones
python3 build.py [dir] [--trace]                           # just the harness (--trace: VCD via E2E_VCD=file)
```

Needs Verilator, gcc, ffmpeg and Ubuntu's gnuradio (bindings for python3.12).

## What runs

```
 firmware (components/tx_app + every driver, the code that flies, built for the host)
   │ tx_board_t HAL: each call advances simulated time
   ├─ I²C ───────────▶ Si5351A model ── CLK0 ──▶ FPGA clock (whatever was programmed)
   │                                   └ CLK1 ──▶ AD9116 CLKIN
   ├─ config SPI ────▶ ECP5 sysCONFIG model ── DONE ──▶ FPGA logic starts
   ├─ stream SPI ────▶ dvbt_tx_top (gateware/rtl, Verilated), bit by bit at 20 MHz
   │   DREQ ◀────────┘          │ 12-bit DDR bus + DCLKIO
   ├─ setup SPI ─────▶ AD9116 model ◀────────┘ latches on DCLKIO edges per DATA_CTRL
   │   (spi_bus_pack) └▶ ADRF6755 model ── LO, LDET, TXDIS, modulator power
   └─ GPIO: TXDIS, DAC RESET, LDET
                                ▼
                rf.iq: I/Q at 27.43 MS/s while the RF is on
                                ▼
   decimate 4x ─▶ gr-dtv DVB-T receiver ─▶ rx.ts ─▶ compared with sent.ts, ffprobe, ffmpeg
```

- **Time** is simulated in femtoseconds and owned by the harness
  (`e2e.cpp`). An SPI frame clocks its bits into the RTL at the real SCK
  rate while the FPGA clock runs alongside; a delay runs the clock; a DREQ
  wait runs it until DREQ rises. Before the ECP5 model says DONE the FPGA
  has no clock and its pins float.
- **The models** (`models.h`) are written from the datasheets, not from the
  drivers, and every rule they state is a violation in the report: the
  Si5351A's SYS_INIT and register 183, the ECP5's command order and that
  its port goes quiet after wake-up, the AD9116's RESET width, instruction
  format and read-only registers, setup/hold of the DAC data against
  DCLKIO, the retimer's 128 cycles of CLKIN and DCLKIO, the ADRF6755's I²C
  power-up mode, every "set to" bit, all writable registers written before
  CR0, Equations 1-3 and Table 6, the VCO range, and the modulator powered
  only after lock.
- **The FPGA starts from zero** (`--x-initial 0`), as the ECP5's global
  set/reset leaves every flip-flop and BRAM after configuration.
- **The receiver** (`model/dvbt_rx.py`) is gr-dtv's: synchronisation,
  channel estimation, Viterbi, Reed-Solomon, descrambling. It needs ~0.1 s
  to lock, so runs carry margin.

## Scenarios (`test_e2e.py`)

| test | what it proves |
|---|---|
| `boot_to_video` | power-up to 1080p30 H.264 on a receiver: clocks exact, LO 1279 MHz, DAC format agreed, RF only after lock, every received packet equal to what the firmware sent with none lost, PCR within 2 ticks of the channel timeline, every PTS ahead of the clock, the service named after the callsign, ffmpeg decodes with no errors or warnings |
| `no_image_boots_from_flash` | empty partition: W25Q32 fallback, link and stream work |
| `corrupt_image_boots_from_flash` | bad image CRC: never sent to the FPGA, fallback |
| `rejected_bitstream_boots_from_flash` | a valid image the FPGA rejects: FAIL status, fallback |
| `nothing_boots_keeps_rf_off` | no image and no flash: bring-up fails with the RF never on |
| `pll_never_locks_keeps_rf_off` | the ADRF6755 never locks: bring-up stops (LDET timeout), RF never on |
| `lo_unlock_recovers` | the VCO drifts out of its band in flight (unlocked until reprogrammed): RF off within one health period, relock, back on air, received again |
| `fpga_loss_recovers` | the FPGA loses its configuration: ID check, RF off, reload, DAC re-sync, re-prime, back on air |
| `p4_stall_longer_than_fifo` | the P4 stops for 40 ms (past the 16 KB FIFO): the FPGA fills with nulls, no packet lost, and the mux's clock catches up so the PCRs stay on the air's timeline |
| `p4_under_load_needs_no_nulls` | a busy P4 (8 ms preemptions, interrupt latency, frame gaps) never makes the FPGA insert a null |
| `tcxo_tolerance_still_locks` | the ADRF6755 locks with its TCXO 2.5 ppm fast or slow (20 MHz PFD) |
| `lo_feedthrough_calibration` | through the RF chain: the -43 dBc LO feedthrough corrupts every 4th symbol until the DC-offset calibration removes it |
| `flight_profile_15km` | every typical impairment at once, through the RF chain and the air at 15 km: every packet, clean video |
| `boots_at_either_end_of_the_band` | boot channel at 1243.5 and 1296.5 MHz: locks, LO exact |
| `out_of_band_boot_channel_keeps_rf_off` | 1300 MHz (half the signal outside the band): no bring-up, RF never on |
| `channel_commands_retries_and_refusals` | the flight computer's UART at 115200 baud against the flight code: bad checksum, out of band, reused seq refused with nothing changed; a retry answered identically and never switching twice; exactly one LO change, `DONE` within 3 ms of the command, RF dark < 1 ms and never on unlocked |
| `switch_to_a_channel_that_will_not_lock_falls_back` | this board's PLL will not lock at 1260 MHz: `FAIL`, back on air on the old channel within the LDET timeout |
| `switch_in_flight_received_on_the_new_channel` | in flight with video: a receiver on 1279 MHz has every packet up to the switch, one on 1255 MHz every packet after; ~150 ms of stream lost across it (the old receiver's pipeline + acquisition) |

## Real-world imperfections

`impairments.py` adds them everywhere (clock ppm and jitter, PLL phase,
DAC-bus skew against setup/hold, P4 latency and stalls, DAC errors, filter
tolerances, modulator quadrature error, feedthrough and phase noise, PA
compression, path loss, roll fading, Doppler, receiver offsets) and finds
where the link breaks: see [IMPAIRMENTS.md](IMPAIRMENTS.md).

## Can it fail? (`mutation_check.py`)

Twenty-four planted integration bugs, each of the kind that only shows when
the pieces meet, must each turn a scenario red: stale-status FIFO priming,
a 1 s DREQ wait with the FPGA gone, FPGA offset binary against a two's
complement DAC, RF on without waiting for lock, a health check blind to
LDET, the DAC's CLKIN never enabled, the mux at the wrong guard's rate,
I/Q swapped by the DAC's latch edge, the modulator on in the init
sequence, RFDIV off by one, a 3-wire read one bit long, DCLKIO inverted,
DCLKIO in phase with the data, and DREQ promising one packet of room
where the firmware sends two, the 2 KB FIFO back, the mux clock not
caught up after FPGA nulls, the PFD sized for a nominal TCXO, the
bench calibration never written; and for channel switching: the modulator
on before the new channel locks, an out-of-band channel accepted at boot or
by command, a retry switching twice, the flight computer's checksum
ignored, and a channel that will not lock leaving the RF off. A control mutant (an erase delay removed)
is expected to survive: the ECP5 model does not time the erase.

## What it found while being written

- The ECP5 loader read the status register after `ISC_DISABLE`, when the
  slave-SPI port has gone quiet and reads all ones (FAIL included): every
  slave-SPI load would have been judged failed. Now read before.
- Priming the TS FIFO trusted the status byte from the start of the last
  frame, which can say "room" after that frame filled the FIFO; with
  tx_en low nothing drains it, so bring-up hung on DREQ. Now the pin.
- The default pins put DREQ and LDET on GPIO24/25, the P4's USB
  Serial/JTAG (flashing, console), and the AD9116's pulled-down RESET on a
  strapping pin. Moved.
- With the FPGA gone, the stream pump waited up to a second for DREQ with
  the RF on; it now runs the health check after one health period.
- The half-band filter's shift-and-add chains, written as wire arrays,
  made Verilator re-evaluate whole arrays every edge (12x slower); now a
  function over constant digit masks, the same adders after synthesis.

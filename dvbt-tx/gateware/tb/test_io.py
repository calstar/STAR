"""cocotb tests for the I/O side: FIFO with packet commit, TS SPI input, null
insertion, SPI master, and the whole transmitter core."""

from __future__ import annotations

import random

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, RisingEdge, Timer

from streams import seed


@cocotb.test()
async def fifo(dut):
    """Random writes, commits, aborts, reads (16 deep, so full and empty
    happen constantly): the reader sees exactly the committed writes, in
    order, and never one that was aborted."""
    rng = random.Random(seed())
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    dut.rst.value = 1
    dut.s_valid.value = 0
    dut.w_commit.value = 0
    dut.w_abort.value = 0
    dut.m_ready.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst.value = 0
    pending, committed, got = [], [], []
    n_abort = 0
    for cyc in range(6000):
        await FallingEdge(dut.clk)
        # read side: settled outputs
        burst = (cyc // 300) % 3   # phases: reader slow / fast / stopped
        acc = rng.random() < (0.3, 0.95, 0.0)[burst]
        dut.m_ready.value = int(acc)
        if acc and int(dut.m_valid.value):
            got.append(int(dut.m_data.value))
        await Timer(1, unit="ns")
        s_ready = int(dut.s_ready.value)
        lvl, free = int(dut.level.value), int(dut.free.value)
        assert lvl <= 16 and free <= 16, f"level {lvl} free {free}"
        r = rng.random()
        push = r < 0.6 and cyc < 5000
        abort = (not push) and r < 0.62 and cyc < 5000
        commit = push and rng.random() < 0.25 or (cyc == 5000)
        x = rng.randrange(256)
        dut.s_data.value = x
        dut.s_valid.value = int(push)
        dut.w_abort.value = int(abort)
        dut.w_commit.value = int(commit)
        if abort:
            pending = []
            n_abort += 1
        else:
            if push and s_ready:
                pending.append(x)
            if commit:
                committed += pending
                pending = []
    dut.m_ready.value = 1
    for _ in range(100):
        await FallingEdge(dut.clk)
        if int(dut.m_valid.value):
            got.append(int(dut.m_data.value))
    assert got == committed, f"{len(got)} read vs {len(committed)} committed; " + next(
        (f"first diff at {k}: {a} vs {b}" for k, (a, b) in enumerate(zip(got, committed)) if a != b),
        "prefix equal")
    cocotb.log.info("fifo: %d bytes through, %d aborts", len(got), n_abort)


# ---- host interface ----------------------------------------------------------
CLK_PS = 36458   # 27.428571 MHz
SCK_HALF_PS = 25000  # 20 MHz SPI
NULL = bytes([0x47, 0x1F, 0xFF, 0x10] + [0xFF] * 184)


class Esp32:
    """The ESP32-P4 as an SPI master, mode 0, on its own clock."""

    def __init__(self, dut, rng):
        self.dut, self.rng = dut, rng
        dut.spi_cs_n.value = 1
        dut.spi_sck.value = 0
        dut.spi_mosi.value = 0

    async def frame(self, data: bytes, cut_after: int | None = None) -> bytes:
        d = self.dut
        d.spi_cs_n.value = 0
        await Timer(SCK_HALF_PS + self.rng.randrange(20000), unit="ps")
        miso = []
        for k, byte in enumerate(data):
            if cut_after is not None and k == cut_after:
                break
            v = 0
            for b in range(7, -1, -1):
                d.spi_mosi.value = (byte >> b) & 1
                await Timer(SCK_HALF_PS, unit="ps")
                d.spi_sck.value = 1
                v = (v << 1) | int(d.spi_miso.value)
                await Timer(SCK_HALF_PS, unit="ps")
                d.spi_sck.value = 0
            miso.append(v)
            if self.rng.random() < 0.1:   # the odd pause between bytes
                await Timer(self.rng.randrange(1, 400) * 1000, unit="ps")
        await Timer(SCK_HALF_PS, unit="ps")
        d.spi_cs_n.value = 1
        await Timer(4 * CLK_PS + self.rng.randrange(100000), unit="ps")
        return bytes(miso)

    async def write(self, a: int, v: int) -> None:
        await self.frame(bytes([0x80 | a]) + v.to_bytes(4, "big"))

    async def read(self, a: int) -> int:
        r = await self.frame(bytes([0x40 | a, 0, 0, 0, 0, 0]))
        return int.from_bytes(r[2:6], "big")


def packet(rng, n: int) -> bytes:
    """A TS packet with a recognisable PID (never 0x1FFF) and payload."""
    pid = 0x100 + n % 0x1000
    return bytes([0x47, pid >> 8, pid & 0xFF, 0x10 | (n & 15)]) + bytes(rng.randrange(256) for _ in range(184))


async def ts_sink(dut, rng, out: list, ready_p: list):
    """Collect TS bytes from the host's stream output, with backpressure."""
    while True:
        await FallingEdge(dut.clk)
        acc = rng.random() < ready_p[0]
        if acc and int(dut.ts_valid.value):
            out.append((int(dut.ts_data.value), int(dut.ts_sop.value)))
        dut.ts_ready.value = int(acc)


def split_packets(out):
    data = bytes(b for b, _ in out)
    sops = [k for k, (_, s) in enumerate(out) if s]
    n = len(data) // 188
    assert sops[: n] == [188 * k for k in range(n)], f"sop at {sops[:6]}..."
    return [data[188 * k: 188 * (k + 1)] for k in range(n)]


@cocotb.test()
async def host(dut):
    rng = random.Random(seed())
    cocotb.start_soon(Clock(dut.clk, CLK_PS, unit="ps").start())
    esp = Esp32(dut, rng)
    dut.ts_rst.value = 1
    dut.ts_ready.value = 0
    dut.st_underflow.value = 0
    dut.st_align.value = 0
    dut.sm_miso.value = 0
    dut.rst.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst.value = 0
    dut.ts_rst.value = 0
    await Timer(10 * CLK_PS, unit="ps")

    # registers
    assert await esp.read(7) == 0xD7B70001, "ID"
    assert await esp.read(0) == 0x80, "CTRL reset value (guard 1/8, tx off)"
    assert await esp.read(1) == (40960 << 16) | 40960, "GAIN reset value"
    await esp.write(1, 0x12345678)
    await esp.write(3, 0x07FF0801)
    assert await esp.read(1) == 0x12345678
    assert await esp.read(3) == 0x07FF0801
    assert int(dut.gain_i.value) == 0x1234 and int(dut.gain_q.value) == 0x5678
    assert int(dut.off_i.value) == 0x7FF and int(dut.off_q.value) == 0x801
    await esp.write(0, 0x00000255)
    assert int(dut.tx_en.value) == 1 and int(dut.cfg_mod.value) == 2
    assert int(dut.cfg_rate.value) == 2 and int(dut.cfg_guard.value) == 1
    assert int(dut.cfg_obin.value) == 0 and int(dut.cfg_swap.value) == 1
    # Status byte on MISO during any command byte: DREQ (empty FIFO) and tx_en.
    r = await esp.frame(bytes([0x47, 0, 0, 0, 0, 0]))
    assert r[0] == 0xC0, f"status byte {r[0]:02x}, want c0"

    # TS: good packets mixed with a bad sync byte and frames cut short; the
    # consumer takes them slowly so null packets fill gaps at times.
    out, ready_p = [], [0.5]
    cocotb.start_soon(ts_sink(dut, rng, out, ready_p))
    good, n = [], 0
    for f in range(14):
        pk = [packet(rng, n + k) for k in range(rng.randrange(1, 4))]
        kind = f % 5
        if kind == 3:       # second packet has a bad sync byte: only it is dropped
            bad = bytearray(pk[-1]); bad[0] = 0x48
            pk[-1] = bytes(bad)
            if len(pk) == 1:
                pk.insert(0, packet(rng, n + 7))
            await esp.frame(b"\x00" + b"".join(pk))
            good += pk[:-1]
        elif kind == 4:     # cut in the middle of the last packet
            await esp.frame(b"\x00" + b"".join(pk), cut_after=1 + 188 * (len(pk) - 1) + rng.randrange(1, 187))
            good += pk[:-1]
        else:
            await esp.frame(b"\x00" + b"".join(pk))
            good += pk
        n += 10
        if rng.random() < 0.3:
            await Timer(rng.randrange(20, 200) * CLK_PS, unit="ps")   # let nulls in
    await Timer(30000 * CLK_PS, unit="ps")
    pkts = split_packets(out)
    nulls = [p for p in pkts if p[1:3] == b"\x1f\xff"]
    real = [p for p in pkts if p[1:3] != b"\x1f\xff"]
    assert all(p == NULL for p in nulls), "malformed null packet"
    assert real == good, f"{len(real)} packets out, {len(good)} expected"
    st = await esp.read(6)
    assert st & 0x4, "ts_bad not flagged"
    # The counter may already include a null packet the sink hasn't finished.
    assert len(nulls) <= (st >> 16) <= len(nulls) + 1, f"null count {st >> 16} vs {len(nulls)}"
    cocotb.log.info("host: %d packets through, %d nulls inserted, status %08x", len(real), len(nulls), st)

    # DREQ: consumer stopped, send while DREQ is high.
    ready_p[0] = 0.0
    await Timer(50 * CLK_PS, unit="ps")
    await esp.write(6, 0xF)      # clear flags
    sent = []
    while int(dut.dreq.value):
        p = packet(rng, 1000 + len(sent))
        await esp.frame(b"\x00" + p)
        sent.append(p)
    # 2048-byte FIFO, DREQ while room for 2 more packets (376 bytes): 9 fit
    # (2048 - 9*188 = 356, plus the <= 3 bytes already in the read queue).
    assert len(sent) == 9, f"DREQ fell after {len(sent)} packets"
    # Ignore DREQ: the packet that doesn't fit is dropped whole, and flagged.
    extra = [packet(rng, 2000 + k) for k in range(2)]
    for p in extra:
        await esp.frame(b"\x00" + p)
    st = await esp.read(6)
    assert st & 0x8, "overflow not flagged"
    ready_p[0] = 0.7
    await Timer(20000 * CLK_PS, unit="ps")
    pkts = [p for p in split_packets(out) if p[1:3] != b"\x1f\xff"][len(good):]
    assert pkts[: len(sent)] == sent, "DREQ-paced packets lost or reordered"
    assert len(pkts) == len(sent) + 1 and pkts[-1] == extra[0], (
        f"{len(pkts) - len(sent)} of the 2 extra packets came out (1 fits)")

    # Setup SPI master: 24 bits to device 1, a pattern clocked back in.
    await esp.write(5, (3 << 16) | (1 << 8) | 23)
    pattern = 0x5A3C96
    bits_seen, cs_seen = [], set()

    async def slave():
        k = 0
        dut.sm_miso.value = (pattern >> 23) & 1
        while len(bits_seen) < 24:
            await RisingEdge(dut.sm_sclk)
            bits_seen.append(int(dut.sm_mosi.value))
            cs_seen.add(int(dut.sm_cs_n.value))
            await FallingEdge(dut.sm_sclk)
            k += 1
            dut.sm_miso.value = (pattern >> (23 - k)) & 1 if k < 24 else 0

    sl = cocotb.start_soon(slave())
    await esp.write(4, 0xABCDEF00)
    await sl
    while (await esp.read(5)) >> 31:
        pass
    word = int("".join(map(str, bits_seen)), 2)
    assert word == 0xABCDEF, f"SPI master sent {word:06x}"
    assert cs_seen == {0b01}, f"chip selects seen {cs_seen}"
    assert int(dut.sm_cs_n.value) == 0b11
    assert await esp.read(4) == pattern, "SPI master read-back"
    cocotb.log.info("host: registers, TS commit/discard, DREQ, overflow, nulls, SPI master ok")


# ---- the whole transmitter -----------------------------------------------------
@cocotb.test()
async def tx_core(dut):
    """TS over SPI in, AD9116 pins out, against gr-dtv.

    The ESP32 model primes the TS FIFO with tx_en low, raises tx_en, and
    keeps sending a packet whenever DREQ is high. The DAC pins are sampled
    in both halves of every clock (I, Q), the 27.43 MS/s signal is
    decimated back to 48/7 MS/s with scipy, each symbol's guard is dropped,
    and its FFT is compared with gr-dtv's carriers: MER, as a receiver would
    measure it. Also: no underflow, no null packets, no alignment error.
    """
    import os
    import numpy as np
    from scipy import signal
    import golden

    rng = random.Random(seed())
    n_pkt = int(os.environ.get("N_PKT", "48"))
    ts = golden.random_ts(n_pkt, seed=seed())
    car = golden.carriers(ts, "qpsk", "1/2")
    packets = [bytes(ts[188 * k: 188 * (k + 1)]) for k in range(n_pkt)]

    cocotb.start_soon(Clock(dut.clk, CLK_PS, unit="ps").start())
    esp = Esp32(dut, rng)
    dut.sm_miso.value = 0
    dut.rst.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst.value = 0
    await Timer(10 * CLK_PS, unit="ps")

    await esp.write(1, (16384 << 16) | 16384)          # unity trims
    await esp.write(0, 0x80)                           # QPSK 1/2, guard 1/8, off
    sent = 0
    while int(dut.dreq.value) and sent < n_pkt:
        await esp.frame(b"\x00" + packets[sent])
        sent += 1
    cocotb.log.info("tx_core: %d packets primed", sent)

    samples = []

    async def dac_capture():
        while True:
            await RisingEdge(dut.clk)
            await Timer(CLK_PS // 4, unit="ps")
            i = int(dut.dac_d.value)
            await Timer(CLK_PS // 2, unit="ps")
            q = int(dut.dac_d.value)
            samples.append(complex(i - 4096 * (i >> 11), q - 4096 * (q >> 11)))

    await esp.write(0, 0x81)                           # transmit
    assert await esp.read(0) == 0x81 and int(dut.tx_on.value) == 1, "tx_en did not take"
    cap = cocotb.start_soon(dac_capture())
    n_sym = len(car) - 4
    need = int((n_sym + 1) * 2304 * 4 + 6000)
    while len(samples) < need:
        if sent < n_pkt and int(dut.dreq.value):
            await esp.frame(b"\x00" + packets[sent])
            sent += 1
        else:
            await Timer(2000 * CLK_PS, unit="ps")
        assert sent == n_pkt or len(samples) < need, "ran out of TS"
    cap.cancel()
    st = await esp.read(6)
    cocotb.log.info("tx_core: %d packets sent, %d DAC samples, status %08x", sent, len(samples), st)
    assert st & 0x3 == 0, f"status {st:08x}: underflow or alignment error"
    assert st >> 16 == 0, f"{st >> 16} null packets inserted while the FIFO was fed"

    x = np.array(samples)
    if os.environ.get("TB_DUMP"):
        np.savez(os.environ["TB_DUMP"], x=x, car=car)
    ng, N = 256, 2048
    bins = np.zeros((n_sym, N), complex)
    bins[:, [(k - 852) % N for k in range(1705)]] = car[:n_sym]
    t = np.fft.ifft(bins, axis=1)
    want = np.concatenate([t[:, -ng:], t], axis=1).reshape(-1)
    # The receiver's part: decimate 4x with a sharp low-pass (the 1705
    # carriers reach 2.85 MHz; scipy's default filter would eat the edge
    # ones), find the sample phase and the symbol timing, equalise with one
    # complex gain for the whole run, compare carriers after start-up.
    STARTUP = 10
    taps = signal.firwin(801, 3.2, window=("kaiser", 10), fs=4 * 48 / 7) * 4
    best = None
    for ph in range(4):
        y = signal.resample_poly(x[ph:], 1, 4, window=taps)
        L = 6 * (N + ng)
        lag = int(np.argmax(np.abs(np.correlate(y[: L + 4000], want[:L], mode="valid"))))
        if len(y) < lag + n_sym * (N + ng):
            continue
        yy = y[lag: lag + n_sym * (N + ng)].reshape(n_sym, N + ng)
        rx = np.fft.fft(yy[:, ng:], axis=1)[:, [(k - 852) % N for k in range(1705)]]
        ref, got = car[STARTUP:n_sym], rx[STARTUP:]
        g = np.vdot(ref, got) / np.vdot(ref, ref)
        err = got / g - ref
        per = [10 * np.log10(np.sum(np.abs(r) ** 2) / np.sum(np.abs(e) ** 2)) for r, e in zip(ref, err)]
        if best is None or min(per) > min(best[1]):
            best = (ph, per, lag)
    ph, per, lag = best
    rms = np.sqrt(np.mean(np.abs(x[-4 * 8 * (N + ng):]) ** 2))
    cocotb.log.info("tx_core: sample phase %d, symbol lag %d: MER %.1f dB worst of %d symbols "
                    "(mean %.1f), DAC RMS %.0f of 2047", ph, lag, min(per), len(per),
                    np.mean(per), rms)
    # 12-bit quantization at unity gain (RMS ~172 LSB) allows ~53 dB.
    assert min(per) >= 45, f"MER {min(per):.1f} dB in some symbol"

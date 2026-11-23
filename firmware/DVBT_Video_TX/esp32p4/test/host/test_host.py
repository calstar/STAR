"""Host tests for the ESP32-P4 firmware's pure logic.

    /usr/bin/python3.12 -m pytest -q firmware/DVBT_Video_TX/esp32p4/test/host

The Si5351A plans are checked by decoding the register bytes with AN619's
equations in exact fractions; the AD9116 driver against a model of the
chip's SPI port as its datasheet describes it; the FPGA frames against the
protocol in gateware/rtl/dvbt_host.v (and, in gateware/tb/test_io.py,
against the RTL itself).
"""
from __future__ import annotations

import ctypes
import random
import re
from fractions import Fraction
from pathlib import Path

import pytest

import fwlib

FW = fwlib.FW


# ---- register map / frames ---------------------------------------------------
def test_id_matches_rtl():
    v = (FW.parent / "gateware/rtl/dvbt_host.v").read_text()
    rtl = int(re.search(r"localparam \[31:0\] ID = 32'h([0-9A-Fa-f_]+)", v).group(1).replace("_", ""), 16)
    h = (FW / "components/fpga_link/include/dvbt_regs.h").read_text()
    fw = int(re.search(r"#define DVBT_ID\s+0x([0-9A-Fa-f]+)u", h).group(1), 16)
    assert fw == rtl, f"firmware expects ID {fw:08x}, RTL has {rtl:08x}"


def test_frames():
    assert fwlib.frame_write(1, 0x12345678) == bytes([0x81, 0x12, 0x34, 0x56, 0x78])
    assert fwlib.frame_write(8, 1) == bytes([0x88, 0, 0, 0, 1])
    assert fwlib.frame_read(7) == bytes([0x47, 0, 0, 0, 0, 0])
    p = bytes([0x47]) + bytes(range(187))
    assert fwlib.frame_ts(p + p) == b"\x00" + p + p
    assert fwlib.parse_read(bytes([0xC0, 0, 0xD7, 0xB7, 0x00, 0x02])) == 0xD7B70002


# ---- Si5351A -------------------------------------------------------------------
class Plan(ctypes.Structure):
    _fields_ = [("pll_a", ctypes.c_uint32), ("pll_b", ctypes.c_uint32), ("pll_c", ctypes.c_uint32),
                ("ms_div", ctypes.c_uint32), ("r_div_log2", ctypes.c_uint32),
                ("vco_hz", ctypes.c_double), ("out_hz", ctypes.c_double)]


class Params(ctypes.Structure):
    _fields_ = [("p1", ctypes.c_uint32), ("p2", ctypes.c_uint32), ("p3", ctypes.c_uint32)]


def plan(xtal, num, den):
    lib = fwlib.load()
    p = Plan()
    ok = lib.si5351_plan(ctypes.c_uint32(xtal), ctypes.c_uint64(num), ctypes.c_uint64(den), ctypes.byref(p))
    return p if ok else None


def regs(a, b, c, r=0):
    lib = fwlib.load()
    lib.si5351_encode.restype = Params
    pp = lib.si5351_encode(ctypes.c_uint32(a), ctypes.c_uint32(b), ctypes.c_uint32(c))
    out = (ctypes.c_uint8 * 8)()
    lib.si5351_pack(ctypes.byref(pp), ctypes.c_uint32(r), out)
    return bytes(out)


def decode(o: bytes):
    """AN619 register layout -> (a + b/c as a Fraction, R divider exponent)."""
    p3 = ((o[5] >> 4) << 16) | (o[0] << 8) | o[1]
    p1 = ((o[2] & 3) << 16) | (o[3] << 8) | o[4]
    p2 = ((o[5] & 15) << 16) | (o[6] << 8) | o[7]
    # AN619: P1 = 128a + floor(128 b/c) - 512, P2 = 128b - c floor(128 b/c), P3 = c
    #  => a + b/c = (P1 + 512 + P2/P3) / 128
    return Fraction(p1 + 512, 128) + Fraction(p2, 128 * p3), (o[2] >> 4) & 7


def test_si5351_27M428571_exact():
    xtal = 25_000_000
    p = plan(xtal, 192_000_000, 7)
    assert p is not None
    pll, _ = decode(regs(p.pll_a, p.pll_b, p.pll_c))
    ms, r = decode(regs(p.ms_div, 0, 1, p.r_div_log2))
    vco = xtal * pll
    assert 600e6 <= vco <= 900e6, f"VCO {float(vco)}"
    assert ms.denominator == 1 and ms.numerator % 2 == 0, "output divider not an even integer"
    fout = vco / ms / 2 ** r
    assert fout == Fraction(192_000_000, 7), f"got {float(fout)} Hz"


@pytest.mark.parametrize("seed", range(3))
def test_si5351_random(seed):
    rng = random.Random(seed)
    for _ in range(200):
        xtal = rng.choice([25_000_000, 27_000_000])
        f = rng.randrange(8_000, 150_000_000)
        p = plan(xtal, f, 1)
        assert p is not None, f"no plan for {f}"
        pll, _ = decode(regs(p.pll_a, p.pll_b, p.pll_c))
        ms, r = decode(regs(p.ms_div, 0, 1, p.r_div_log2))
        vco = xtal * pll
        assert 600e6 <= vco <= 900e6
        fout = vco / ms / 2 ** r
        assert abs(float(fout) / f - 1) < 1e-9, f"{f}: {float(fout)}"


# ---- AD9116 driver --------------------------------------------------------------
XFER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_bool,
                        ctypes.c_int, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32))
RESET = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_bool)
PULSE = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_int)


class Bus(ctypes.Structure):
    _fields_ = [("xfer", XFER), ("cs_pulse", PULSE), ("ctx", ctypes.c_void_p)]


class Dev(ctypes.Structure):
    _fields_ = [("bus", ctypes.POINTER(Bus)), ("dev", ctypes.c_int), ("set_reset", RESET),
                ("reset_ctx", ctypes.c_void_p)]


class AD9116Model:
    """The SPI port per the datasheet (Rev. F pp. 34-36): 3-wire, instruction
    byte R/W N1 N0 A4..A0 then N+1 data bytes, MSB first; RESET pulse loads
    defaults; the retimer searches for a few polls after reset."""

    def __init__(self, searching_polls=3, stuck=False):
        self.regs = {0x02: 0x34, 0x14: 0x00, 0x1F: 0x0A}
        self.log, self.polls, self.searching, self.stuck = [], 0, searching_polls, stuck
        self.reset_level = 0

    def reset(self, ctx, high):
        self.log.append(("reset", bool(high)))
        if self.reset_level and not high:
            self.regs = {0x02: 0x34, 0x14: 0x10, 0x1F: 0x0A}
            self.polls = 0
        self.reset_level = int(high)

    def xfer(self, ctx, dev, nbits, three_wire, wr_bits, tx, rx):
        assert self.reset_level == 0, "SPI while RESET/PINMD high (pin mode)"
        assert dev == 0 and three_wire, "AD9116 is 3-wire on device 0"
        ins = (tx >> (nbits - 8)) & 0xFF
        rd, n, a = ins >> 7, ((ins >> 5) & 3) + 1, ins & 0x1F
        assert nbits == 8 + 8 * n, f"{nbits} bits for {n} data bytes"
        assert wr_bits == (8 if rd else nbits), f"turnaround after {wr_bits} bits"
        self.log.append(("rd" if rd else "wr", a, tx & 0xFF))
        if rd:
            if a == 0x14:
                self.polls += 1
                if self.polls > self.searching and not self.stuck:
                    self.regs[0x14] = 0x00
            v = self.regs.get(a, 0)
            if rx:
                rx[0] = v
        else:
            self.regs[a] = tx & 0xFF
        return 0


def run_init(model, twos):
    lib = fwlib.load()
    bus = Bus(XFER(model.xfer), PULSE(), None)
    dev = Dev(ctypes.pointer(bus), 0, RESET(model.reset), None)
    ver = ctypes.c_uint8()
    rc = lib.ad9116_init(ctypes.byref(dev), ctypes.c_bool(twos), ctypes.byref(ver))
    return rc, ver.value


def test_ad9116_init():
    m = AD9116Model()
    rc, ver = run_init(m, True)
    assert rc == 0 and ver == 0x0A
    assert m.log[:2] == [("reset", True), ("reset", False)], "reset pulse first"
    assert m.regs[0x02] == 0xB4, f"DATA_CTRL {m.regs[0x02]:02x}: want TWOS|IFIRST|IRISING|DCI_EN"
    assert m.polls == 4, "should poll CLKMODE until Searching clears"
    m2 = AD9116Model()
    assert run_init(m2, False)[0] == 0 and m2.regs[0x02] == 0x34


def test_ad9116_retimer_timeout():
    rc, _ = run_init(AD9116Model(stuck=True), True)
    assert rc == 0x107, "must report ESP_ERR_TIMEOUT when the retimer never locks"


# ---- ADRF6755 ---------------------------------------------------------------------
class APlan(ctypes.Structure):
    _fields_ = [("pfd_hz", ctypes.c_uint32), ("r", ctypes.c_uint8), ("doubler", ctypes.c_bool),
                ("r_half", ctypes.c_bool), ("r_enable", ctypes.c_bool), ("intg", ctypes.c_uint16),
                ("frac", ctypes.c_uint32), ("rfdiv", ctypes.c_uint8), ("cr27_bit4", ctypes.c_bool),
                ("bscdiv", ctypes.c_uint8), ("lo_hz", ctypes.c_double)]


def aplan(refin, lo):
    p = APlan()
    ok = fwlib.load().adrf6755_plan(ctypes.c_uint32(refin), ctypes.c_uint64(lo), ctypes.byref(p))
    return p if ok else None


def aseq(p, atten=0):
    buf = (ctypes.c_uint8 * 2 * 64)()
    n = fwlib.load().adrf6755_init_sequence(ctypes.byref(p), ctypes.c_uint8(atten), buf, 64)
    return [(buf[i][0], buf[i][1]) for i in range(n)]


def regs_of(seq):
    out = {}
    for r, v in seq:
        out[r] = v
    return out


def test_adrf6755_datasheet_examples():
    """The datasheet's own worked examples (Rev. B pp. 23, 35-36), PFD 40 MHz."""
    p = aplan(40_000_000, 1_875_000_000)                      # p. 23
    assert (p.intg, p.frac, p.rfdiv) == (46, 29_360_128, 0)
    p = aplan(40_000_000, 2_000_000_000)                      # p. 35
    r = regs_of(aseq(p))
    assert (r[7], r[6], r[3], r[2], r[1], r[0], r[28] & 7, r[27] & 0x10) == (0, 0x32, 0x04, 0, 0, 0, 0, 0x10)
    p = aplan(40_000_000, 925_000_000)                        # p. 36
    r = regs_of(aseq(p))
    assert (p.intg, p.frac) == (46, 8_388_608)
    assert (r[7], r[6], r[3], r[2], r[1], r[0], r[28] & 7, r[27] & 0x10) == (0, 0x2E, 0x04, 0x80, 0, 0, 1, 0)
    assert p.bscdiv == 100, "CR25 = 0x64 at 40 MHz (step 6)"


def test_adrf6755_flight_lo():
    """1279 MHz from the 40 MHz TCXO (design doc): within 1 Hz, divide-by-1 band."""
    p = aplan(40_000_000, 1_279_000_000)
    assert p.pfd_hz == 40_000_000 and p.rfdiv == 0 and p.cr27_bit4
    lo = Fraction(p.pfd_hz) * (p.intg + Fraction(p.frac, 1 << 25))
    assert abs(lo - 1_279_000_000) < 1, f"LO {float(lo)}"


def test_adrf6755_pfd_margin_for_tcxo_tolerance():
    """A 40 MHz TCXO a few ppm fast must not put the PFD past 40 MHz: with a
    tolerance the planner divides by 2 and keeps the LO exact."""
    lib = fwlib.load()
    p = APlan()
    assert lib.adrf6755_plan_tol(ctypes.c_uint32(40_000_000), ctypes.c_uint32(5),
                                 ctypes.c_uint64(1_279_000_000), ctypes.byref(p))
    assert p.pfd_hz == 20_000_000 and p.r_half and p.r == 1 and p.r_enable
    assert 40_000_000 * (1 + 5e-6) / 2 <= 40e6
    lo = Fraction(p.pfd_hz) * (p.intg + Fraction(p.frac, 1 << 25))
    assert abs(lo - 1_279_000_000) < 1 and p.intg == 63
    assert p.bscdiv == 50, "autocal 70 us at 20 MHz (Equation 3)"
    r = regs_of(aseq(p))
    assert r[13] == 0xA8 and r[10] & 0x40 and r[5] & 0x10, "2048-cycle LDET count, R/2 selected and enabled"
    q = APlan()                                               # a 38.4 MHz TCXO keeps its full PFD
    assert lib.adrf6755_plan_tol(ctypes.c_uint32(38_400_000), ctypes.c_uint32(5),
                                 ctypes.c_uint64(1_279_000_000), ctypes.byref(q)) and q.pfd_hz == 38_400_000


def test_adrf6755_init_sequence_order():
    """Step order of the Suggested Power-Up Sequence: every writable register,
    CR0 after all the other double-buffered ones, CR27 last, modulator off."""
    seq = aseq(aplan(40_000_000, 1_279_000_000), atten=35)
    regs_written = [r for r, _ in seq]
    assert regs_written[:2] == [30, 29] and seq[1][1] == 0x80, "attenuator, then modulator off"
    assert set(regs_written) == set(range(31)), "all writable registers CR0-CR30"
    assert regs_written[-2:] == [0, 27], "CR0 then CR27 last"
    assert seq[0][1] == 0x33, "35 dB -> 0b110011 (Table 27)"
    assert regs_of(seq)[3] & 0xFE == 0x04, "CR3 = 0000010x"
    for r in (1, 2, 3, 5, 6, 7, 9, 10, 28):                    # double-buffered: before CR0
        assert regs_written.index(r) < regs_written.index(0)


def test_adrf6755_reference_division():
    p = aplan(80_000_000, 1_279_000_000)                      # even: ÷2 path, R = 1
    assert (p.pfd_hz, p.r_half, p.r, p.r_enable) == (40_000_000, True, 1, True)
    p = aplan(100_000_000, 1_279_000_000)                     # 100/3 = 33.3 MHz, odd: all in R
    assert (p.pfd_hz, p.r_half, p.r) == (33_333_333, False, 3)
    assert aplan(5_000_000, 1_279_000_000) is None            # REFIN below 10 MHz


class ADRF6755Model:
    """SPI port per the datasheet (Rev. B p. 27): SPI only after 3 CS pulses;
    24-bit writes D4|reg|data; reads: 16-bit D4|reg then 16-bit D5|data."""

    def __init__(self):
        self.pulses, self.regs, self.sel, self.log = 0, {}, None, []

    def cs_pulse(self, ctx, dev):
        self.pulses += 1
        return 0

    def xfer(self, ctx, dev, nbits, three_wire, wr_bits, tx, rx):
        assert self.pulses >= 3, "SPI traffic before the part was locked into SPI mode"
        assert dev == 1 and not three_wire, "ADRF6755: 4-wire on device 1"
        if nbits == 24:
            assert tx >> 16 == 0xD4, f"write command {tx >> 16:02x}"
            self.regs[(tx >> 8) & 0xFF] = tx & 0xFF
            self.log.append((tx >> 8) & 0xFF)
        elif nbits == 16 and tx >> 8 == 0xD4:
            self.sel = tx & 0xFF
        elif nbits == 16 and tx >> 8 == 0xD5:
            assert self.sel is not None, "read without selecting a register"
            if rx:
                rx[0] = self.regs.get(self.sel, 0)
        else:
            raise AssertionError(f"unexpected {nbits}-bit frame {tx:x}")
        return 0


class ADev(ctypes.Structure):
    _fields_ = [("bus", ctypes.POINTER(Bus)), ("dev", ctypes.c_int)]


def test_adrf6755_driver():
    lib = fwlib.load()
    m = ADRF6755Model()
    bus = Bus(XFER(m.xfer), PULSE(m.cs_pulse), None)
    dev = ADev(ctypes.pointer(bus), 1)
    assert lib.adrf6755_lock_spi(ctypes.byref(dev)) == 0 and m.pulses == 3
    p = aplan(40_000_000, 1_279_000_000)
    assert lib.adrf6755_init(ctypes.byref(dev), ctypes.byref(p), ctypes.c_uint8(10)) == 0
    assert m.log == [r for r, _ in aseq(p, 10)], "driver must send the planned sequence, in order"
    assert m.regs[29] == 0x80
    assert lib.adrf6755_modulator_on(ctypes.byref(dev), ctypes.c_bool(True)) == 0 and m.regs[29] == 0x81


# ---- ESP SPI backend bit packing ----------------------------------------------------
class Frame(ctypes.Structure):
    _fields_ = [("tx", ctypes.c_uint8 * 4), ("tx_bits", ctypes.c_int), ("rx_bits", ctypes.c_int)]


def pack(nbits, three_wire, wr_bits, tx):
    f = Frame()
    fwlib.load().spi_bus_pack(nbits, ctypes.c_bool(three_wire), wr_bits, ctypes.c_uint32(tx), ctypes.byref(f))
    return f


def unpack(f, rx: bytes):
    lib = fwlib.load()
    lib.spi_bus_unpack.restype = ctypes.c_uint32
    return lib.spi_bus_unpack(ctypes.byref(f), (ctypes.c_uint8 * 4)(*rx))


def test_spi_pack_ad9116():
    """3-wire: a write is all bits out; a read writes the instruction byte,
    then clocks the data byte in on the same line (Rev. F p. 34)."""
    f = pack(16, True, 16, 0x02B4)                         # write Data Control = 0xB4
    assert (bytes(f.tx[:2]), f.tx_bits, f.rx_bits) == (b"\x02\xb4", 16, 0)
    f = pack(16, True, 8, 0x8200)                          # read 0x02
    assert (f.tx[0], f.tx_bits, f.rx_bits) == (0x82, 8, 8)
    assert unpack(f, b"\xb4\x00\x00\x00") == 0xB4
    f = pack(24, True, 8, 0xA20000)                        # 2-byte read
    assert (f.tx[0], f.tx_bits, f.rx_bits) == (0xA2, 8, 16)
    assert unpack(f, b"\xb4\x40\x00\x00") == 0xB440


def test_spi_pack_adrf6755():
    """4-wire full duplex: 24-bit D4|reg|data writes; the D5 read's data is
    the last 8 of 16 bits clocked in on SDO (Rev. B p. 27)."""
    f = pack(24, False, 0, 0xD41C08)
    assert (bytes(f.tx[:3]), f.tx_bits, f.rx_bits) == (b"\xd4\x1c\x08", 24, 24)
    f = pack(16, False, 0, 0xD500)
    assert bytes(f.tx[:2]) == b"\xd5\x00"
    assert unpack(f, b"\x00\x1f\x00\x00") & 0xFF == 0x1F


@pytest.mark.parametrize("nbits", [1, 5, 8, 13, 24, 32])
def test_spi_pack_roundtrip(nbits):
    """Any width: the bits on the wire, MSB first, are exactly the low nbits of tx."""
    rng = random.Random(nbits)
    for _ in range(50):
        tx = rng.getrandbits(nbits)
        f = pack(nbits, False, 0, tx)
        wire = "".join(f"{b:08b}" for b in bytes(f.tx))[:nbits]
        assert wire == f"{tx:0{nbits}b}"
        assert unpack(f, bytes(f.tx)) == tx                 # loopback

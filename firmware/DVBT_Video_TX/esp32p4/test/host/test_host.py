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


class Bus(ctypes.Structure):
    _fields_ = [("xfer", XFER), ("ctx", ctypes.c_void_p)]


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
    bus = Bus(XFER(model.xfer), None)
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

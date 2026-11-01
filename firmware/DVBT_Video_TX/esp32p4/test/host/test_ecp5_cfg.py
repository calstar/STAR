"""ECP5 configuration loader (components/ecp5_cfg) against an emulated
configuration port, including every fallback to the FPGA's own flash."""
from __future__ import annotations

import ctypes
import os
import sys
import zlib
from pathlib import Path

import pytest

import fwlib

sys.path.insert(0, str(fwlib.FW / "tools"))
import make_fpga_image  # noqa: E402

ID = 0x41111043
OK, TIMEOUT, NOT_FOUND, BAD_CRC, BAD_VER, FAIL = 0, 0x107, 0x105, 0x109, 0x10A, -1


class ECP5:
    """The FPGA's configuration port as the loader must drive it."""

    def __init__(self, idcode=ID, flash_ok=True, initn_works=True, corrupt=False):
        self.idcode, self.flash_ok, self.initn_works, self.corrupt = idcode, flash_ok, initn_works, corrupt
        self.sspi = False
        self.programn = True
        self.cs = False
        self.initn = self.done = False
        self.state = "idle"
        self.frame = bytearray()
        self.burst = bytearray()
        self.loaded = None
        self.log = []

    # HAL callbacks
    def set_cfg_sspi(self, ctx, sspi):
        self.sspi = bool(sspi)

    def set_programn(self, ctx, high):
        if self.programn and not high:            # falling edge: clear the FPGA
            self.initn = self.done = False
            self.state = "reset"
            self.burst = bytearray()
            self.loaded = None
        if not self.programn and high:            # rising edge: start configuration
            if self.sspi:
                self.initn = self.initn_works
                self.state = "wait_cmd"
            else:                                 # master SPI: boot from the W25Q32
                self.initn = True
                self.done = self.flash_ok
                self.state = "flash" if self.flash_ok else "flash_failed"
                self.log.append("flash_boot")
        self.programn = bool(high)

    def get_initn(self, ctx):
        return self.initn

    def get_done(self, ctx):
        return self.done

    def set_cs(self, ctx, low):
        if low and not self.cs:
            self.frame = bytearray()
        if not low and self.cs:
            self.end_frame()
        self.cs = bool(low)

    def spi(self, ctx, tx, rx, n):
        assert self.cs, "SPI bytes with SN high"
        assert self.sspi, "slave-SPI traffic while CFG selects master SPI"
        data = bytes(tx[:n])
        start = len(self.frame)
        self.frame += data
        if rx:
            out = self.respond(start, n)
            for i, b in enumerate(out):
                rx[i] = b
        return 0

    def respond(self, start, n):
        f = bytes(self.frame[:4]) if len(self.frame) >= 4 else b""
        payload = bytearray(n)
        if f[:1] == b"\xE0":
            val = self.idcode.to_bytes(4, "big")
        elif f[:1] == b"\x3C":
            st = (1 << 8 if self.done else 0) | (1 << 9 if self.state == "enabled" else 0)
            val = st.to_bytes(4, "big")
        else:
            return payload
        for i in range(n):
            k = start + i - 4
            if 0 <= k < 4:
                payload[i] = val[k]
        return payload

    def end_frame(self):
        f = bytes(self.frame)
        if not f:
            return
        op = f[0]
        self.log.append(f"{op:02X}")
        if self.state not in ("wait_cmd", "enabled", "erased", "crc", "loaded"):
            raise AssertionError(f"command {op:02X} before PROGRAMN/INITN")
        if op == 0xC6:
            assert f[1:4] == b"\0\0\0"
            self.state = "enabled"
        elif op == 0x0E:
            assert self.state == "enabled", "erase before ISC_ENABLE"
            assert f[1:4] == b"\x01\0\0", "ECP5 SRAM erase operand"
            self.state = "erased"
        elif op == 0x3B:
            assert self.state == "erased"
            self.state = "crc"
        elif op == 0x7A:
            assert self.state == "crc", "bitstream burst before enable/erase/CRC reset"
            self.loaded = f[4:]
            self.state = "loaded"
        elif op == 0x26:
            assert self.state == "loaded", "ISC_DISABLE without a burst"
            good = self.loaded == self.expected and not self.corrupt
            self.done = good
            self.state = "wait_cmd"
        elif op in (0xE0, 0x3C, 0xFF):
            pass
        else:
            raise AssertionError(f"unexpected opcode {op:02X}")


HAL_FIELDS = [
    ("ctx", ctypes.c_void_p),
    ("set_cfg_sspi", ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_bool)),
    ("set_programn", ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_bool)),
    ("get_initn", ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_void_p)),
    ("get_done", ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_void_p)),
    ("set_cs", ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_bool)),
    ("spi", ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8),
                             ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t)),
    ("read", ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t,
                              ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t)),
    ("delay_us", ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_uint32)),
]


class Hal(ctypes.Structure):
    _fields_ = HAL_FIELDS


class Result(ctypes.Structure):
    _fields_ = [("via", ctypes.c_int), ("sspi_err", ctypes.c_int), ("idcode", ctypes.c_uint32),
                ("status", ctypes.c_uint32)]


def run(fpga: ECP5, part: bytes, part_size=0x100000):
    lib = fwlib.load()
    keep = []

    def cb(i, fn):
        f = HAL_FIELDS[i][1](fn)
        keep.append(f)
        return f

    def spi(ctx, tx, rx, n):
        return fpga.spi(ctx, tx, rx if rx else None, n)

    def read(ctx, off, buf, n):
        chunk = part[off:off + n]
        if len(chunk) < n:
            chunk = chunk + b"\xff" * (n - len(chunk))
        ctypes.memmove(buf, chunk, n)
        return 0

    h = Hal(None, cb(1, fpga.set_cfg_sspi), cb(2, fpga.set_programn), cb(3, fpga.get_initn),
            cb(4, fpga.get_done), cb(5, fpga.set_cs), cb(6, spi), cb(7, read), cb(8, lambda c, us: None))
    res = Result()
    rc = lib.ecp5_configure(ctypes.byref(h), ctypes.c_size_t(part_size), ctypes.byref(res))
    return rc, res


BIT = bytes([0xFF, 0x00]) + b"Lattice ECP5 test bitstream" + os.urandom(5000)


def test_loads_over_slave_spi():
    f = ECP5()
    f.expected = BIT
    rc, res = run(f, make_fpga_image.make(BIT))
    assert rc == OK and res.via == 1 and res.sspi_err == OK, (rc, res.via, res.sspi_err)
    assert f.loaded == BIT, "bitstream not delivered intact"
    assert f.log[:6] == ["E0", "C6", "0E", "3B", "7A", "26"], f.log
    assert "flash_boot" not in f.log
    assert res.idcode == ID and res.status & (1 << 8)
    assert not f.sspi, "CFG must be released to the straps afterwards"


def test_empty_partition_boots_from_flash():
    f = ECP5()
    f.expected = BIT
    rc, res = run(f, b"\xff" * 64)
    assert rc == OK and res.via == 2 and res.sspi_err == NOT_FOUND
    assert f.log == ["flash_boot"], "must not touch the slave-SPI port without an image"


def test_corrupt_image_boots_from_flash():
    img = bytearray(make_fpga_image.make(BIT))
    img[100] ^= 0x01
    f = ECP5()
    f.expected = BIT
    rc, res = run(f, bytes(img))
    assert rc == OK and res.via == 2 and res.sspi_err == BAD_CRC
    assert f.log == ["flash_boot"]


def test_wrong_device_boots_from_flash():
    f = ECP5(idcode=0x21111043)                     # an LFE5U-12F
    f.expected = BIT
    rc, res = run(f, make_fpga_image.make(BIT))
    assert rc == OK and res.via == 2 and res.sspi_err == BAD_VER
    assert "7A" not in f.log, "no burst into the wrong part"


def test_failed_load_boots_from_flash():
    f = ECP5(corrupt=True)                          # DONE never rises
    f.expected = BIT
    rc, res = run(f, make_fpga_image.make(BIT))
    assert rc == OK and res.via == 2 and res.sspi_err == FAIL
    assert f.log[-1] == "flash_boot"


def test_initn_stuck_boots_from_flash():
    f = ECP5(initn_works=False)
    f.expected = BIT
    rc, res = run(f, make_fpga_image.make(BIT))
    assert res.via == 2 and res.sspi_err == TIMEOUT


def test_nothing_works_reports_it():
    f = ECP5(flash_ok=False)
    f.expected = BIT
    rc, res = run(f, b"\xff" * 64)
    assert rc == TIMEOUT and res.via == 0


def test_image_format():
    img = make_fpga_image.make(BIT)
    assert img[:8] == b"DVBTFPGA" and len(img) == 36 + len(BIT)
    lib = fwlib.load()
    lib.ecp5_crc32.restype = ctypes.c_uint32
    assert lib.ecp5_crc32(0, BIT, len(BIT)) == zlib.crc32(BIT) & 0xFFFFFFFF, "CRC-32 must match zlib's"

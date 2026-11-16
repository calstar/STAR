"""The SD recorder's ring (components/recorder/rec_ring.c) and the USB FPGA
updater's parser (components/fpga_update/fpga_update.c)."""
from __future__ import annotations

import ctypes
import random
import sys
import zlib

import fwlib

sys.path.insert(0, str(fwlib.FW / "tools"))
import make_fpga_image  # noqa: E402


# --------------------------------------------------------------- rec_ring --
class Ring(ctypes.Structure):
    _fields_ = [("buf", ctypes.POINTER(ctypes.c_uint8)), ("size", ctypes.c_size_t),
                ("w", ctypes.c_size_t), ("r", ctypes.c_size_t), ("dropped", ctypes.c_uint32)]


def test_ring_keeps_order_across_wrap_and_drops_whole_pushes():
    lib = fwlib.load()
    size = 188 * 7 + 100                       # not a multiple of 188: pushes wrap mid-packet
    mem = (ctypes.c_uint8 * size)()
    q = Ring()
    lib.rec_ring_init(ctypes.byref(q), mem, ctypes.c_size_t(size))
    rng = random.Random(1)
    sent, got, dropped = bytearray(), bytearray(), 0
    for n in range(400):
        k = rng.choice([1, 2])
        data = bytes(rng.randrange(256) for _ in range(188 * k))
        if lib.rec_ring_push(ctypes.byref(q), data, ctypes.c_size_t(len(data))):
            sent += data
        else:
            dropped += k
        if rng.random() < 0.6:                 # a slow card: drain some of the time
            p = ctypes.POINTER(ctypes.c_uint8)()
            m = lib.rec_ring_peek(ctypes.byref(q), ctypes.byref(p))
            m = min(m, rng.randrange(1, 600))
            got += bytes(p[:m])
            lib.rec_ring_pop(ctypes.byref(q), ctypes.c_size_t(m))
    while True:
        p = ctypes.POINTER(ctypes.c_uint8)()
        m = lib.rec_ring_peek(ctypes.byref(q), ctypes.byref(p))
        if not m:
            break
        got += bytes(p[:m])
        lib.rec_ring_pop(ctypes.byref(q), ctypes.c_size_t(m))
    assert dropped > 0, "the test never filled the ring"
    assert got == sent, "bytes reordered, duplicated or lost across the wrap"
    assert q.dropped == dropped and len(got) % 188 == 0


# ------------------------------------------------------------- fpga_update --
OK, IDLE, BUSY, DONE, ERROR = 0, 0, 1, 2, 3
ERASE = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t)
WRITE = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_uint8),
                         ctypes.c_size_t)


class Img(ctypes.Structure):
    _fields_ = [("length", ctypes.c_uint32), ("crc32", ctypes.c_uint32), ("idcode", ctypes.c_uint32)]


class Upd(ctypes.Structure):
    _fields_ = [("erase", ERASE), ("write", WRITE), ("ctx", ctypes.c_void_p), ("part_size", ctypes.c_size_t),
                ("hdr", ctypes.c_uint8 * 36), ("hn", ctypes.c_size_t), ("off", ctypes.c_size_t),
                ("img", Img), ("crc", ctypes.c_uint32), ("state", ctypes.c_int)]


class Flash:
    def __init__(self, size=0x100000):
        self.mem = bytearray(b"\xff" * size)
        self.erases = []

    def erase(self, ctx, n):
        self.erases.append(n)
        self.mem[:n] = b"\xff" * n
        return 0

    def write(self, ctx, off, p, n):
        chunk = bytes(p[:n])
        assert all(b == 0xFF for b in self.mem[off:off + n]), "write over unerased flash"
        self.mem[off:off + n] = chunk
        return 0


def feed(stream: bytes, flash: Flash, chunk=37):
    lib = fwlib.load()
    lib.fpga_update_feed.restype = ctypes.c_int
    e, w = ERASE(flash.erase), WRITE(flash.write)
    u = Upd(e, w, None, len(flash.mem))
    lib.fpga_update_init(ctypes.byref(u))
    out = []
    for i in range(0, len(stream), chunk):
        msg = ctypes.c_char_p()
        b = stream[i:i + chunk]
        out.append((lib.fpga_update_feed(ctypes.byref(u), b, ctypes.c_size_t(len(b)), ctypes.byref(msg)),
                    msg.value))
    return out


def loads(flash: Flash, part_size=0x100000) -> bool:
    """What the loader at boot will make of the partition."""
    lib = fwlib.load()
    img = Img()
    return bool(lib.ecp5_image_parse(bytes(flash.mem[:36]), ctypes.c_size_t(part_size), ctypes.byref(img))) and \
        zlib.crc32(bytes(flash.mem[36:36 + img.length])) & 0xFFFFFFFF == img.crc32


BIT = random.Random(3).randbytes(20000)


def test_update_writes_the_image_with_noise_before_it():
    f = Flash()
    res = feed(b"log line\r\nDVBT junk DVBTFP" + make_fpga_image.make(BIT), f)
    assert res[-1][0] == DONE and all(s != ERROR for s, _ in res), res[-3:]
    assert bytes(f.mem[:36 + len(BIT)]) == make_fpga_image.make(BIT)
    assert loads(f)


def test_corrupted_transfer_is_rejected_and_never_loads():
    img = bytearray(make_fpga_image.make(BIT))
    img[36 + 1234] ^= 0x01
    f = Flash()
    res = feed(bytes(img), f)
    assert res[-1][0] == ERROR and b"CRC" in res[-1][1]
    assert not loads(f), "a damaged image must fail the boot-time check (W25Q32 fallback)"


def test_cut_short_never_loads():
    f = Flash()
    res = feed(make_fpga_image.make(BIT)[:5000], f)
    assert res[-1][0] == BUSY
    assert not loads(f)


def test_wrong_fpga_and_oversize_refused_without_erasing():
    f = Flash()
    res = feed(make_fpga_image.make(BIT, idcode=0x21111043), f)
    assert any(s == ERROR and b"idcode" in m for s, m in res) and not f.erases
    f = Flash(size=4096)
    res = feed(make_fpga_image.make(BIT), f)
    assert any(s == ERROR and b"header" in m for s, m in res) and not f.erases

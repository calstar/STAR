#!/usr/bin/env python3
"""Wrap an ecppack .bit file as the image the firmware loads into the FPGA
(components/ecp5_cfg): "DVBTFPGA" | version 1 | length | CRC-32 | idcode |
12 reserved bytes, then the bitstream.

    tools/make_fpga_image.py ../gateware/build/dvbt_tx_top/dvbt_tx.bit build/fpga.img
    esptool.py --chip esp32p4 write_flash 0x310000 build/fpga.img   # the "fpga" partition

The same .bit, written raw at offset 0 of the W25Q32, is the fallback image
the FPGA boots from by itself.
"""
import struct
import sys
import zlib

IDCODE_LFE5U_25F = 0x41111043


def make(bit: bytes, idcode: int = IDCODE_LFE5U_25F) -> bytes:
    hdr = b"DVBTFPGA" + struct.pack("<IIII", 1, len(bit), zlib.crc32(bit) & 0xFFFFFFFF, idcode) + bytes(12)
    assert len(hdr) == 36
    return hdr + bit


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    data = open(src, "rb").read()
    open(dst, "wb").write(make(data))
    print(f"{dst}: {len(data)} bytes of bitstream, crc32 {zlib.crc32(data) & 0xFFFFFFFF:08x}")

"""Decode an SD NAND backup-log image (layout: sdlog_core.h)."""
import struct
import sys
import zlib

SUPER_MAGIC = 0x31445353
BLOCK_MAGIC = 0x314C4453
BS = 512
PAYLOAD = BS - 20 - 4
MAX_BURST = 8


def crc32(data):
    return zlib.crc32(data) & 0xFFFFFFFF


def read_image(path, data_start=None):
    """Returns (records, problems, blocks); a record is
    (session, block, type, t_ms, data)."""
    with open(path, "rb") as f:
        img = f.read()
    if len(img) < BS:
        return [], ["file too small"], 0
    s = img[:BS]
    magic, _version, epoch, start, _capacity = struct.unpack_from("<5I", s)
    if magic != SUPER_MAGIC or struct.unpack_from("<I", s, 508)[0] != crc32(s[:508]):
        return [], ["superblock invalid"], 0
    if data_start is not None:
        start = data_start

    def block(k):
        b = img[(start + k) * BS:(start + k + 1) * BS]
        ok = (len(b) == BS
              and struct.unpack_from("<3I", b) == (BLOCK_MAGIC, epoch, k)
              and struct.unpack_from("<H", b, 18)[0] <= PAYLOAD
              and struct.unpack_from("<I", b, 508)[0] == crc32(b[:508]))
        return b if ok else None

    records, problems, k, nblocks = [], [], 0, 0
    while True:
        b = block(k)
        if b is None:  # the end, or a hole a torn burst left
            later = next((j for j in range(k + 1, k + MAX_BURST) if block(j)), None)
            if later is None:
                break
            problems.append(f"blocks {k}..{later - 1} missing")
            k, b = later, block(later)
        session = struct.unpack_from("<I", b, 12)[0]
        used = struct.unpack_from("<H", b, 18)[0]
        o = 0
        while o + 6 <= used:
            rtype, rlen, t_ms = struct.unpack_from("<BBI", b, 20 + o)
            if o + 6 + rlen > used:
                problems.append(f"block {k}: record at {o} overruns")
                break
            records.append((session, k, rtype, t_ms, b[26 + o:26 + o + rlen]))
            o += 6 + rlen
        nblocks += 1
        k += 1
    return records, problems, nblocks


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 sdlog_read.py sd_image.bin")
        sys.exit(1)
    records, problems, nblocks = read_image(sys.argv[1])
    for session, k, rtype, t_ms, data in records:
        print(f"{session} {k} 0x{rtype:02X} {t_ms} {data.hex()}")
    print(f"{nblocks} blocks, {len(records)} records")
    for p in problems:
        print(f"PROBLEM: {p}")
    sys.exit(1 if problems else 0)

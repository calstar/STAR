"""Tests for sdlog_read.py: synthetic images built here, plus the image the C
end-to-end test wrote (SDLOG_E2E_IMAGE, set by run_tests.sh)."""
import os
import struct
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sdlog_read  # noqa: E402

BS, START, EPOCH = 512, 64, 7


def sealed(b):
    return b[:508] + struct.pack("<I", zlib.crc32(b[:508]) & 0xFFFFFFFF)


def superblock():
    return sealed(struct.pack("<5I", 0x31445353, 1, EPOCH, START, 1024).ljust(BS, b"\0"))


def log_block(k, records, session=1, used=None):
    payload = b"".join(struct.pack("<BBI", t, len(d), ms) + d for t, ms, d in records)
    head = struct.pack("<4IBBH", 0x314C4453, EPOCH, k, session, 1, 0,
                       len(payload) if used is None else used)
    return sealed((head + payload).ljust(BS, b"\0"))


def image(blocks):
    img = bytearray(superblock().ljust(START * BS, b"\0"))
    for b in blocks:
        img += b
    return bytes(img + bytes(16 * BS))


class ReadImage(unittest.TestCase):
    def read(self, data):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(data)
        try:
            return sdlog_read.read_image(f.name)
        finally:
            os.unlink(f.name)

    def test_records_in_order(self):
        recs, problems, n = self.read(image([
            log_block(0, [(0x01, 5, b"\x02"), (0x12, 6, b"abc")]),
            log_block(1, [(0x13, 7, b"")], session=2)]))
        self.assertEqual(problems, [])
        self.assertEqual(n, 2)
        self.assertEqual(recs, [(1, 0, 0x01, 5, b"\x02"), (1, 0, 0x12, 6, b"abc"),
                                (2, 1, 0x13, 7, b"")])

    def test_hole_from_a_torn_burst_is_skipped_and_reported(self):
        bad = bytearray(log_block(1, [(0x12, 2, b"")]))
        bad[30] ^= 1
        recs, problems, n = self.read(image([
            log_block(0, [(0x12, 1, b"")]), bytes(bad), log_block(2, [(0x12, 3, b"")])]))
        self.assertEqual([r[3] for r in recs], [1, 3])
        self.assertEqual(problems, ["blocks 1..1 missing"])
        self.assertEqual(n, 2)

    def test_stale_epoch_ends_the_log(self):
        old = bytearray(log_block(1, [(0x12, 2, b"")]))
        old[4] = EPOCH - 1
        recs, problems, _ = self.read(image([log_block(0, [(0x12, 1, b"")]), sealed(bytes(old))]))
        self.assertEqual((len(recs), problems), (1, []))

    def test_record_overrunning_used_is_reported(self):
        recs, problems, _ = self.read(image([log_block(0, [(0x12, 1, b"abcd")], used=8)]))
        self.assertEqual(recs, [])
        self.assertEqual(problems, ["block 0: record at 0 overruns"])

    def test_bad_superblock_and_short_file(self):
        img = bytearray(image([log_block(0, [(0x12, 1, b"")])]))
        img[20] ^= 1
        self.assertEqual(self.read(bytes(img)), ([], ["superblock invalid"], 0))
        self.assertEqual(self.read(b"\0" * 100), ([], ["file too small"], 0))

    @unittest.skipUnless(os.environ.get("SDLOG_E2E_IMAGE"), "run via run_tests.sh")
    def test_image_written_by_the_c_log(self):
        recs, problems, _ = sdlog_read.read_image(os.environ["SDLOG_E2E_IMAGE"])
        self.assertEqual(problems, [])
        s1 = [r for r in recs if r[0] == 1]
        s2 = [r for r in recs if r[0] == 2]
        self.assertEqual([r[2] for r in s1], [0x01] + [0x13] * 60 + [0x03])
        self.assertEqual([r[2] for r in s2], [0x01] + [0x12] * 10 + [0x03])
        for i, r in enumerate(s1[1:-1]):
            self.assertEqual((r[3], r[4]), (i, bytes([i]) * 49))
        self.assertEqual([r[3] for r in s2[1:-1]], list(range(1000, 1010)))


if __name__ == "__main__":
    unittest.main()

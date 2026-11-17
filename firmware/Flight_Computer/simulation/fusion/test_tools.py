import os
import subprocess
import struct
import tempfile
import unittest
from pathlib import Path
import zlib
from extract_log import extract
from replay_csv import convert
from reference import BARO, IMU, HIGHG, HIGHG_UNALIGNED, HIGH_G, FORMATS, OUTPUT, Filter
import numpy as np


class LogTests(unittest.TestCase):
    def block(self):
        b = bytearray(512)
        payload = struct.pack(FORMATS[BARO], 1000, 2000, 101325)
        record = struct.pack("<BBI", BARO, len(payload), 1) + payload
        struct.pack_into("<IIIIBBH", b, 0, 0x31474C53, 2, 91, 3, 1, 0, len(record))
        b[20 : 20 + len(record)] = record
        struct.pack_into("<I", b, 508, zlib.crc32(b[:508]))
        return b, payload

    def test_roundtrip_and_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "flight.slg"
            out = Path(tmp) / "records.bin"
            b, payload = self.block()
            source.write_bytes(b)
            self.assertEqual(extract(source, out), 1)
            self.assertEqual(out.read_bytes(), bytes([BARO, len(payload)]) + payload)
            b[30] ^= 1
            source.write_bytes(b)
            with self.assertRaisesRegex(ValueError, "CRC"):
                extract(source, out)

    def test_truncated_and_reordered(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "flight.slg"
            out = Path(tmp) / "records.bin"
            b, _ = self.block()
            source.write_bytes(b[:-1])
            with self.assertRaisesRegex(ValueError, "truncated"):
                extract(source, out)
            source.write_bytes(b + b)
            with self.assertRaisesRegex(ValueError, "reordered"):
                extract(source, out)

    @unittest.skipUnless(
        os.environ.get("FUSION_C_REPLAY"), "set FUSION_C_REPLAY to test CLI"
    )
    def test_replay_mounting_and_argument_validation(self):
        executable = os.environ["FUSION_C_REPLAY"]
        records = []
        for i in range(600):
            t = i * 1200
            if i % 16 == 0:
                records.append((BARO, struct.pack(FORMATS[BARO], t, 2000, 101325)))
            records.append((HIGHG, struct.pack(FORMATS[HIGHG], t, 5, -4, 26)))
            records.append(
                (
                    IMU,
                    struct.pack(
                        FORMATS[IMU], t, 0, 0, 0, 0, 0, 0, 2049 if i < 512 else 32767
                    ),
                )
            )
        with tempfile.TemporaryDirectory() as tmp:
            source, out = Path(tmp) / "input.bin", Path(tmp) / "output.bin"
            source.write_bytes(b"".join(bytes([k, len(p)]) + p for k, p in records))
            for axes in [None, (1, 2, 3), (-2, 1, 3)]:
                args = [] if axes is None else list(map(str, axes))
                subprocess.run(
                    [executable, str(source), str(out), "16", "4000", *args],
                    check=True,
                    capture_output=True,
                )
                f = Filter(highg_axes=axes)
                expected = np.array(
                    [r for k, p in records if (r := f.feed(k, p)) is not None]
                )
                actual = np.array(list(struct.iter_unpack(OUTPUT, out.read_bytes())))
                self.assertGreater(len(actual), 0)
                np.testing.assert_array_equal(
                    actual[:, [0, 11, 12]], expected[:, [0, 11, 12]]
                )
                np.testing.assert_allclose(
                    actual[:, 1:11], expected[:, 1:11], atol=0.002, rtol=0.001
                )
                flags = int(actual[-1, 11])
                self.assertEqual(bool(flags & HIGHG_UNALIGNED), axes is None)
                self.assertEqual(bool(flags & HIGH_G), axes is not None)
            for args in [
                ["16", "4000", "1", "1", "3"],
                ["16", "4000", "257", "2", "3"],
                ["16x", "4000"],
                ["3", "4000"],
                [],
            ]:
                result = subprocess.run(
                    [executable, str(source), str(out), *args], capture_output=True
                )
                self.assertEqual(result.returncode, 2)

    def test_local_captures_are_not_upsampled(self):
        for name, expected in [("flight-data.csv", 84), ("flight-data2.csv", 102)]:
            path = Path(__file__).parent / "data" / name
            records = convert(path)
            self.assertEqual(len(records), expected)
            f = Filter()
            outputs = [r for k, p in records if (r := f.feed(k, p)) is not None]
            self.assertEqual(outputs, [])


if __name__ == "__main__":
    unittest.main()

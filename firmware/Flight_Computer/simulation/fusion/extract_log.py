"""Validate GUI flight.slg blocks and extract original records for C replay."""

import argparse
from pathlib import Path
import struct
import zlib
from reference import FORMATS


def extract(source, destination):
    count = 0
    epoch = None
    session = None
    sequence = None
    with source.open("rb") as f, destination.open("wb") as out:
        while True:
            block = f.read(512)
            if not block:
                break
            if len(block) != 512:
                raise ValueError("truncated 512-byte log block")
            magic, e, seq, s, kind, _, used = struct.unpack_from("<IIIIBBH", block)
            crc = struct.unpack_from("<I", block, 508)[0]
            if magic != 0x31474C53 or zlib.crc32(block[:508]) != crc:
                raise ValueError("bad log magic or CRC")
            if epoch is None:
                epoch, session, sequence = e, s, seq
            if e != epoch or s != session or seq != sequence:
                raise ValueError("mixed session/epoch or missing/reordered blocks")
            sequence += 1
            if used > 488 or kind not in (1, 2):
                raise ValueError("invalid block header")
            if kind == 2:
                continue
            offset = 20
            end = 20 + used
            while offset < end:
                if offset + 6 > end:
                    raise ValueError("truncated record header")
                k, n, _ = struct.unpack_from("<BBI", block, offset)
                offset += 6
                if offset + n > end:
                    raise ValueError("truncated record payload")
                if k in FORMATS:
                    if n != struct.calcsize(FORMATS[k]):
                        raise ValueError("unexpected sensor record size")
                    out.write(bytes([k, n]) + block[offset : offset + n])
                    count += 1
                offset += n
    if not count:
        raise ValueError("no sensor records")
    return count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("flight_slg", type=Path)
    ap.add_argument("records_bin", type=Path)
    a = ap.parse_args()
    try:
        print(
            f"{extract(a.flight_slg,a.records_bin)} original sensor records extracted"
        )
    except ValueError as e:
        a.records_bin.unlink(missing_ok=True)
        raise SystemExit(str(e))


if __name__ == "__main__":
    main()

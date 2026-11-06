"""Channel switching, host side: the flight computer's UART protocol
(fc_link) and a PLL plan for every channel in the band. The switch itself,
end to end, is test/e2e's test_hop_*."""
from __future__ import annotations

import ctypes

import pytest

import fwlib
from test_host import APlan


FC_HOP, FC_QUERY, FC_BAD_CSUM, FC_BAD_SYNTAX = range(4)


class FcCmd(ctypes.Structure):
    _fields_ = [("kind", ctypes.c_int), ("seq", ctypes.c_uint16), ("khz", ctypes.c_uint32)]


class FcRx(ctypes.Structure):
    _fields_ = [("buf", ctypes.c_char * 96), ("n", ctypes.c_size_t), ("in_line", ctypes.c_bool),
                ("overflow", ctypes.c_bool)]


def line(body: str) -> bytes:
    cs = 0
    for c in body.encode():
        cs ^= c
    return f"${body}*{cs:02X}\r\n".encode()


def feed(data: bytes, rx: FcRx | None = None) -> list[tuple[int, int, int]]:
    lib = fwlib.load()
    rx = rx or FcRx()
    out = []
    for b in data:
        c = FcCmd()
        if lib.fc_rx_byte(ctypes.byref(rx), ctypes.c_uint8(b), ctypes.byref(c)):
            out.append((c.kind, c.seq, c.khz))
    return out


# ------------------------------------------------------------ fc_link --
def test_fc_hop_and_query():
    assert feed(line("HOP,7,1255000")) == [(FC_HOP, 7, 1255000)]
    assert feed(line("CH?")) == [(FC_QUERY, 0, 0)]
    # Lower-case checksum, no CR, two lines back to back, noise between them.
    lo = line("HOP,65535,1296500").replace(b"\r", b"").lower().replace(b"$hop", b"$HOP")
    assert feed(b"\x00junk" + lo + b"noise" + line("CH?")) == [(FC_HOP, 65535, 1296500), (FC_QUERY, 0, 0)]


@pytest.mark.parametrize("raw,kind", [
    (b"$HOP,7,1255000*00\r\n", FC_BAD_CSUM),          # wrong checksum
    (b"$HOP,7,1255000\r\n", FC_BAD_CSUM),             # none at all
    (line("HOP,7,1255000").replace(b"1255000", b"1255001"), FC_BAD_CSUM),   # a flipped digit
    (line("HOP,65536,1255000"), FC_BAD_SYNTAX),       # seq above 16 bits
    (line("HOP,7,12x5000"), FC_BAD_SYNTAX),
    (line("HOP,7,"), FC_BAD_SYNTAX),
    (line("HOP,,1255000"), FC_BAD_SYNTAX),
    (line("HOP,7,1255000,9"), FC_BAD_SYNTAX),         # extra field
    (line("HOP 7 1255000"), FC_BAD_SYNTAX),
    (line("RESET"), FC_BAD_SYNTAX),
    (b"$" + b"A" * 200 + b"*00\r\n", FC_BAD_SYNTAX),  # longer than any command
])
def test_fc_rejects(raw, kind):
    got = feed(raw)
    assert len(got) == 1 and got[0][0] == kind, got


def test_fc_dollar_restarts_a_line():
    """A line cut off by a reset of the flight computer, then a whole one:
    the whole one is read, the fragment is not."""
    assert feed(b"$HOP,1,12" + line("HOP,2,1260000")) == [(FC_HOP, 2, 1260000)]


def test_fc_format_round_trips():
    lib = fwlib.load()
    buf = ctypes.create_string_buffer(120)
    n = lib.fc_format(buf, 120, b"DONE,7,1255000,OK")
    assert buf.value == line("DONE,7,1255000,OK") and n == len(buf.value)
    assert lib.fc_format(buf, 10, b"DONE,7,1255000,OK") == 0      # does not fit: nothing


# --------------------------------------------------------- PLL plans --
def test_every_channel_in_the_band_has_a_plan():
    """Every 125 kHz from 1243.5 to 1296.5 MHz, from the 40 MHz TCXO at its
    5 ppm (the flight configuration): a plan, within 1 Hz, PFD <= 40 MHz at
    the fast end, VCO inside 2310-4800 MHz, RFDIV 0 (Table 6)."""
    lib = fwlib.load()
    for khz in range(1243500, 1296501, 125):
        p = APlan()
        assert lib.adrf6755_plan_tol(ctypes.c_uint32(40_000_000), ctypes.c_uint32(5), ctypes.c_uint64(khz * 1000),
                                     ctypes.byref(p)), khz
        assert abs(p.lo_hz - khz * 1e3) < 1.0, (khz, p.lo_hz)
        assert p.pfd_hz * (1 + 5e-6) <= 40e6
        assert 2310e6 <= p.lo_hz * 2 * (1 << p.rfdiv) <= 4800e6 and p.rfdiv == 0

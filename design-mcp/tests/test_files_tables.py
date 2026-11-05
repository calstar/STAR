"""Links, the size cap, tables and downsampling."""

from __future__ import annotations

import numpy as np

from star_design_mcp.data import compact, downsample
from star_design_mcp.files import FileStore
from star_design_mcp.tables import from_unit_csv


def _store(tmp_path, clock=None, max_bytes=10_000_000):
    return FileStore(
        tmp_path,
        key=b"k" * 40,
        public_url="https://mcp.example.org",
        max_bytes=max_bytes,
        ttl_s=900,
        **({"clock": clock} if clock else {}),
    )


def test_a_link_opens_its_file_and_names_who_it_was_issued_to(tmp_path):
    fs = _store(tmp_path)
    stored = fs.put_bytes(b"hello", "x.txt", "text/plain")
    link = fs.link(stored, "alice@berkeley.edu")
    token = link["url"].rsplit("/", 1)[1]
    path, claims = fs.open_link(token)
    assert path.read_bytes() == b"hello"
    assert claims["u"] == "alice@berkeley.edu"
    assert link["size"] == 5


def test_a_tampered_or_expired_link_is_refused(tmp_path):
    now = [1000.0]
    fs = _store(tmp_path, clock=lambda: now[0])
    token = fs.link(fs.put_bytes(b"a", "a", "text/plain"), "a@b.edu")["url"].rsplit("/", 1)[1]
    payload, sig = token.split(".")
    assert fs.open_link(payload + "." + sig[:-2] + "AA") == "invalid link"
    # Re-signing someone else's payload needs the key; editing the payload breaks the signature.
    assert fs.open_link(payload[:-2] + "xx." + sig) == "invalid link"
    now[0] += 901
    assert fs.open_link(token) == "link expired"


def test_the_cache_evicts_oldest_first_past_its_cap(tmp_path):
    fs = _store(tmp_path, max_bytes=2500)
    first = fs.put_bytes(b"a" * 1000, "a", "x")
    import os
    import time

    os.utime(fs.path_of(first), (time.time() - 100, time.time() - 100))
    fs.put_bytes(b"b" * 1000, "b", "x")
    fs.put_bytes(b"c" * 1000, "c", "x")
    assert fs.path_of(first) is None


def test_memo_keys_are_per_person(tmp_path):
    assert FileStore.memo_key("a@b.edu", "x", 1) != FileStore.memo_key("c@d.edu", "x", 1)


def test_downsample_keeps_a_one_sample_spike():
    t = np.arange(100_000, dtype=float)
    y = np.zeros_like(t)
    y[54_321] = 9.0  # an ignition spike between any every-Nth stride
    ts, ys = downsample(t, y, 200)
    assert len(ts) <= 200
    assert ys.max() == 9.0


def test_compact_summarizes_long_arrays_and_keeps_short_ones():
    out = compact({"short": [1, 2], "long": list(range(1000)), "nested": {"s": "x" * 5000}})
    assert out["short"] == [1, 2]
    assert out["long"] == {"_list_of": 1000, "min": 0.0, "max": 999.0, "first": 0, "last": 999}
    assert len(out["nested"]["s"]) < 2000


def test_layerx_csv_reads_with_units_and_blank_cells():
    table = from_unit_csv("t [s],pc [psia],firing [-]\n0.0,14.7,0\n0.1,,1\n0.2,300.5,1\n")
    assert table.units == {"t": "s", "pc": "psia", "firing": "-"}
    assert np.isnan(table.columns["pc"][1])
    assert table.columns["pc"][2] == 300.5

"""The port against OpenRocket itself, when somebody has exported a run.

Every other test of `physics/openrocket.py` compares it against source that was
*read*. This compares it against the program that was *run*, which is the only
check that can catch a misreading rather than a mistranscription.

It **skips** when no golden CSV is committed, so the suite is green before
anyone has produced one and starts enforcing the moment somebody does. See
`tools/openrocket-golden/README.md` for how to make one.

The parser tests below do not skip: they run against a synthetic CSV, so a
regression in the reader is caught even with no golden run in the repo. That
matters because the reader is the part most likely to break silently -- an
OpenRocket version that renames a column would otherwise turn the real check
into a skip, and a skipped test looks exactly like a passing one.
"""

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOL = os.path.join(ROOT, "tools", "openrocket-golden")
GOLDEN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "openrocket")

sys.path.insert(0, TOOL)

from compare_golden import (  # noqa: E402
    COLUMNS,
    TOLERANCE,
    compare,
    interpolate,
    read_golden,
)


# --- the reader, against a synthetic export --------------------------------

SAMPLE = """\
# OpenRocket simulation export
# Rocket: worked example
# Time (s),Altitude (m),Vertical velocity (m/s),Vertical acceleration (m/s^2)
0.000,914.000,0.000,-9.796
0.500,912.775,-4.898,-9.796
1.000,909.102,-9.796,-9.795
"""

HEADER_OUTSIDE_COMMENT = """\
# OpenRocket simulation export
Time (s),Altitude (m),Vertical velocity (m/s),Vertical acceleration (m/s^2)
0.000,914.000,0.000,-9.796
0.500,912.775,-4.898,-9.796
"""


def test_reads_a_header_inside_the_comment_block(tmp_path):
    """Some OpenRocket versions prefix the header row with `#`."""
    path = tmp_path / "golden.csv"
    path.write_text(SAMPLE, encoding="utf-8")

    data = read_golden(str(path))
    assert data["t"] == [0.0, 0.5, 1.0]
    assert data["z"][0] == pytest.approx(914.0)
    assert data["v"][1] == pytest.approx(-4.898)
    assert data["a"][0] == pytest.approx(-9.796)


def test_reads_a_header_outside_the_comment_block(tmp_path):
    path = tmp_path / "golden.csv"
    path.write_text(HEADER_OUTSIDE_COMMENT, encoding="utf-8")

    data = read_golden(str(path))
    assert data["t"] == [0.0, 0.5]
    assert data["z"][1] == pytest.approx(912.775)


def test_a_missing_column_is_a_clear_error(tmp_path):
    """The failure has to name what to re-export, not just refuse.

    This is the one that keeps a renamed column from degrading the real check
    into a silent skip.
    """
    path = tmp_path / "golden.csv"
    path.write_text(
        "# Time (s),Altitude (m)\n0.0,914.0\n0.5,912.8\n", encoding="utf-8")

    with pytest.raises(SystemExit, match="Vertical velocity"):
        read_golden(str(path))


def test_trailing_junk_rows_are_dropped(tmp_path):
    """Exports sometimes end with a blank or NaN row."""
    path = tmp_path / "golden.csv"
    path.write_text(SAMPLE + ",,,\nNaN,NaN,NaN,NaN\n", encoding="utf-8")
    assert read_golden(str(path))["t"] == [0.0, 0.5, 1.0]


def test_interpolate_spans_a_ragged_grid():
    ts = [0.0, 1.0, 3.0]
    vs = [0.0, 10.0, 30.0]
    assert interpolate(ts, vs, -1.0) == 0.0     # clamped low
    assert interpolate(ts, vs, 0.5) == pytest.approx(5.0)
    assert interpolate(ts, vs, 2.0) == pytest.approx(20.0)
    assert interpolate(ts, vs, 9.0) == 30.0     # clamped high


def test_the_channel_map_covers_what_the_comparison_needs():
    assert set(COLUMNS) == {"t", "z", "v", "a"}
    assert set(TOLERANCE) == {"z", "v", "a"}
    # Acceleration is looser on purpose: OpenRocket opens a canopy between two
    # integration points, so its a(t) has a spike no finite-inflation model has.
    assert TOLERANCE["a"] > TOLERANCE["z"]


# --- the real check, when a golden run exists ------------------------------


def _golden_pairs():
    """(config, csv) pairs for every committed golden run."""
    if not os.path.isdir(GOLDEN_DIR):
        return []
    pairs = []
    for name in sorted(os.listdir(GOLDEN_DIR)):
        if not name.endswith(".csv"):
            continue
        config = os.path.join(ROOT, "tests", "fixtures",
                              name[:-4] + ".json")
        if os.path.exists(config):
            pairs.append((config, os.path.join(GOLDEN_DIR, name)))
    return pairs


@pytest.mark.parametrize("config_path, golden_path", _golden_pairs())
def test_port_reproduces_the_golden_run(config_path, golden_path):
    """The port against the program, not against the source.

    If this fails, read `tools/openrocket-golden/README.md` before assuming the
    port is wrong: the pre-deployment coast is a documented approximation and a
    mismatched vehicle in the .ork is likelier than a bug here.
    """
    deviations = compare(config_path, golden_path, verbose=False)
    for channel, worst in deviations.items():
        assert worst <= TOLERANCE[channel], (
            "%s deviates %.2f%% from the golden run (tolerance %.1f%%)"
            % (channel, 100 * worst, 100 * TOLERANCE[channel]))


def test_there_is_a_way_to_produce_a_golden_run():
    """The procedure has to stay documented, or the skip above becomes
    permanent and nobody notices the strongest check never runs."""
    readme = os.path.join(TOOL, "README.md")
    assert os.path.exists(readme)
    text = open(readme, encoding="utf-8").read()
    assert "release-24.12" in text
    assert "Air-start" in text
    if not _golden_pairs():
        pytest.skip(
            "No golden CSV committed yet — the port is validated against "
            "OpenRocket's source and its own JUnit values, but not yet "
            "against a run of the program. See %s" % readme)

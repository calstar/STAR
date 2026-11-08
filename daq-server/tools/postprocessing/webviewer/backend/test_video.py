"""Video clips on a run's timeline: listing, matching, and serving.

Run: cd webviewer && .venv/bin/python -m pytest backend/test_video.py -q
"""

import json
import struct
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from . import config, export_cache, main, video

TZ = "America/Los_Angeles"


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def mp4(seconds: float, version: int = 0, scale: int = 1000, tail: bytes = b"") -> bytes:
    """A file with just enough mp4 for a duration: ftyp, moov/mvhd, then some 'mdat'."""
    if version == 1:
        mvhd = bytes([1, 0, 0, 0]) + struct.pack(">QQIQ", 0, 0, scale, int(seconds * scale))
    else:
        mvhd = bytes([0, 0, 0, 0]) + struct.pack(">IIII", 0, 0, scale, int(seconds * scale))
    mvhd += bytes(80)  # rate, volume, matrix, ... (unread)
    return box(b"ftyp", b"isom" + bytes(4)) + box(b"moov", box(b"mvhd", mvhd)) + box(b"mdat", tail or bytes(64))


def epoch(y, mo, d, h, mi, s) -> float:
    return datetime(y, mo, d, h, mi, s, tzinfo=ZoneInfo(TZ)).timestamp()


@pytest.fixture
def rec_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "VIDEO_DIR", tmp_path)
    monkeypatch.setattr(config, "VIDEO_TZ", TZ)
    video._dur_cache.clear()
    video._timing_cache.clear()
    return tmp_path


def put(rec_dir, folder: str, stream: str, seconds: float) -> None:
    (rec_dir / folder).mkdir(exist_ok=True)
    (rec_dir / folder / f"{stream}.mp4").write_bytes(mp4(seconds))


# ── mp4 header ────────────────────────────────────────────────────────────────


def test_duration_from_mvhd_v0_and_v1(tmp_path):
    (tmp_path / "a.mp4").write_bytes(mp4(12.5))
    (tmp_path / "b.mp4").write_bytes(mp4(7.25, version=1, scale=90000))
    assert video.mp4_duration(tmp_path / "a.mp4") == pytest.approx(12.5)
    assert video.mp4_duration(tmp_path / "b.mp4") == pytest.approx(7.25)


def test_duration_none_for_unfinished_or_foreign_files(tmp_path):
    whole = mp4(10)
    (tmp_path / "cut.mp4").write_bytes(whole[:30])  # ffmpeg still writing
    (tmp_path / "text.mp4").write_bytes(b"not a movie at all")
    (tmp_path / "nomoov.mp4").write_bytes(box(b"ftyp", b"isom" + bytes(4)) + box(b"mdat", bytes(32)))
    for name in ("cut.mp4", "text.mp4", "nomoov.mp4"):
        assert video.mp4_duration(tmp_path / name) is None


def trak(handler: bytes, scale: int, dur: int, samples: int) -> bytes:
    mdhd = bytes([0, 0, 0, 0]) + struct.pack(">IIII", 0, 0, scale, dur) + bytes(4)
    hdlr = bytes(4) + bytes(4) + handler + bytes(12) + b"\0"
    stsz = bytes(4) + struct.pack(">II", 0, samples)
    stbl = box(b"stbl", box(b"stsz", stsz))
    return box(b"trak", box(b"mdia", box(b"mdhd", mdhd) + box(b"hdlr", hdlr) + box(b"minf", stbl)))


def test_frame_period_from_the_video_track(tmp_path):
    mvhd = bytes([0, 0, 0, 0]) + struct.pack(">IIII", 0, 0, 1000, 10000) + bytes(80)
    # An audio track first, so the video one has to be found, not assumed.
    moov = box(b"moov", box(b"mvhd", mvhd) + trak(b"soun", 8000, 80000, 500) + trak(b"vide", 90000, 900000, 250))
    (tmp_path / "v.mp4").write_bytes(box(b"ftyp", b"isom" + bytes(4)) + moov)
    assert video.mp4_frame_seconds(tmp_path / "v.mp4") == pytest.approx(1 / 25)
    # No video track, or no header at all: nothing to step by.
    (tmp_path / "a.mp4").write_bytes(box(b"moov", box(b"mvhd", mvhd) + trak(b"soun", 8000, 80000, 500)))
    assert video.mp4_frame_seconds(tmp_path / "a.mp4") is None
    (tmp_path / "x.mp4").write_bytes(mp4(10))
    assert video.mp4_frame_seconds(tmp_path / "x.mp4") is None


# ── Timing from the folder name ──────────────────────────────────────────────


def test_record_starts_at_its_name_save_ends_at_its_name(rec_dir):
    put(rec_dir, "2026-11-07_140322_record", "cam1", 30)
    put(rec_dir, "2026-11-07_141000_save", "cam1", 300)
    by_kind = {c.kind: c for c in video.list_clips()}
    assert by_kind["record"].start == epoch(2026, 11, 7, 14, 3, 22)
    assert by_kind["record"].end == epoch(2026, 11, 7, 14, 3, 52)
    # A Save keeps the buffer *before* the press.
    assert by_kind["save"].end == epoch(2026, 11, 7, 14, 10, 0)
    assert by_kind["save"].start == epoch(2026, 11, 7, 14, 5, 0)
    assert all(c.approx for c in by_kind.values())


def test_folder_name_is_read_in_the_gateway_zone_not_utc(rec_dir):
    put(rec_dir, "2026-07-01_120000_record", "cam1", 5)
    (clip,) = video.list_clips()
    # 12:00 PDT is 19:00 UTC.
    assert clip.start == datetime(2026, 7, 1, 19, 0, 0, tzinfo=ZoneInfo("UTC")).timestamp()


def test_listing_skips_what_is_not_a_finished_clip(rec_dir):
    put(rec_dir, "2026-11-07_140322_record", "cam1", 30)
    (rec_dir / "2026-11-07_140322_record" / ".cam2").mkdir()  # work dir mid-recording
    (rec_dir / "2026-11-07_140322_record" / "half.mp4").write_bytes(mp4(10)[:20])
    (rec_dir / "2026-11-07_140322_record" / "bad.name.mp4").write_bytes(mp4(10))
    (rec_dir / "random-folder").mkdir()
    (rec_dir / "random-folder" / "cam1.mp4").write_bytes(mp4(10))
    assert [(c.recording, c.stream) for c in video.list_clips()] == [
        ("2026-11-07_140322_record", "cam1")
    ]


def test_no_mount_means_no_clips(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "VIDEO_DIR", None)
    assert not video.available() and video.list_clips() == []
    monkeypatch.setattr(config, "VIDEO_DIR", tmp_path / "missing")
    assert not video.available() and video.list_clips() == []


# ── Timing files ─────────────────────────────────────────────────────────────


def put_timing(rec_dir, folder, stream, timing) -> None:
    (rec_dir / folder / f"{stream}.json").write_text(json.dumps(timing))


def test_timing_file_places_the_clip_exactly_and_spans_its_gap(rec_dir):
    folder = "2026-11-07_140322_record"
    put(rec_dir, folder, "cam1", 30)
    t0 = epoch(2026, 11, 7, 14, 3, 21) + 0.6  # keyframe before the press
    put_timing(rec_dir, folder, "cam1", {
        "version": 1, "durationS": 30, "latencyMs": 0,
        # 20 s of footage, a 32 s outage, then 10 s more
        "pieces": [{"fileS": 0, "wallMs": t0 * 1000}, {"fileS": 20, "wallMs": (t0 + 52) * 1000}],
    })
    (clip,) = video.list_clips()
    assert not clip.approx
    assert clip.start == pytest.approx(t0, abs=1e-3)
    assert clip.end == pytest.approx(t0 + 62, abs=1e-3)  # not t0 + 30: the gap is real time
    assert clip.as_json()["pieces"] == [
        {"fileS": 0.0, "wall": pytest.approx(t0, abs=1e-3)}, {"fileS": 20.0, "wall": pytest.approx(t0 + 52, abs=1e-3)}
    ]


def test_gateway_clock_offset_is_taken_off_so_clips_sit_on_the_daq_clock(rec_dir):
    folder = "2026-11-07_140322_record"
    put(rec_dir, folder, "cam1", 30)
    g0 = epoch(2026, 11, 7, 14, 3, 21)  # first frame, by the gateway's clock
    put_timing(rec_dir, folder, "cam1", {
        "version": 1, "durationS": 30,
        # The gateway runs 2.5 s ahead of the DAQ: its 14:03:21 is the sensors' 14:03:18.5.
        "clockOffsetMs": 2500, "clockUncertaintyMs": 3,
        "pieces": [{"fileS": 0, "wallMs": g0 * 1000}, {"fileS": 10, "wallMs": (g0 + 10) * 1000}],
    })
    (clip,) = video.list_clips()
    assert clip.start == pytest.approx(g0 - 2.5, abs=1e-3)
    assert clip.pieces[1][1] == pytest.approx(g0 + 7.5, abs=1e-3)
    assert clip.end == pytest.approx(g0 + 27.5, abs=1e-3)
    j = clip.as_json()
    assert (j["clockOffset"], j["clockUncertainty"]) == (2.5, 0.003)


def test_no_measured_offset_means_the_clocks_are_taken_as_equal(rec_dir):
    folder = "2026-11-07_140322_record"
    put(rec_dir, folder, "cam1", 30)
    g0 = epoch(2026, 11, 7, 14, 3, 21)
    put_timing(rec_dir, folder, "cam1", {"version": 1, "durationS": 30, "pieces": [{"fileS": 0, "wallMs": g0 * 1000}]})
    (clip,) = video.list_clips()
    assert clip.start == pytest.approx(g0, abs=1e-3) and clip.clock_offset is None


@pytest.mark.parametrize("bad", [
    "not json",
    {"version": 2, "durationS": 30, "pieces": [{"fileS": 0, "wallMs": 1}]},
    {"version": 1, "durationS": 30, "pieces": []},
    {"version": 1, "durationS": 30, "pieces": [{"fileS": 5, "wallMs": 1}]},
    {"version": 1, "durationS": 30, "pieces": [{"fileS": 0, "wallMs": 1}, {"fileS": 0, "wallMs": 2}]},
    {"version": 1, "durationS": 30, "pieces": [{"fileS": 0, "wallMs": 1}, {"fileS": 31, "wallMs": 2}]},
    {"version": 1, "pieces": [{"fileS": 0, "wallMs": 1}]},
])
def test_a_timing_file_that_does_not_parse_falls_back_to_the_name(rec_dir, bad):
    folder = "2026-11-07_140322_record"
    put(rec_dir, folder, "cam1", 30)
    (rec_dir / folder / "cam1.json").write_text(bad if isinstance(bad, str) else json.dumps(bad))
    (clip,) = video.list_clips()
    assert clip.approx and clip.start == epoch(2026, 11, 7, 14, 3, 22)


def test_approximate_clip_serves_one_piece(rec_dir):
    put(rec_dir, "2026-11-07_140322_record", "cam1", 30)
    (clip,) = video.list_clips()
    assert clip.as_json()["pieces"] == [{"fileS": 0.0, "wall": clip.start}]


# ── Matching a run ───────────────────────────────────────────────────────────


def test_overlap_keeps_partial_clips_and_drops_outside_ones(rec_dir):
    put(rec_dir, "2026-11-07_140000_record", "before", 10)  # 14:00:00-14:00:10
    put(rec_dir, "2026-11-07_140055_record", "straddle", 10)  # 14:00:55-14:01:05
    put(rec_dir, "2026-11-07_140130_record", "inside", 10)
    put(rec_dir, "2026-11-07_140500_save", "after-save", 60)  # 14:04:00-14:05:00
    put(rec_dir, "2026-11-07_150000_record", "later", 10)
    t0, t1 = epoch(2026, 11, 7, 14, 1, 0), epoch(2026, 11, 7, 14, 4, 30)
    got = sorted(c.stream for c in video.clips_overlapping(t0, t1))
    assert got == ["after-save", "inside", "straddle"]


# ── HTTP ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def client(rec_dir, monkeypatch):
    run = "daq_20261107_140000"
    t0, t1 = epoch(2026, 11, 7, 14, 1, 0), epoch(2026, 11, 7, 14, 4, 30)
    monkeypatch.setattr(export_cache, "is_cached", lambda r: r == run)
    monkeypatch.setattr(
        export_cache,
        "get_index",
        lambda r: {"t_min": t0, "t_max": t1, "sensor_t_min": t0 + 0.5, "sensor_t_max": t1 - 0.5},
    )
    return TestClient(main.app), run


def test_run_video_lists_overlapping_clips(client, rec_dir):
    c, run = client
    put(rec_dir, "2026-11-07_140130_record", "cam1", 10)
    put(rec_dir, "2026-11-07_150000_record", "cam1", 10)
    r = c.get(f"/api/runs/{run}/video")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    assert [(x["recording"], x["stream"]) for x in body["clips"]] == [("2026-11-07_140130_record", "cam1")]
    assert body["clips"][0]["end"] - body["clips"][0]["start"] == pytest.approx(10)


def test_run_video_without_mount_says_unavailable(client, monkeypatch):
    c, run = client
    monkeypatch.setattr(config, "VIDEO_DIR", None)
    assert c.get(f"/api/runs/{run}/video").json() == {"available": False, "clips": []}


def test_run_video_unindexed_is_409(client):
    c, _ = client
    assert c.get("/api/runs/daq_20261107_150000/video").status_code == 409


def test_clip_served_with_range(client, rec_dir):
    c, _ = client
    folder = "2026-11-07_140130_record"
    (rec_dir / folder).mkdir()
    data = mp4(10, tail=bytes(range(256)) * 40)
    (rec_dir / folder / "cam1.mp4").write_bytes(data)
    r = c.get(f"/api/video/{folder}/cam1.mp4", headers={"Range": "bytes=100-199"})
    assert r.status_code == 206
    assert r.content == data[100:200]
    assert r.headers["content-type"] == "video/mp4"
    assert c.get(f"/api/video/{folder}/cam1.mp4").content == data


@pytest.mark.parametrize(
    "path",
    [
        "/api/video/2026-11-07_140130_record/cam2.mp4",  # not a listed clip
        "/api/video/not-a-recording/cam1.mp4",
        "/api/video/2026-11-07_140130_record/..%2F..%2Fsecret.mp4",
        "/api/video/..%2Fetc/passwd.mp4",
    ],
)
def test_clip_refuses_anything_not_listed(client, rec_dir, path):
    c, _ = client
    put(rec_dir, "2026-11-07_140130_record", "cam1", 10)
    (rec_dir / "secret.mp4").write_bytes(mp4(10))
    assert c.get(path).status_code == 404

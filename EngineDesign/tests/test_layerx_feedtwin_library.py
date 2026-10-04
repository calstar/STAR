"""Layer X lists the feed twin's library (2026-10-03: "pull from it and trust it")."""

import json
import shutil

from engine.layerx import sources


def test_the_feed_twins_library_is_listed_and_deduplicated(tmp_path, monkeypatch):
    shipped = sources.shipped_drawings_dir()
    lib = tmp_path / "library"
    (lib / "blobs").mkdir(parents=True)
    he = shipped / "copv_study_he.json"
    # One drawing the twin pulled from pid-designer (a changed copy), one byte-identical to a shipped file.
    changed = json.loads(he.read_text())
    changed["nodes"][0]["data"]["label"] = "COPV-PULLED"
    (lib / "blobs" / "pulled.json").write_text(json.dumps(changed))
    shutil.copy(he, lib / "blobs" / "same.json")
    (lib / "manifest.json").write_text(json.dumps([
        {"kind": "diagram", "name": "stand from pid-designer", "filename": "pulled.json", "source": "pid-designer:local/x",
         "imported_at": "2026-10-01T10:00:00+00:00"},
        {"kind": "diagram", "name": "copv_study_he", "filename": "same.json", "source": "shipped:copv_study_he.json",
         "imported_at": "2026-09-12T04:03:32+00:00"},
        {"kind": "engine", "name": "an engine", "filename": "e.yaml"},
    ]))
    monkeypatch.setenv("LAYERX_FEEDTWIN_LIBRARY", str(lib))
    sources._SHIPPED_CACHE.clear()
    listed = sources.DrawingStore(None).list()
    names = [d.name for d in listed]
    assert "stand from pid-designer" in names
    assert names.count("copv_study_he") == 1          # the same bytes are one drawing
    pulled = next(d for d in listed if d.name == "stand from pid-designer")
    assert pulled.source.startswith("feed-twin library")
    assert sources.DrawingStore(None).get(pulled.id) is not None

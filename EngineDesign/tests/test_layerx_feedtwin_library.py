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


def _image_env():
    """The engine-design-api container's environment, as Dockerfile.api and docker-compose.yml set it, and
    where its files come from: the image's COPY destinations and the compose volume mounts."""
    import re
    from pathlib import Path

    import yaml

    root = Path(__file__).resolve().parents[2]
    docker = (root / "EngineDesign" / "Dockerfile.api").read_text()
    env = {}
    for block in re.findall(r"^ENV ((?:.*\\\n)*.*)$", docker, flags=re.M):
        for k, v in re.findall(r"(\w+)=(\S+)", block.replace("\\\n", " ")):
            env[k] = v
    copies = [dest.rstrip("/") for _src, dest in re.findall(r"^COPY (?:--\S+ )*(\S+) (\S+)$", docker, flags=re.M)]
    compose = yaml.safe_load((root / "docker-compose.yml").read_text())["services"]
    api = compose["engine-design-api"]
    env.update({k: str(v) for k, v in (api.get("environment") or {}).items()})
    mounts = {m.split(":")[0]: m.split(":")[1] for m in api.get("volumes") or []}
    return env, copies, mounts, compose


def test_the_deployed_layer_x_reads_the_twins_library_and_its_featured_stand():
    """In compose, Layer X resolved the twin's library and sample set to /feed-twin/backend/..., which the
    image does not have: production Layer X listed none of the cockpit's drawings or pulls, and no featured
    stand (R003). Every drawing source must be set to a place the container has."""
    env, copies, mounts, compose = _image_env()
    for key in ("LAYERX_DRAWINGS", "LAYERX_STATEMACHINES", "LAYERX_SAMPLE", "LAYERX_FEEDTWIN_LIBRARY"):
        path = env.get(key)
        assert path, f"{key} is not set for engine-design-api"
        in_image = any(path == c or path.startswith(c + "/") for c in copies)
        on_volume = any(path == m or path.startswith(m + "/") for m in mounts.values())
        assert in_image or on_volume, f"{key}={path} is neither copied into the image nor on a mounted volume"
    # The library is the twin's own: the same directory on the same volume as feed-twin-api's.
    twin = compose["feed-twin-api"]
    twin_mounts = {m.split(":")[0]: m.split(":")[1] for m in twin.get("volumes") or []}
    lib = twin["environment"]["FEEDTWIN_LIBRARY"]
    volume = next(v for v, m in twin_mounts.items() if lib.startswith(m + "/"))
    assert mounts.get(volume) == twin_mounts[volume] and env["LAYERX_FEEDTWIN_LIBRARY"] == lib


def test_the_drawing_summary_gives_the_droop_the_twin_runs_and_says_when_it_is_the_default():
    """The rail's 'Dome regulator' row was blank and its hover said 'droop — psi (from the drawing)' while the
    burn ran the twin's 20 psi library default (feedtwin.pid.network FALLBACKS)."""
    he = json.loads((sources.shipped_drawings_dir() / "copv_study_gn2.json").read_text())
    drawn = sources.summarize(he, "gn2")
    reg = next(r for r in drawn["regulators"] if r["id"] == "PR_D")
    assert reg["flow_droop_psi"] == 8.3 and reg["flow_droop_default"] is False
    node = next(n for n in he["nodes"] if n["id"] == "PR_D")
    del node["data"]["params"]["flow_droop"]
    reg = next(r for r in sources.summarize(he, "gn2")["regulators"] if r["id"] == "PR_D")
    assert reg["flow_droop_psi"] == 20.0 and reg["flow_droop_default"] is True


def test_a_missing_drawing_source_is_said_not_listed_as_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("LAYERX_SAMPLE", str(tmp_path / "nowhere"))
    monkeypatch.setenv("LAYERX_FEEDTWIN_LIBRARY", str(tmp_path))
    problems = sources.source_problems()
    assert any("LAYERX_SAMPLE" in p and "nowhere" in p for p in problems)
    assert not any("LAYERX_FEEDTWIN_LIBRARY" in p for p in problems)

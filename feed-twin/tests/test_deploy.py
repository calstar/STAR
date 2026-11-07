"""What the deployed image runs on, and what its run records say it ran.

A checkout finds things beside the app that an image does not have: the CEA
tables under EngineDesign/output/cache, and a ``.git`` to name the commit.
These guard the image's side of both (R048, R053), and the dev side of the
commit's "dirty" flag.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from backend import main, version
from backend.assembly import engine_from_bytes

REPO = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO / "feed-twin" / "Dockerfile.api"
COMPOSE = REPO / "docker-compose.yml"
TABLES = REPO / "EngineDesign" / "output" / "cache"
SAMPLE = REPO / "feed-twin" / "backend" / "sample"

client = TestClient(main.app)


def _engine() -> object:
    return engine_from_bytes(
        (SAMPLE / "ethalox-doublet.yaml").read_bytes(), name="ethalox-doublet.yaml"
    )


# ------------------------------------------------------------------ R048


def test_the_image_carries_the_cea_tables_and_points_at_them() -> None:
    """In the image the checkout's path resolves to /EngineDesign/output/cache,
    which nothing put there: every engine without a card made 0 N."""
    text = DOCKERFILE.read_text("utf-8")
    copied = re.search(r"^COPY (EngineDesign/output/cache/\S+) (\S+)$", text, re.M)
    assert copied, "Dockerfile.api copies the CEA tables"
    pointed = re.search(r"^ENV FEEDTWIN_CEA_DIR=(\S+)$", text, re.M)
    assert pointed and pointed.group(1).rstrip("/") == copied.group(2).rstrip("/")
    assert list(REPO.glob(copied.group(1))), "the glob matches a committed table"
    assert "no CEA table" in text, "and the build fails without one"
    ignored = (REPO / ".dockerignore").read_text("utf-8")
    assert "!EngineDesign/output/cache" in ignored, "the tables reach the context"


def test_a_cea_dir_from_the_environment_is_searched(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The image's case: nothing at the checkout's path, the tables where
    FEEDTWIN_CEA_DIR says."""
    monkeypatch.setattr(main, "CEA_SEARCH", [tmp_path / "EngineDesign-not-here"])
    monkeypatch.delenv("FEEDTWIN_CEA_DIR", raising=False)
    assert main._cea_for(_engine()) == ""  # type: ignore[arg-type]
    monkeypatch.setenv("FEEDTWIN_CEA_DIR", str(TABLES))
    found = main._cea_for(_engine())  # type: ignore[arg-type]
    assert Path(found).parent == TABLES and "LOX_Ethanol" in Path(found).name


def test_an_engine_with_no_table_says_so(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Without a card and without a table the simplified engine makes no
    thrust, and the console said "Not lit: cold flow ... press the tanks
    first". The report says what is missing instead."""
    config = yaml.safe_load((SAMPLE / "ethalox-doublet.yaml").read_text("utf-8"))
    config["name"] = "no-table test engine"
    uploaded = client.post(
        "/api/library/engines",
        files={"file": ("no-table.yaml", yaml.safe_dump(config), "text/plain")},
    )
    assert uploaded.status_code == 200, uploaded.text
    engine = uploaded.json()["artifact"]["id"]
    drawing = next(
        a.id for a in main.library.list("diagram") if "ethalox_stand" in a.source
    )
    try:
        assert uploaded.json()["artifact"]["card"] == {}, "no EngineDesign here"

        def warnings() -> list[str]:
            view = client.get(
                "/api/model", params={"diagram": drawing, "engine": engine}
            )
            assert view.status_code == 200, view.text
            found: list[str] = view.json()["report"]["warnings"]
            return found

        assert not any("No CEA table" in w for w in warnings())
        monkeypatch.setattr(main, "CEA_SEARCH", [tmp_path])
        monkeypatch.delenv("FEEDTWIN_CEA_DIR", raising=False)
        assert any("No CEA table" in w for w in warnings())
    finally:
        main.library.remove(engine)


# ------------------------------------------------------------------ R053


def test_the_image_is_told_its_commit() -> None:
    """An image has no .git: every deployed run recorded commit ''."""
    text = DOCKERFILE.read_text("utf-8")
    assert re.search(r"^ARG FEEDTWIN_COMMIT", text, re.M)
    assert re.search(r"^ENV FEEDTWIN_COMMIT=\$\{FEEDTWIN_COMMIT\}$", text, re.M)
    service = yaml.safe_load(COMPOSE.read_text("utf-8"))["services"]["feed-twin-api"]
    assert "FEEDTWIN_COMMIT" in service["build"]["args"]


def _git(root: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=root,
        check=True,
        capture_output=True,
    )


def test_an_import_into_the_dev_library_is_not_a_code_change(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The dev library is the tracked feed-twin/backend/library, and an import
    adds a blob and rewrites the manifest: every dev run after one read
    "dirty" with no code changed."""
    library = tmp_path / "feed-twin" / "backend" / "library"
    (library / "blobs").mkdir(parents=True)
    (library / "manifest.json").write_text("[]")
    (tmp_path / "feed-twin" / "backend" / "main.py").write_text("x = 1\n")
    (tmp_path / "lib" / "feedtwin").mkdir(parents=True)
    (tmp_path / "lib" / "feedtwin" / "core.py").write_text("y = 1\n")
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "base")
    monkeypatch.setattr(version, "_ROOT", tmp_path)
    monkeypatch.delenv("FEEDTWIN_COMMIT", raising=False)

    (library / "manifest.json").write_text('[{"id": "new"}]')
    (library / "blobs" / "new.json").write_text("{}")
    assert version.code_version.__wrapped__()["dirty"] is False

    (tmp_path / "lib" / "feedtwin" / "core.py").write_text("y = 2\n")
    assert version.code_version.__wrapped__()["dirty"] is True

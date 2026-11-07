"""POST /api/config/upload writes only a basename, only under the caller's folder, only if it parses.

The multipart filename is the client's string. Joined onto the uploads folder as given,
"../../../x.yaml" climbed out of output/user_configs/<user>/ and an absolute path replaced the
folder outright (pathlib's ``/`` drops the left side for an absolute right side) -- so a request
naming /app/configs/default.yaml overwrote the default every new session loads. The bytes were
written before they were parsed, so even a file answered with 400 "Invalid YAML" had landed.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

import backend.main as backend_main  # noqa: E402
from backend import session as session_mod  # noqa: E402

H = {"X-Auth-Email": "upload-confined@berkeley.edu"}
VALID = session_mod._DEFAULT_CONFIG_PATH.read_bytes()


@pytest.fixture
def root(tmp_path, monkeypatch):
    """A project root three folders deep, so a climb of three lands inside tmp_path."""
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path / "userdata"))
    proj = tmp_path / "a" / "b" / "c"
    proj.mkdir(parents=True)
    monkeypatch.setattr(backend_main, "project_root", proj)
    return proj


@pytest.fixture
def client():
    return TestClient(backend_main.app, raise_server_exceptions=False)


def _yaml_files(base: Path) -> set[Path]:
    return {p for p in base.rglob("*.y*ml")}


def test_a_climbing_filename_lands_in_the_users_folder(root, tmp_path, client):
    r = client.post(
        "/api/config/upload",
        files={"file": ("../../../escaped.yaml", VALID, "application/x-yaml")},
        headers=H,
    )
    assert r.status_code == 200, r.text
    uploads = (root / "output" / "user_configs").resolve()
    written = _yaml_files(tmp_path)
    assert written, "nothing was written at all; the upload path is not exercised"
    assert all(uploads in p.resolve().parents for p in written), (
        f"the upload escaped output/user_configs/<user>/: {sorted(map(str, written))}"
    )
    assert "../" not in r.json()["message"]


def test_an_absolute_filename_does_not_replace_the_folder(root, tmp_path, client):
    target = tmp_path / "abs_escape.yaml"
    r = client.post(
        "/api/config/upload",
        files={"file": (str(target), VALID, "application/x-yaml")},
        headers=H,
    )
    assert r.status_code == 200, r.text
    assert not target.exists(), "an absolute filename wrote outside the project"
    assert (root / "output" / "user_configs").exists()


def test_a_file_that_does_not_parse_is_not_written(root, tmp_path, client):
    r = client.post(
        "/api/config/upload",
        files={"file": ("broken.yaml", b"not: [valid", "application/x-yaml")},
        headers=H,
    )
    assert r.status_code == 400, r.text
    assert not _yaml_files(tmp_path), "an upload refused as invalid YAML was written anyway"


def test_a_file_that_is_not_a_config_is_not_written(root, tmp_path, client):
    r = client.post(
        "/api/config/upload",
        files={"file": ("notaconfig.yaml", b"chamber: 3\n", "application/x-yaml")},
        headers=H,
    )
    assert r.status_code in (400, 422), r.text[:200]
    assert not _yaml_files(tmp_path), "an upload refused by validation was written anyway"


@pytest.mark.parametrize("name", ["", ".yaml", "../", "config.txt"])
def test_names_that_are_not_yaml_files_are_refused(root, client, name):
    r = client.post(
        "/api/config/upload",
        files={"file": (name, VALID, "application/x-yaml")},
        headers=H,
    )
    assert r.status_code in (400, 422), r.text[:200]

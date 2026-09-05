"""Wrappers for the stdlib-only tool suites.

`tools/fruity-chute-scraper/` and `site-climatology/` keep their own runnable
script suites rather than being ported to pytest, because both are deliberately
stdlib-only -- the scraper README and pad_state's docstring both say so, and
pytest is a dependency. Porting them would make the tools tree need a venv to
test, regressing exactly the property that lets them run anywhere.

Shelling out gets the one-runner benefit without either cost: `pytest tests/`
covers everything, and the scripts stay independently runnable.
"""

import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Blocking the network turns "someone added a live fetch to a test" into a hard
# failure rather than an intermittent flake that only shows up when the vendor
# is having a bad day. Port 9 (discard) is closed, so it is a refused
# connection. urllib honours these, and every network call in these trees goes
# through urllib.
OFFLINE = {
    "http_proxy": "http://127.0.0.1:9",
    "https_proxy": "http://127.0.0.1:9",
    "no_proxy": "",
}


def _run_script(directory, script, offline):
    path = os.path.join(ROOT, directory)
    if not os.path.isfile(os.path.join(path, script)):
        pytest.skip("%s/%s not present" % (directory, script))
    env = dict(os.environ)
    if offline:
        env.update(OFFLINE)
    proc = subprocess.run(
        [sys.executable, script], cwd=path, env=env,
        capture_output=True, text=True, timeout=600,
    )
    assert proc.returncode == 0, (
        "%s/%s failed:\n%s\n%s" % (directory, script, proc.stdout[-4000:],
                                   proc.stderr[-2000:])
    )
    return proc.stdout


def test_fruity_chute_scraper_mock_suite():
    """test_mock.py stands up a local HTTP server mimicking the vendor API, so
    it needs loopback and is NOT run with the proxy block."""
    out = _run_script("tools/fruity-chute-scraper", "test_mock.py", offline=False)
    assert "ALL PASS" in out


def test_site_climatology_suite():
    out = _run_script("site-climatology", "test_site_climatology.py", offline=True)
    assert "all passed" in out

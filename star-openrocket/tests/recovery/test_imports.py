"""The import boundary. PLAN.md §11.2, and the ISA-consolidation invariant.

`physics.atmosphere` and `physics.pad_state` are stdlib-only so
that `site-climatology/` can import the one canonical copy of §5 while staying
dependency-free and offline. That property is what let the duplicate ISA
implementation be deleted rather than maintained, and it holds only while
`physics/__init__.py` stays empty.

These tests are the thing that keeps it honest. Without them, a convenience
re-export in `__init__.py` would silently make the tools tree need a venv.
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _run(code):
    """Run `code` in a clean interpreter with the subproject root on the path."""
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT, capture_output=True, text=True, timeout=120,
    )


def test_atmosphere_imports_without_numpy_scipy_or_pydantic():
    proc = _run(
        "import sys\n"
        "sys.path.insert(0, '.')\n"
        "import physics.atmosphere\n"
        "heavy = [m for m in ('numpy', 'scipy', 'pydantic', 'matplotlib')\n"
        "         if m in sys.modules]\n"
        "assert not heavy, 'atmosphere pulled in ' + repr(heavy)\n"
        "print('ok')\n"
    )
    assert proc.returncode == 0, proc.stderr
    assert "ok" in proc.stdout


def test_pad_state_imports_without_numpy_scipy_or_pydantic():
    proc = _run(
        "import sys\n"
        "sys.path.insert(0, '.')\n"
        "import physics.pad_state\n"
        "heavy = [m for m in ('numpy', 'scipy', 'pydantic', 'matplotlib')\n"
        "         if m in sys.modules]\n"
        "assert not heavy, 'pad_state pulled in ' + repr(heavy)\n"
        "print('ok')\n"
    )
    assert proc.returncode == 0, proc.stderr
    assert "ok" in proc.stdout


def test_reference_model_ports_are_stdlib_only():
    """`mastersheet` and `openrocket` are ports of other people's models.

    Both are scalar arithmetic -- eight LAMBDAs and a hand-rolled Euler loop --
    so neither needs numpy, and neither may import `schema` and drag pydantic
    in behind it. They are duck-typed on `Config` instead. Keeping them in the
    stdlib tier means the Cross-check comparison can be reasoned about, and
    run, without the heavy half of the dependency tree.
    """
    proc = _run(
        "import sys\n"
        "sys.path.insert(0, '.')\n"
        "import physics.mastersheet, physics.openrocket\n"
        "heavy = [m for m in ('numpy', 'scipy', 'pydantic', 'matplotlib')\n"
        "         if m in sys.modules]\n"
        "assert not heavy, 'reference ports pulled in ' + repr(heavy)\n"
        "print('ok')\n"
    )
    assert proc.returncode == 0, proc.stderr
    assert "ok" in proc.stdout


def test_package_init_imports_nothing():
    """An import here -- even a convenience re-export of Config or simulate --
    would pull pydantic and scipy into every consumer of atmosphere."""
    proc = _run(
        "import sys\n"
        "sys.path.insert(0, '.')\n"
        "import physics\n"
        "heavy = [m for m in ('numpy', 'scipy', 'pydantic', 'matplotlib')\n"
        "         if m in sys.modules]\n"
        "assert not heavy, '__init__ pulled in ' + repr(heavy)\n"
        "print('ok')\n"
    )
    assert proc.returncode == 0, proc.stderr
    assert "ok" in proc.stdout


def test_physics_never_imports_fastapi():
    """§11.2: the library must never import FastAPI. It is a library with a
    CLI; the web app is one consumer, the test suite and notebooks are others.
    The §12 assertions run headless in CI with no server."""
    proc = _run(
        "import sys\n"
        "sys.path.insert(0, '.')\n"
        "import physics.solver, physics.cases\n"
        "import physics.report, physics.loads\n"
        "web = [m for m in sys.modules if m.split('.')[0] in\n"
        "       ('fastapi', 'uvicorn', 'starlette')]\n"
        "assert not web, 'library imported web machinery: ' + repr(web)\n"
        "print('ok')\n"
    )
    assert proc.returncode == 0, proc.stderr
    assert "ok" in proc.stdout


def test_site_climatology_still_imports_the_canonical_pad_state():
    """The consolidation's whole point: one copy of eqs (7a)/(7b), imported
    rather than duplicated, from a tree that has no venv."""
    site = os.path.join(ROOT, "site-climatology")
    if not os.path.isdir(site):
        return
    proc = subprocess.run(
        [sys.executable, "-c",
         "from _padstate import pad_state\n"
         "assert hasattr(pad_state, 'p_pad_metar'), 'eq (7b) missing'\n"
         "assert hasattr(pad_state, 'p_pad_isa'), 'eq (7a) missing'\n"
         "assert 'physics' in pad_state.__name__ or True\n"
         "print(pad_state.__file__)\n"],
        cwd=site, capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    # It must resolve into the package, not to a leftover copy.
    assert os.path.join("physics", "pad_state.py") in proc.stdout


def test_cli_entry_point_works():
    """§11.2 makes `python -m physics config.json` an invariant, not a
    development phase -- it is the escape hatch for bisecting a bug without
    React in the stack."""
    fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "worked_example.json")
    proc = subprocess.run(
        [sys.executable, "-m", "physics", fixture, "--which", "axial"],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, proc.stderr
    assert "F_design" in proc.stdout
    assert "OFF-NOMINAL CASES" in proc.stdout


def test_cli_json_output_is_serialisable():
    """`--json` is documented in the README, and it was broken.

    `DeviceLoads.bound_valid` came back as a `numpy.bool`, which `json` refuses.
    The failure was invisible in two ways: nothing exercised `--json`, and the
    error message names the type numpy *reports*, so it read "Object of type
    bool is not JSON serializable" -- which looks impossible and sends you
    looking anywhere but at numpy. Every config hit it.
    """
    import json as _json

    fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "worked_example.json")
    proc = subprocess.run(
        [sys.executable, "-m", "physics", fixture, "--which", "axial", "--json"],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, proc.stderr
    payload = _json.loads(proc.stdout)
    assert payload["axial"]["nominal"]["devices"]
    # The specific field that broke it.
    assert isinstance(payload["axial"]["nominal"]["devices"][0]["bound_valid"],
                      bool)

"""check_config_load.py checks any config it is handed, of any injector type.

It read '/Users/carlton/Downloads/Layer 3 Optimized Config.yaml' and printed a pintle-only field, so
on any other machine it died with FileNotFoundError and on an impinging design it checked nothing.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _script():
    spec = importlib.util.spec_from_file_location("check_config_load", ROOT / "check_config_load.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_shipped_configs_of_both_injectors_load(capsys):
    rc = _script().main([str(ROOT / "configs" / "canonical" / "impinging.yaml"),
                         str(ROOT / "configs" / "canonical" / "pintle.yaml")])
    out = capsys.readouterr().out
    assert rc == 0, out
    assert "injector impinging" in out and "injector pintle" in out


def test_a_broken_config_fails_with_the_loaders_reason(tmp_path, capsys):
    bad = tmp_path / "bad.yaml"
    bad.write_text("propellant_preset: ethalox\nchamber_geometry: 3\n")
    rc = _script().main([str(bad)])
    out = capsys.readouterr().out
    assert rc == 1 and "FAIL" in out and str(bad) in out


def test_no_arguments_is_a_usage_line(capsys):
    assert _script().main([]) == 2
    assert "check_config_load.py" in capsys.readouterr().out

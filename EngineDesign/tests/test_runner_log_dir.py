"""Where an evaluate's debug log goes.

The Evaluate route runs the engine with ``debug=True``, which writes
``output/logs/evaluate.log`` under the working directory -- the repo, for a
stack run from a working tree -- and echoes every block to the console.
``ENGINE_DESIGN_LOG_DIR`` moves the file and ``ENGINE_DESIGN_CONSOLE_LOG_LEVEL``
quiets the console; unset, both are exactly as before.
"""

from __future__ import annotations

import logging
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PSI = 6894.757293168361


def _evaluate_debug() -> None:
    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner

    cfg = load_config(str(ROOT / "configs/ethalox_6500N.yaml"))
    P = 584.2669657943025 * PSI
    PintleEngineRunner(cfg).evaluate(P_tank_O=P, P_tank_F=P, debug=True)


def _console_levels() -> list[int]:
    return [
        h.level
        for h in logging.getLogger("evaluate").handlers
        if type(h) is logging.StreamHandler
    ]


def test_debug_log_goes_where_it_is_told(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ENGINE_DESIGN_LOG_DIR", str(tmp_path / "elsewhere"))
    monkeypatch.setenv("ENGINE_DESIGN_CONSOLE_LOG_LEVEL", "warning")
    _evaluate_debug()
    assert (tmp_path / "elsewhere" / "evaluate.log").stat().st_size > 0
    assert not (tmp_path / "output").exists()
    assert _console_levels() == [logging.WARNING]


def test_unset_it_is_output_logs_under_the_working_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("ENGINE_DESIGN_LOG_DIR", raising=False)
    monkeypatch.delenv("ENGINE_DESIGN_CONSOLE_LOG_LEVEL", raising=False)
    _evaluate_debug()
    assert (tmp_path / "output" / "logs" / "evaluate.log").stat().st_size > 0
    assert _console_levels() == [logging.INFO]


def test_a_level_it_does_not_know_keeps_the_console_at_info(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ENGINE_DESIGN_LOG_DIR", str(tmp_path))
    monkeypatch.setenv("ENGINE_DESIGN_CONSOLE_LOG_LEVEL", "chatty")
    _evaluate_debug()
    assert _console_levels() == [logging.INFO]

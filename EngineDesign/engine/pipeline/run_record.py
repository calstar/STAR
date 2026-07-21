"""Append-only run records: one row per (commit, config) evaluation.

WHY
---
Config drift is invisible without history. On 2026-07-21 an audit found that NO committed config
satisfied its own declared gates, and reconstructing *why* required manual git archaeology across
several commits. The proximate cause (commit 1e3f7426 replaced momentum-reconstruction thrust with
RPA delivered thrust) moved every engine's operating point while the yamls stayed frozen -- and the
second-order effect on injector stiffness went unnoticed for days.

One row per commit per config would have made that a one-line query.

THE KEY FIELD IS ``config_sha256``
----------------------------------
It is the hash of the **resolved in-memory config**, not of the yaml file. Two consequences:

  * It is invariant to file layout, so splitting intent/derived across files (or extracting shared
    material presets) does not break the series.
  * Combined with ``git_sha`` it disambiguates *why* a number moved:

        config_sha same, git_sha changed   -> the physics moved
        config_sha changed, git_sha same   -> someone edited the config
        both changed                       -> ambiguous, go look

PROVENANCE HONESTY
------------------
``git_dirty`` records whether the tree had uncommitted changes; ``git_diff_sha`` hashes the actual
diff so two different dirty states are distinguishable. A dirty row is NOT a baseline -- it cannot
be reproduced from a commit alone. CI (clean by construction) writes the real series.

Rows recorded before the config cleanup lands are archaeology, not baseline: at the time of writing
7 of 10 configs fail their own gates and ``default.yaml`` evaluates to negative thrust.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np

# Layer-1 final-validation defaults (layer1_static_optimization.py:2401 / :3177).
DEFAULT_THRUST_TOL = 0.10
DEFAULT_OF_TOL = 0.15

PSI = 6894.757


def _git(root: Path, *args: str) -> Optional[str]:
    """Run a git command, returning stripped stdout or None if git/repo is unavailable."""
    try:
        out = subprocess.run(
            ["git", *args], cwd=str(root), capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def git_provenance(root: Path) -> Dict[str, Any]:
    """Commit identity plus an honest dirty-state fingerprint.

    ``git_diff_sha`` is the hash of the working-tree diff (tracked files only). It is what lets two
    dirty runs be told apart; without it every local experiment looks identical in the record.
    """
    sha = _git(root, "rev-parse", "HEAD")
    porcelain = _git(root, "status", "--porcelain")
    dirty = bool(porcelain)
    diff_sha = None
    if dirty:
        diff = _git(root, "diff", "HEAD")
        if diff is not None:
            diff_sha = hashlib.sha256(diff.encode("utf-8", "replace")).hexdigest()[:16]
    return {
        "git_sha": sha,
        "git_dirty": dirty,
        "git_diff_sha": diff_sha,
        "git_branch": _git(root, "rev-parse", "--abbrev-ref", "HEAD"),
    }


def config_fingerprint(config: Any) -> str:
    """SHA-256 of the RESOLVED config (post-preset-overlay), not of the source file.

    Hashing the file would make the series break the moment configs are split across files or start
    inheriting from shared presets. Hashing what the solver actually sees does not.
    """
    payload = config.model_dump(mode="json")
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _f(value: Any) -> float:
    """Coerce to float, mapping None/non-numeric to NaN so a row never fails to serialize."""
    try:
        out = float(value)
    except (TypeError, ValueError):
        return float("nan")
    return out


def _jsonable(value: Any) -> Any:
    """JSON has no NaN/Infinity — emit null so rows stay parseable by strict readers."""
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


def evaluate_config(config_path: Path) -> Dict[str, Any]:
    """Load a config and evaluate it at its OWN declared design point.

    Shared by the CI guard (``tests/test_config_design_validity.py``) and the run recorder so the
    two cannot drift apart on what "evaluated at its design point" means.

    ``kind`` is one of ``not_engine`` / ``load_error`` / ``eval_error`` / ``checked``.
    """
    from engine.core.runner import PintleEngineRunner
    from engine.optimizer.injector_dp_penalty import (
        injector_dp_ratio_within_gate,
        injector_dp_ratios_from_eval_result,
    )
    from engine.pipeline.io import load_config

    import yaml

    # Classify BEFORE the schema load: non-engine yamls under configs/ (e.g. the robust-DDP
    # controller config) legitimately fail PintleEngineConfig validation, and that is not staleness.
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
    except Exception as exc:  # noqa: BLE001 - unreadable file is a real, reportable condition
        return {"kind": "load_error", "detail": f"{type(exc).__name__}: {exc}"}
    if not isinstance(raw, dict) or not (raw.get("design_requirements") or {}).get("target_thrust"):
        return {"kind": "not_engine", "detail": "no design_requirements.target_thrust"}

    try:
        cfg = load_config(str(config_path))
    except Exception as exc:  # noqa: BLE001 - surfaced as a row/verdict, not raised
        return {"kind": "load_error", "detail": f"{type(exc).__name__}: {exc}"}

    req = cfg.design_requirements
    target_thrust = _f(getattr(req, "target_thrust", None))
    target_of = _f(getattr(req, "optimal_of_ratio", None))

    try:
        res = PintleEngineRunner(cfg).evaluate(
            _f(cfg.lox_tank.initial_pressure_psi) * PSI,
            _f(cfg.fuel_tank.initial_pressure_psi) * PSI,
            silent=True,
        )
    except Exception as exc:  # noqa: BLE001 - a config that cannot evaluate is the finding
        return {
            "kind": "eval_error",
            "detail": f"{type(exc).__name__}: {str(exc)[:200]}",
            "config_sha256": config_fingerprint(cfg),
        }

    pc = _f(res.get("Pc"))
    F = _f(res.get("F"))
    MR = _f(res.get("MR"))
    stab = res.get("stability") or res.get("stability_results") or {}
    chug = stab.get("chugging", {}) or {}
    ro, rf = injector_dp_ratios_from_eval_result(pc, res)

    thr_tol = _f(getattr(req, "layer1_thrust_validation_rel_tol", None) or DEFAULT_THRUST_TOL)
    of_tol = _f(getattr(req, "layer1_of_validation_tol", None) or DEFAULT_OF_TOL)

    thrust_err = abs(F - target_thrust) / target_thrust if target_thrust > 0 else float("nan")
    of_err = abs(MR - target_of) / target_of if target_of > 0 else float("nan")

    # OFF-SPEC IS NOT BROKEN. A config that misses its thrust target is an unconverged design, not
    # a defect someone introduced -- blocking a commit on it means work-in-progress designs cannot
    # be checked in, which is precisely the pressure that produces "just widen the band". These are
    # reported and recorded, never used to fail CI. Genuine breakage (won't load, won't evaluate,
    # non-physical output) is what the ``load_error``/``eval_error`` kinds cover, and those DO fail.
    off_spec = []
    if not (thrust_err <= thr_tol):
        off_spec.append(
            f"thrust {F:.0f}N vs target {target_thrust:.0f}N ({thrust_err*100:.1f}% > {thr_tol*100:.0f}%)"
        )
    if target_of > 0 and not (of_err <= of_tol):
        off_spec.append(
            f"O/F {MR:.2f} vs target {target_of:.2f} ({of_err*100:.1f}% > {of_tol*100:.0f}%)"
        )
    for side, ratio in (("O", ro), ("F", rf)):
        lo = getattr(req, f"injector_dp_ratio_{side}_min", None)
        hi = getattr(req, f"injector_dp_ratio_{side}_max", None)
        if lo is None or hi is None:
            continue
        if injector_dp_ratio_within_gate(ratio, _f(lo), _f(hi)) is False:
            off_spec.append(
                f"dP_inj_{side}/Pc {_f(ratio):.3f} outside band [{_f(lo):.2f}, {_f(hi):.2f}]"
            )

    return {
        "kind": "checked",
        "ok": not off_spec,          # "meets its own spec" -- reported, not enforced
        "failures": off_spec,
        "config_sha256": config_fingerprint(cfg),
        "metrics": {
            "Pc": pc,
            "F": F,
            "Isp": _f(res.get("Isp")),
            "MR": MR,
            "mdot_total": _f(res.get("mdot_total")),
            "eta_inj_O": _f(ro),
            "eta_inj_F": _f(rf),
            "chug_gain_margin": _f(chug.get("chug_gain_margin")),
            "chugging_stability_margin": _f(chug.get("stability_margin")),
            "stability_source": stab.get("stability_source"),
            "target_thrust": target_thrust,
            "target_of_ratio": target_of,
            "thrust_err": thrust_err,
            "of_err": of_err,
        },
    }


def build_row(config_path: Path, root: Path, *, timestamp: str) -> Dict[str, Any]:
    """One JSONL row: provenance + config identity + metrics + gate verdict.

    ``timestamp`` is passed in rather than read here so a batch of rows shares one instant and the
    caller owns clock policy.
    """
    verdict = evaluate_config(config_path)
    row: Dict[str, Any] = {
        "ts": timestamp,
        "config_path": config_path.relative_to(root / "configs").as_posix(),
        "config_sha256": verdict.get("config_sha256"),
        "kind": verdict["kind"],
        "gates_passed": verdict.get("ok"),
        "failures": verdict.get("failures") or [],
        "detail": verdict.get("detail"),
        **git_provenance(root),
    }
    for key, value in (verdict.get("metrics") or {}).items():
        row[key] = _jsonable(value)
    return row

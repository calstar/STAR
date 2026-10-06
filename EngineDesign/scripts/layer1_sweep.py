"""Run Layer 1 on many cases at once and collect the results.

    python3 scripts/layer1_sweep.py cases.json --out runs/ --parallel 3 --workers 3

``cases.json`` is a list of cases::

    {"name": "6500N_seed1", "config": "configs/ethalox_6500N.yaml",
     "set": {"design_requirements.layer1_random_seed": 1, "design_requirements.target_thrust": 6500}}

``config`` may also be ``"blank:impinging:ethalox"``: the canonical impinging config with the
ethalox preset switched in, exactly what a user gets from a new design in the UI.

Each case runs ``scripts/layer1_run.py`` in its own process (``ED_L1_WORKERS`` = --workers), so
a crash or hang in one case cannot take the sweep down. Writes, per case, ``<name>.json`` (summary),
``<name>_config.yaml`` (the optimised design), ``<name>.log``, and one ``summary.json`` for all.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _set(d: dict, dotted: str, value) -> None:
    keys = dotted.split(".")
    for k in keys[:-1]:
        if d.get(k) is None:
            d[k] = {}
        d = d[k]
    d[keys[-1]] = value


def blank_config(injector: str, propellant: str) -> dict:
    """What the UI hands a user who starts a new design: the canonical config for the injector
    type, with the propellant preset switched in."""
    from engine.pipeline.config_switch import switch_config
    base = yaml.safe_load((ROOT / "configs" / "canonical" / f"{injector}.yaml").read_text())
    return switch_config(base, injector_type=None, propellant_preset=propellant)


def build_case_config(case: dict, out_dir: Path) -> Path:
    src = case["config"]
    if src.startswith("blank:"):
        _, inj, prop = src.split(":")
        cfg = blank_config(inj, prop)
    else:
        cfg = yaml.safe_load((ROOT / src).read_text() if not Path(src).is_absolute() else Path(src).read_text())
    cfg = copy.deepcopy(cfg)
    for k, v in (case.get("set") or {}).items():
        _set(cfg, k, v)
    p = out_dir / f"{case['name']}_input.yaml"
    p.write_text(yaml.safe_dump(cfg, sort_keys=False))
    return p


def run_case(case: dict, out_dir: Path, workers: int, timeout: int) -> dict:
    name = case["name"]
    t0 = time.time()
    try:
        cfg_path = build_case_config(case, out_dir)
    except Exception as e:  # a case that cannot even be built is a result, not a crash
        return {"name": name, "status": "build_failed", "error": repr(e)}
    env = dict(os.environ, ED_L1_WORKERS=str(workers),
               PYTHONPATH=str(ROOT.parent / "lib" / "stardesign") + os.pathsep + os.environ.get("PYTHONPATH", ""),
               PYTHONWARNINGS="ignore")
    out_json = out_dir / f"{name}.json"
    log = out_dir / f"{name}.log"
    try:
        with open(log, "w") as fh:
            proc = subprocess.run(
                [sys.executable, "-W", "ignore", str(ROOT / "scripts" / "layer1_run.py"),
                 "--config", str(cfg_path), "--out", str(out_json), "--label", name],
                cwd=str(ROOT), env=env, stdout=fh, stderr=subprocess.STDOUT, timeout=timeout)
        status = "ok" if proc.returncode == 0 else f"exit_{proc.returncode}"
    except subprocess.TimeoutExpired:
        status = "timeout"
    res = {"name": name, "status": status, "seconds": round(time.time() - t0, 1), "case": case}
    if out_json.exists():
        try:
            res["result"] = json.loads(out_json.read_text())
        except Exception as e:
            res["result_error"] = repr(e)
    if status != "ok":
        res["log_tail"] = log.read_text()[-3000:] if log.exists() else ""
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cases")
    ap.add_argument("--out", required=True)
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--timeout", type=int, default=1800)
    a = ap.parse_args()
    cases = json.loads(Path(a.cases).read_text())
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    results = []
    summary_path = out / "summary.json"
    with ThreadPoolExecutor(max_workers=a.parallel) as ex:
        futs = {ex.submit(run_case, c, out, a.workers, a.timeout): c for c in cases}
        for f in as_completed(futs):
            r = f.result()
            results.append(r)
            rr = r.get("result") or {}
            print(f"[{len(results)}/{len(cases)}] {r['name']}: {r['status']} {r.get('seconds')}s "
                  f"F={rr.get('F')} O/F={rr.get('MR')} Pc={rr.get('Pc_psi')} Isp={rr.get('Isp')} "
                  f"fail={rr.get('failure_reasons')}", flush=True)
            summary_path.write_text(json.dumps(results, indent=1, default=str))
    print(f"wrote {summary_path}")


if __name__ == "__main__":
    main()

"""LE4 Layer X baseline ("golden") burns.

Runs Layer X in-process (no HTTP server) at today's default settings and reduces each burn to
the numbers a design review reads. The JSON it writes is the reference for the overnight rule
"a change that moves the LE4 baseline by more than 1 % must be reported"; the slow test
``tests/test_layerx_golden.py`` holds the pad helium case to it.

Cases (the engine is LE4, ``configs/ethalox_6800N.yaml`` unless ``--config`` says otherwise)::

    he_pad      copv_study_he on the pad, erosion replay on (the hot-fire drawing)
    he_flight   the same, flown at the design's liftoff mass (``liftoff_mass_kg`` unset: the
                config's airframe plus motor, propellant and gases)
    gn2_pad     copv_study_gn2 on the pad (the drawing the Layer X tab selects by default)

Supplementary (``--all`` or ``--case``)::

    gn2_flight           copv_study_gn2 flown: the tab's out-of-the-box run (the UI defaults flight on)
    he_flight_he_ullage  he_flight with config.{lox,fuel}_tank.ullage_gas = Helium in the run's copy
                         of the config: a what-if, because at defaults the flight prices the ullage
                         refill as nitrogen and refuses the helium bottle (see CASES)

Settings are ``LayerXSettings``'s defaults except ``drawing_id``, ``flight`` and ``--dt``. The UI's
``DEFAULT_SETTINGS`` (frontend/src/api/layerx.ts) equal them except that the UI turns ``flight``
on; the pad cases are therefore one toggle away from the tab's out-of-the-box run.

The run is the router's (backend/routers/layerx.py ``start_run``): a private deepcopy of the
config, its own ``PintleEngineRunner`` (so the Forward cross-check runs), no restated drawing
parameters, ``run_prepared(prep, runner=..., replay=settings.replay, config=...)``.

Usage::

    cd EngineDesign
    PYTHONPATH=../lib/stardesign python3 scripts/layerx_baseline.py            # the baseline's three
    PYTHONPATH=../lib/stardesign python3 scripts/layerx_baseline.py --all \\
        --out docs/layerx/baseline-2026-10-02.json                                 # + supplementary
    PYTHONPATH=../lib/stardesign python3 scripts/layerx_baseline.py --case he_pad --dt 0.02
    PYTHONPATH=../lib/stardesign python3 scripts/layerx_baseline.py --config path/to/current.json

``--config`` takes a YAML config, an app document (``.userdata/.../current.json``, its ``config``
key), or a baseline JSON written by this script (its embedded ``inputs.config``), so a baseline
can be re-burned on exactly the design it was taken on.

Importable: ``run_case`` and ``run_baseline`` return plain dicts.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PSI = 6894.757293168361
DEFAULT_CONFIG = ROOT / "configs" / "ethalox_6800N.yaml"

#: name -> drawing, flown, what it is. ``supplementary`` cases are not the baseline's three; they are
#: run by ``--all`` (or by name) and say what they change. ``config_patch`` is applied to the run's
#: private copy of the config only ({section: {field: value}}), never to a file.
CASES: Dict[str, Dict[str, Any]] = {
    "he_pad": {"drawing": "copv_study_he", "flight": False,
               "label": "Helium hot-fire drawing, on the pad, erosion replay on"},
    "he_flight": {"drawing": "copv_study_he", "flight": True,
                  "label": "Helium hot-fire drawing, flown at the design liftoff mass"},
    # Nitrogen over LOX is refused for a hot fire since 2026-10-03 (prepare.gn2_on_lox); the GN2 study
    # cases burn it anyway, acknowledged, so they stay comparable with the baseline (``settings``).
    "gn2_pad": {"drawing": "copv_study_gn2", "flight": False, "settings": {"ack_gn2_condensation": True},
                "label": "GN2 drawing (the Layer X tab's default drawing), on the pad"},
    # The tab's out-of-the-box run: the GN2 drawing with the UI's flight: true.
    "gn2_flight": {"drawing": "copv_study_gn2", "flight": True, "supplementary": True,
                   "settings": {"ack_gn2_condensation": True},
                   "label": "GN2 drawing flown at the design liftoff mass (the UI's DEFAULT_SETTINGS run)"},
    # The flight simulation prices the ullage refill with config.<tank>.ullage_gas (Nitrogen in LE4's
    # config) whatever gas the drawing's bottle holds, so he_flight fails its COPV budget at defaults.
    # This what-if names the drawing's gas in the run's copy of the config so the helium burn can fly.
    "he_flight_he_ullage": {"drawing": "copv_study_he", "flight": True, "supplementary": True,
                            "config_patch": {"lox_tank": {"ullage_gas": "Helium"},
                                             "fuel_tank": {"ullage_gas": "Helium"}},
                            "label": "Helium drawing flown, config ullage_gas set to Helium (what-if, not default)"},
}
BASELINE_CASES = tuple(k for k, v in CASES.items() if not v.get("supplementary"))


def _patched(config: Any, patch: Optional[Dict[str, Dict[str, Any]]]) -> Any:
    if not patch:
        return config
    from engine.pipeline.config_schemas import PintleEngineConfig

    raw = config.model_dump(mode="json")
    for section, fields in patch.items():
        raw.setdefault(section, {}).update(fields)
    return PintleEngineConfig(**raw)


# ------------------------------------------------------------------ inputs


def _sha256_file(path: Optional[Path]) -> Optional[str]:
    if path is None or not Path(path).is_file():
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_dir(path: Path, pattern: str = "*") -> Optional[str]:
    if not path.is_dir():
        return None
    h = hashlib.sha256()
    for p in sorted(path.glob(pattern)):
        if p.is_file():
            h.update(p.name.encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def load_engine_config(source: Any = None) -> Tuple[Any, Dict[str, Any]]:
    """``(config, info)``. ``source``: None (LE4's YAML), a path (YAML, an app document JSON, or a
    baseline JSON from this script), or an already-built config dict."""
    from engine.pipeline.config_schemas import PintleEngineConfig
    from engine.pipeline.io import load_config

    if source is None:
        source = DEFAULT_CONFIG
    if isinstance(source, dict):
        return PintleEngineConfig(**source), {"kind": "dict", "path": None}
    path = Path(source)
    if path.suffix.lower() in (".yaml", ".yml"):
        return load_config(str(path)), {"kind": "yaml", "path": str(path)}
    raw = json.loads(path.read_text())
    if isinstance(raw.get("inputs"), dict) and isinstance(raw["inputs"].get("config"), dict):
        return PintleEngineConfig(**raw["inputs"]["config"]), {"kind": "baseline", "path": str(path)}
    if isinstance(raw.get("config"), dict):
        return PintleEngineConfig(**raw["config"]), {"kind": "app document", "path": str(path)}
    raise ValueError(f"{path}: not a YAML config, an app document or a baseline JSON")


def find_drawing(name: str) -> Any:
    from engine.layerx import DrawingStore

    found = {d.name: d for d in DrawingStore(None).list()}
    if name not in found:
        raise FileNotFoundError(f"shipped drawing {name!r} not found (have: {', '.join(sorted(found))})")
    return found[name]


# ------------------------------------------------------------------ reduction


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _first(*values: Any) -> Optional[float]:
    for v in values:
        f = _num(v)
        if f is not None:
            return f
    return None


def metrics(result: Dict[str, Any], prep: Any) -> Dict[str, Any]:
    """The baseline's figures from a ``run_prepared`` result.

    Engine quantities (impulse, thrust, Pc, Isp) are the *delivered* ones, EngineDesign's eroding
    replay, exactly as the Layer X tab's headline reads them (LayerXResult.tsx ``figureCells``);
    the twin's own are kept beside them. Feed quantities (burn time, tanks, bottle, O/F, stiffness)
    are the twin's last pass, also as the tab reads them."""
    s = result["summary"]
    d = ((result.get("delivered") or {}).get("summary")) or {}
    ox, fu = s["ox"], s["fuel"]
    lockup_ui = max(ox["t0_psia"], fu["t0_psia"])          # LayerXResult.tsx verdictItems
    target = float(prep.derived.get("target_lockup_psia") or 0.0)
    ambient_psia = float(prep.ambient_pa) / PSI
    copv_end = _num(s.get("copv_end_psia"))
    side = s.get("depleted_side") or ""
    other = fu if side == "oxidiser" else ox if side == "fuel" else None

    # Tank peaks during the burn alone (peak_psia also covers the hold).
    series = result["series"]
    fire = [i for i, f in enumerate(series["firing"]) if f]
    burn_peak = {k: (max(series[k]["tank_psia"][i] for i in fire) if fire else None) for k in ("ox", "fuel")}

    out: Dict[str, Any] = {
        # ---- performance (delivered: the replay's engine on the twin's steps)
        "total_impulse_Ns": _first(d.get("total_impulse_Ns"), s.get("total_impulse_Ns")),
        "burn_time_s": _num(s.get("burn_time_s")),
        "mean_thrust_N": _first(d.get("mean_thrust_N"), s.get("mean_thrust_N")),
        "min_thrust_N": _first(d.get("min_thrust_N"), s.get("min_thrust_N")),
        "max_thrust_N": _first(d.get("peak_thrust_N"), s.get("peak_thrust_N")),
        "pc_mean_psia": _first(d.get("pc_mean_psia"), s.get("pc_mean_psia")),
        "pc_min_psia": _first(d.get("pc_min_psia"), s.get("pc_min_psia")),
        "pc_max_psia": _first(d.get("pc_max_psia"), s.get("pc_max_psia")),
        "of_mean": _num(s.get("of_mean")),
        "of_min": _num(s.get("of_min")),
        "of_max": _num(s.get("of_max")),
        "isp_mean_s": _first(d.get("isp_mean_s"), s.get("isp_mean_s")),
        "propellant_used_kg": _num(s.get("propellant_used_kg")),
        # ---- the twin's own engine figures (card, as-built thrust law), for the record
        "twin": {
            "total_impulse_Ns": _num(s.get("total_impulse_Ns")),
            "impulse_to_depletion_Ns": _num(s.get("impulse_to_depletion_Ns")),
            "mean_thrust_N": _num(s.get("mean_thrust_N")),
            "min_thrust_N": _num(s.get("min_thrust_N")),
            "max_thrust_N": _num(s.get("peak_thrust_N")),
            "thrust_t0_N": _num(s.get("thrust_t0_N")),
            "pc_mean_psia": _num(s.get("pc_mean_psia")),
            "isp_mean_s": _num(s.get("isp_mean_s")),
        },
        # ---- pressurant
        "lockup_target_psia": target,
        "lockup_t0_psia": lockup_ui,
        "dome_psig": _num(prep.derived.get("dome_psig")),
        "copv_t0_psia": _num(s.get("copv_t0_psia")),
        "copv_end_psia": copv_end,
        "copv_over_lockup_psi": (copv_end - lockup_ui) if copv_end is not None else None,
        "copv_over_tank_end_psi": (copv_end - max(ox["end_psia"], fu["end_psia"])) if copv_end is not None else None,
        "copv_used_kg": _num(s.get("copv_used_kg")),
        "pressurant": prep.derived.get("pressurant_gas"),
        # ---- tanks
        "ox_tank": {
            "t0_psia": ox["t0_psia"], "min_psia": ox["min_psia"], "end_psia": ox["end_psia"],
            "peak_psia": ox["peak_psia"], "peak_burn_psia": burn_peak["ox"],
            "peak_across_wall_psi": ox["peak_psia"] - ambient_psia,
            "ignition_dip_psi": ox["ignition_dip_psi"], "inlet_mean_psia": ox["inlet_mean_psia"],
            "loaded_kg": ox["loaded_kg"], "residual_kg": ox["residual_kg"],
        },
        "fuel_tank": {
            "t0_psia": fu["t0_psia"], "min_psia": fu["min_psia"], "end_psia": fu["end_psia"],
            "peak_psia": fu["peak_psia"], "peak_burn_psia": burn_peak["fuel"],
            "peak_across_wall_psi": fu["peak_psia"] - ambient_psia,
            "ignition_dip_psi": fu["ignition_dip_psi"], "inlet_mean_psia": fu["inlet_mean_psia"],
            "loaded_kg": fu["loaded_kg"], "residual_kg": fu["residual_kg"],
        },
        "tank_mawp_psi": prep.derived.get("tank_mawp_psi"),
        # ---- injector stiffness (manifold to chamber over chamber; settled = after 0.2 s)
        "ox_stiffness_min": _num(ox.get("stiffness_min")),
        "fuel_stiffness_min": _num(fu.get("stiffness_min")),
        "ox_stiffness_min_ignition": _num(ox.get("stiffness_min_ignition")),
        "fuel_stiffness_min_ignition": _num(fu.get("stiffness_min_ignition")),
        "ox_dp_injector_min_psi": _num(ox.get("dp_injector_min_psi")),
        "fuel_dp_injector_min_psi": _num(fu.get("dp_injector_min_psi")),
        "stiffness_band": prep.derived.get("stiffness_band"),
        # ---- chug (EngineDesign's gain margin along the replay, worst over the mixing-lag band)
        "chug_margin_min": _num(d.get("chug_margin_min")),
        "chug_margin_min_t_s": _num(d.get("chug_margin_min_t")),
        # ---- depletion
        "depleted_side": side,
        "depleted_tank": s.get("depleted_tank"),
        "residual_other_kg": (other["residual_kg"] if other is not None else None),
        "residual_depleted_kg": ((ox if side == "oxidiser" else fu)["residual_kg"] if side else None),
        # ---- throat
        "throat_area_growth": _num(d.get("throat_area_growth")),
        "throat_recession_mm": _num(d.get("throat_recession_mm")),
        # ---- solver health
        "converged": result.get("converged"),
        "passes": len(result.get("passes") or []) or 1,
        "steps": s.get("steps"),
        "failed_steps": s.get("failed_steps"),
        "extrapolated_steps": s.get("extrapolated_steps"),
        "card_outside_steps": s.get("card_outside_steps"),
        "t0_settled": s.get("t0_settled"),
        "engine_check_worst": (result.get("engine_check") or {}).get("worst"),
        "replay_agreement_worst": (((result.get("passes") or [{}])[-1].get("agreement") or {}).get("worst")),
        "cross_check": {r["key"]: r.get("rel") for r in ((result.get("cross_check") or {}).get("rows") or [])},
        "wall_s": _num((result.get("provenance") or {}).get("wall_s")),
    }
    fl = result.get("flight")
    if fl is not None:
        ok = bool(fl.get("ok"))
        out["flight"] = {
            "ok": ok,
            "error": fl.get("error"),
            "apogee_agl_m": _num(fl.get("apogee_agl_m")) if ok else None,
            "apogee_agl_ft": (_num(fl.get("apogee_agl_m")) or 0.0) / 0.3048 if ok else None,
            "apogee_msl_m": _num(fl.get("apogee_msl_m")) if ok else None,
            "apogee_time_s": _num(fl.get("apogee_time_s")) if ok else None,
            "max_velocity_m_s": _num(fl.get("max_velocity_m_s")) if ok else None,
            "max_mach": _num(fl.get("max_mach")) if ok else None,
            "rail_exit_velocity_m_s": _num(fl.get("rail_exit_velocity_m_s")) if ok else None,
            "liftoff_mass_kg": _num(fl.get("liftoff_mass_kg")) if ok else None,
            "burnout_mass_kg": _num(fl.get("burnout_mass_kg")) if ok else None,
            "liftoff_accel_g": _num(fl.get("liftoff_accel_g")) if ok else None,
            "max_accel_g": _num(fl.get("max_accel_g")) if ok else None,
            "pad": fl.get("pad"),
            "in_flight": fl.get("in_flight"),
            "mass_budget": fl.get("mass_budget"),
        }
    out["apogee_agl_m"] = (out.get("flight") or {}).get("apogee_agl_m")
    return out


# ------------------------------------------------------------------ running


def _git_describe() -> str:
    try:
        r = subprocess.run(["git", "describe", "--always", "--dirty"], cwd=ROOT, capture_output=True, text=True, timeout=5)
        return r.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def _versions() -> Dict[str, Any]:
    out: Dict[str, Any] = {"python": platform.python_version(), "platform": platform.platform()}
    for mod in ("numpy", "scipy", "CoolProp", "fluids", "rocketpy", "numba", "feedtwin"):
        try:
            m = __import__(mod)
            out[mod] = getattr(m, "__version__", "?")
        except Exception:  # noqa: BLE001 - a missing optional module is recorded, not fatal
            out[mod] = None
    return out


def run_case(name: str, *, config: Any = None, config_source: Any = None, dt: Optional[float] = None,
             progress: Optional[Callable[[str, float], None]] = None, keep_result: bool = False) -> Dict[str, Any]:
    """Burn one case and return ``{"case", "settings", "inputs", "metrics", ...}``.

    ``config``: an engine config to use (it is deep-copied, as the router does); otherwise
    ``config_source`` is loaded with :func:`load_engine_config`. ``dt`` overrides the default step."""
    from engine.core.runner import PintleEngineRunner
    from engine.layerx import LayerXSettings, prepare, run_prepared
    from engine.layerx.fingerprint import config_fingerprint
    from engine.layerx.sources import cea_table_path, machines_dir

    spec = CASES[name]
    info: Dict[str, Any] = {"kind": "given", "path": None}
    if config is None:
        config, info = load_engine_config(config_source)
    drawing = find_drawing(spec["drawing"])
    kwargs: Dict[str, Any] = {"drawing_id": drawing.id, "flight": bool(spec["flight"]), **(spec.get("settings") or {})}
    if dt is not None:
        kwargs["dt"] = float(dt)
    settings = LayerXSettings(**kwargs)

    started = time.perf_counter()
    cfg = _patched(copy.deepcopy(config), spec.get("config_patch"))
    runner = PintleEngineRunner(cfg)
    prep = prepare(cfg, runner, drawing, settings, [])
    prep_s = time.perf_counter() - started
    failing = [f"{c.key}: {c.detail}" for c in prep.checks if c.status == "fail"]
    if not prep.ok:
        raise RuntimeError(f"{name}: preflight failed: {failing}")
    result = run_prepared(prep, runner=runner, replay=prep.settings.replay, config=cfg,
                          progress=progress or (lambda stage, frac: None))
    total_s = time.perf_counter() - started
    m = metrics(result, prep)
    m["wall_total_s"] = total_s
    m["wall_prepare_s"] = prep_s
    cea = cea_table_path(cfg)
    out = {
        "case": name,
        "label": spec["label"],
        "supplementary": bool(spec.get("supplementary")),
        "config_patch": spec.get("config_patch"),
        "settings": {k: v for k, v in settings.__dict__.items()},
        "inputs": {
            "config_source": info,
            "config_sha256": config_fingerprint(config),
            "config_sha256_burned": config_fingerprint(cfg),
            "drawing": {"name": drawing.name, "id": drawing.id, "sha256": drawing.sha256, "source": drawing.source},
            "cea_table": {"name": cea.name if cea else None, "sha256": _sha256_file(cea)},
            "state_machines_sha256": _sha256_dir(machines_dir()),
            "ambient_pa": prep.ambient_pa,
        },
        "checks": [{"key": c.key, "status": c.status, "detail": c.detail} for c in prep.checks
                   if c.status in ("warn", "fail")],
        "metrics": m,
    }
    if keep_result:
        out["result"] = result
    return out


def run_baseline(cases: Optional[Iterable[str]] = None, *, config_source: Any = None, dt: Optional[float] = None,
                 embed_config: bool = True, verbose: bool = True) -> Dict[str, Any]:
    """Every case in ``cases`` (all by default) on one config. The config is embedded so the
    baseline can be burned again on exactly this design (``--config <baseline.json>``)."""
    from dataclasses import asdict

    from engine.layerx import LayerXSettings
    from engine.layerx.fingerprint import config_fingerprint

    config, info = load_engine_config(config_source)
    names = list(cases or BASELINE_CASES)
    out: Dict[str, Any] = {
        "what": "LE4 Layer X baseline: in-process burns at today's default LayerXSettings",
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "code": _git_describe(),
        "versions": _versions(),
        "config_source": info,
        "config_sha256": config_fingerprint(config),
        # The library's defaults the cases ran on (drawing_id aside), so a changed default is seen.
        "layerx_settings_defaults": {k: v for k, v in asdict(LayerXSettings(drawing_id="")).items()
                                     if k != "drawing_id"},
        "cases": {},
    }
    for name in names:
        if verbose:
            print(f"[layerx_baseline] {name}: {CASES[name]['label']} ...", flush=True)
        out["cases"][name] = run_case(name, config=config, dt=dt)
        out["cases"][name]["inputs"]["config_source"] = info
        if verbose:
            print(format_case(out["cases"][name]), flush=True)
    if embed_config:
        out["inputs"] = {"config": config.model_dump(mode="json")}
    return out


# ------------------------------------------------------------------ printing


def _f(v: Any, nd: int = 1, unit: str = "") -> str:
    f = _num(v)
    return "-" if f is None else f"{f:,.{nd}f}{(' ' + unit) if unit else ''}"


def format_case(case: Dict[str, Any]) -> str:
    m = case["metrics"]
    o, fu = m["ox_tank"], m["fuel_tank"]
    lines = [
        f"  {case['case']}  ({case['inputs']['drawing']['name']}, {m['pressurant']}, dt {case['settings']['dt']} s)",
        f"    impulse {_f(m['total_impulse_Ns'], 0, 'N·s')}   burn {_f(m['burn_time_s'], 3, 's')}   "
        f"thrust mean/min/max {_f(m['mean_thrust_N'], 0)}/{_f(m['min_thrust_N'], 0)}/{_f(m['max_thrust_N'], 0)} N",
        f"    Pc mean {_f(m['pc_mean_psia'], 1, 'psia')} ({_f(m['pc_min_psia'], 1)}-{_f(m['pc_max_psia'], 1)})   "
        f"O/F {_f(m['of_mean'], 4)}   Isp {_f(m['isp_mean_s'], 2, 's')}   burned {_f(m['propellant_used_kg'], 3, 'kg')}",
        f"    bottle {_f(m['copv_t0_psia'], 0)} -> {_f(m['copv_end_psia'], 1, 'psia')} at burnout, "
        f"{_f(m['copv_over_lockup_psi'], 1, 'psi')} over lockup ({_f(m['copv_over_tank_end_psi'], 1, 'psi')} over the tanks at end), "
        f"{_f(m['copv_used_kg'], 4, 'kg')} used",
        f"    tanks LOX t0/min/end/peak {_f(o['t0_psia'])}/{_f(o['min_psia'])}/{_f(o['end_psia'])}/{_f(o['peak_psia'])} psia   "
        f"fuel {_f(fu['t0_psia'])}/{_f(fu['min_psia'])}/{_f(fu['end_psia'])}/{_f(fu['peak_psia'])} psia",
        f"    min dP/Pc LOX {_f((m['ox_stiffness_min'] or 0) * 100, 2, '%')} (ign {_f((m['ox_stiffness_min_ignition'] or 0) * 100, 2, '%')})   "
        f"fuel {_f((m['fuel_stiffness_min'] or 0) * 100, 2, '%')} (ign {_f((m['fuel_stiffness_min_ignition'] or 0) * 100, 2, '%')})",
        f"    chug margin min {_f(m['chug_margin_min'], 3)} at {_f(m['chug_margin_min_t_s'], 2, 's')}   "
        f"depleted {m['depleted_side']} ({_f(m['residual_other_kg'], 4, 'kg')} of the other left)   "
        f"throat +{_f((m['throat_area_growth'] or 0) * 100, 2, '%')} area, {_f(m['throat_recession_mm'], 3, 'mm')}",
        f"    converged {m['converged']} in {m['passes']} pass(es), failed steps {m['failed_steps']}, "
        f"wall {_f(m['wall_total_s'], 1, 's')} (prepare {_f(m['wall_prepare_s'], 1, 's')})",
    ]
    fl = m.get("flight")
    if fl is not None:
        if fl.get("ok"):
            lines.append(f"    apogee {_f(fl['apogee_agl_m'], 0, 'm')} AGL ({_f(fl['apogee_agl_ft'], 0, 'ft')}), "
                         f"liftoff {_f(fl['liftoff_mass_kg'], 2, 'kg')} at {_f(fl['liftoff_accel_g'], 2, 'g')}, "
                         f"max {_f(fl['max_accel_g'], 2, 'g')}, Mach {_f(fl['max_mach'], 2)}")
        else:
            lines.append(f"    flight FAILED: {fl.get('error')}")
    return "\n".join(lines)


def _json_default(o: Any) -> Any:
    if hasattr(o, "item"):
        return o.item()
    return str(o)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--case", action="append", choices=sorted(CASES),
                    help=f"case to run (repeatable; default the baseline's {', '.join(BASELINE_CASES)})")
    ap.add_argument("--all", action="store_true", help="the baseline's cases and the supplementary ones")
    ap.add_argument("--dt", type=float, default=None, help="time step [s] (default: LayerXSettings's, 0.05)")
    ap.add_argument("--out", type=Path, default=None, help="write the JSON here")
    ap.add_argument("--config", default=None,
                    help="engine config: YAML, app document JSON, or a baseline JSON (default configs/ethalox_6800N.yaml)")
    ap.add_argument("--no-embed", action="store_true", help="do not embed the config in the JSON")
    args = ap.parse_args(argv)

    cases = list(CASES) if args.all else args.case
    data = run_baseline(cases, config_source=args.config, dt=args.dt, embed_config=not args.no_embed)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(data, indent=1, default=_json_default) + "\n")
        print(f"[layerx_baseline] wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

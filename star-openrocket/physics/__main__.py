"""CLI: python -m physics config.json

PLAN.md §11.2 makes this an invariant, not a development phase. The library has
a CLI; the web app is one consumer, the test suite and notebooks are others. It
stays working as a debugging escape hatch -- a way to bisect a bug without
React in the stack.

The file this accepts is byte-identical to what the GUI's Save produces: the
form state *is* the config schema, one serialiser, no translation layer.
"""

import argparse
import json
import sys

from physics.cases import evaluate_all, sweep
from physics.report import render, render_crosscheck, render_sweep
from physics.schema import Config


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="python -m physics",
        description="1-D recovery descent and opening loads. See PLAN.md.",
    )
    ap.add_argument("config", help="JSON config file (schema)")
    ap.add_argument(
        "--which", choices=("axial", "broadside", "both"), default="both",
        help="airframe drag bound. Default 'both' -- does not permit "
             "picking one, and for the worked vehicle the band is worth 2.1x "
             "on the design load.",
    )
    ap.add_argument("--sweep", action="store_true",
                    help="also run the 16-corner uncertainty sweep")
    ap.add_argument(
        "--crosscheck", action="store_true",
        help="also run OpenRocket's descent model and the recovery "
             "mastersheet's, and tabulate all three. Comparison only -- it "
             "sizes nothing.",
    )
    ap.add_argument(
        "--wind", type=float, default=0.0, metavar="M_S",
        help="wind speed for the mastersheet's drift estimate, m/s. Ours and "
             "OpenRocket's runs are windless either way (Phase 1, §14).",
    )
    ap.add_argument("--json", action="store_true",
                    help="emit machine-readable results instead of a report")
    args = ap.parse_args(argv)

    with open(args.config, encoding="utf-8") as handle:
        config = Config.model_validate(json.load(handle))

    bounds = ("axial", "broadside") if args.which == "both" else (args.which,)

    payload = {}
    for which in bounds:
        results = evaluate_all(config, which=which)
        payload[which] = results
        if not args.json:
            print(render(config, results, which))
            print()

    if args.sweep:
        rows = sweep(config)
        if not args.json:
            print(render_sweep(rows))

    comparison = None
    if args.crosscheck:
        # Always at the axial bound, whatever --which asked for: the other two
        # models have no airframe term to vary, so running the comparison at
        # both bounds would print the same two foreign columns twice.
        from physics.crosscheck import crosscheck

        comparison = crosscheck(config, which="axial", wind_ms=args.wind)
        if not args.json:
            print(render_crosscheck(comparison))

    if args.json:
        out = _to_json(payload)
        if comparison is not None:
            # A sibling key, not a member of `payload`: that dict is indexed by
            # airframe bound and `_to_json` walks it as such, so hanging a
            # comparison off it would be a shape error waiting to happen.
            out["crosscheck"] = {
                "which": comparison.which,
                "wind_ms": comparison.wind,
                "metrics": [m.as_dict() for m in comparison.metrics],
                "warnings": comparison.warnings,
            }
        print(json.dumps(out, indent=2))
    return 0


def _to_json(payload):
    out = {}
    for which, results in payload.items():
        out[which] = {}
        for case, cr in results.items():
            out[which][case] = {
                "descent_time_s": cr.run.t_ground,
                "impact_speed_ms": cr.run.v_impact,
                "F_design_N": cr.design.F_design,
                "governing_device": cr.design.governing_device,
                "governing_candidate": cr.design.governing_candidate,
                "devices": [d.as_dict() for d in cr.per_device],
                "warnings": cr.run.warnings,
            }
    return out


if __name__ == "__main__":
    sys.exit(main())

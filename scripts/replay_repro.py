#!/usr/bin/env python3
"""Play a feed-twin repro (Solver tab -> "export repro") on this machine.

    python3 scripts/replay_repro.py repro.json
    python3 scripts/replay_repro.py repro.json --until 120 --every 5

The repro carries the drawing and the engine themselves, the setup the stand
was opened with, the hookup it ran and every command and T-0 at its stand time.
This opens the same stand in a throwaway library (never the real one -- see
FEEDTWIN_LIBRARY), plays the commands at their times, and prints the end state
and the watcher's flags beside the ones the original run recorded.

The ticks are this script's, not the browser's, so a replay integrates the same
commands on a slightly different grid: numbers agree closely, not bit for bit.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
#: The longest tick played [s]: the console's own ceiling.
TICK = 0.5


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("repro", type=Path)
    parser.add_argument("--until", type=float, help="stop at this stand time [s]")
    parser.add_argument(
        "--every", type=float, default=0.0, help="print the tanks this often [s]"
    )
    args = parser.parse_args()
    repro = json.loads(args.repro.read_text())
    if repro.get("kind") != "feedtwin-repro":
        print("not a feed-twin repro", file=sys.stderr)
        return 2

    # A scratch library and user store, set before the app is imported: the
    # app's library is the real one otherwise.
    scratch = Path(tempfile.mkdtemp(prefix="feedtwin-repro-"))
    os.environ["FEEDTWIN_LIBRARY"] = str(scratch / "library")
    os.environ["USERDATA_DIR"] = str(scratch / "userdata")
    os.environ.setdefault("FEEDTWIN_S3_BUCKET", "")
    sys.path.insert(0, str(ROOT / "feed-twin"))
    from fastapi.testclient import TestClient

    from backend.main import app, library

    client = TestClient(app)
    opened = repro["opened"]

    def ok(response: Any) -> Any:
        if response.status_code != 200:
            raise SystemExit(
                f"{response.request.url}: {response.status_code} {response.text}"
            )
        return response.json()

    name = opened.get("drawing_name") or "repro"
    drawing = ok(
        client.post(
            "/api/library/diagrams",
            files={
                "file": (
                    f"{name}.json",
                    json.dumps(repro["drawing"]).encode(),
                    "application/json",
                )
            },
        )
    )["artifact"]["id"]
    engine = ""
    if repro.get("engine"):
        e = repro["engine"]
        engine = ok(
            client.post(
                "/api/library/engines",
                files={"file": (e["filename"], e["text"].encode(), "text/yaml")},
            )
        )["artifact"]["id"]
        if e.get("card"):
            library.attach(engine, "card", json.dumps(e["card"]).encode())

    body = {k: v for k, v in (opened.get("body") or {}).items() if k != "stand"}
    if repro.get("hookup"):
        body["hookup"] = repro["hookup"]
    session = ok(
        client.post(
            "/api/session",
            params={
                "diagram": drawing,
                "engine": engine,
                "fluid_set": opened.get("fluid_set", "hotfire"),
                "machine": opened.get("machine", "diablo"),
                "multiphase": opened.get("multiphase", False),
            },
            json=body,
        )
    )
    sid = session["id"]
    print(
        f"{name}: {len(repro['events'])} events to {repro['end']['t']:.1f} s "
        f"(exported {repro.get('exported_at', '?')}, commit {repro['code'].get('commit')}"
        f"{' dirty' if repro['code'].get('dirty') else ''})"
    )

    state = {"t": session["t"], "last_print": -1e9}

    def show(frame: dict[str, Any]) -> None:
        tanks = ", ".join(
            f"{t['label']} {t['pressure_psi'] + 14.696:.1f} psia {t['liquid_mass_kg']:.3f} kg"
            for t in frame["tanks"]
        )
        print(f"  t={frame['t']:8.2f}  {frame.get('state', '')}: {tanks}")

    def run_to(t_end: float) -> None:
        while state["t"] < t_end - 1e-6:
            dt = min(TICK, t_end - state["t"])
            frame = ok(client.post(f"/api/session/{sid}/tick", json={"dt": dt}))
            state["t"] = frame["t"]
            if args.every and state["t"] - state["last_print"] >= args.every:
                state["last_print"] = state["t"]
                show(frame)

    end = repro["end"]["t"] if args.until is None else args.until
    for event in repro["events"]:
        if event["t"] > end:
            break
        run_to(event["t"])
        if "command" in event:
            print(
                f"  t={event['t']:8.2f}  command {json.dumps(event['command'])[:120]}"
            )
            frame = client.post(f"/api/session/{sid}/command", json=event["command"])
            if frame.status_code != 200:
                print(f"             refused: {frame.status_code} {frame.text[:160]}")
            else:
                state["t"] = frame.json()["t"]
        elif event.get("t0"):
            print(f"  t={event['t']:8.2f}  T-0")
            state["t"] = ok(client.post(f"/api/session/{sid}/t0"))["t"]
    run_to(end)

    replayed = ok(client.get(f"/api/session/{sid}/repro"))["end"]
    print("\nend of replay vs the original:")
    for label, tank in replayed["tanks"].items():
        was = repro["end"]["tanks"].get(label, {})
        print(
            f"  {label:22s} {tank['pressure_psi'] + 14.696:9.2f} psia {tank['liquid_kg']:8.3f} kg"
            f"   (was {was.get('pressure_psi', float('nan')) + 14.696:9.2f} psia "
            f"{was.get('liquid_kg', float('nan')):8.3f} kg)"
        )
    for title, flags in (
        ("flags in the replay", replayed["flags"]),
        ("flags in the original", repro["end"].get("flags", [])),
    ):
        print(f"\n{title}: {len(flags) or 'none'}")
        for f in flags:
            print(
                f"  [{f['started']:8.2f} - {f['last']:8.2f}{' open' if f['open'] else ''}] "
                f"{f['title']} | {f['subject']} | {f['detail']}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())

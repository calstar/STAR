"""One-time bulk mirror of the thrustcurve.org catalog into ``cache/motors/``.

    python -m backend.motors.fetch                 # mirror everything
    python -m backend.motors.fetch --manufacturer Estes --limit 50   # a slice, for testing
    python -m backend.motors.fetch --force         # re-download already-cached motors

Enumerates motors per manufacturer (search caps its result count), downloads both RASP and
RockSim files, parses them with our OpenRocket-faithful loaders, and writes the parsed arrays
plus a searchable index. Idempotent and resumable: motors whose data file already exists are
kept as-is unless ``--force``. This is the only step that hits the network.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from . import load_motor_text
from .db import MotorDB, motor_to_dict
from .motor import Motor
from .thrustcurve import ThrustCurveClient

MOTORS_DIR = Path(__file__).resolve().parents[2] / "cache" / "motors"
_BATCH = 25


def _meta_from_result(r: dict) -> dict:
    """Lightweight, searchable record kept in index.json."""
    return {
        "motorId": r.get("motorId"),
        "manufacturer": r.get("manufacturer"),
        "manufacturerAbbrev": r.get("manufacturerAbbrev"),
        "designation": r.get("designation"),
        "commonName": r.get("commonName"),
        "impulseClass": r.get("impulseClass"),
        "diameter": r.get("diameter"),  # mm
        "length": r.get("length"),  # mm
        "type": r.get("type"),
        "totalWeightG": r.get("totalWeightG"),
        "propWeightG": r.get("propWeightG"),
        "delays": r.get("delays"),
        "avgThrustN": r.get("avgThrustN"),
        "maxThrustN": r.get("maxThrustN"),
        "totImpulseNs": r.get("totImpulseNs"),
        "burnTimeS": r.get("burnTimeS"),
        "infoUrl": r.get("infoUrl"),
    }


def _enrich(motor: Motor, meta: dict, simfile_id: str, fmt: str) -> Motor:
    motor.motor_id = meta.get("motorId") or ""
    motor.simfile_id = simfile_id
    motor.file_format = fmt
    motor.common_name = meta.get("commonName") or ""
    motor.impulse_class = meta.get("impulseClass") or ""
    return motor


def _simfile_meta(motors: list[Motor]) -> list[dict]:
    return [
        {"simfileId": s.simfile_id, "format": s.file_format, "quality": s.quality}
        for s in motors
    ]


def _write_motor_data(db: MotorDB, motor_id: str, simfiles: list[Motor]) -> None:
    path = db._data_path(motor_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"motorId": motor_id, "simfiles": [motor_to_dict(s) for s in simfiles]}
    path.write_text(json.dumps(payload))


def _batches(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def fetch(out_dir: Path, manufacturer: str | None, limit: int | None, force: bool) -> None:
    db = MotorDB(out_dir)
    (out_dir / "data").mkdir(parents=True, exist_ok=True)

    index_motors: list[dict] = []
    total_simfiles = 0

    with ThrustCurveClient() as client:
        manufacturers = (
            [manufacturer] if manufacturer else client.list_manufacturers()
        )
        print(f"Mirroring {len(manufacturers)} manufacturer(s) -> {out_dir}")

        seen = 0
        for mi, mfg in enumerate(manufacturers, 1):
            results = client.search(mfg)
            meta_by_id = {r["motorId"]: _meta_from_result(r) for r in results if r.get("motorId")}
            print(f"  [{mi}/{len(manufacturers)}] {mfg}: {len(meta_by_id)} motors")

            # Which motors still need downloading?
            to_download = []
            for mid, meta in meta_by_id.items():
                if limit is not None and seen >= limit:
                    break
                seen += 1
                if not force and db._data_path(mid).exists():
                    simfiles = db.get_simfiles(mid)
                    meta["simfiles"] = _simfile_meta(simfiles)
                    index_motors.append(meta)
                    total_simfiles += len(simfiles)
                else:
                    to_download.append(mid)

            for batch in _batches(to_download, _BATCH):
                downloaded: dict[str, list[Motor]] = {mid: [] for mid in batch}
                for fmt in ("RASP", "RockSim"):
                    for f in client.download(batch, fmt):
                        if f.motor_id not in downloaded:
                            continue
                        try:
                            parsed = load_motor_text(_fname(f.fmt), f.text)
                        except Exception:  # noqa: BLE001 - skip unparseable catalog files
                            continue
                        if not parsed:
                            continue
                        motor = _enrich(parsed[0], meta_by_id[f.motor_id], f.simfile_id, f.fmt)
                        downloaded[f.motor_id].append(motor)

                for mid in batch:
                    simfiles = downloaded[mid]
                    meta = meta_by_id[mid]
                    if simfiles:
                        _write_motor_data(db, mid, simfiles)
                    meta["simfiles"] = _simfile_meta(simfiles)
                    index_motors.append(meta)
                    total_simfiles += len(simfiles)

            if limit is not None and seen >= limit:
                break

    index = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "count": len(index_motors),
        "simfileCount": total_simfiles,
        "motors": index_motors,
    }
    db.index_path.write_text(json.dumps(index))
    print(f"Done: {len(index_motors)} motors, {total_simfiles} simfiles -> {db.index_path}")


def _fname(fmt: str) -> str:
    return "m.rse" if fmt == "RockSim" else "m.eng"


def main() -> None:
    parser = argparse.ArgumentParser(description="Mirror the thrustcurve.org motor catalog.")
    parser.add_argument("--out", type=Path, default=MOTORS_DIR, help="output cache dir")
    parser.add_argument("--manufacturer", help="limit to one manufacturer abbreviation")
    parser.add_argument("--limit", type=int, help="cap the number of motors (for testing)")
    parser.add_argument("--force", action="store_true", help="re-download cached motors")
    args = parser.parse_args()
    fetch(args.out, args.manufacturer, args.limit, args.force)


if __name__ == "__main__":
    main()

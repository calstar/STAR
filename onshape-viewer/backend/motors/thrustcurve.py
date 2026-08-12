"""thrustcurve.org REST API v1 client.

The upstream source OpenRocket itself pulls from. Three endpoints matter:

* ``GET  /metadata.json``  -> the list of manufacturers (used to enumerate the catalog,
  since ``search`` caps its result count).
* ``POST /search.json``    -> motor metadata records (incl. the 24-hex ``motorId``).
* ``POST /download.json``  -> simulator files; we request ``data="file"`` for both RASP and
  RockSim formats and base64-decode the raw file so our own OpenRocket-faithful parsers run.

This is the **only** module that touches the network. Requests are throttled and retried; the
mirror is written once by ``fetch.py`` and everything else reads the offline cache via ``db``.
"""

from __future__ import annotations

import base64
import time as _time
from dataclasses import dataclass

import httpx

BASE_URL = "https://www.thrustcurve.org/api/v1"
DEFAULT_TIMEOUT = 30.0
#: Polite delay between calls; the catalog is a few thousand motors fetched once.
THROTTLE_S = 0.25


@dataclass
class DownloadedFile:
    motor_id: str
    simfile_id: str
    fmt: str  # "RASP" | "RockSim"
    text: str  # decoded file contents


class ThrustCurveClient:
    def __init__(self, timeout: float = DEFAULT_TIMEOUT, throttle: float = THROTTLE_S) -> None:
        self._client = httpx.Client(
            base_url=BASE_URL,
            timeout=timeout,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        self._throttle = throttle

    def __enter__(self) -> "ThrustCurveClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def _post(self, path: str, payload: dict, retries: int = 3) -> dict:
        last: Exception | None = None
        for attempt in range(retries):
            try:
                r = self._client.post(path, json=payload)
                r.raise_for_status()
                _time.sleep(self._throttle)
                return r.json()
            except httpx.HTTPError as exc:  # transient network / 5xx
                last = exc
                _time.sleep(self._throttle * (attempt + 2))
        raise RuntimeError(f"thrustcurve.org POST {path} failed: {last}")

    def list_manufacturers(self) -> list[str]:
        """Manufacturer abbreviations, for enumerating the catalog by maker."""
        r = self._client.get("/metadata.json")
        r.raise_for_status()
        _time.sleep(self._throttle)
        data = r.json()
        return [m["abbrev"] for m in data.get("manufacturers", []) if m.get("abbrev")]

    def search(self, manufacturer: str, max_results: int = 5000) -> list[dict]:
        """All motor metadata records for one manufacturer."""
        payload = {"manufacturer": manufacturer, "maxResults": max_results}
        return self._post("/search.json", payload).get("results", [])

    def download(self, motor_ids: list[str], fmt: str) -> list[DownloadedFile]:
        """Raw simulator files (base64-decoded) for the given motors in one format."""
        if not motor_ids:
            return []
        payload = {
            "motorIds": motor_ids,
            "format": fmt,
            "data": "file",
            "maxResults": len(motor_ids) * 8,
        }
        results = self._post("/download.json", payload).get("results", [])
        files: list[DownloadedFile] = []
        for entry in results:
            raw = entry.get("data")
            if not raw:
                continue
            try:
                text = base64.b64decode(raw).decode(
                    "iso-8859-1" if fmt == "RASP" else "utf-8", errors="replace"
                )
            except (ValueError, UnicodeDecodeError):
                continue
            files.append(
                DownloadedFile(
                    motor_id=entry.get("motorId", ""),
                    simfile_id=entry.get("simfileId", ""),
                    fmt=entry.get("format", fmt),
                    text=text,
                )
            )
        return files

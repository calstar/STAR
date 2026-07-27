#!/usr/bin/env python3
"""Scrape every parachute's metrics from the Fruity Chutes descent-rate calculator.

The calculator page (fruitychutes.com/help_for_parachutes/parachute-descent-rate-calculator)
backs its "Parachute Metrics" table with a plain JSON endpoint:

    GET /parachuteapi.js?method=get&term=<SKU>   ->  [ { ...one record per match... } ]

The response fields are exactly the rows of the on-page metrics table, so there is
no need to parse rendered HTML for the numbers. This script discovers the full SKU
list (the calculator's "model" dropdown), fetches each record, and writes the
results to SQLite (primary output), plus JSON and CSV.

Stdlib only -- no pip install required.

    python3 scrape_fruitychutes.py --out-dir out
    python3 scrape_fruitychutes.py --skus CFC-96 TARC-16 --out-dir out
    python3 scrape_fruitychutes.py --from-har capture.har --db parachutes.db
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import json
import logging
import os
import random
import re
import sqlite3
import string
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

BASE = "https://fruitychutes.com"
API_PATH = "/parachuteapi.js"
CALCULATOR_PATH = "/help_for_parachutes/parachute-descent-rate-calculator"

# The three XHRs in the reference HAR carried no cookies at all, so nothing is
# gated on a session or CSRF token. The response does carry
# "vary: Accept-Encoding,User-Agent" though, so a real browser UA is worth
# sending -- the server may serve different bytes to unknown agents.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)

# JSON field -> label used in the calculator's "Parachute Metrics" table.
# Order here is the column order of the emitted CSV.
METRIC_LABELS: Dict[str, str] = {
    "SKU": "SKU",
    "model": "Model",
    "trim": "Trim",
    "style": "Chute Style",
    "canopy_style": "Canopy Shape",
    "diameter": "Canopy Diameter (in)",
    "diameter_spill": "Diameter Spill Hole (in)",
    "gores": "Number Gores",
    "rate_20": "Rating @ 20fps (lbs)",
    "rate_15": "Rating @ 15fps (lbs)",
    "weight_oz": "Weight oz",
    "weight_grams": "Weight grams",
    "packing_volume": "Packing Volume (in^3)",
    "area_projected": "Area Projected (sq ft)",
    "area_canopy": "Area Canopy (sq ft)",
    "cd_projected": "Cd Projected",
    "cd_area_canopy": "Cd Area Canopy",
    # The API really does spell it "flattend" -- keep the key, fix the label.
    "equivalent_flattend_d": "Equivalent Flattened D (in)",
    "performance_ratio_20": "Performance Ratio 20fps (rating @ 20fps / weight)",
    "performance_ratio_15": "Performance Ratio 15fps (rating @ 15fps / weight)",
    "manufacturer": "Manufacturer",
    # Present in the API response but not shown in the on-page table.
    "area_spill": "Area Spill (sq ft)",
    "id": "Internal ID",
    "description": "Description",
    "url": "URL",
}

log = logging.getLogger("fruitychutes")


# ---------------------------------------------------------------------------
# SQLite schema
# ---------------------------------------------------------------------------

TABLE = "parachutes"

# One row per SKU. The API hands back every number as a string ("96.0000"), so
# they are coerced to REAL here to keep the table directly queryable for chute
# sizing. `raw_json` preserves the untouched response in case a field is added
# upstream or a coercion ever loses something.
SCHEMA = f"""
CREATE TABLE IF NOT EXISTS {TABLE} (
    sku                         TEXT    PRIMARY KEY,
    api_id                      INTEGER,
    model                       TEXT,
    trim                        TEXT,
    style                       TEXT,
    canopy_style                TEXT,
    diameter_in                 REAL,
    diameter_spill_in           REAL,
    gores                       REAL,
    rating_20fps_lb             REAL,
    rating_15fps_lb             REAL,
    weight_oz                   REAL,
    weight_g                    REAL,
    packing_volume_in3          REAL,
    area_projected_sqft         REAL,
    area_canopy_sqft            REAL,
    area_spill_sqft             REAL,
    cd_projected                REAL,
    cd_area_canopy              REAL,
    equivalent_flat_diameter_in REAL,
    performance_ratio_20fps     REAL,
    performance_ratio_15fps     REAL,
    manufacturer                TEXT,
    description                 TEXT,
    url                         TEXT,
    source                      TEXT    NOT NULL,
    scraped_at                  TEXT    NOT NULL,
    raw_json                    TEXT    NOT NULL
);

-- Sizing a chute means "what holds <weight> at <descent rate>", so index the
-- ratings and the columns used to narrow by product line and size.
CREATE INDEX IF NOT EXISTS idx_{TABLE}_model       ON {TABLE}(model);
CREATE INDEX IF NOT EXISTS idx_{TABLE}_diameter    ON {TABLE}(diameter_in);
CREATE INDEX IF NOT EXISTS idx_{TABLE}_rating_20   ON {TABLE}(rating_20fps_lb);
CREATE INDEX IF NOT EXISTS idx_{TABLE}_rating_15   ON {TABLE}(rating_15fps_lb);
CREATE INDEX IF NOT EXISTS idx_{TABLE}_canopy      ON {TABLE}(canopy_style);
"""

# db column -> (api field, coercion)
COLUMN_MAP: Sequence[Tuple[str, str, str]] = (
    ("sku", "SKU", "text"),
    ("api_id", "id", "int"),
    ("model", "model", "text"),
    ("trim", "trim", "text"),
    ("style", "style", "text"),
    ("canopy_style", "canopy_style", "text"),
    ("diameter_in", "diameter", "real"),
    ("diameter_spill_in", "diameter_spill", "real"),
    ("gores", "gores", "real"),
    ("rating_20fps_lb", "rate_20", "real"),
    ("rating_15fps_lb", "rate_15", "real"),
    ("weight_oz", "weight_oz", "real"),
    ("weight_g", "weight_grams", "real"),
    ("packing_volume_in3", "packing_volume", "real"),
    ("area_projected_sqft", "area_projected", "real"),
    ("area_canopy_sqft", "area_canopy", "real"),
    ("area_spill_sqft", "area_spill", "real"),
    ("cd_projected", "cd_projected", "real"),
    ("cd_area_canopy", "cd_area_canopy", "real"),
    ("equivalent_flat_diameter_in", "equivalent_flattend_d", "real"),
    ("performance_ratio_20fps", "performance_ratio_20", "real"),
    ("performance_ratio_15fps", "performance_ratio_15", "real"),
    ("manufacturer", "manufacturer", "text"),
    ("description", "description", "text"),
    ("url", "url", "text"),
)


def _coerce(value: Any, kind: str) -> Any:
    if value is None or value == "":
        return None
    if kind == "text":
        return str(value)
    try:
        return int(value) if kind == "int" else float(value)
    except (TypeError, ValueError):
        log.debug("Could not coerce %r to %s; storing NULL", value, kind)
        return None


def _row(record: Dict[str, Any], source: str, scraped_at: str) -> Tuple[Any, ...]:
    values = [_coerce(record.get(field), kind) for _, field, kind in COLUMN_MAP]
    values.append(source)
    values.append(scraped_at)
    values.append(json.dumps(record, sort_keys=True))
    return tuple(values)


def write_sqlite(
    records: Sequence[Dict[str, Any]],
    path: str,
    *,
    source: str = "api",
    scraped_at: Optional[str] = None,
) -> int:
    """Upsert records into the SQLite table, creating it if needed.

    Upsert (rather than replace) means a partial run tops the table up instead
    of truncating it, so a scrape interrupted halfway is never destructive.
    """
    stamp = scraped_at or dt.datetime.now(dt.timezone.utc).isoformat(
        timespec="seconds"
    )
    columns = [column for column, _, _ in COLUMN_MAP] + [
        "source",
        "scraped_at",
        "raw_json",
    ]
    placeholders = ",".join("?" * len(columns))
    updates = ",".join(f"{c}=excluded.{c}" for c in columns if c != "sku")
    statement = (
        f"INSERT INTO {TABLE} ({','.join(columns)}) VALUES ({placeholders}) "
        f"ON CONFLICT(sku) DO UPDATE SET {updates}"
    )

    connection = sqlite3.connect(path)
    try:
        connection.executescript(SCHEMA)
        with connection:
            connection.executemany(
                statement, [_row(r, source, stamp) for r in records]
            )
        total = connection.execute(f"SELECT COUNT(*) FROM {TABLE}").fetchone()[0]
    finally:
        connection.close()
    log.info("Wrote %s (%d upserted, %d rows total)", path, len(records), total)
    return total


class FruityChutesClient:
    """Minimal polite HTTP client for the parachute API."""

    def __init__(
        self,
        delay: float = 0.5,
        timeout: float = 30.0,
        retries: int = 4,
        jitter: float = 0.25,
    ) -> None:
        self.delay = delay
        self.timeout = timeout
        self.retries = retries
        self.jitter = jitter
        self._last_request = 0.0
        self._opener = urllib.request.build_opener()

    # -- transport ---------------------------------------------------------

    def _throttle(self) -> None:
        wait = self.delay - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)

    def _headers(self, *, xhr: bool) -> Dict[str, str]:
        headers = {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
            "Referer": BASE + CALCULATOR_PATH,
        }
        if xhr:
            # Mirrors what descentRate.js sends via jQuery $.ajax.
            headers["Accept"] = "*/*"
            headers["X-Requested-With"] = "XMLHttpRequest"
        else:
            headers["Accept"] = "text/html,application/xhtml+xml,*/*;q=0.8"
        return headers

    @staticmethod
    def _decode(response: Any) -> str:
        raw = response.read()
        encoding = (response.headers.get("Content-Encoding") or "").lower()
        if encoding == "gzip":
            raw = gzip.decompress(raw)
        elif encoding == "deflate":
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                raw = zlib.decompress(raw, -zlib.MAX_WBITS)
        charset = response.headers.get_content_charset() or "utf-8"
        return raw.decode(charset, errors="replace")

    def get(self, url: str, *, xhr: bool = True) -> Optional[str]:
        """GET a URL with throttling and exponential backoff. None on failure."""
        request = urllib.request.Request(url, headers=self._headers(xhr=xhr))
        for attempt in range(1, self.retries + 1):
            self._throttle()
            try:
                with self._opener.open(request, timeout=self.timeout) as response:
                    self._last_request = time.monotonic()
                    return self._decode(response)
            except urllib.error.HTTPError as exc:
                self._last_request = time.monotonic()
                # 4xx other than 429 will not improve on retry.
                if exc.code != 429 and 400 <= exc.code < 500:
                    log.warning("HTTP %s for %s -- not retrying", exc.code, url)
                    return None
                log.warning("HTTP %s for %s (attempt %d)", exc.code, url, attempt)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                self._last_request = time.monotonic()
                log.warning("Network error for %s (attempt %d): %s", url, attempt, exc)

            if attempt < self.retries:
                backoff = (2 ** (attempt - 1)) + random.uniform(0, self.jitter)
                log.debug("Backing off %.2fs", backoff)
                time.sleep(backoff)
        log.error("Giving up on %s after %d attempts", url, self.retries)
        return None

    # -- API ---------------------------------------------------------------

    def api(self, method: str, **params: str) -> Optional[List[Dict[str, Any]]]:
        """Call parachuteapi.js and return the decoded record list."""
        query = urllib.parse.urlencode({"method": method, **params})
        body = self.get(f"{BASE}{API_PATH}?{query}")
        if body is None:
            return None
        return _parse_records(body)

    def query_term(self, term: str) -> List[Dict[str, Any]]:
        """method=get with a search term. Returns [] on failure or no match."""
        return self.api("get", term=term) or []

    def calculator_page(self) -> Optional[str]:
        return self.get(BASE + CALCULATOR_PATH, xhr=False)


def _parse_records(body: str) -> Optional[List[Dict[str, Any]]]:
    """Decode an API body into a list of parachute dicts.

    The endpoint is served as text/javascript but the payload observed in the
    HAR is plain JSON. Tolerate a JSONP wrapper and stray whitespace anyway.
    """
    text = body.strip()
    if not text:
        return []
    if not text.startswith(("[", "{")):
        # Possible JSONP: callback([...]);
        match = re.search(r"\(\s*(\[.*\]|\{.*\})\s*\)\s*;?\s*$", text, re.DOTALL)
        if not match:
            log.debug("Unrecognised API body: %.120r", text)
            return None
        text = match.group(1)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        log.debug("JSON decode failed (%s): %.120r", exc, text)
        return None
    if isinstance(data, dict):
        # Some endpoints may wrap results; unwrap the first list-valued key.
        for value in data.values():
            if isinstance(value, list):
                data = value
                break
        else:
            data = [data]
    if not isinstance(data, list):
        return None
    return [item for item in data if isinstance(item, dict) and item.get("SKU")]


# ---------------------------------------------------------------------------
# SKU discovery
# ---------------------------------------------------------------------------

# Bulk-dump method names worth a try before falling back to sweeping. None of
# these are confirmed to exist -- "get" is the only method seen in the HAR --
# but they cost four requests and would save several dozen.
BULK_METHODS: Sequence[Dict[str, str]] = (
    {"method": "list"},
    {"method": "all"},
    {"method": "get", "term": ""},
    {"method": "search", "term": ""},
)

SWEEP_ALPHABET = string.ascii_uppercase + string.digits


def discover_from_bulk(client: FruityChutesClient) -> List[Dict[str, Any]]:
    """Try to pull the whole table in one shot."""
    for params in BULK_METHODS:
        method = params["method"]
        rest = {k: v for k, v in params.items() if k != "method"}
        records = client.api(method, **rest)
        if records:
            log.info(
                "Bulk dump via method=%s%s returned %d records",
                method,
                f"&term={rest['term']!r}" if "term" in rest else "",
                len(records),
            )
            return records
    log.info("No bulk-dump endpoint responded; falling back to other strategies")
    return []


def discover_from_dropdown(client: FruityChutesClient) -> Set[str]:
    """Parse the calculator page's model <select> for SKU option values.

    zelect.js is a <select> replacement widget, so the real option list ships in
    the page HTML. The control is named/ided "term" (the calculator's own share
    links look like ...?term=TARC-20&weight=1.5).
    """
    html = client.calculator_page()
    if not html:
        log.warning("Could not fetch the calculator page for dropdown discovery")
        return set()

    selects = re.findall(
        r"<select\b[^>]*>(.*?)</select>", html, re.IGNORECASE | re.DOTALL
    )
    select_tags = re.findall(r"<select\b[^>]*>", html, re.IGNORECASE)

    candidates: List[str] = []
    for tag, inner in zip(select_tags, selects):
        if re.search(r'(?:id|name)\s*=\s*["\']?(term|model|chute|sku)', tag, re.I):
            candidates.append(inner)
    if not candidates:
        # No obviously-named select; consider every one on the page.
        candidates = selects

    skus: Set[str] = set()
    for inner in candidates:
        for value in re.findall(
            r"<option\b[^>]*\bvalue\s*=\s*[\"']([^\"']+)[\"']", inner, re.IGNORECASE
        ):
            value = value.strip()
            if _looks_like_sku(value):
                skus.add(value)

    if skus:
        log.info("Dropdown discovery found %d SKUs", len(skus))
    else:
        log.warning("Dropdown discovery found no SKU-shaped option values")
    return skus


def _looks_like_sku(value: str) -> bool:
    """SKUs look like CFC-96, TARC-16, IFC-48-S -- letters, digits, dashes."""
    if not value or len(value) > 40:
        return False
    if value.lower() in {"0", "none", "select", "choose", "-1", ""}:
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9]+(?:-[A-Za-z0-9.]+)+", value))


def discover_by_sweep(
    client: FruityChutesClient, alphabet: Iterable[str] = SWEEP_ALPHABET
) -> List[Dict[str, Any]]:
    """Query one character at a time and union the matches.

    If the backend matches `term` with a LIKE, every SKU contains at least one
    letter or digit, so a 36-request sweep enumerates the catalogue. If it only
    prefix-matches, the sweep still covers every possible first character.
    """
    found: Dict[str, Dict[str, Any]] = {}
    for char in alphabet:
        records = client.query_term(char)
        new = 0
        for record in records:
            sku = str(record["SKU"])
            if sku not in found:
                found[sku] = record
                new += 1
        log.info(
            "sweep %-3s -> %3d records (%d new, %d total)",
            char,
            len(records),
            new,
            len(found),
        )
    return list(found.values())


def probe_partial_matching(client: FruityChutesClient) -> bool:
    """Check whether `term` does substring matching rather than exact SKU only.

    CFC-96 and CFC-84 both exist (per the reference HAR), so a partial-matching
    backend must return at least two records for "CFC".
    """
    records = client.query_term("CFC")
    if len(records) > 1:
        log.info(
            "Endpoint does partial matching (term=CFC -> %d records)", len(records)
        )
        return True
    log.info(
        "Endpoint appears to require near-exact SKUs (term=CFC -> %d records)",
        len(records),
    )
    return False


def discover_by_enumeration(
    client: FruityChutesClient,
    known: Sequence[Dict[str, Any]],
    max_diameter: int,
) -> List[Dict[str, Any]]:
    """Last resort: cross every observed SKU prefix with a range of diameters.

    Fruity Chutes SKUs are <PREFIX>-<DIAMETER>[-<TRIM>]; prefixes and trim
    suffixes are taken from whatever the earlier strategies already turned up,
    so this stays data-driven rather than guessing product-line names.
    """
    prefixes: Set[str] = set()
    suffixes: Set[str] = {""}
    for record in known:
        parts = str(record["SKU"]).split("-")
        if len(parts) >= 2:
            prefixes.add(parts[0])
        if len(parts) >= 3:
            suffixes.add("-" + "-".join(parts[2:]))

    if not prefixes:
        log.warning("Enumeration needs at least one known SKU to derive prefixes")
        return []

    seen = {str(r["SKU"]) for r in known}
    found: List[Dict[str, Any]] = []
    total = len(prefixes) * len(suffixes) * max_diameter
    log.info(
        "Enumerating %d candidates (%d prefixes x %d suffixes x diameters 1-%d)",
        total,
        len(prefixes),
        len(suffixes),
        max_diameter,
    )
    for prefix in sorted(prefixes):
        for suffix in sorted(suffixes):
            for diameter in range(1, max_diameter + 1):
                sku = f"{prefix}-{diameter}{suffix}"
                if sku in seen:
                    continue
                for record in client.query_term(sku):
                    record_sku = str(record["SKU"])
                    if record_sku not in seen:
                        seen.add(record_sku)
                        found.append(record)
                        log.info("enumeration found %s", record_sku)
    return found


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def collect(
    client: FruityChutesClient,
    explicit_skus: Optional[Sequence[str]],
    *,
    use_bulk: bool,
    use_dropdown: bool,
    use_sweep: bool,
    enumerate_max: int,
    refetch: bool,
) -> List[Dict[str, Any]]:
    """Run the discovery strategies and return one record per SKU."""
    records: Dict[str, Dict[str, Any]] = {}

    def absorb(new: Iterable[Dict[str, Any]]) -> None:
        for record in new:
            records.setdefault(str(record["SKU"]), record)

    if explicit_skus:
        for sku in explicit_skus:
            matches = client.query_term(sku)
            if not matches:
                log.warning("No record for %s", sku)
            absorb(matches)
        return _sorted_records(records)

    if use_bulk:
        absorb(discover_from_bulk(client))
        if len(records) > 50:
            log.info(
                "Bulk dump looks complete (%d records); skipping other passes",
                len(records),
            )
            return _sorted_records(records)

    if use_dropdown:
        for sku in sorted(discover_from_dropdown(client)):
            if sku not in records:
                absorb(client.query_term(sku))

    if use_sweep:
        if probe_partial_matching(client) or not records:
            absorb(discover_by_sweep(client))
        else:
            log.info("Skipping sweep: endpoint does not do partial matching")

    if enumerate_max > 0:
        absorb(discover_by_enumeration(client, list(records.values()), enumerate_max))

    if refetch:
        # Re-pull each SKU individually so every row comes from the same
        # authoritative method=get response shape.
        log.info("Re-fetching %d SKUs individually", len(records))
        refetched: Dict[str, Dict[str, Any]] = {}
        for sku in sorted(records):
            for record in client.query_term(sku):
                refetched.setdefault(str(record["SKU"]), record)
        if refetched:
            records = refetched

    return _sorted_records(records)


def _sorted_records(records: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    def key(record: Dict[str, Any]):
        sku = str(record.get("SKU", ""))
        parts = sku.split("-")
        try:
            diameter = float(parts[1])
        except (IndexError, ValueError):
            diameter = float("inf")
        return (str(record.get("model") or ""), parts[0], diameter, sku)

    return sorted(records.values(), key=key)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def load_from_har(path: str) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Recover parachute records from a DevTools HAR capture.

    Lets the committed database be rebuilt from a saved capture without network
    access, and keeps its provenance auditable. Returns the records plus the
    earliest capture timestamp, so rebuilding the same HAR is deterministic.
    """
    with open(path, encoding="utf-8") as handle:
        har = json.load(handle)

    found: Dict[str, Dict[str, Any]] = {}
    stamps: List[str] = []
    for entry in har.get("log", {}).get("entries", []):
        url = entry.get("request", {}).get("url", "")
        if API_PATH not in url:
            continue
        text = entry.get("response", {}).get("content", {}).get("text")
        if not text:
            continue
        for record in _parse_records(text) or []:
            found.setdefault(str(record["SKU"]), record)
        if entry.get("startedDateTime"):
            stamps.append(entry["startedDateTime"])

    log.info("Recovered %d records from %s", len(found), path)
    return list(found.values()), min(stamps) if stamps else None


def write_json(records: Sequence[Dict[str, Any]], path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(records, handle, indent=2, sort_keys=False)
        handle.write("\n")
    log.info("Wrote %s (%d records)", path, len(records))


def write_csv(records: Sequence[Dict[str, Any]], path: str) -> None:
    # Start from the curated label order, then append any field the API grew
    # since this script was written so nothing is silently dropped.
    fields = list(METRIC_LABELS)
    for record in records:
        for key in record:
            if key not in fields:
                fields.append(key)

    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(METRIC_LABELS.get(field, field) for field in fields)
        for record in records:
            writer.writerow(record.get(field, "") for field in fields)
    log.info("Wrote %s (%d records)", path, len(records))


def print_metrics_table(record: Dict[str, Any]) -> None:
    """Render one record the way the calculator page shows it."""
    print(f"\nParachute Metrics -- {record.get('SKU')}")
    for field, label in METRIC_LABELS.items():
        if field in {"SKU", "id", "url", "description"}:
            continue
        value = record.get(field)
        if value in (None, ""):
            continue
        print(f"{label}:\t{value}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Scrape parachute metrics from the Fruity Chutes calculator API.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--out-dir",
        default=".",
        help="Directory for parachutes.json / .csv (default: .)",
    )
    parser.add_argument(
        "--skus",
        nargs="+",
        metavar="SKU",
        help="Fetch only these SKUs (skips discovery), e.g. --skus CFC-96 TARC-16",
    )
    parser.add_argument(
        "--sku-file", help="File with one SKU per line; combined with --skus"
    )
    parser.add_argument(
        "--db",
        default=None,
        metavar="PATH",
        help="SQLite database to upsert into (default: <out-dir>/parachutes.db)",
    )
    parser.add_argument(
        "--from-har",
        metavar="FILE",
        help="Load records from a saved HAR capture instead of hitting the network",
    )
    parser.add_argument(
        "--no-flat-files",
        action="store_true",
        help="Write only the SQLite database, skipping parachutes.json/.csv",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.5,
        help="Minimum seconds between requests (default: 0.5)",
    )
    parser.add_argument(
        "--timeout", type=float, default=30.0, help="Per-request timeout (default: 30)"
    )
    parser.add_argument(
        "--retries", type=int, default=4, help="Attempts per request (default: 4)"
    )
    parser.add_argument(
        "--no-bulk", action="store_true", help="Skip the bulk-dump attempts"
    )
    parser.add_argument(
        "--no-dropdown", action="store_true", help="Skip parsing the calculator page"
    )
    parser.add_argument(
        "--no-sweep", action="store_true", help="Skip the A-Z/0-9 term sweep"
    )
    parser.add_argument(
        "--enumerate-max",
        type=int,
        default=0,
        metavar="N",
        help="Brute-force <PREFIX>-1..N after discovery (slow; default: 0 = off)",
    )
    parser.add_argument(
        "--no-refetch",
        action="store_true",
        help="Trust discovery results instead of re-fetching each SKU individually",
    )
    parser.add_argument(
        "--print-table",
        action="store_true",
        help="Also print each record as a Parachute Metrics table",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)-7s %(message)s",
        stream=sys.stderr,
    )

    skus: List[str] = list(args.skus or [])
    if args.sku_file:
        with open(args.sku_file, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith("#"):
                    skus.append(line)

    if args.from_har:
        records, scraped_at = load_from_har(args.from_har)
        source = "har"
    else:
        client = FruityChutesClient(
            delay=args.delay, timeout=args.timeout, retries=args.retries
        )
        records = collect(
            client,
            skus or None,
            use_bulk=not args.no_bulk,
            use_dropdown=not args.no_dropdown,
            use_sweep=not args.no_sweep,
            enumerate_max=args.enumerate_max,
            refetch=not args.no_refetch and not skus,
        )
        scraped_at, source = None, "api"

    if not records:
        log.error("No parachutes found -- nothing written")
        return 1

    records = _sorted_records({str(r["SKU"]): r for r in records})

    os.makedirs(args.out_dir, exist_ok=True)
    db_path = args.db or os.path.join(args.out_dir, "parachutes.db")
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    write_sqlite(records, db_path, source=source, scraped_at=scraped_at)

    if not args.no_flat_files:
        write_json(records, os.path.join(args.out_dir, "parachutes.json"))
        write_csv(records, os.path.join(args.out_dir, "parachutes.csv"))

    if args.print_table:
        for record in records:
            print_metrics_table(record)

    models = sorted({str(r.get("model") or "?") for r in records})
    log.info("Done: %d parachutes across models %s", len(records), ", ".join(models))
    return 0


if __name__ == "__main__":
    sys.exit(main())

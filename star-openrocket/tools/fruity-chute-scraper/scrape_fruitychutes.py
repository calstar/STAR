#!/usr/bin/env python3
"""Scrape every parachute's metrics from the Fruity Chutes descent-rate calculator.

The calculator page (fruitychutes.com/help_for_parachutes/parachute-descent-rate-calculator)
backs its "Parachute Metrics" table with a plain JSON endpoint:

    GET /parachuteapi.js?method=get&term=<SKU>   ->  [ { ...one record per match... } ]

The response fields are exactly the rows of the on-page metrics table, so there is
no need to parse rendered HTML for the numbers. This script discovers the full SKU
list (the calculator's "model" dropdown), fetches each record, and writes:

    parachutes.csv     one row per SKU, stable machine column names
    raw/<sku>.json     the untouched API payload, one file per device

CSV rather than SQLite, per PLAN.md section 11.2: this is committed reference data
feeding structural load calculations, so a vendor revising Cd from 2.2 to 1.9 --
a 14% shift in CdS, straight into eq (23) -- has to show up as a readable line in
a pull request. A binary database makes every re-scrape an unreviewable blob.
`raw_json` lives in its own file per SKU for the same reason, and so CSV quoting
stays sane.

Stdlib only -- no pip install required.

    python3 scrape_fruitychutes.py --out-dir out
    python3 scrape_fruitychutes.py --skus CFC-96 TARC-16 --out-dir out
    python3 scrape_fruitychutes.py --from-har capture.har --out-dir .
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import http.cookiejar
import json
import logging
import os
import math
import random
import re
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
# CSV table
# ---------------------------------------------------------------------------

# csv column -> (api field, coercion). This ordering IS the column order of
# parachutes.csv, and the names are the contract physics/devices.py reads
# against -- they are deliberately machine names, not the display labels in
# METRIC_LABELS, so that renaming a table heading on the vendor's page cannot
# break the loader. Units are carried in the column name and left in vendor
# units; PLAN.md eqs (A1)-(A3) do the SI conversion at load time, so there is
# exactly one place that converts.
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


CSV_COLUMNS: List[str] = [column for column, _, _ in COLUMN_MAP] + [
    "source",
    "scraped_at",
]


def _fmt(value: Any) -> str:
    """Render a coerced value for CSV.

    Floats print without trailing noise so that re-scraping unchanged data
    produces a byte-identical file and the diff stays empty. That is the whole
    point of choosing CSV, so it is worth the repr dance.
    """
    if value is None:
        return ""
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return ""
        return repr(round(value, 6)).rstrip("0").rstrip(".") if value else "0"
    return str(value)


def _row(record: Dict[str, Any], source: str, scraped_at: str) -> Dict[str, str]:
    row = {
        column: _fmt(_coerce(record.get(field), kind))
        for column, field, kind in COLUMN_MAP
    }
    row["source"] = source
    row["scraped_at"] = scraped_at
    return row


def read_csv_table(path: str) -> Dict[str, Dict[str, str]]:
    """Read an existing parachutes.csv into {sku: row}. Empty if absent."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    existing = {r["sku"]: r for r in rows if r.get("sku")}
    log.debug("Read %d existing rows from %s", len(existing), path)
    return existing


def write_csv_table(
    records: Sequence[Dict[str, Any]],
    path: str,
    *,
    source: str = "api",
    scraped_at: Optional[str] = None,
) -> int:
    """Merge records into parachutes.csv, keyed on sku.

    Merge (rather than truncate-and-write) keeps the property the SQLite upsert
    had: a scrape interrupted halfway tops the table up instead of destroying
    the rows it did not reach. Output is sorted by sku so the file order is a
    function of content alone and diffs stay minimal.
    """
    stamp = scraped_at or dt.datetime.now(dt.timezone.utc).isoformat(
        timespec="seconds"
    )
    table = read_csv_table(path)
    before = len(table)
    for record in records:
        row = _row(record, source, stamp)
        table[row["sku"]] = row

    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, lineterminator="\n")
        writer.writeheader()
        for sku in sorted(table):
            writer.writerow({c: table[sku].get(c, "") for c in CSV_COLUMNS})

    log.info(
        "Wrote %s (%d upserted, %d new, %d rows total)",
        path,
        len(records),
        len(table) - before,
        len(table),
    )
    return len(table)


def write_raw_json(records: Sequence[Dict[str, Any]], directory: str) -> int:
    """One untouched API payload per SKU, so vendor data stays diffable too."""
    os.makedirs(directory, exist_ok=True)
    written = 0
    for record in records:
        sku = str(record.get("SKU") or "").strip()
        if not sku:
            continue
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", sku)
        with open(
            os.path.join(directory, f"{safe}.json"), "w", encoding="utf-8"
        ) as handle:
            json.dump(record, handle, indent=2, sort_keys=True)
            handle.write("\n")
        written += 1
    log.info("Wrote %d raw payloads to %s/", written, directory)
    return written


# ---------------------------------------------------------------------------
# Consistency checks -- PLAN.md eqs (A4)-(A6)
# ---------------------------------------------------------------------------


def check_record(record: Dict[str, Any]) -> List[str]:
    """Return a list of consistency complaints for one record.

    These validate that the row parsed correctly, which matters because a
    silently mis-parsed Cd or area goes straight into eq (23) as a wrong load.
    Run at scrape time as well as load time -- catching it here means a bad
    scrape never reaches a commit.
    """
    def num(field: str) -> Optional[float]:
        return _coerce(record.get(field), "real")

    problems: List[str] = []
    cd_p, area_p = num("cd_projected"), num("area_projected")
    cd_c, area_c = num("cd_area_canopy"), num("area_canopy")
    d_flat = num("equivalent_flattend_d")
    r15, r20 = num("rate_15"), num("rate_20")

    def rel(a: float, b: float) -> float:
        return abs(a - b) / abs(b) if b else float("inf")

    # (A4) the two Cd/area conventions must describe the same drag area
    if None not in (cd_p, area_p, cd_c, area_c):
        if rel(cd_p * area_p, cd_c * area_c) > 0.01:
            problems.append(
                "A4: cd_projected*area_projected=%.4f != cd_area_canopy*area_canopy=%.4f"
                % (cd_p * area_p, cd_c * area_c)
            )
    # (A5) flat diameter must be the circle of equal canopy area
    if None not in (d_flat, area_c) and area_c > 0:
        want = math.sqrt(4 * area_c / math.pi) * 12.0  # sq ft -> in
        if rel(d_flat, want) > 0.01:
            problems.append(
                "A5: equivalent_flattend_d=%.3f in != sqrt(4*area_canopy/pi)=%.3f in"
                % (d_flat, want)
            )
    # (A6) ratings scale with v^2
    if None not in (r15, r20) and r20:
        if rel(r15 / r20, (15.0 / 20.0) ** 2) > 0.01:
            problems.append(
                "A6: rate_15/rate_20=%.4f != 0.5625" % (r15 / r20)
            )
    return problems


def check_records(records: Sequence[Dict[str, Any]]) -> int:
    """Log (A4)-(A6) violations. Returns the number of bad records."""
    bad = 0
    for record in records:
        problems = check_record(record)
        if problems:
            bad += 1
            for problem in problems:
                log.warning("%s  %s", record.get("SKU"), problem)
    if bad:
        log.warning("%d of %d records failed a consistency check", bad, len(records))
    else:
        log.info("All %d records pass eqs (A4)-(A6)", len(records))
    return bad


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
        # A cookie jar is load-bearing, not hygiene. `method=list` and
        # `method=manufacturer` return a bare [] without a PHPSESSID, with a
        # 200 and no error -- so a session-less scrape looks like an empty
        # catalogue rather than a failure. `method=get` needs no session, which
        # is why the reference HAR (three get calls) never revealed this.
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar)
        )
        self._warmed = False

    # -- transport ---------------------------------------------------------

    def warm_session(self) -> bool:
        """Fetch the calculator page once to obtain a PHPSESSID.

        Idempotent, and cheap enough to call before any list query.
        """
        if self._warmed:
            return True
        self.calculator_page()
        self._warmed = any(c.name == "PHPSESSID" for c in self._jar)
        if self._warmed:
            log.debug("Session warmed: %s", [c.name for c in self._jar])
        else:
            log.warning(
                "No PHPSESSID after loading the calculator page -- bulk "
                "discovery will probably come back empty"
            )
        return self._warmed

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
        """method=get with a search term. Returns [] on failure or no match.

        Filters to rows carrying an uppercase "SKU", which is the full-record
        shape. The lighter {sku, description} rows that method=list returns are
        deliberately not accepted here -- callers of this method expect a
        complete record.
        """
        return [r for r in (self.api("get", term=term) or []) if r.get("SKU")]

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
    return [item for item in data if isinstance(item, dict)]


# ---------------------------------------------------------------------------
# SKU discovery
# ---------------------------------------------------------------------------

SWEEP_ALPHABET = string.ascii_uppercase + string.digits


def discover_manufacturers(client: FruityChutesClient) -> List[str]:
    """Enumerate manufacturer keys via method=manufacturer.

    Returns the keys, including the empty-string "** all **" key that the
    calculator uses for an unfiltered list.
    """
    client.warm_session()
    rows = client.api("manufacturer", term="", page="0") or []
    keys = [str(r.get("key", "")) for r in rows]
    if rows:
        log.info(
            "Manufacturers: %s",
            ", ".join(r.get("description", "?") for r in rows),
        )
    return keys


def discover_catalogue(client: FruityChutesClient) -> Set[str]:
    """Pull the full SKU list the calculator's model dropdown is built from.

    Two things about this endpoint are non-obvious and both produce a silent
    empty result rather than an error:

      * it needs a **PHPSESSID**, so the calculator page must be fetched first
        (see FruityChutesClient.warm_session);
      * `page` is **0-indexed**. page=1 returns [] on a 121-row catalogue that
        fits entirely on page 0, which reads exactly like "no such endpoint".

    Neither is visible in the reference HAR, which only ever captured
    `method=get`. The response carries {sku, description} only -- not full
    records -- so every SKU is re-fetched with method=get afterwards.
    """
    if not client.warm_session():
        log.warning("Proceeding without a session; the catalogue may come back empty")

    skus: Set[str] = set()

    def pull(mfgr: str) -> int:
        found = 0
        for page in range(0, 50):  # 0-indexed; stop at the first empty page
            rows = client.api("list", term="", page=str(page), mfgr=mfgr) or []
            if not rows:
                break
            for row in rows:
                sku = str(row.get("sku") or "").strip()
                if sku:
                    skus.add(sku)
                    found += 1
        return found

    # The "** all **" key returns the whole catalogue in one page, but ask each
    # manufacturer separately too: it costs a handful of requests and it is the
    # only cross-check that the unfiltered list is not itself truncated.
    total = pull("")
    log.info("Unfiltered catalogue: %d rows, %d unique SKUs", total, len(skus))

    for key in discover_manufacturers(client):
        if not key:
            continue
        before = len(skus)
        count = pull(key)
        log.info(
            "  %-22s %3d rows%s",
            key,
            count,
            f"  (+{len(skus) - before} not in the unfiltered list)"
            if len(skus) > before
            else "",
        )

    if skus:
        log.info("Catalogue discovery found %d SKUs", len(skus))
    else:
        log.info("Catalogue discovery came back empty; falling back")
    return skus


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
        catalogue = discover_catalogue(client)
        for sku in sorted(catalogue):
            absorb(client.query_term(sku))
        if len(records) > 50:
            log.info(
                "Catalogue looks complete (%d records); skipping other passes",
                len(records),
            )
            return _sorted_records(records)
        if catalogue and not records:
            log.warning(
                "Discovered %d SKUs but fetched 0 records -- method=get may have "
                "changed shape",
                len(catalogue),
            )

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


def unmapped_fields(records: Sequence[Dict[str, Any]]) -> List[str]:
    """API fields that COLUMN_MAP does not carry into the CSV.

    The raw payloads keep everything regardless, but a field appearing upstream
    that the loader never sees is worth saying out loud rather than dropping in
    silence.
    """
    known = {field for _, field, _ in COLUMN_MAP}
    seen: List[str] = []
    for record in records:
        for key in record:
            if key not in known and key not in seen:
                seen.append(key)
    return seen


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
        help="Directory for parachutes.csv and raw/ (default: .)",
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
        "--csv",
        default=None,
        metavar="PATH",
        help="CSV table to merge into (default: <out-dir>/parachutes.csv)",
    )
    parser.add_argument(
        "--raw-dir",
        default=None,
        metavar="PATH",
        help="Directory for one raw payload per SKU (default: <out-dir>/raw)",
    )
    parser.add_argument(
        "--from-har",
        metavar="FILE",
        help="Load records from a saved HAR capture instead of hitting the network",
    )
    parser.add_argument(
        "--no-raw",
        action="store_true",
        help="Skip writing raw/<sku>.json",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero if any record fails an eq (A4)-(A6) consistency check",
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
    csv_path = args.csv or os.path.join(args.out_dir, "parachutes.csv")
    write_csv_table(records, csv_path, source=source, scraped_at=scraped_at)

    if not args.no_raw:
        write_raw_json(records, args.raw_dir or os.path.join(args.out_dir, "raw"))

    extra = unmapped_fields(records)
    if extra:
        log.warning(
            "API returned %d field(s) not in COLUMN_MAP (kept in raw/, absent "
            "from the CSV): %s",
            len(extra),
            ", ".join(extra),
        )

    bad = check_records(records)

    if args.print_table:
        for record in records:
            print_metrics_table(record)

    models = sorted({str(r.get("model") or "?") for r in records})
    log.info("Done: %d parachutes across models %s", len(records), ", ".join(models))
    return 1 if (bad and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())

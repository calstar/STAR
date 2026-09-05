"""Scrape makeitfrom.com into a local SQLite database.

makeitfrom.com is a curated database of engineering material properties. It has
no API, sitemap, or robots.txt, but its markup is static server-rendered HTML
with a very regular shape, so a small crawler + regex parser is enough to lift
every material and every property it publishes.

Structure of the site
---------------------
* The home page lists ~18 top-level ``/material-group/<slug>`` pages (Aluminum
  Alloy, Thermoplastic, Natural Stone, ...).
* Group pages nest: a group links to sub-groups and/or to leaf materials. Links
  are ``<a href='/material-group/...'>`` and ``<a href='/material-properties/...'>``
  written with SINGLE quotes.
* Leaf material pages (``/material-properties/<slug>``) carry the data. Each
  property is a ``<div class='CLASS'><p>Name</p> ...bars... <p>Value</p></div>``
  where CLASS is one of mech / therm / ele / other / common (Mechanical,
  Thermal, Electrical, Otherwise Unclassified, Common Calculations). Alloy
  composition is a ``<table class="comps">``.

The value cell holds the SI figure inline and the imperial figure inside a
``<span class="float-right">`` -- e.g. ``69 <i>GPa</i><span class="float-right">10
<i>x 10<sup>6</sup> psi</i></span>``. We keep the parsed SI number + unit, the
raw imperial string, and the full stripped text so nothing is lost.

Schema is entity-attribute-value because materials expose heterogeneous property
sets (a rubber has no melting point, a ceramic has no elongation); a wide table
would be mostly NULL. See ``init_db`` for the tables.

Usage
-----
    python backend/materials/scrape.py                 # discover + scrape all
    python backend/materials/scrape.py --limit 25      # smoke test
    python backend/materials/scrape.py --discover-only  # just map the tree
    python backend/materials/scrape.py --refresh       # re-scrape everything

The crawl is resumable: a material already stored with HTTP 200 is skipped
unless --refresh is given, so an interrupted run continues where it stopped.
"""

from __future__ import annotations

import argparse
import html
import re
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx

BASE = "https://www.makeitfrom.com"
DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "materials.db"
USER_AGENT = (
    "STAR-materials-scraper/1.0 (+https://github.com; research/engineering use)"
)

# Inner property-div class -> section label shown on the page.
SECTIONS = {
    "mech": "Mechanical",
    "therm": "Thermal",
    "ele": "Electrical",
    "other": "Otherwise Unclassified",
    "common": "Common Calculations",
}

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def make_client(timeout: float = 30.0) -> httpx.Client:
    return httpx.Client(
        base_url=BASE,
        headers={"User-Agent": USER_AGENT},
        timeout=timeout,
        follow_redirects=True,
    )


def fetch(client: httpx.Client, path: str, retries: int = 4) -> httpx.Response | None:
    """GET ``path`` with exponential backoff. Returns None on hard failure."""
    for attempt in range(retries):
        try:
            resp = client.get(path)
        except httpx.HTTPError:
            time.sleep(1.5 * (attempt + 1))
            continue
        if resp.status_code == 200:
            return resp
        if resp.status_code == 404:
            return resp  # caller records the miss; no point retrying
        if resp.status_code in (429, 500, 502, 503, 504):
            time.sleep(2.0 * (attempt + 1))
            continue
        return resp
    return None


# ---------------------------------------------------------------------------
# HTML helpers
# ---------------------------------------------------------------------------

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
_SUP = re.compile(r"<sup>(.*?)</sup>", re.S)
_SUB = re.compile(r"<sub>(.*?)</sub>", re.S)
# A signed decimal, ignoring surrounding markup.
_NUM = re.compile(r"-?\d+(?:\.\d+)?")
_TO = re.compile(r"\bto\b")


def strip_tags(fragment: str) -> str:
    """Turn an HTML fragment into clean unicode text (entities decoded).

    Superscripts become ``^n`` and subscripts collapse inline, so units survive
    the flattening: ``g/cm<sup>3</sup>`` -> ``g/cm^3``, ``x 10<sup>6</sup>`` ->
    ``x 10^6``, ``CO<sub>2</sub>`` -> ``CO2``.
    """
    fragment = _SUP.sub(r"^\1", fragment)
    fragment = _SUB.sub(r"\1", fragment)
    text = _TAG.sub(" ", fragment)
    text = html.unescape(text)
    return _WS.sub(" ", text).strip()


LINK_RE = re.compile(r"href='(/material-(?:group|properties)/[^']+)'")


def extract_links(page: str) -> tuple[set[str], set[str]]:
    """Return (group_slugs, material_slugs) linked from a page."""
    groups: set[str] = set()
    materials: set[str] = set()
    for href in LINK_RE.findall(page):
        slug = href.rsplit("/", 1)[1]
        if href.startswith("/material-group/"):
            groups.add(slug)
        else:
            materials.add(slug)
    return groups, materials


H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.S)
PROSE_RE = re.compile(r'<div class="prose">(.*?)</div>', re.S)


def page_title(page: str) -> str:
    m = H1_RE.search(page)
    return strip_tags(m.group(1)) if m else ""


def page_description(page: str) -> str:
    m = PROSE_RE.search(page)
    return strip_tags(m.group(1)) if m else ""


# ---------------------------------------------------------------------------
# Material-page parsing
# ---------------------------------------------------------------------------

PROP_RE = re.compile(
    r"<div class='(mech|therm|ele|other|common)'>(.*?)</div>\s*(?=<div class='(?:mech|therm|ele|other|common)'>|</div>)",
    re.S,
)
P_RE = re.compile(r"<p>(.*?)</p>", re.S)
FLOAT_RIGHT_RE = re.compile(r'<span class="float-right">(.*?)</span>', re.S)
FIRST_I_RE = re.compile(r"<i>(.*?)</i>", re.S)


def parse_value(value_html: str) -> dict:
    """Split a value cell into SI number/unit, imperial string, and raw text."""
    imperial = ""
    m = FLOAT_RIGHT_RE.search(value_html)
    si_html = value_html
    if m:
        imperial = strip_tags(m.group(1))
        si_html = value_html[: m.start()] + value_html[m.end() :]

    unit = ""
    im = FIRST_I_RE.search(si_html)
    if im:
        unit = strip_tags(im.group(1))

    si_text = strip_tags(si_html)
    nums = _NUM.findall(si_text)
    value_num = float(nums[0]) if nums else None
    # Many figures are ranges ("76 to 140 MPa"): keep low in value_num, high in
    # value_max. Only treat the second number as a max when "to" joins them, so
    # a lone scientific mantissa/exponent is not mistaken for a range.
    value_max = float(nums[1]) if len(nums) > 1 and _TO.search(si_text) else None

    return {
        "value_num": value_num,
        "value_max": value_max,
        "unit": unit,
        "value_imperial": imperial,
        "value_text": strip_tags(value_html),
    }


def parse_properties(page: str) -> list[dict]:
    """Every property row on a material page, in document order."""
    out: list[dict] = []
    pos = 0
    for cls, body in ((m.group(1), m.group(2)) for m in PROP_RE.finditer(page)):
        ps = P_RE.findall(body)
        if len(ps) < 2:
            continue
        name = strip_tags(ps[0])
        parsed = parse_value(ps[-1])
        out.append(
            {
                "section": SECTIONS.get(cls, cls),
                "name": name,
                "position": pos,
                **parsed,
            }
        )
        pos += 1
    return out


COMP_TABLE_RE = re.compile(r'<table class="comps">(.*?)</table>', re.S)
COMP_ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.S)
COMP_TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
HIDE_NARROW_RE = re.compile(r'<span class="hide-narrow">(.*?)</span>', re.S)
INLINE_NARROW_RE = re.compile(r'<span class="inline-narrow">(.*?)</span>', re.S)


def parse_composition(page: str) -> list[dict]:
    """Alloy composition rows (element, symbol, percent range)."""
    tbl = COMP_TABLE_RE.search(page)
    if not tbl:
        return []
    out: list[dict] = []
    for pos, row in enumerate(COMP_ROW_RE.findall(tbl.group(1))):
        tds = COMP_TD_RE.findall(row)
        if len(tds) < 2:
            continue
        name_cell = tds[0]
        full = HIDE_NARROW_RE.search(name_cell)
        sym = INLINE_NARROW_RE.search(name_cell)
        element = strip_tags(full.group(1)) if full else strip_tags(name_cell)
        symbol = strip_tags(sym.group(1)) if sym else ""
        pct_text = strip_tags(tds[-1])
        nums = _NUM.findall(pct_text)
        pct_min = float(nums[0]) if nums else None
        pct_max = float(nums[1]) if len(nums) > 1 else pct_min
        out.append(
            {
                "element": element,
                "symbol": symbol,
                "pct_min": pct_min,
                "pct_max": pct_max,
                "pct_text": pct_text,
                "position": pos,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        CREATE TABLE IF NOT EXISTS groups (
            slug        TEXT PRIMARY KEY,
            name        TEXT,
            url         TEXT,
            description TEXT
        );

        CREATE TABLE IF NOT EXISTS group_edges (
            parent_slug TEXT,
            child_slug  TEXT,
            PRIMARY KEY (parent_slug, child_slug)
        );

        CREATE TABLE IF NOT EXISTS material_group (
            material_slug TEXT,
            group_slug    TEXT,
            PRIMARY KEY (material_slug, group_slug)
        );

        CREATE TABLE IF NOT EXISTS materials (
            slug        TEXT PRIMARY KEY,
            name        TEXT,
            url         TEXT,
            description TEXT,
            http_status INTEGER,
            scraped_at  REAL
        );

        CREATE TABLE IF NOT EXISTS properties (
            material_slug  TEXT,
            section        TEXT,
            name           TEXT,
            value_num      REAL,
            value_max      REAL,
            unit           TEXT,
            value_imperial TEXT,
            value_text     TEXT,
            position       INTEGER,
            FOREIGN KEY (material_slug) REFERENCES materials(slug) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS composition (
            material_slug TEXT,
            element       TEXT,
            symbol        TEXT,
            pct_min       REAL,
            pct_max       REAL,
            pct_text      TEXT,
            position      INTEGER,
            FOREIGN KEY (material_slug) REFERENCES materials(slug) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_prop_material ON properties(material_slug);
        CREATE INDEX IF NOT EXISTS idx_prop_name ON properties(name);
        CREATE INDEX IF NOT EXISTS idx_comp_material ON composition(material_slug);
        CREATE INDEX IF NOT EXISTS idx_matgroup_group ON material_group(group_slug);
        """
    )
    conn.commit()


def already_scraped(conn: sqlite3.Connection, slug: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM materials WHERE slug=? AND http_status=200", (slug,)
    ).fetchone()
    return row is not None


# ---------------------------------------------------------------------------
# Discovery (crawl the group tree)
# ---------------------------------------------------------------------------


def discover(client: httpx.Client, conn: sqlite3.Connection, log) -> set[str]:
    """BFS the material-group tree. Persists groups + edges, returns material slugs."""
    home = fetch(client, "/")
    if home is None:
        raise SystemExit("could not fetch home page")
    roots, _ = extract_links(home.text)
    log(f"discover: {len(roots)} top-level groups")

    seen_groups: set[str] = set()
    materials: set[str] = set()
    queue = list(roots)

    while queue:
        slug = queue.pop()
        if slug in seen_groups:
            continue
        seen_groups.add(slug)
        resp = fetch(client, f"/material-group/{slug}")
        if resp is None or resp.status_code != 200:
            log(f"  ! group {slug}: {resp.status_code if resp else 'ERR'}")
            continue
        page = resp.text
        conn.execute(
            "INSERT OR REPLACE INTO groups(slug,name,url,description) VALUES(?,?,?,?)",
            (slug, page_title(page), f"{BASE}/material-group/{slug}", page_description(page)),
        )
        child_groups, child_materials = extract_links(page)
        child_groups.discard(slug)
        for cg in child_groups:
            conn.execute(
                "INSERT OR IGNORE INTO group_edges(parent_slug,child_slug) VALUES(?,?)",
                (slug, cg),
            )
            if cg not in seen_groups:
                queue.append(cg)
        for cm in child_materials:
            conn.execute(
                "INSERT OR IGNORE INTO material_group(material_slug,group_slug) VALUES(?,?)",
                (cm, slug),
            )
            materials.add(cm)
        conn.commit()
        log(
            f"  group {slug}: +{len(child_groups)} groups, "
            f"+{len(child_materials)} materials (total {len(materials)})"
        )

    log(f"discover: {len(seen_groups)} groups, {len(materials)} unique materials")
    return materials


# ---------------------------------------------------------------------------
# Scrape one material
# ---------------------------------------------------------------------------


def scrape_material(client: httpx.Client, slug: str) -> dict:
    url = f"{BASE}/material-properties/{slug}"
    resp = fetch(client, f"/material-properties/{slug}")
    if resp is None:
        return {"slug": slug, "url": url, "http_status": None}
    result = {"slug": slug, "url": url, "http_status": resp.status_code}
    if resp.status_code == 200:
        page = resp.text
        result["name"] = page_title(page)
        result["description"] = page_description(page)
        result["properties"] = parse_properties(page)
        result["composition"] = parse_composition(page)
    return result


def store_material(conn: sqlite3.Connection, r: dict) -> None:
    slug = r["slug"]
    conn.execute("DELETE FROM properties WHERE material_slug=?", (slug,))
    conn.execute("DELETE FROM composition WHERE material_slug=?", (slug,))
    conn.execute(
        "INSERT OR REPLACE INTO materials(slug,name,url,description,http_status,scraped_at)"
        " VALUES(?,?,?,?,?,?)",
        (
            slug,
            r.get("name"),
            r.get("url"),
            r.get("description"),
            r.get("http_status"),
            time.time(),
        ),
    )
    for p in r.get("properties", []):
        conn.execute(
            "INSERT INTO properties(material_slug,section,name,value_num,value_max,unit,"
            "value_imperial,value_text,position) VALUES(?,?,?,?,?,?,?,?,?)",
            (
                slug,
                p["section"],
                p["name"],
                p["value_num"],
                p["value_max"],
                p["unit"],
                p["value_imperial"],
                p["value_text"],
                p["position"],
            ),
        )
    for c in r.get("composition", []):
        conn.execute(
            "INSERT INTO composition(material_slug,element,symbol,pct_min,pct_max,"
            "pct_text,position) VALUES(?,?,?,?,?,?,?)",
            (
                slug,
                c["element"],
                c["symbol"],
                c["pct_min"],
                c["pct_max"],
                c["pct_text"],
                c["position"],
            ),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Scrape makeitfrom.com into SQLite.")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help="output SQLite path")
    ap.add_argument("--workers", type=int, default=6, help="concurrent fetchers")
    ap.add_argument("--limit", type=int, default=0, help="cap materials (0 = all)")
    ap.add_argument("--discover-only", action="store_true", help="map tree, no scrape")
    ap.add_argument("--refresh", action="store_true", help="re-scrape stored materials")
    args = ap.parse_args(argv)

    args.db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(args.db)
    init_db(conn)

    lock = threading.Lock()

    def log(msg: str) -> None:
        print(msg, file=sys.stderr, flush=True)

    with make_client() as client:
        materials = sorted(discover(client, conn, log))
        if args.discover_only:
            log("discover-only: done")
            conn.close()
            return 0

        todo = [
            s
            for s in materials
            if args.refresh or not already_scraped(conn, s)
        ]
        if args.limit:
            todo = todo[: args.limit]
        log(f"scrape: {len(todo)} materials to fetch "
            f"({len(materials) - len(todo)} already stored)")

        done = 0
        failures = 0

        def worker(slug: str) -> dict:
            # Each thread gets its own client for connection-pool safety.
            with make_client() as c:
                return scrape_material(c, slug)

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = {pool.submit(worker, s): s for s in todo}
            for fut in as_completed(futs):
                slug = futs[fut]
                try:
                    r = fut.result()
                except Exception as exc:  # noqa: BLE001
                    log(f"  ! {slug}: {exc}")
                    failures += 1
                    continue
                with lock:
                    store_material(conn, r)
                done += 1
                status = r.get("http_status")
                if status != 200:
                    failures += 1
                    log(f"  ! {slug}: HTTP {status}")
                if done % 50 == 0:
                    log(f"  ... {done}/{len(todo)} ({failures} failures)")

        log(f"scrape: done, {done} fetched, {failures} failures")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

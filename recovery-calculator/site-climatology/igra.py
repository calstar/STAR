"""IGRA v2 radiosonde archive: fetch and parse.

NOAA NCEI's Integrated Global Radiosonde Archive is the authoritative store for
balloon soundings. Two access paths matter here:

    data-por/<ID>-data.txt.zip           period of record, updated ~annually
    data-y2d/<ID>-data-beg<YYYY>.txt.zip current year to date

A window that straddles New Year needs both, which is why `load` takes a date
range and stitches rather than taking a file.

Format is fixed-width and column positions are load-bearing -- splitting on
whitespace silently mis-parses any line with a missing field, and most lines
have several. Positions below are 0-indexed slices of the 1-indexed spec in
igra2-data-format.txt.

Also considered and rejected as sources:
  - rucsoundings.noaa.gov/get_soundings.cgi. Would have given RAP model
    soundings interpolated to the pad's own lat/lon, which is strictly better
    than any station. Returns empty for every query form tried (2026-07); it
    looks retired.
  - weather.uwyo.edu. Same IGRA data as scraped HTML, rate limited.
"""

import io
import math
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile

BASE = "https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/access"

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache", "igra")

MISSING = (-9999, -8888)

# Hydrostatic / gas constants. Deliberately the same values pad_state uses.
G0 = 9.80665
RD = 287.053


class Level:
    __slots__ = ("p", "t", "gph", "is_surface", "z")

    def __init__(self, p, t, gph, is_surface):
        self.p = p                  # Pa
        self.t = t                  # K, or None
        self.gph = gph              # m, reported geopotential height, or None
        self.is_surface = is_surface
        self.z = None               # m, our hydrostatic height (see build_heights)


class Sounding:
    __slots__ = ("station", "year", "month", "day", "hour", "levels")

    def __init__(self, station, year, month, day, hour):
        self.station = station
        self.year, self.month, self.day, self.hour = year, month, day, hour
        self.levels = []

    @property
    def key(self):
        return (self.year, self.month, self.day, self.hour)


# --- fetch -----------------------------------------------------------------

def _download(url, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                data = r.read()
            break
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                raise      # a 404 is an answer, not a failure to get one
            if attempt == 3:
                raise
            print("  retry in %ds (%s)" % (2 ** attempt, e), file=sys.stderr)
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 3:
                raise
            print("  retry in %ds (%s)" % (2 ** attempt, e), file=sys.stderr)
            time.sleep(2 ** attempt)
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return path


def fetch(igra_id, year=None, refetch=False):
    """One archive file. `year` selects data-y2d; None selects data-por.

    data-por is 14-45 MB per station and rarely changes, so it is cached hard.
    Pass refetch=True after a NCEI annual update.
    """
    if year is None:
        name, sub = "%s-data.txt.zip" % igra_id, "data-por"
    else:
        name, sub = "%s-data-beg%d.txt.zip" % (igra_id, year), "data-y2d"
    path = os.path.join(CACHE, name)
    if os.path.exists(path) and not refetch:
        return path
    print("  fetching %s/%s" % (sub, name), file=sys.stderr)
    return _download("%s/%s/%s" % (BASE, sub, name), path)


# --- parse -----------------------------------------------------------------

def _int(s):
    s = s.strip()
    if not s or s == "-":
        return None
    try:
        v = int(s)
    except ValueError:
        return None
    return None if v in MISSING else v


def parse(stream, since=None, until=None, p_floor=0.0):
    """Yield Soundings from an open IGRA v2 text stream.

    since/until are (year, month) inclusive bounds; p_floor drops levels above
    a pressure ceiling so a 25 kft profile does not carry 30 kPa of stratosphere
    it will never use.
    """
    cur = None
    keep = False
    for raw in stream:
        line = raw.decode("ascii", "replace") if isinstance(raw, bytes) else raw
        if line[:1] == "#":
            if cur is not None and keep and cur.levels:
                yield cur
            station = line[1:12]
            year, month = int(line[13:17]), int(line[18:20])
            day = int(line[21:23])
            hour = _int(line[24:26])
            cur = Sounding(station, year, month, day,
                           hour if hour is not None else -1)
            ym = (year, month)
            keep = ((since is None or ym >= since) and
                    (until is None or ym <= until))
            continue
        if cur is None or not keep:
            continue

        # 1-indexed spec -> 0-indexed slices.
        lvltyp2 = line[1:2]                 # spec col 2: 1 = surface level
        p = _int(line[9:15])                # spec 10-15, Pa
        gph = _int(line[16:21])             # spec 17-21, m
        t = _int(line[22:27])               # spec 23-27, tenths of degC
        if p is None or p < p_floor:
            continue
        cur.levels.append(Level(
            p=float(p),
            t=None if t is None else t / 10.0 + 273.15,
            gph=None if gph is None else float(gph),
            is_surface=(lvltyp2 == "1"),
        ))
    if cur is not None and keep and cur.levels:
        yield cur


def load(igra_id, since, until, p_floor=0.0):
    """Every sounding in [since, until], stitched across data-por and data-y2d.

    data-por ends at NCEI's last annual rebuild, so anything after that only
    exists in data-y2d. Reading both and de-duplicating on the observation key
    is cheaper than working out where the seam is, and it is robust to NCEI
    moving it.
    """
    # data-y2d holds only the year in progress; every earlier year has been
    # folded into data-por. Asking for 2016 is ten 404s and forty seconds of
    # backoff for nothing, so ask only for the tail.
    paths = [fetch(igra_id)]
    for y in range(max(since[0], until[0] - 1), until[0] + 1):
        try:
            paths.append(fetch(igra_id, year=y))
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise   # no y2d file for that year; data-por has it

    seen, out = set(), []
    for path in paths:
        with zipfile.ZipFile(path) as z:
            with z.open(z.namelist()[0]) as f:
                for s in parse(io.TextIOWrapper(f, "ascii", "replace"),
                               since, until, p_floor):
                    if s.key in seen:
                        continue
                    seen.add(s.key)
                    out.append(s)
    out.sort(key=lambda s: s.key)
    return out


# --- heights ---------------------------------------------------------------

def build_heights(snd, station_elev):
    """Assign a geopotential height to every level with a temperature.

    Reported GPH exists only at mandatory levels (925, 850, 700, 500 hPa ...).
    Every significant level -- which is where the inversions and the sharp
    lapse-rate changes are, and therefore the whole reason to read a sounding
    instead of assuming ISA -- reports -9999. Integrating the hypsometric
    relation from the surface keeps those levels:

        dZ = (Rd * Tbar / g0) * ln(p1 / p2)

    Dry Tbar, not virtual: IGRA RH is missing on most of these records, and
    PLAN.md section 5 already defers the humidity correction as a <=1.5% effect.
    Here it is smaller still -- it biases each layer thickness by the same
    fraction, and the desert soundings this is applied to are dry.

    Returns the levels that got a height, ascending. The reported GPH is left
    alone on the Level for `gph_residual` to check the integration against.
    """
    ls = sorted((l for l in snd.levels if l.t is not None),
                key=lambda l: -l.p)
    if not ls:
        return []

    base = ls[0]
    # Prefer the surface level's own reported height; fall back to the station
    # elevation from the IGRA metadata. Balloons are released at the station.
    base.z = base.gph if (base.is_surface and base.gph is not None) else float(station_elev)
    if ls[0].gph is not None and not ls[0].is_surface:
        base.z = ls[0].gph

    for prev, cur in zip(ls, ls[1:]):
        tbar = 0.5 * (prev.t + cur.t)
        cur.z = prev.z + (RD * tbar / G0) * math.log(prev.p / cur.p)
    return ls


def gph_residual(levels):
    """Our integrated height minus the reported one, at levels that report both.

    A QC number, not a correction. If this runs to tens of metres the
    integration is sound; hundreds means the surface anchor is wrong.
    """
    return [l.z - l.gph for l in levels
            if l.z is not None and l.gph is not None]


def interp(levels, targets):
    """Temperature at each target geopotential height, linear in height.

    Returns None for a target outside the profile, except that up to
    EXTRAP_M below the lowest level it extrapolates on the lowest layer's own
    lapse rate -- the pad sits ~90 m under Edwards and refusing to answer for
    the bottom 90 m of a 7.6 km profile would be pedantry.
    """
    EXTRAP_M = 200.0
    if len(levels) < 2:
        return [None] * len(targets)
    out = []
    for z in targets:
        if z < levels[0].z:
            if levels[0].z - z > EXTRAP_M:
                out.append(None)
                continue
            a, b = levels[0], levels[1]
            lapse = (b.t - a.t) / (b.z - a.z)
            out.append(a.t + lapse * (z - a.z))
            continue
        if z > levels[-1].z:
            out.append(None)
            continue
        for a, b in zip(levels, levels[1:]):
            if a.z <= z <= b.z:
                if b.z == a.z:
                    out.append(a.t)
                else:
                    out.append(a.t + (b.t - a.t) * (z - a.z) / (b.z - a.z))
                break
        else:
            out.append(None)
    return out

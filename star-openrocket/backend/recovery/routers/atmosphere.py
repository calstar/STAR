"""POST /api/atmosphere. PLAN.md §5.

Resolves the pad state and returns the profile, so the UI can show what
atmosphere a run actually used rather than asserting it.

The endpoint is deliberately thin: `Atmosphere` takes three scalars and does
not care where they came from. Whoever resolves them -- the eq (7a) default, a
pad barometer, a METAR via eq (7b), or the climatology tables -- is somebody
else's problem, and that seam is what lets the atmosphere work stay
independent.
"""

import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from physics.atmosphere import Atmosphere, geopotential
from physics.constants import L0_ISA
from physics.site import FAR_ELEV_M
from physics.pad_state import fetch_metar, p_pad_isa, p_pad_metar, parse_metar

router = APIRouter(prefix="/api", tags=["atmosphere"])


class PadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    z_site: float = Field(default=FAR_ELEV_M,
                          description="Pad elevation, m MSL. Defaults to FAR "
                                      "(physics/site.py); the run schema has "
                                      "no elevation field at all.")
    T_pad: float | None = Field(default=None, gt=0.0)
    p_pad: float | None = Field(default=None, gt=0.0)
    lapse: float | None = Field(default=None,
                                description="Measured lapse rate, K/m (negative "
                                            "for a cooling column). None re-fits "
                                            "eq (7) from T_pad, as before.")
    max_altitude: float = Field(default=4000.0, gt=0.0,
                                description="Profile ceiling, m AGL")
    samples: int = Field(default=40, ge=2, le=500)


@router.post("/atmosphere")
def resolve_pad(req: PadRequest):
    try:
        atm = Atmosphere(req.z_site, req.T_pad, req.p_pad, req.lapse)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    step = req.max_altitude / (req.samples - 1)
    profile = []
    for i in range(req.samples):
        z = i * step
        profile.append({
            "z_agl": z,
            "z_msl": z + atm.site_elev,
            "T": atm.T(z),
            "p": atm.p(z),
            "rho": atm.rho(z),
            "g": atm.g(z),
        })

    return {
        "pad": {
            "z_site": atm.site_elev,
            "H_pad": atm.H_pad,
            "T_pad": atm.T_pad,
            "p_pad": atm.p_pad,
            "rho_pad": atm.rho(0.0),
            "lapse": atm.L0,
            "lapse_isa": L0_ISA,
            "refit": atm._refit,
            "T_source": "supplied" if req.T_pad is not None else "ISA at site",
            "p_source": ("supplied" if req.p_pad is not None
                         else "standard column"),
        },
        "profile": profile,
        # §15.7: the atmosphere is worth 1-3% on descent rate and *exactly
        # zero* on the main's opening load, which cancels density entirely.
        # Stated here so nobody chases a sounding while Cx remains a guess.
        "note": (
            "Temperature dominates: ~7% in density vs ~0.4% for pressure."
        ),
    }


# Stations that serve FAR, with the elevation each one reports. The gap to the
# pad is what sizes the eq (7b) lapse-transfer error, so it is surfaced rather
# than hidden -- §5 ranks the refinement as only worth taking when a reporting
# station sits within a few hundred metres of site elevation.
STATIONS = {
    "KNID": {"name": "China Lake NAWS", "elev_m": 696.0, "distance_km": 39.0},
    "KEDW": {"name": "Edwards AFB", "elev_m": 702.0, "distance_km": 50.0},
    "KMHV": {"name": "Mojave Air & Space Port", "elev_m": 849.0, "distance_km": 45.0},
}


# Upstream deadline for the one route that leaves the process.
#
# `fetch_metar` defaults to 30 s, which is right for a CLI and wrong here: the
# browser gives up at 6 s and reports "no response from the backend", blaming
# this service for the AWC API being slow. Failing fast lets the real 502 --
# naming the observation service -- reach the user instead.
_UPSTREAM_TIMEOUT_S = 4.0

# METARs are issued hourly, so re-fetching per keystroke buys nothing and makes
# switching stations in the site form feel like a network operation. Two
# minutes is far shorter than the issue interval, so the cache can never serve
# an observation the station has already superseded by more than that.
_CACHE_TTL_S = 120.0
_cache: dict[str, tuple[float, object]] = {}


def _observation(icao):
    """Latest observation for `icao`, cached briefly. Errors are not cached."""
    hit = _cache.get(icao)
    now = time.monotonic()
    if hit is not None and now - hit[0] < _CACHE_TTL_S:
        return hit[1]
    ob = fetch_metar(icao, timeout=_UPSTREAM_TIMEOUT_S)
    _cache[icao] = (now, ob)
    return ob


@router.get("/atmosphere/stations")
def list_stations():
    """The stations the site form can resolve from, with their pad gaps."""
    return [
        {"id": icao, "gap_m": meta["elev_m"] - FAR_ELEV_M, **meta}
        for icao, meta in sorted(STATIONS.items(),
                                 key=lambda kv: abs(kv[1]["elev_m"] - FAR_ELEV_M))
    ]


@router.get("/atmosphere/station/{icao}")
def resolve_from_station(icao: str):
    """Fetch the latest observation and resolve pad state from it.

    This is the one route in the app that reaches the network. It exists so
    the site form can *populate and lock* T_pad and p_pad rather than leaving
    them editable: a value resolved from a station is not a value the user
    typed, and letting it be edited invites a number that claims a provenance
    it does not have.

    Both conversions that §5 insists on happen here, not in the UI:
      * temperature is lapse-transferred across the station/pad elevation gap
      * pressure is the eq (7b) inversion of the altimeter setting, never the
        setting itself -- that raw value is an 11-18% density error at these
        elevations and exactly 0% at sea level, so it is invisible in testing
    """
    icao = icao.upper()
    meta = STATIONS.get(icao)
    if meta is None:
        raise HTTPException(
            status_code=404,
            detail="unknown station %r; try one of %s"
                   % (icao, ", ".join(sorted(STATIONS))),
        )

    try:
        ob = _observation(icao)
    except SystemExit as exc:
        # pad_state.fetch_metar raises SystemExit for "station reports nothing",
        # which is right for a CLI and wrong for a request handler.
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - network is the expected failure
        raise HTTPException(
            status_code=502,
            detail="could not reach the observation service for %s "
                   "within %g s (%s)" % (icao, _UPSTREAM_TIMEOUT_S, exc),
        ) from exc

    H_pad = geopotential(FAR_ELEV_M)
    T_pad = (ob.temp_c + 273.15) - L0_ISA * (meta["elev_m"] - FAR_ELEV_M)
    p_pad = p_pad_metar(ob.altim_pa, H_pad) if ob.altim_pa else None

    return {
        "station": icao,
        "name": meta["name"],
        "observed": ob.time,
        "raw": ob.raw,
        "station_elev_m": meta["elev_m"],
        "gap_m": meta["elev_m"] - FAR_ELEV_M,
        "temp_c": ob.temp_c,
        "dewpoint_c": ob.dewp_c,
        "maintenance_flag": ob.maintenance,
        # The two numbers the site form locks in.
        "T_pad": T_pad,
        "p_pad": p_pad,
        "T_transferred": True,
        "p_pad_isa": p_pad_isa(H_pad),
    }


class MetarRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    raw: str = Field(description="Raw METAR text")
    z_site: float = Field(default=FAR_ELEV_M,
                          description="Pad elevation, m MSL. Defaults to FAR "
                                      "(physics/site.py); the run schema has "
                                      "no elevation field at all.")
    station_elev: float | None = Field(
        default=None,
        description="Reporting station elevation, m MSL. Without it the "
                    "station temperature is used unadjusted.",
    )


@router.post("/atmosphere/metar")
def decode_metar(req: MetarRequest):
    """Decode a pasted METAR into pad state via eq (7b).

    No network: this parses text the user supplies. The trap it exists to
    prevent is using the altimeter setting raw as station pressure, which is an
    11-18% density error at high desert sites and exactly 0% at sea level --
    invisible in testing and worst where these vehicles actually fly.
    """
    try:
        ob = parse_metar(req.raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    H_pad = geopotential(req.z_site)
    T_pad = ob.temp_c + 273.15
    transferred = False
    if req.station_elev is not None:
        T_pad -= L0_ISA * (req.station_elev - req.z_site)
        transferred = True

    p_isa = p_pad_isa(H_pad)
    p_pad = p_pad_metar(ob.altim_pa, H_pad) if ob.altim_pa else None

    return {
        "station": ob.station,
        "time": ob.time,
        "temp_c": ob.temp_c,
        "dewpoint_c": ob.dewp_c,
        "altimeter_pa": ob.altim_pa,
        "maintenance_flag": ob.maintenance,
        "T_pad": T_pad,
        "T_transferred": transferred,
        "p_pad": p_pad,
        "p_pad_isa": p_isa,
        "p_naive_error_pct": (
            None if p_pad is None else (ob.altim_pa / p_pad - 1.0) * 100.0
        ),
    }

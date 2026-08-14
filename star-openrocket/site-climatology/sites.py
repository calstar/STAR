"""The observing stations that serve the launch site.

Everything here is a per-station constant, kept in one place so the two
fetchers and the tests cannot drift apart on which station they mean.

The *site* itself -- position and pad elevation -- lives in `physics/site.py`
and is imported below rather than duplicated. Pad elevation appears in two
places that must agree: eq (7a) inside the recovery model, and the station
elevation gaps here that size the eq (7b) lapse-transfer error. Two copies
could drift; one cannot.
"""

from _padstate import site as _site

# Friends of Amateur Rocketry, Mojave CA.
FAR_LAT = _site.FAR_LAT      # 35.35333
FAR_LON = _site.FAR_LON      # -117.80717

# Pad elevation MSL, metres, and whether it is a stated value or an inherited
# guess. Both come from physics/site.py, which carries the provenance; re-export
# the flag rather than letting each consumer decide, because it was once
# hard-coded True in the JSON export and stayed True after the elevation was
# confirmed. 10 m of error is 0.12% in pressure.
FAR_ELEV = _site.FAR_ELEV_M
FAR_ELEV_CONFIRMED = _site.FAR_ELEV_CONFIRMED


class Surface:
    """A METAR reporting station."""

    def __init__(self, icao, iem_id, name, lat, lon, elev_m, note=""):
        self.icao = icao
        self.iem_id = iem_id      # IEM drops the leading K for US stations
        self.name = name
        self.lat = lat
        self.lon = lon
        self.elev_m = elev_m      # as the station itself reports it
        self.note = note

    @property
    def gap_m(self):
        """Elevation gap to the pad. This is what sizes the eq (7b) error."""
        return self.elev_m - FAR_ELEV


# Distances are great-circle to the pad; see README for the full survey and for
# why L71 and KIYK are not here.
SURFACE = {
    "KNID": Surface("KNID", "NID", "China Lake NAWS", 35.688, -117.690, 696.0,
                    "primary: 39 km, +86 m gap. Temperature drops out ~06-11Z."),
    "KMHV": Surface("KMHV", "MHV", "Mojave Air & Space Port", 35.059, -118.152, 849.0,
                    "cross-check: 45 km, +239 m gap. Reports temperature overnight."),
    "KEDW": Surface("KEDW", "EDW", "Edwards AFB", 34.906, -117.884, 702.0,
                    "cross-check: 50 km, +92 m gap. Co-located with RAOB 72381."),
}

# Elevations above are as the IEM archive reports them, because that is the
# archive these numbers are decoded from. AWC's stationinfo disagrees by up to
# 14 m (KNID 682, KEDW 698, KMHV 841). It does not matter: station elevation
# enters only the temperature lapse transfer, where 14 m is 0.09 K. It does
# NOT enter eq (7b) at all -- an altimeter setting is already referred to sea
# level, so the only elevation in that equation is the pad's.

PRIMARY_SURFACE = "KNID"


class Upper:
    """An IGRA v2 radiosonde station."""

    def __init__(self, igra_id, wmo, name, lat, lon, elev_m, note=""):
        self.igra_id = igra_id
        self.wmo = wmo
        self.name = name
        self.lat = lat
        self.lon = lon
        self.elev_m = elev_m
        self.note = note


# The trade here is location against sampling, and no single station wins both.
# See README "Sounding stations".
UPPER = {
    "EDW": Upper("USM00072381", 72381, "Edwards AFB", 34.9167, -117.9000, 702.0,
                 "49 km. Test-range operation: 160/yr in 2017, 41/yr in 2025."),
    "NID": Upper("USM00074612", 74612, "China Lake NAF", 35.6833, -117.6833, 696.0,
                 "38 km, the closest. Steady ~50/yr, and it holds up where "
                 "Edwards thinned out."),
    "VEF": Upper("USM00072388", 72388, "Las Vegas", 36.0471, -115.1846, 697.2,
                 "249 km east. Operational 00/12Z, ~730/yr. Different site, "
                 "so a cross-check rather than a pool member."),
}

# Pooled by default. Both are inside 50 km, 40 km from each other, both ~700 m
# high desert -- one air mass sampled twice, not two climates averaged. Each
# alone is too thin for monthly bins; together they are 1491 soundings over the
# last decade against Edwards' 992.
PRIMARY_UPPER = ["EDW", "NID"]

# Ceiling for the temperature profile: 25,000 ft AGL over the pad.
CEILING_AGL_M = 25000 * 0.3048          # 7620.0 m
CEILING_MSL_M = FAR_ELEV + CEILING_AGL_M  # 8230.0 m

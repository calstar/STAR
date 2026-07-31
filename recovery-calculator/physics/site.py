"""The launch site. Stdlib only.

This project models exactly one site -- the Friends of Amateur Rocketry (FAR)
range in the Mojave -- so pad elevation is a constant rather than an input.
Removing it from the config schema removes a field nobody should be editing
and a whole class of "someone typed the wrong elevation" error.

`site-climatology/sites.py` imports FAR_ELEV_M from here rather than keeping
its own copy, so the elevation that sizes the eq (7b) station gaps and the
elevation that feeds eq (7a) can never drift apart.

If the range ever moves, or the survey below is corrected, this is the only
line to change.
"""

# Pad elevation, metres MSL. 630 m is 2067 ft.
#
# Supplied by the project lead, superseding the 610 m estimate this file
# inherited from pad-state/README.md -- which was flagged there as unconfirmed
# and never checked. The 20 m correction is 0.24% in pressure, hence ~0.24% in
# density and ~0.12% in descent rate: real but far below the Cx band of
# +/-20% (§15.7). It also shifts every station elevation gap in
# site-climatology by the same 20 m, which is what sizes the eq (7b)
# lapse-transfer error there.
FAR_ELEV_M = 630.0

# 35 deg 21' 12.00" N, 117 deg 48' 25.80" W
FAR_LAT = 35 + 21 / 60 + 12.00 / 3600
FAR_LON = -(117 + 48 / 60 + 25.80 / 3600)

FAR_NAME = "Friends of Amateur Rocketry (FAR), Mojave CA"

# True where FAR_ELEV_M is a stated value rather than an inherited guess. The
# warning in schema.py keys off this, so flipping it silences the "unconfirmed
# estimate" note. Set when the 630 m figure replaced the 610 m estimate.
FAR_ELEV_CONFIRMED = True

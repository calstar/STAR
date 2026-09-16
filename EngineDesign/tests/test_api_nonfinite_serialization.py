"""Non-finite floats must not take down an API response.

A NaN anywhere in the results dict made json.dumps raise
"Out of range float values are not JSON compliant", which the evaluate router
turned into a blanket HTTP 500 on forward evaluation. NaN is a legal model output
(e.g. a lag model that does not define K_v), so it must serialise as null.
"""
import math
import numpy as np
import pytest

from backend.routers.evaluate import convert_numpy as ev_convert
from backend.routers.flight import convert_numpy as fl_convert
from backend.routers.timeseries import convert_numpy as ts_convert
from backend.routers.optimizer import convert_numpy as op_convert

CONVERTERS = [
    pytest.param(ev_convert, id="evaluate"),
    pytest.param(fl_convert, id="flight"),
    pytest.param(ts_convert, id="timeseries"),
    pytest.param(op_convert, id="optimizer"),
]


@pytest.mark.parametrize("convert", CONVERTERS)
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"),
                                 np.float64("nan"), np.float64("inf")])
def test_non_finite_becomes_none(convert, bad):
    assert convert(bad) is None


@pytest.mark.parametrize("convert", CONVERTERS)
def test_nested_payload_is_json_serialisable(convert):
    """The shape that actually broke: NaN buried in the stability payload."""
    import json
    payload = {
        "F": np.float64(8000.0),
        "stability_rich": {"chug": {"lag_breakdown": {
            "O": {"K_v": float("nan"), "tau_vap_s": 0.0037},
            "F": {"K_v": np.float64("nan"), "tau_vap_s": 0.0141},
        }}},
        "series": [1.0, float("inf"), np.float64("nan"), 4.0],
    }
    out = convert(payload)
    json.dumps(out)                                   # must not raise
    assert out["stability_rich"]["chug"]["lag_breakdown"]["O"]["K_v"] is None
    assert out["stability_rich"]["chug"]["lag_breakdown"]["F"]["K_v"] is None
    assert out["series"][1] is None and out["series"][2] is None


@pytest.mark.parametrize("convert", CONVERTERS)
def test_finite_values_are_untouched(convert):
    """The guard must not eat real numbers."""
    assert convert(np.float64(8000.0)) == pytest.approx(8000.0)
    assert convert(0.0) == 0.0
    assert convert(-1.5) == pytest.approx(-1.5)
    assert convert(np.int64(26)) == 26

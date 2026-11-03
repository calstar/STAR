"""The thrustcurve.org client waits out a rate limit instead of giving up within a second."""

import httpx
import pytest

from backend.motors import thrustcurve
from backend.motors.thrustcurve import ThrustCurveClient


def _client(responses, monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(thrustcurve._time, "sleep", sleeps.append)
    queue = list(responses)
    client = ThrustCurveClient(throttle=0.0)
    client._client = httpx.Client(
        base_url=thrustcurve.BASE_URL, transport=httpx.MockTransport(lambda req: queue.pop(0))
    )
    return client, sleeps


def test_a_rate_limit_is_waited_out_and_does_not_use_up_the_retries(monkeypatch):
    responses = [httpx.Response(429)] * 4 + [httpx.Response(200, json={"results": [{"motorId": "m"}]})]
    client, sleeps = _client(responses, monkeypatch)
    assert client.search("CTI") == [{"motorId": "m"}]
    assert sleeps[:4] == [30.0, 60.0, 120.0, 240.0]


def test_retry_after_is_honoured_and_capped(monkeypatch):
    responses = [
        httpx.Response(429, headers={"Retry-After": "7"}),
        httpx.Response(429, headers={"Retry-After": "9999"}),
        httpx.Response(200, json={"results": []}),
    ]
    client, sleeps = _client(responses, monkeypatch)
    client.search("CTI")
    assert sleeps[:2] == [7.0, thrustcurve.RATE_LIMIT_MAX_WAIT_S]


def test_it_still_gives_up(monkeypatch):
    client, _ = _client([httpx.Response(429)] * 20, monkeypatch)
    with pytest.raises(RuntimeError, match="429"):
        client.search("CTI")
    client, _ = _client([httpx.Response(500)] * 3, monkeypatch)
    with pytest.raises(RuntimeError, match="500"):
        client.search("CTI")

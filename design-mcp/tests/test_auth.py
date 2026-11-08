"""Who gets in, and who the apps are told is asking."""

from __future__ import annotations

import httpx
import pytest

from star_design_mcp import settings as settings_mod
from star_design_mcp.tokens import TokenVerifier

from .conftest import ALICE, BOB, HOST, NO_SCOPE


async def test_no_token_is_refused(harness):
    r = await harness.rpc("tools/list", token=None)
    assert r.status_code == 401
    assert r.json()["reason"] == "missing"
    assert "Bearer" in r.headers["www-authenticate"]


async def test_starproject_only_token_is_refused_with_the_reason(harness):
    r = await harness.rpc("tools/list", token=NO_SCOPE)
    assert r.status_code == 401
    assert r.json()["reason"] == "scope"
    assert "Design tools" in r.json()["hint"]


async def test_starproject_down_is_503_not_a_pass(harness):
    harness.verifier.down = True
    r = await harness.rpc("tools/list", token=ALICE)
    assert r.status_code == 503


async def test_apps_hear_the_token_owner_never_a_client_header(harness):
    harness.fake.on("daq-viewer", "GET", "/api/runs/r1/summary", lambda req: httpx.Response(200, json={"run_id": "r1"}))
    # A client-sent identity header must not reach an app: the token decides.
    await harness.call("daq_run_summary", {"run_id": "r1"}, token=BOB, **{"X-Auth-Email": "alice@berkeley.edu"})
    sent = harness.fake.seen[-1]
    assert sent.headers["x-auth-email"] == "bob@berkeley.edu"


async def test_whoami(harness):
    assert (await harness.call_json("whoami"))["email"] == "alice@berkeley.edu"


async def test_files_and_health_need_no_bearer(harness):
    assert (await harness.client.get("/healthz")).status_code == 200
    # An unsigned file token is refused by the link check, not by bearer auth.
    assert (await harness.client.get("/files/abc.def")).status_code == 403


async def test_a_401_points_oauth_clients_at_starproject(harness):
    # claude.ai connectors can't send a header token: the 401 names the metadata,
    # and the metadata names STARProject (the verify URL's origin) as the issuer.
    r = await harness.rpc("tools/list", token=None)
    challenge = r.headers["www-authenticate"]
    url = challenge.split('resource_metadata="')[1].split('"')[0]
    assert url.endswith("/.well-known/oauth-protected-resource/mcp")
    meta = (await harness.client.get(url.replace(HOST, ""))).json()
    assert meta["resource"] == f"{HOST}/mcp"
    assert meta["authorization_servers"] == ["http://starproject.test"]
    assert (await harness.client.get("/.well-known/oauth-protected-resource")).json() == meta


def test_auth_server_can_be_named_and_is_absent_on_a_dev_server(env):
    assert settings_mod.load({**env, "DESIGN_MCP_AUTH_SERVER": "https://project.example/"}).auth_server == (
        "https://project.example"
    )
    dev = {k: v for k, v in env.items() if not k.startswith("DESIGN_MCP_VERIFY")}
    assert settings_mod.load({**dev, "DESIGN_MCP_DEV_EMAIL": "a@berkeley.edu"}).auth_server is None
    with pytest.raises(settings_mod.SettingsError):
        settings_mod.load({**env, "DESIGN_MCP_AUTH_SERVER": "project.example"})


# ── the verifier itself, against a fake STARProject ─────────────────────────


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _verifier(handler, clock):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return TokenVerifier("http://sp/api/mcp/verify", "secret", cache_s=60, client=client, clock=clock)


async def test_verifier_sends_scope_and_secret_and_caches_a_yes():
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return httpx.Response(200, json={"email": "A@Berkeley.edu", "name": "A", "tokenId": "t1"})

    clock = Clock()
    v = _verifier(handler, clock)
    who = await v.check(ALICE)
    assert who.email == "a@berkeley.edu"
    assert calls[0].headers["x-internal-secret"] == "secret"
    assert b'"scope":"design"' in calls[0].content.replace(b" ", b"")
    await v.check(ALICE)
    assert len(calls) == 1, "a yes is cached"
    clock.t += 61
    await v.check(ALICE)
    assert len(calls) == 2, "and re-asked after the cache window (so a revoke lands within it)"


async def test_verifier_never_caches_an_outage_or_a_bad_secret():
    state = {"status": 403}
    calls = []

    def handler(req):
        calls.append(req)
        if state["status"] == 200:
            return httpx.Response(200, json={"email": "a@b.edu", "name": "", "tokenId": "t"})
        return httpx.Response(state["status"], json={"error": "forbidden"})

    v = _verifier(handler, Clock())
    assert (await v.check(ALICE)).reason == "unavailable"
    state["status"] = 200
    assert (await v.check(ALICE)).email == "a@b.edu", "a 403 (our secret) must not stick to the token"


async def test_verifier_passes_on_the_refusal_reason():
    v = _verifier(lambda req: httpx.Response(401, json={"error": "unauthorized", "reason": "revoked"}), Clock())
    assert (await v.check(ALICE)).reason == "revoked"


async def test_verifier_rejects_non_tokens_without_asking():
    v = _verifier(lambda req: pytest.fail("asked STARProject about a non-token"), Clock())
    assert (await v.check("ghp_whatever")).reason == "malformed"
    assert (await v.check(None)).reason == "missing"


# ── settings ────────────────────────────────────────────────────────────────


def test_settings_refuse_a_server_that_checks_nothing(env):
    del env["DESIGN_MCP_VERIFY_URL"]
    with pytest.raises(settings_mod.SettingsError):
        settings_mod.load(env)


def test_settings_refuse_dev_and_prod_at_once(env):
    env["DESIGN_MCP_DEV_EMAIL"] = "me@berkeley.edu"
    with pytest.raises(settings_mod.SettingsError):
        settings_mod.load(env)


def test_unset_app_is_absent_not_guessed(env):
    del env["DAQ_VIEWER_URL"]
    assert "daq-viewer" not in settings_mod.load(env).app_urls

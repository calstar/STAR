#!/usr/bin/env bash
# End-to-end check that a protected site really refuses unauthenticated callers.
#
# check_gate_order.py proves the *order* is right by reading adapted JSON. This
# proves the *behaviour*: it stands up the real Caddyfile against stub upstreams
# and asserts what a browser would actually get. Both are kept because the static
# check is fast and covers every site, while this one pins the semantics that
# matter -- 401 without a session, and an identity the client cannot choose.
#
#   ./test_auth_gate.sh [path/to/Caddyfile]     (defaults to the one next door)
#
# Requires Docker. openrocket.* stands in for every site built the same way.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDYFILE="$(cd "$(dirname "${1:-$HERE/../Caddyfile}")" && pwd)/$(basename "${1:-Caddyfile}")"
NET="caddyauthtest$$"; PORT="${TEST_PORT:-9080}"; FAIL=0
VHOST=openrocket.starberkeley.org

cleanup(){ docker rm -f ct-caddy ct-auth ct-api ct-fe >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup; docker network create "$NET" >/dev/null

stub(){ docker run -d --rm --name "$1" --network "$NET" --network-alias "$2" \
          -e ROLE="$4" -e NAME="$2" -e PORT="$3" -v "$HERE/stub.py":/stub.py:ro \
          python:3.12-alpine python /stub.py >/dev/null; }
stub ct-auth auth 5000 auth
stub ct-api  star-openrocket-api 8002 app
stub ct-fe   star-openrocket-frontend 4177 app

docker run -d --rm --name ct-caddy --network "$NET" -p "$PORT":80 \
  -e SCHEME=http -e BASE_DOMAIN=starberkeley.org \
  -v "$CADDYFILE":/etc/caddy/Caddyfile:ro caddy:2-alpine >/dev/null
# Wait for Caddy to bind rather than sleeping a fixed amount.
for _ in $(seq 40); do
  curl -sS -o /dev/null --max-time 2 -H "Host: $VHOST" "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.5
done

BODY="$(mktemp)"
req(){ curl -sS --max-time 10 -o "$BODY" -w '%{http_code}' -H "Host: $VHOST" "${@:2}" "http://127.0.0.1:$PORT$1" 2>/dev/null; }
check(){ local label="$1" want="$2" want_body="${3:-}"
  if [ "$CODE" = "$want" ] && { [ -z "$want_body" ] || grep -q "$want_body" "$BODY"; }; then
    echo "  PASS  $label"
  else
    echo "  FAIL  $label -> HTTP $CODE body='$(head -c 90 "$BODY")' (wanted $want ${want_body:+containing '$want_body'})"
    FAIL=1
  fi; }

echo "--- unauthenticated must be refused ---"
CODE=$(req /api/health); check "GET /api/health, no cookie" 401
CODE=$(req /);            check "GET /,           no cookie" 401
echo "--- authenticated must reach the right upstream ---"
CODE=$(req /api/health -H 'Cookie: session=good'); check "GET /api/health -> api"      200 "star-openrocket-api"
CODE=$(req /            -H 'Cookie: session=good'); check "GET /           -> frontend" 200 "star-openrocket-frontend"
echo "--- identity comes from auth, never from the client ---"
CODE=$(req /api/whoami -H 'Cookie: session=good'); check "identity injected by auth" 200 "x-auth-email=real@berkeley.edu"
CODE=$(req /api/whoami -H 'Cookie: session=good' -H 'X-Auth-Email: forged@evil.com'); check "forged header overwritten" 200 "x-auth-email=real@berkeley.edu"
CODE=$(req /api/whoami -H 'X-Auth-Email: forged@evil.com'); check "forged header without session refused" 401

rm -f "$BODY"
[ "$FAIL" = 0 ] && echo "all assertions passed" || echo "FAILURES -- the site is not gated the way it looks"
exit $FAIL

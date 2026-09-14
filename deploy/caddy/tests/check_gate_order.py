#!/usr/bin/env python3
"""Assert every gated site runs forward_auth BEFORE it proxies anything.

Reads `caddy adapt` JSON on stdin. This exists because the failure it catches is
invisible in the Caddyfile: `import protected` expands to a `route`, and the
adapter sorts `handle` ahead of `route`. A site written as

    openrocket.example.org {
        import protected
        handle /api/* { reverse_proxy api:8002 }
        handle        { reverse_proxy frontend:4177 }
    }

therefore matches a handle, proxies, and terminates the request before the auth
subrequest ever runs -- serving the whole app, API included, to anyone. It looks
protected, it adapts without warning, and every page still loads while logged in,
so nothing short of checking the adapted order catches it.

Sites that are public on purpose go in PUBLIC_HOSTS.
"""
import json
import sys

#: Hosts with no auth by design. auth itself must never be gated -- it is what
#: grants access, so protecting it would deadlock the login flow.
PUBLIC_HOSTS = {"auth"}


def _sequence(handlers):
    """Ordered list of "auth"/"proxy" for one site's handler tree."""
    out = []
    for h in handlers:
        if h.get("handler") == "subroute":
            for r in h.get("routes", []):
                blob = json.dumps(r.get("handle", []))
                # forward_auth is the only reverse_proxy that sets X-Forwarded-Uri.
                if '"X-Forwarded-Uri"' in blob:
                    out.append("auth")
                elif '"reverse_proxy"' in blob:
                    out.append("proxy")
                else:
                    out.extend(_sequence(r.get("handle", [])))
    return out


def main() -> int:
    cfg = json.load(sys.stdin)
    failures = []
    checked = 0
    for server in cfg.get("apps", {}).get("http", {}).get("servers", {}).values():
        for route in server.get("routes", []):
            hosts = [h for m in route.get("match", []) for h in m.get("host", [])]
            if not hosts:
                continue
            label = hosts[0]
            if label.split(".")[0] in PUBLIC_HOSTS:
                continue
            seq = _sequence(route.get("handle", []))
            if not seq:
                continue
            checked += 1
            if "auth" not in seq:
                failures.append(f"{label}: no forward_auth at all (sequence: {seq})")
            elif seq.index("auth") != 0:
                failures.append(
                    f"{label}: forward_auth runs at position {seq.index('auth')}, "
                    f"after {seq.index('auth')} proxy handler(s) -- the site is UNGATED "
                    f"(sequence: {seq}). Wrap the site body in a single route{{}}."
                )
    if failures:
        print("FAIL: gated sites that do not actually gate:\n")
        for f in failures:
            print("  -", f)
        print("\nSee deploy/caddy/tests/check_gate_order.py for why this happens.")
        return 1
    print(f"OK: all {checked} non-public site(s) run forward_auth first")
    return 0


if __name__ == "__main__":
    sys.exit(main())

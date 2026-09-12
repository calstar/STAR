"""Stub upstream. ROLE=auth mimics /verify; ROLE=app echoes what it received."""
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
ROLE = os.environ["ROLE"]; NAME = os.environ.get("NAME", ROLE); PORT = int(os.environ["PORT"])

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _send(self, code, body=b"", extra=None):
        self.send_response(code)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)
    def do_GET(self):
        if ROLE == "auth":
            # Only a request carrying our known-good session is allowed through.
            cookie = self.headers.get("Cookie", "")
            if "session=good" in cookie:
                self._send(200, b"OK", {"X-Auth-Email": "real@berkeley.edu",
                                        "X-Auth-User": "Real User"})
            else:
                self._send(401, b"Unauthorized")
        else:
            # Report which upstream answered and the identity it was handed.
            seen = self.headers.get("X-Auth-Email", "<none>")
            self._send(200, f"{NAME}|x-auth-email={seen}".encode())
    do_POST = do_GET
    def log_message(self, *a): pass

HTTPServer(("0.0.0.0", PORT), H).serve_forever()

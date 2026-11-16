"""Minimal RFC 6455 client for watching the backend's WebSocket, stdlib only.

A background thread reads frames, answers pings, and appends (monotonic_s, decoded JSON) to
`frames`. Server frames are unmasked; the ws library the backend uses has permessage-deflate off
by default, so no extension handling is needed.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import threading
import time


class WsProbe:
    def __init__(self, host: str, port: int, path: str = "/"):
        self.frames: list[tuple[float, dict]] = []
        self.close_code: int | None = None
        self.closed_at: float | None = None
        self.lock = threading.Lock()
        self.sock = socket.create_connection((host, port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WS handshake: connection closed")
            resp += chunk
        head, self._buf = resp.split(b"\r\n\r\n", 1)
        self.status_line = head.split(b"\r\n", 1)[0].decode()
        if " 101 " not in self.status_line:
            raise ConnectionError(f"WS handshake failed: {self.status_line}")
        self.sock.settimeout(0.5)
        self._stop = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _read(self, n: int) -> bytes:
        while len(self._buf) < n:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                if self._stop:
                    raise ConnectionError("stopped")
                continue
            if not chunk:
                raise ConnectionError("eof")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send(self, opcode: int, payload: bytes = b""):
        mask = os.urandom(4)
        hdr = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        try:
            self.sock.sendall(hdr + mask + masked)
        except OSError:
            pass

    def _run(self):
        message = b""
        try:
            while not self._stop:
                b0, b1 = self._read(2)
                opcode = b0 & 0x0F
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self._read(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self._read(8))[0]
                payload = self._read(n)
                if opcode == 0x9:
                    self._send(0xA, payload)
                    continue
                if opcode == 0x8:
                    self.close_code = (
                        struct.unpack(">H", payload[:2])[0]
                        if len(payload) >= 2
                        else 1005
                    )
                    self.closed_at = time.monotonic()
                    return
                if opcode in (0x1, 0x2, 0x0):
                    message += payload
                    if b0 & 0x80:
                        try:
                            obj = json.loads(message.decode("utf-8"))
                        except ValueError:
                            obj = {"type": "<non-json>"}
                        with self.lock:
                            self.frames.append((time.monotonic(), obj))
                        message = b""
        except (ConnectionError, OSError):
            if self.closed_at is None:
                self.closed_at = time.monotonic()
                self.close_code = self.close_code or 1006

    def snapshot(self) -> list[tuple[float, dict]]:
        with self.lock:
            return list(self.frames)

    def close(self):
        self._stop = True
        self._send(0x8, struct.pack(">H", 1000))
        try:
            self.sock.close()
        except OSError:
            pass

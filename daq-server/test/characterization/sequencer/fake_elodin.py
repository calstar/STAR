"""A stand-in for elodin-db on DB_PORT: a side channel and a fake pressure feed.

The sequencer publishes every state change as a StateTransition table ([0x43, 0x00]: u64 ts_ns,
u8 from, u8 to, u8 reason) at the end of doTransitionTo(). Those frames are what this suite uses
as the boundary between one state's actuator loop and the next — they are how a 1 Hz republish
is told apart from a state entry without guessing from packet timing. They are recorded, never
frozen: the Elodin schema is another area's golden.

It also serves calibrated-PT frames to whichever connection subscribes, so a dynamic state's
pressure() can be driven. Framing (ElodinClient.cpp / ElodinClient.hpp): len u32 LE (bytes after
the len field), type u8, packet id 2 bytes, request id u8, payload. A subscribe is type MSG with
packet id 0x11 0x0d and the table id in body bytes 4..5. A CalibratedPTMessage payload
(transport/include/comms/messages/sensor/CalibratedPTMessage.hpp) is 21 packed bytes:
u64 ts_ns, u8 channel, 3 pad, f32 psi, u32 raw_adc, u8 calibration_status.
"""

from __future__ import annotations

import socket
import struct
import threading
import time

TABLE_STATE_TRANSITION = (0x43, 0x00)


class FakeElodin:
    def __init__(self, port: int):
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", port))
        self.srv.listen(16)
        self.srv.settimeout(0.05)
        self.lock = threading.Lock()
        self.transitions: list[tuple[int, int, int]] = (
            []
        )  # (monotonic ns, from id, to id)
        self.conns: list[dict] = []
        # table (hi, lo) -> (psi, cal_status); None stops publishing that table
        self.values: dict[tuple[int, int], tuple[float, int]] = {}
        self.running = True
        self.threads = [
            threading.Thread(target=self._accept, daemon=True),
            threading.Thread(target=self._publish, daemon=True),
        ]
        for t in self.threads:
            t.start()

    # ── side channel ───────────────────────────────────────────────────────────────────────────

    def mark(self) -> int:
        return len(self.transitions)

    def since(self, mark: int):
        with self.lock:
            return list(self.transitions[mark:])

    # ── pressure feed ──────────────────────────────────────────────────────────────────────────

    def set_pressure(
        self, table: tuple[int, int], psi: float | None, cal: int = 1
    ) -> None:
        with self.lock:
            if psi is None:
                self.values.pop(table, None)
            else:
                self.values[table] = (psi, cal)

    def clear_pressures(self) -> None:
        with self.lock:
            self.values.clear()

    # ── plumbing ───────────────────────────────────────────────────────────────────────────────

    def _accept(self):
        while self.running:
            try:
                c, _ = self.srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            conn = {"sock": c, "subs": set(), "wlock": threading.Lock(), "alive": True}
            with self.lock:
                self.conns.append(conn)
            threading.Thread(target=self._read, args=(conn,), daemon=True).start()

    def _read(self, conn):
        s = conn["sock"]
        buf = b""
        try:
            while self.running:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while len(buf) >= 4:
                    (n,) = struct.unpack_from("<I", buf, 0)
                    if len(buf) < 4 + n:
                        break
                    frame, buf = buf[: 4 + n], buf[4 + n :]
                    self._frame(conn, frame)
        except OSError:
            pass
        conn["alive"] = False

    def _frame(self, conn, frame: bytes):
        if len(frame) < 8:
            return
        pid = (frame[5], frame[6])
        if pid == (0x11, 0x0D) and len(frame) >= 10:
            conn["subs"].add((frame[8], frame[9]))
        elif pid == TABLE_STATE_TRANSITION and len(frame) >= 8 + 11:
            t = time.monotonic_ns()
            frm, to = frame[16], frame[17]
            with self.lock:
                self.transitions.append((t, frm, to))

    def _publish(self):
        while self.running:
            time.sleep(0.05)
            with self.lock:
                values = dict(self.values)
                conns = [c for c in self.conns if c["alive"]]
            for conn in conns:
                for table in conn["subs"]:
                    if table not in values:
                        continue
                    psi, cal = values[table]
                    body = struct.pack(
                        "<QB3xfIB", time.monotonic_ns(), table[1] & 0x1F, psi, 0, cal
                    )
                    frame = struct.pack(
                        "<IB2BB", 4 + len(body), 0, table[0], table[1], 0
                    )
                    try:
                        with conn["wlock"]:
                            conn["sock"].sendall(frame + body)
                    except OSError:
                        conn["alive"] = False

    def close(self):
        self.running = False
        for t in self.threads:
            t.join()
        with self.lock:
            for c in self.conns:
                try:
                    c["sock"].close()
                except OSError:
                    pass
        self.srv.close()

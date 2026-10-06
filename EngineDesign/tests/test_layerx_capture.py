"""Capturing a flight's prints must not capture, or lose, anyone else's (engine/layerx/capture.py).

Two burns fly at once in the API. With ``contextlib.redirect_stdout`` the second restored the
first's buffer and the server printed into it for ever; this is that scene.
"""

from __future__ import annotations

import sys
import threading
import time

from engine.layerx.capture import thread_stdout


def test_two_threads_capture_only_their_own_and_the_stream_comes_back():
    got = {}
    barrier = threading.Barrier(2)

    def fly(name: str, hold: float) -> None:
        with thread_stdout() as buf:
            barrier.wait()
            for _ in range(5):
                print(f"[flight_sim] {name}")
                time.sleep(hold)
        got[name] = buf.getvalue()

    a = threading.Thread(target=fly, args=("A", 0.01))
    b = threading.Thread(target=fly, args=("B", 0.002))
    a.start(); b.start()
    print("main thread line")           # not captured by either
    a.join(); b.join()
    assert got["A"].count("A") == 5 and "B" not in got["A"]
    assert got["B"].count("B") == 5 and "A" not in got["B"]
    # After both exit, this thread writes to the real stream again, not to a buffer left behind.
    assert sys.stdout._target() is sys.stdout.real
    with thread_stdout() as again:
        print("x")
    assert again.getvalue() == "x\n"
    assert "main thread line" not in got["A"] + got["B"]

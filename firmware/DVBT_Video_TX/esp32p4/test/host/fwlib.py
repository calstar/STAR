"""Build the firmware's host-testable C (no ESP-IDF calls) into a shared
library and load it with ctypes. Used by test_host.py and by the gateware's
cocotb tests, so the firmware's frames are checked against the RTL."""
from __future__ import annotations

import ctypes
import subprocess
import tempfile
from pathlib import Path

FW = Path(__file__).resolve().parents[2]
SRCS = ["components/fpga_link/fpga_proto.c", "components/si5351/si5351_plan.c",
        "components/ad9116/ad9116.c", "components/adrf6755/adrf6755_plan.c",
        "components/adrf6755/adrf6755.c", "components/spi_bus_esp/spi_bus_pack.c",
        "components/ecp5_cfg/ecp5_cfg_core.c", "components/ts_mux/ts_mux.c",
        "components/video_src/h264_util.c"]
INCS = ["test/host/shim", "components/spi_bus_if/include", "components/fpga_link/include",
        "components/si5351/include", "components/ad9116/include", "components/adrf6755/include",
        "components/spi_bus_esp/include", "components/ecp5_cfg/include",
        "components/ts_mux/include", "components/video_src/include"]

_lib = None


def load() -> ctypes.CDLL:
    global _lib
    if _lib is None:
        out = Path(tempfile.mkdtemp()) / "libfw.so"
        cmd = ["gcc", "-shared", "-fPIC", "-O1", "-Wall", "-Wextra", "-Werror", "-o", str(out)]
        cmd += [f"-I{FW / i}" for i in INCS] + [str(FW / s) for s in SRCS]
        subprocess.run(cmd, check=True)
        _lib = ctypes.CDLL(str(out))
    return _lib


def frame_write(addr: int, val: int) -> bytes:
    b = (ctypes.c_uint8 * 8)()
    n = load().fpga_frame_write(b, addr, ctypes.c_uint32(val))
    return bytes(b[:n])


def frame_read(addr: int) -> bytes:
    b = (ctypes.c_uint8 * 8)()
    n = load().fpga_frame_read(b, addr)
    return bytes(b[:n])


def frame_ts(pkts: bytes) -> bytes:
    n = len(pkts) // 188
    b = (ctypes.c_uint8 * (1 + 188 * n))()
    m = load().fpga_frame_ts(b, pkts, ctypes.c_size_t(n))
    return bytes(b[:m])


def parse_read(rx: bytes) -> int:
    lib = load()
    lib.fpga_parse_read.restype = ctypes.c_uint32
    return lib.fpga_parse_read((ctypes.c_uint8 * len(rx))(*rx))

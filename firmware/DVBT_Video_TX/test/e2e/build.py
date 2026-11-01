#!/usr/bin/env python3
"""Build the end-to-end harness: the firmware's C (gcc, as a static
library) and the FPGA's top level (Verilator, C++) into one binary.

    python3 test/e2e/build.py [build-dir]     # prints the binary's path
"""
from __future__ import annotations

import fcntl
import hashlib
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]                       # firmware/DVBT_Video_TX
FW = ROOT / "esp32p4"
GW = ROOT / "gateware"
# Mutation runs point these at mutated copies (mutation_check.py).
COMP = Path(os.environ.get("DVBT_E2E_FW_DIR", FW / "components"))
RTL = Path(os.environ.get("DVBT_E2E_RTL_DIR", GW / "rtl"))

FW_SRCS = ["fpga_link/fpga_proto.c", "fpga_link/fpga_link.c", "si5351/si5351_plan.c", "si5351/si5351.c",
           "ad9116/ad9116.c", "adrf6755/adrf6755_plan.c", "adrf6755/adrf6755.c",
           "spi_bus_esp/spi_bus_pack.c", "ecp5_cfg/ecp5_cfg_core.c", "ts_mux/ts_mux.c", "tx_app/tx_app.c"]
FW_INCS = [HERE / "shim", FW / "test/host/shim"] + [COMP / c / "include" for c in (
    "spi_bus_if", "fpga_link", "si5351", "ad9116", "adrf6755", "spi_bus_esp", "ecp5_cfg", "ts_mux", "tx_app")]


def sources() -> list[Path]:
    rtl = sorted(RTL.glob("*.v")) + [GW / "tb/models/ODDRX1F.v", HERE / "models/EHXPLLL.v"]
    fw = [COMP / s for s in FW_SRCS] + sorted(COMP.glob("*/include/*.h"))
    return rtl + fw + [HERE / "e2e.cpp", HERE / "models.h"] + sorted((RTL / "rom").glob("*"))


def build(out: Path | None = None, trace: bool = False) -> Path:
    out = Path(out or os.environ.get("DVBT_E2E_BUILD", HERE / "build"))
    out.mkdir(parents=True, exist_ok=True)
    # pytest -n runs one session per worker: one builds, the others wait.
    with open(out / "lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        return _build(out, trace)


def _build(out: Path, trace: bool) -> Path:
    h = hashlib.sha256()
    for p in sources():
        h.update(str(p).encode())
        h.update(p.read_bytes())
    h.update(str(trace).encode())
    stamp = out / "stamp"
    exe = out / "obj/e2e"
    if exe.exists() and stamp.exists() and stamp.read_text() == h.hexdigest():
        return exe
    inc = [f"-I{p}" for p in FW_INCS]
    objs = []
    for s in FW_SRCS:
        o = out / (s.replace("/", "_") + ".o")
        subprocess.run(["gcc", "-c", "-O2", "-g", "-Wall", "-Wextra", "-Werror", *inc,
                        str(COMP / s), "-o", str(o)], check=True)
        objs.append(str(o))
    lib = out / "libfw.a"
    lib.unlink(missing_ok=True)
    subprocess.run(["ar", "rcs", str(lib), *objs], check=True)
    rtl = [str(p) for p in sorted(RTL.glob("*.v"))] + [str(GW / "tb/models/ODDRX1F.v"),
                                                                str(HERE / "models/EHXPLLL.v")]
    cflags = " ".join(["-O2", "-std=c++17", *inc, f"-I{HERE}"] + (["-DE2E_TRACE"] if trace else []))
    subprocess.run(["verilator", "--cc", "--exe", "--build", "-j", str(os.cpu_count() or 2), "-O3",
                    "--x-assign", "unique", "--x-initial", "0",   # ECP5: every FF and BRAM is 0 after configuration (GSR)
                    "-Wno-fatal", "-Wno-lint", "-Wno-style",
                    "--top-module", "dvbt_tx_top", f"-DDVBT_ROM_DIR=\"{RTL / 'rom'}\"",
                    "--Mdir", str(out / "obj"), "-o", "e2e", *(["--trace"] if trace else []), "-CFLAGS", cflags,
                    "-LDFLAGS", str(lib), *rtl, str(HERE / "e2e.cpp")], check=True,
                   stdout=subprocess.DEVNULL)
    stamp.write_text(h.hexdigest())
    return exe


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--trace"]
    print(build(Path(args[0]) if args else None, trace="--trace" in sys.argv))

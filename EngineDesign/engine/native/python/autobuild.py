"""Auto-build the native library on demand, cross-platform (macOS/Linux/Windows).

The first time the native path is used, this configures and builds libed_physics
with CMake into an arch-tagged build dir. Building with the *running interpreter's*
architecture means the ctypes load always matches (this is what removes the macOS
Rosetta arch caveat automatically — no manual flag needed). On Windows it shells
out to whatever CMake generator/toolchain is installed (MSVC or MinGW).

Rebuilds only when the library is missing or older than any header/source/CMake
file, so steady-state startup is a couple of stat() calls.
"""
from __future__ import annotations

import os
import platform
import subprocess
import sys
import threading

_LOCK = threading.Lock()
_CACHED_LIB: str | None = None

NATIVE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _system() -> str:
    return platform.system()  # 'Darwin' | 'Linux' | 'Windows'


def _lib_names() -> list[str]:
    s = _system()
    if s == "Darwin":
        return ["libed_physics.dylib"]
    if s == "Windows":
        return ["ed_physics.dll", "libed_physics.dll"]
    return ["libed_physics.so"]


def _build_dir() -> str:
    # Arch-tag so an x86_64 (Rosetta) and arm64 build never clash on macOS.
    tag = f"{_system().lower()}_{platform.machine().lower()}"
    return os.path.join(NATIVE_DIR, f"build_auto_{tag}")


def _find_lib(build_dir: str) -> str | None:
    # Single-config (Make/Ninja): build_dir/lib*. Multi-config (MSVC): build_dir/Release/*.
    search_dirs = [build_dir, os.path.join(build_dir, "Release"),
                   os.path.join(build_dir, "RelWithDebInfo")]
    for d in search_dirs:
        for name in _lib_names():
            p = os.path.join(d, name)
            if os.path.exists(p):
                return p
    return None


def _newest_source_mtime() -> float:
    newest = 0.0
    for sub in ("include", "src"):
        d = os.path.join(NATIVE_DIR, sub)
        for root, _, files in os.walk(d):
            for fn in files:
                if fn.endswith((".c", ".h")):
                    newest = max(newest, os.path.getmtime(os.path.join(root, fn)))
    cml = os.path.join(NATIVE_DIR, "CMakeLists.txt")
    if os.path.exists(cml):
        newest = max(newest, os.path.getmtime(cml))
    return newest


def _configure_args(build_dir: str) -> list[str]:
    args = ["cmake", "-S", NATIVE_DIR, "-B", build_dir, "-DCMAKE_BUILD_TYPE=Release"]
    if _system() == "Darwin":
        # Match the interpreter arch exactly; disable -march=native for that cross.
        args += [f"-DCMAKE_OSX_ARCHITECTURES={platform.machine()}", "-DED_NATIVE_ARCH=OFF"]
    return args


def ensure_lib(force: bool = False, verbose: bool = False) -> str:
    """Return a path to a current, arch-matched libed_physics, building if needed.

    Raises RuntimeError if CMake is unavailable or the build fails.
    """
    global _CACHED_LIB
    with _LOCK:
        if _CACHED_LIB and not force and os.path.exists(_CACHED_LIB):
            return _CACHED_LIB

        build_dir = _build_dir()
        lib = _find_lib(build_dir)
        needs_build = force or lib is None
        if lib is not None and not force:
            if os.path.getmtime(lib) < _newest_source_mtime():
                needs_build = True

        if needs_build:
            out = None if verbose else subprocess.DEVNULL
            try:
                subprocess.run(_configure_args(build_dir), check=True, stdout=out, stderr=out)
                subprocess.run(["cmake", "--build", build_dir, "--config", "Release",
                                "--target", "ed_physics_shared", "-j"],
                               check=True, stdout=out, stderr=out)
            except FileNotFoundError as e:
                raise RuntimeError("CMake not found on PATH; cannot auto-build native kernel") from e
            except subprocess.CalledProcessError as e:
                raise RuntimeError(f"Native build failed (see cmake output): {e}") from e
            lib = _find_lib(build_dir)

        if lib is None:
            raise RuntimeError(f"Native library not found after build in {build_dir}")
        _CACHED_LIB = lib
        return lib


def _safe_ensure() -> None:
    try:
        ensure_lib()
    except Exception:  # noqa: BLE001 - prewarm must never crash startup
        pass


def prewarm() -> "threading.Thread":
    """Kick off the build in a background daemon thread (non-blocking startup).

    The first native call blocks on the same lock, so it transparently waits for
    this to finish if it is still running.
    """
    t = threading.Thread(target=_safe_ensure, name="ed-native-prewarm", daemon=True)
    t.start()
    return t


if __name__ == "__main__":
    print(ensure_lib(force="--force" in sys.argv, verbose=True))

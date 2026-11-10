"""Make the built image independent of where it was built.

PlatformIO extra script. Wire it in with, in a project's platformio.ini:

    extra_scripts = pre:../../tools/reproducible_build.py

Why this exists
---------------
Every board reports a SHA-256 of its own firmware in its heartbeat, and CI keeps
a registry mapping that digest back to the commit that produced it (see
firmware/tools/which_firmware.py). That only works if the same source produces
the same bytes on every machine.

It did not. `ESP_ERROR_CHECK`, `assert` and the ESP log macros all expand
`__FILE__`, and the compiler sees absolute paths, so the image carried strings
like

    /home/aidan/.platformio/packages/framework-arduinoespressif32/cores/esp32/esp32-hal-spi.c
    /home/aidan/STAR-daq/firmware/Hotfire_Code/common/SensorHotfireCore.h

baked into the hashed bytes -- the username, the home directory and the checkout
path. The same commit built by two people, or by CI, produced three different
digests, so the digest identified the machine rather than the firmware.

`-ffile-prefix-map=OLD=NEW` rewrites those paths at compile time (it covers
`__FILE__` and the debug info both). GCC compares OLD as a literal prefix of the
path it has already normalised, so the mapping has to be an absolute, canonical
path -- which is why this is a script and not a line of `build_flags`: the header
that leaks sits at `-I../common`, outside `$PROJECT_DIR`, and no interpolation
available in platformio.ini can name its directory without a `..` that then
fails to match.

Keep the replacement names stable. Changing `/star` or `/pio` changes every
digest in the registry.
"""

from pathlib import Path

Import("env")  # noqa: F821  (injected by PlatformIO/SCons)

# This script's own path is not available: SCons runs it through exec(), so
# `__file__` is undefined. Find the repo root by walking up from the project
# until we see this very file, which works at any nesting depth and needs no git.
_MARKER = Path("firmware/tools/reproducible_build.py")


def _find_repo_root(start):
    for candidate in [start, *start.parents]:
        if (candidate / _MARKER).is_file():
            return candidate
    return None


REPO_ROOT = _find_repo_root(Path(env.subst("$PROJECT_DIR")).resolve())  # noqa: F821

# General prefix first, most specific last: the packages dir normally sits inside
# the core dir, and when two mappings both match GCC applies the LAST one (checked
# against GCC 8.4.0, the esp32s3 toolchain -- with the order reversed the packages
# paths came out under the core dir's replacement).
_MAPPINGS = [
    (env.subst("$PROJECT_CORE_DIR"), "/piocore"),  # noqa: F821
    (env.subst("$PROJECT_PACKAGES_DIR"), "/pio"),  # noqa: F821
    (str(REPO_ROOT) if REPO_ROOT else "", "/star"),
]

flags = []
seen = set()


def _add(old, new):
    if not old:
        return
    old = str(Path(old).resolve())
    if old in seen:
        return
    seen.add(old)
    flags.append(f"-ffile-prefix-map={old}={new}")


for _old, _new in _MAPPINGS:
    _add(_old, _new)

# Strip the @version suffix off each package directory.
#
# Mapping the packages dir alone is not enough: PlatformIO names a package
# directory `<name>` when it holds one version of it and `<name>@<version>`
# when it holds more than one, and that name lands in __FILE__. So a clean
# store compiled the Arduino core as
#     /pio/framework-arduinoespressif32/cores/esp32/esp32-hal-spi.c
# while a store that had ever seen a second espressif32 got
#     /pio/framework-arduinoespressif32@4.20017.260907+sha.dcc1105b/cores/...
# -- nine such strings, ~33 characters longer each, which moved the image by
# 256 bytes and gave that machine a different digest from CI for the same
# commit. These mappings come last because GCC applies the last mapping that
# matches (checked on GCC 8.4.0), so they win over the packages-dir mapping.
_packages = env.subst("$PROJECT_PACKAGES_DIR")  # noqa: F821
if _packages:
    _pkgdir = Path(_packages)
    if _pkgdir.is_dir():
        for _child in sorted(_pkgdir.iterdir()):
            if _child.is_dir() and "@" in _child.name:
                _add(_child, "/pio/" + _child.name.split("@", 1)[0])

# CCFLAGS rather than CFLAGS/CXXFLAGS: it reaches C and C++ alike, and appending
# to `env` (not `projenv`) in a pre: script reaches the Arduino core and the
# libraries too -- which is the point, since 9 of the 10 leaked paths were the
# framework's own sources, not ours.
env.Append(CCFLAGS=flags)  # noqa: F821

if REPO_ROOT is None:
    # Do not fail the build -- a leaking image still runs fine, it just cannot be
    # named by the registry. CI's reproducibility gate is what must go red here.
    print(
        "[reproducible_build] WARNING: could not locate the repo root from "
        f"{env.subst('$PROJECT_DIR')}; this image will carry absolute source "  # noqa: F821
        "paths and its digest will not match CI's"
    )
print("[reproducible_build] " + " ".join(flags))

"""
PlatformIO extra_script: make ``pio run -t upload`` push over Ethernet.

Adapted from maxgerhardt/pio-esp32-ethernet-ota, which replaces UPLOADCMD with
a custom command — the idea being that OTA should be the same one-button
action as a USB upload, not a separate script you have to remember. The
difference here is that it drives ``ota_upload.py`` (our own protocol and our
own error messages) rather than curl.

Wire it into any project by adding an OTA env to its platformio.ini:

    [env:ota]
    extends = env:adafruit_feather_esp32s3   ; your normal build env
    upload_protocol = custom
    extra_scripts = post:../../tools/pio_ota_upload.py   ; adjust depth
    upload_flags =
        --ip=192.168.2.41

Then:

    pio run -e ota -t upload

``upload_flags`` are passed straight through to ota_upload.py, so anything it
accepts works here — e.g. ``--port=3232`` or a longer ``--timeout=90``.

The path depth differs per project (the repo's projects sit at different
levels), which is why this is spelled out per project rather than in
platformio-common.ini — the same reason lib_extra_dirs is per-project there.
"""

import os
import sys

Import("env")  # noqa: F821 - injected by PlatformIO's SCons environment

try:
    _THIS_FILE = __file__
except NameError:
    # SCons exec()s an extra_script with a bare globals dict, so __file__ is
    # not defined -- `pio run` over every env dies here with NameError before
    # it builds anything. The path still rides on the code object, which is
    # exactly what the traceback prints, so take it from there.
    _THIS_FILE = sys._getframe().f_code.co_filename

_TOOLS_DIR = os.path.dirname(os.path.abspath(_THIS_FILE))
_UPLOADER = os.path.join(_TOOLS_DIR, "ota_upload.py")


def _on_upload(source, target, env):
    """Run ota_upload.py against the just-built firmware.bin."""
    firmware = str(source[0])
    # upload_flags does not arrive as a plain list. PlatformIO prepends the
    # literal string "$UPLOAD_FLAGS" onto UPLOADERFLAGS and leaves SCons to
    # expand it when the upload *command* runs -- but we read the value
    # ourselves instead of running a command string, so without expanding it
    # first every flag from platformio.ini is invisible and --ip looks absent.
    flags = [str(f) for f in env.subst_list("$UPLOADERFLAGS")[0]]

    if not any(str(f).startswith("--ip") for f in flags):
        print("[OTA] ERROR: no --ip in upload_flags. Add e.g.\n"
              "        upload_flags =\n"
              "            --ip=192.168.2.41\n"
              "      to this environment in platformio.ini.")
        env.Exit(1)
        return

    cmd = [sys.executable, _UPLOADER, "--bin", firmware] + [str(f) for f in flags]
    print("[OTA] " + " ".join(cmd))
    rc = env.Execute(env.VerboseAction(" ".join(f'"{c}"' for c in cmd),
                                       "Uploading over Ethernet"))
    if rc:
        env.Exit(rc)


env.Replace(UPLOADCMD=_on_upload)  # noqa: F821

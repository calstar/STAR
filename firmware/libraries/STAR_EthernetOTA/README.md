# STAR_EthernetOTA

Firmware updates over Ethernet (W5500) for STAR boards. One implementation,
shared by every board with a W5500 — sense boards (PT/TC/LC/RTD), actuator,
stacklight, encoder, environmental tracker — so they cannot drift apart.

## On the board

```cpp
#include <STAR_EthernetOTA.h>

static StarOTA::Server ota;              // default port 3232

void setup() {
    // ... Ethernet.begin(...) ...
    ota.begin();
}

void loop() {
    ota.poll();                          // returns instantly when idle
    StarOTA::printTestMessage();         // optional, see "Did it work?"
}
```

`poll()` blocks only once a client has actually connected, and then only for
the duration of the transfer (or `timeout_ms` of silence). On success the board
reboots into the new image and never returns.

Projects already have `lib_extra_dirs = ../../libraries`, so no platformio.ini
change is needed to *use* the library.

### Callbacks

```cpp
ota.onStart(freeze_something, &state);   // before the first flash write
ota.onProgress(update_a_light, &state);
ota.onEnd(log_it, &state);
```

The hotfire boards use `onStart` to suspend DHCP lease renewal: their address
is a lease, and a renewal landing mid-flash would move them and drop the
transfer. Wiring that to the callback rather than checking it in the loop
closes the gap where a renewal could slip in between the check and the first
write.

### Tunables

Override in `build_flags`:

| Macro | Default | |
|---|---|---|
| `STAR_OTA_DEFAULT_PORT` | 3232 | TCP port |
| `STAR_OTA_CHUNK_SIZE` | 4096 | read buffer |
| `STAR_OTA_TIMEOUT_MS` | 10000 | header wait / stall timeout |
| `STAR_OTA_MAX_IMAGE_BYTES` | 0x200000 | sanity cap on announced size |
| `STAR_OTA_TEST_MESSAGE` | `""` | bench marker, see below |

## Uploading

Three ways in, all the same protocol.

**From PlatformIO** — the same one-button action as a USB upload. Add an OTA
env to the project (LC_Hotfire and Actuator_Hotfire already have one):

```ini
[env:ota]
extends = env:adafruit_feather_esp32s3    ; your normal build env
upload_protocol = custom
extra_scripts = post:../../tools/pio_ota_upload.py    ; adjust depth
upload_flags =
    --ip=192.168.2.41
```

```bash
pio run -e ota -t upload
```

**From the command line**, for a board whose project has no OTA env, or when
you want to bake in a test message:

```bash
python firmware/tools/ota_upload.py --ip 192.168.2.41 \
    --project firmware/Hotfire_Code/LC_Hotfire --message "third try"
```

**From the Test-GUI** — the OTA tab builds, uploads, and then verifies, using
the Board IP it already discovered. See `Test-GUI/README.md`.

## Did it work?

An OTA that silently does nothing is the failure worth guarding against, so
there are two independent confirmations:

**Firmware hash.** Every board computes the SHA-256 of its own running image at
boot (`Hotfire_Code/common/firmware_hash.h`) and reports it in every
BOARD_HEARTBEAT. `ota_upload.py` prints the SHA-256 of what it sent; when the
two match, the board is provably running that exact binary. The Test-GUI
compares them for you and says "Verified".

**Test message.** Build with a message and the board prints it on a timer:

```bash
python firmware/tools/ota_upload.py --ip 192.168.2.41 \
    --project firmware/Hotfire_Code/LC_Hotfire --message "attempt 4"
```

```
[OTA-MSG] attempt 4
```

Give each upload a different message and the serial monitor shows the board
change over — no hashes to compare. `printTestMessage()` is a no-op unless a
message was compiled in, so leaving the call in `loop()` costs a flight build
nothing.

## Wire protocol

```
client -> board : [4-byte big-endian image size][raw firmware bytes]
board  -> client: "OK\r\n", then reboot
```

Unchanged from the original `Hotfire_Code/common/hotfire_ota.h`, so anything
that already spoke it keeps working. That header is now a compatibility shim
over this library and should not be used by new code.

The board only replies `OK` after `Update.end()` validates the image, so an
`OK` means the image was accepted, not merely received. Any failure prints
`[OTA] ERROR: <reason>` on the board's serial output and leaves the previous
firmware running.

## Relation to the reference project

The PlatformIO upload integration follows
[maxgerhardt/pio-esp32-ethernet-ota](https://github.com/maxgerhardt/pio-esp32-ethernet-ota),
which replaces `UPLOADCMD` so OTA is one button rather than a separate script
to remember. The difference is what gets driven: that project shells out to
`curl` against jandrassy/ArduinoOTA's HTTP endpoint, while this one drives
`tools/ota_upload.py` and the protocol the STAR boards already speak. Switching
to ArduinoOTA would have meant a new third-party dependency and a flag-day
change of the wire protocol on every deployed board, for no capability we do
not already have.

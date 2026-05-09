# Firmware Hash Verification

## How It Works

Each ESP32 board computes a SHA-256 hash of its running firmware at boot using
`esp_partition_get_sha256()` (see `firmware_hash.h`). This hash is sent to the
server in every `BoardHeartbeatPacket`.

The server can independently compute the same hash from the compiled `.bin` file
and compare it to detect whether a board is running the expected firmware.

## Why It Works

`esp_partition_get_sha256()` hashes the app image bytes in flash. The
PlatformIO build output (`firmware.bin`) is byte-for-byte identical to what gets
written to the partition, so `hashlib.sha256(firmware_bin)` on the server
produces the same 32-byte digest.

## Binary Locations

After a PlatformIO build, each board's firmware binary is at:

| Board    | Path                                                                  |
|----------|-----------------------------------------------------------------------|
| PT       | `PT_Hotfire/.pio/build/adafruit_feather_esp32s3/firmware.bin`         |
| TC       | `TC_Hotfire/.pio/build/adafruit_feather_esp32s3/firmware.bin`         |
| LC       | `LC_Hotfire/.pio/build/adafruit_feather_esp32s3/firmware.bin`         |
| RTD      | `RTD_Hotfire/.pio/build/adafruit_feather_esp32s3/firmware.bin`        |
| Actuator | `Actuator_Hotfire/.pio/build/adafruit_feather_esp32s3/firmware.bin`   |
| Stacklight | `Stacklight Driver/.pio/build/adafruit_feather_esp32s3/firmware.bin` (repo root) |

Paths through Actuator are relative to `Hotfire_Code/`. Stacklight is relative to the `DiabloAvionics` repo root (sibling of `Hotfire_Code/`).

## Server-Side Hash Computation (Python)

```python
import hashlib

def compute_firmware_hash(bin_path: str) -> bytes:
    with open(bin_path, 'rb') as f:
        return hashlib.sha256(f.read()).digest()
```

## Comparing Against ESP32 Heartbeat

```python
expected = compute_firmware_hash("path/to/firmware.bin")
actual = firmware_hash_from_heartbeat  # 32 bytes from BoardHeartbeatPacket

if expected == actual:
    print("Firmware matches build")
else:
    print("Firmware is stale or different!")
```

## Caveats

- The `.pio/build/` directory only contains a valid `firmware.bin` after a
  successful build. If artifacts are cleaned or the build happened on a
  different machine, the reference binary won't be available.
- Consider copying `.bin` files to a known location after each build so the
  server always has reference binaries to compare against.

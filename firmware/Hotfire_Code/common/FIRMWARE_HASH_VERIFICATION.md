# Firmware Hash Verification

## What the board reports

Every board puts a 32-byte `firmware_hash` in its `BoardHeartbeatPacket`, once a
second. It comes from `esp_partition_get_sha256()` (see `firmware_hash.h`).

**That value is the SHA-256 ESP-IDF appends to the app image — not a hash of
`firmware.bin` as a file.** Our images are built with the hash appended
(`hash_appended = 1` in the image header), and in that case IDF does this:

```c
if (data.image.hash_appended) {
    memcpy(out_sha_256, data.image_digest, ESP_PARTITION_HASH_LEN);
    uint8_t calc_sha256[ESP_PARTITION_HASH_LEN];
    esp_err_t error = bootloader_sha256_flash_contents(
        address, data.image_len - ESP_PARTITION_HASH_LEN, calc_sha256);
    if (error || memcmp(data.image_digest, calc_sha256, ESP_PARTITION_HASH_LEN) != 0) {
        return ESP_ERR_IMAGE_INVALID;
    }
    return ESP_OK;
}
```
— `bootloader_common_get_sha256_of_partition()`, ESP-IDF v4.4

It returns the appended bytes, having recomputed them once to check. It does not
hash the file.

### So do not do this

```python
hashlib.sha256(open("firmware.bin", "rb").read())   # WRONG -- never matches a board
```

That folds the appended digest into its own input. For a real PT image the two
differ completely:

| | |
|---|---|
| what the board reports | `5f2885e2247f089279bd77af2b10e82722b1deb52b6d5c884cb1ceb0008ee017` |
| `sha256(firmware.bin)` | `6249151830f37675890b2bd2ffa3d1670d5161319ecea0a6af82027ae565a298` |

An earlier version of this document recommended the wrong one.

### Do this instead

```bash
firmware/tools/firmware_digest.py <firmware.bin>            # the digest
firmware/tools/firmware_digest.py <firmware.bin> --verbose  # and why
```

`firmware_digest.py` walks the image's segment table to find where the image
really ends (a `.bin` may carry padding past it, in which case the digest is not
the last 32 bytes of the file), then verifies the appended digest against the
content it covers — the same check IDF makes — so it fails loudly rather than
returning a plausible wrong hash.

## Which commit is that digest?

CI records every image it builds on `main` to the `firmware-registry` branch,
one file per distinct image:

```bash
git fetch origin firmware-registry:firmware-registry
git worktree add /tmp/fwreg firmware-registry
firmware/tools/which_firmware.py 5f2885e2 --registry /tmp/fwreg
```

The repo is public, so the records are also readable over plain HTTP:
`raw.githubusercontent.com/calstar/STAR/firmware-registry/<board>/<digest>.json`

A digest that is not in the registry was never built by CI on `main` — a local
build, a branch, or an image from before the registry existed.

## Why the build has to be path-independent

`ESP_ERROR_CHECK`, `assert` and the ESP log macros expand `__FILE__`, and the
compiler sees absolute paths, so the image used to carry strings like

```
/home/aidan/.platformio/packages/framework-arduinoespressif32/cores/esp32/esp32-hal-spi.c
/home/aidan/STAR-daq/firmware/Hotfire_Code/common/SensorHotfireCore.h
```

inside the hashed bytes — the username, the home directory and the checkout path.
The same commit built by two people produced two different digests, so the digest
identified the machine rather than the firmware.
`firmware/tools/reproducible_build.py` maps those prefixes away with
`-ffile-prefix-map`, and firmware CI rebuilds every image from a second path and
fails if the digests differ.

Still **not** reproducible across a toolchain change: `platformio-common.ini`
pins no version for `platform = espressif32`, so a newer platform resolves to
different bytes with no source change. Each record stores the platform,
framework and toolchain versions it was built with, so that reads as a toolchain
bump rather than a corrupt registry.

## Caveats

- An all-zero digest means the board did not report one: either it has not
  computed it yet, or `esp_partition_get_sha256()` failed, which means the image
  on it does not verify. The board simulator also sends zeros.
- `.pio/build/` holds a valid `firmware.bin` only after a successful build, and
  the digest belongs to that build on that machine. Prefer the registry over a
  local binary as the reference.

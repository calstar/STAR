# Firmware registry

One file per distinct firmware image: `<board>/<image_digest>.json`.

`image_digest` is what a board reports in its `BoardHeartbeatPacket` --
the SHA-256 ESP-IDF appends to the app image, which is what
`esp_partition_get_sha256()` returns. It is NOT `sha256(firmware.bin)`.

Written only by `.github/workflows/firmware-ci.yml` on pushes to main.
Look a digest up with `firmware/tools/which_firmware.py`.

Several commits can build byte-identical firmware, so each record lists
every commit known to produce it rather than naming one.

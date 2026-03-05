## Post-Processing for Elodin Databases

This folder is the home for **all post-processing scripts and notebooks** that operate on Elodin DB runs.

- **DB storage location**: Elodin databases live under `~/.local/share/elodin/`.
- **Dev stack convention**: `scripts/startup/start_tmux_dev.sh` now creates databases under
  `~/.local/share/elodin/<DB_NAME>`, where `<DB_NAME>` defaults to
  `daq_YYYYMMDD_HHMMSS` for each run (and can be overridden with `ELODIN_DB_NAME`).
- **Metadata/logs**: Elodin metadata and logs live in `<DB_PATH>_metadata/` (matching the legacy FSW layout).

Recommended usage:

- Add **Python / Bash utilities** here for:
  - exporting tables (via `elodin-db export`),
  - generating plots and reports,
  - archiving runs into structured folders.
- Treat each `<DB_NAME>` as a single run; scripts should take either:
  - a `DB_NAME` (and resolve `~/.local/share/elodin/<DB_NAME>`), or
  - a full `DB_PATH`.

Example shell usage (manual):

```bash
DB_NAME=daq_20260304_123456
DB_PATH="$HOME/.local/share/elodin/$DB_NAME"

# Inspect tables
elodin-db list "$DB_PATH"

# Export a table to CSV
elodin-db export "$DB_PATH" PT_raw > "PT_raw_${DB_NAME}.csv"
```

Add your concrete post-processing scripts in this folder so they all live in one place.

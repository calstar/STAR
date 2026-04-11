# Cleanup Summary

## Completed (Mar 2026)

### Base repo
- **Removed** `test_ws.py` — minimal websocket test, no references
- **Removed** `.cleanup_archive` — historical cleanup log
- **Removed** root `package.json` / `package-lock.json` — contained invalid dependency `"20": "^3.1.9"`; web-gui has its own package.json in frontend/ and backend/
- **Added** `node_modules/` to .gitignore

### Web-gui
- No archive dirs; `demo-mode.ts` and `message-logger.ts` are in use
- Backend slim migration completed (config packets moved to Python)

## Consider for future cleanup

| Item | Notes |
|------|-------|
| `Diablo DAQ System v2 Software Documentation.pdf` (338KB) | Move to docs/ or external if rarely used |
| `setup.sh` vs `scripts/setup/` | setup.sh = full env setup; scripts/setup/ = fix scripts. Document in README |
| `startup.sh` | Verify still used; may overlap with scripts/startup/ |
| Root `node_modules/` | Orphaned after removing root package.json; run `rm -rf node_modules` to reclaim space |
| `archive/legacy/utl/` | **Keep** — used by FSW and daq_comms build |
| `web-gui/docs/*.md` | ELECTRON_INTEGRATION_PLAN, MOBILE_OPTIMIZATION_PLAN — archive if obsolete |

## Do not modify (submodules)
- `external/DAQv2-Comms`
- `external/DiabloAvionics`
- `engine_sim`
- `external/flash`

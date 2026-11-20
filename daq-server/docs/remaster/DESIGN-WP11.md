# DESIGN-WP11 — `tools/`: broken documented paths only

The "as decided" execution note for WP11 as the LEDGER narrowed it (WP11 row: "fix broken
documented paths only; GUI deletions parked (operator-facing, team decision)"). Scope: BLOAT-MAP §8
and the WP11 row, minus every deletion. Nothing under `tools/` is launched by a systemd unit,
`dev.sh`, CI or the gate (BLOAT-MAP §8: "No `procedures/*.md`, `dev.sh`, `check_env.sh`, backend
route or C++ service invokes anything in `tools/`"), so WP11 cannot touch the frozen contract (D5).
Twelve of its 24 line edits are **executed**: the `python -m scripts.` → `tools.` module paths
(`generate_engine_and_policy_lut.sh:32,41,58,65`, `generate_and_export_policy_lut.sh:25,31`) and the
YAML paths assigned to `ENGINE_CONFIG`/`POLICY_CONFIG`/`LUT_CONFIG` (`:16,17,19,20` / `:13,15`); they
take the two LUT drivers from crashing on their first `python -m` to runnable, which is the intended
outcome. The remaining twelve (usage comments, docstrings, a YAML comment, one `echo`) are read only
by people.

**Baseline.** Line numbers are `git show backend-remastered:daq-server/<path>` at `backend-remastered`
@ **`45b91dc5`** (no change under the listed dirs since `d20852e9`, where this note was first
anchored); `tools/` there is byte-identical to `main` @ `15b5a0c5`. WP4 lands first (DAG
`WP4 → WP11`): `deploy/startup/start_calibration_stack.sh`, which `tools/gui/README.md:60,160`
names, is gone by then (WP12 fixes the README).

**Method.** `git grep -n -I -E '<token>' backend-remastered -- . ':!daq-server/node_modules'
':!daq-server/docs/remaster'` over the whole repo for every module name and every path string edited
or considered; importers checked with `git grep -n -E '^\s*(from|import) '` over `tools/**/*.py`.
Read-only: nothing was run.

**Rules applied:** AGENT-RULES 3, 10; D17 (defects stay: BLOAT-MAP defects 1 and 8), D25; STYLE-S38,
S39 (no black on existing Python; nothing new is added).

---

## 1. What is broken, and what the fix is

### 1.1 `tools/controller_lut/*.sh` and two usage comments — `scripts/` → `tools/` (BLOAT-MAP defect 8)

The tree moved `scripts/controller_lut/` to `tools/controller_lut/`; the two shell drivers still
`python -m scripts.controller_lut.*` and read YAML from `scripts/controller_lut/`, so the documented
LUT regeneration (`tools/controller_lut/README.md:64`
`tools/controller_lut/generate_engine_and_policy_lut.sh small`) fails on the first `python -m`.
`README.md:37` already documents the target form (`python -m tools.controller_lut.generate_controller_lut`),
as does `README.md:93` (`from tools.controller_lut.engine_lut import EngineLUT`). Both scripts
`cd "$(dirname "$0")/../.."` (`:10`, `:8`), which from `tools/controller_lut/` is `daq-server/` —
correct today, unchanged.

| file:line | today | after |
|---|---|---|
| `generate_engine_and_policy_lut.sh:6` | `# Usage: ./scripts/controller_lut/generate_engine_and_policy_lut.sh [small\|full]` | `tools/controller_lut/` |
| `:16,17,19,20` | `ENGINE_CONFIG="scripts/controller_lut/engine_lut_config_small.yaml"` etc. (four YAML paths) | `tools/controller_lut/…` |
| `:32,41,58,65` | `python -m scripts.controller_lut.{extract_thrust_curve_from_config,generate_controller_lut,generate_controller_lut,export_lut_for_fsw}` | `python -m tools.controller_lut.…` |
| `generate_and_export_policy_lut.sh:4` | `#   ./scripts/controller_lut/generate_and_export_policy_lut.sh [small\|full]` | `tools/controller_lut/` |
| `:13,15` | `LUT_CONFIG="scripts/controller_lut/policy_lut_fsw{_small,}.yaml"` | `tools/controller_lut/…` |
| `:25,31` | `python -m scripts.controller_lut.{generate_controller_lut,export_lut_for_fsw}` | `python -m tools.controller_lut.…` |
| `export_lut_for_fsw.py:13` (docstring) | `python -m scripts.controller_lut.export_lut_for_fsw --input output/lut/controller_lut_ddp_small.npz --output output/lut/controller_lut.bin` | `python -m tools.controller_lut.export_lut_for_fsw --input output/lut/controller_policy_fsw.npz --output output/lut/controller_policy_fsw.bin` — the two old output names are the tracked files WP1 deleted (BLOAT-MAP §1); the new ones are what both drivers write (`generate_engine_and_policy_lut.sh:27-28`, `generate_and_export_policy_lut.sh:21-22`) and what the controller reads (`lut_path`) |
| `engine_lut_config.yaml:6-7` (comment) | `#   python -m scripts.controller_lut.generate_controller_lut \` / `#     --lut-config scripts/controller_lut/engine_lut_config.yaml \` | `tools.controller_lut.` / `tools/controller_lut/` |

Why the module form resolves: `python -m tools.controller_lut.X` from `daq-server/` puts the cwd on
`sys.path`; `tools/` has no `__init__.py` and is a namespace package (PEP 420);
`tools/controller_lut/__init__.py` exists (6 lines, a docstring); the modules import each other
relatively (`generate_controller_lut.py:13` `from .config import ControllerLUTConfig`) and the
engine simulator by path (`_add_engine_sim_to_path`, `generate_controller_lut.py:28-37`;
`extract_thrust_curve_from_config.py:17-20`, default `--config engine_sim/configs/default.yaml` at
`:30`). `daq-server/engine_sim` is a tracked symlink to `../EngineDesign` (mode 120000) and
`EngineDesign/configs/default.yaml` exists, so `--project-root "$PROJECT_ROOT"` (= `daq-server/`)
resolves. The `__init__.py` docstring says "engine_sim submodule"; it is a symlink, not a submodule
(no `.gitmodules` in the tree) — a stale word, left alone (not a path).

Not changed in this tree: `extract_thrust_curve_from_config.py`, `generate_controller_lut.py`,
`plot_*.py`, `engine_lut.py`, `config.py`, every `.yaml` but the one comment, `README.md` (already
correct; WP12 owns `tools/**/*.md`).

### 1.2 `tools/debug/**` usage comments — `scripts/debug/` → `tools/debug/`

`docs/DEBUGGING_AND_TESTING_SCRIPTS.md:6,15,23,31,40` already documents all four under
`tools/debug/`; only the scripts' own usage lines lag.

| file:line | today | after |
|---|---|---|
| `compute_elodin_ids.js:2` | `// Usage: node scripts/debug/compute_elodin_ids.js "VTableStream"` | `tools/debug/` |
| `test_vtable_subscription.js:2` | `// Usage: node scripts/debug/test_vtable_subscription.js [elodin_host] [elodin_port]` | `tools/debug/` |
| `repro_relay_race.sh:6` | `# Usage: bash scripts/debug/repro_relay_race.sh` | `tools/debug/` |
| `start_manual_no_tmux.sh:3` | `# Usage: USE_SIM=1 bash scripts/debug/start_manual_no_tmux.sh` | `tools/debug/` |

`check_ws_broadcast.js` has no usage line (nothing to fix).

### 1.3 `tools/postprocessing/` loose scripts — three more `scripts/postprocessing/` strings

The whole-tree grep (`git grep -n -E 'scripts/(postprocessing|calibration|debug|controller_lut|gui)|scripts\.(postprocessing|calibration|controller_lut)' -- daq-server/tools`)
finds, outside §1.1/§1.2 and `calibration_server.py:20-31` (§2), exactly three stale strings in the
LIVE DEV loose scripts (BLOAT-MAP §8: `tools/postprocessing/*` loose = live dev; only the webviewer
is production and it is untouched). Same class of fix — a path whose only reader is a person — so
WP11 takes them; BLOAT-MAP's PARK of `tools/postprocessing/**` was about deletion.

| file:line | today | after |
|---|---|---|
| `export_elodin_db.sh:12` (comment) | `# Data rates (see scripts/postprocessing/README.md):` | `tools/postprocessing/README.md` |
| `export_elodin_db.sh:69` (`echo`, usage text on a bad invocation) | `echo "See scripts/postprocessing/README.md for full docs."` | `tools/postprocessing/README.md` — the one change to a string a script prints (the LUT drivers' executed edits, §1.1, change what they *run*); no harness or test reads it (`git grep 'for full docs'` → only this line) |
| `validate_export.py:5` (docstring) | `Use after: FORMAT=csv ./scripts/postprocessing/export_elodin_db.sh <DB_PATH> ./export_csv` | `./tools/postprocessing/export_elodin_db.sh` |

**Recorded, not changed** (a path edit cannot make them work; they are relay-era, and the relay is
Parked): `repro_relay_race.sh:8` and `start_manual_no_tmux.sh:5` `PROJECT="/home/aidan/Diablo-FSW"`;
`:15`/`:12` `/home/aidan/.cargo/bin/elodin-db`; `:37`/`:32` `./build/FSW/daq_bridge` (binaries
build to `build/bin/`); `:22`/`:19` `npm run relay` and `:28`/`:25` `ELODIN_RELAY_URL=ws://localhost:9090`
(`server.ts` never reads it, BLOAT-MAP §2a); `test_vtable_subscription.js:4`
`require('../../diablo_server/backend/src/elodin-client.js')` — the source is `elodin-client.ts`
and the only `.js` was under `dist/` (deleted by WP1), so the script needs tsx, not a path. Hand to
WP12 with `docs/DEBUGGING_AND_TESTING_SCRIPTS.md` (BLOAT-MAP §7: "relay-era tooling").

---

## 2. Parked (do not delete; evidence kept here for the team's decision)

LEDGER Parked: "Deleting `tools/` operator GUIs (`tools/gui/**`, the orphaned calibration GUIs):
operator-facing, the team's decision, not a refactor's." The LEDGER WP11 row extends that to every
deletion BLOAT-MAP's WP11 row listed. The evidence is complete so the team can decide without
another survey:

| candidate | lines | importers / launchers in the whole repo | notes |
|---|---|---|---|
| `tools/gui/combined_fsw_gui.py` (+ `tools/gui/README.md`) | 2,043 | none import it; documented only by its own README (`:5,53,70,75`), `scripts/README.md:31` ("Operator GUIs") and `tools/calibration/AUTONOMOUS_CALIBRATION.md:163`; `calibration.ts:343` names it in a comment | PyQt6 + pyqtgraph; its README `:60,160` points at `start_calibration_stack.sh`, deleted by WP4 (WP12 fixes) |
| `tools/calibration/smart_calibration_gui.py` | 1,450 | none (`:31` imports `robust_calibration` itself) | fork of `pt_calibration_gui.py` (BLOAT-MAP §8) |
| `tools/calibration/calibration_sequence.py` | 472 | none | |
| `tools/calibration/calibration_performance_monitor.py` | 188 | none (`:18` needs `psutil`) | |
| `tools/calibration/{accelerometer,gyroscope,magnetometer}_calibration.py` | — | none import them; each `:15` imports `imu_calibration` (which stays); documented by `tools/calibration/README_IMU.md:9-11,19,29,38` as run from the directory | |
| `tools/calibration/calibration_server.py` (the Python sidecar) | — | `:20-31` `from scripts.calibration.*` — the package no longer exists, so it cannot start (BLOAT-MAP defect 1); its launchers are all deleted by WP4; `stop_tmux.sh:40` still pkills it | **decision recorded:** stays parked with its import defect; `scripts.` → `tools.` here would revive a dormant service (behaviour), not fix a documented path |
| rest of `tools/calibration/**` (28 files, 14,771 lines) and `tools/calibration/calibrations/*` (third calibration store, BLOAT-MAP defect 5) | | `calibration_orchestrator.py:76,81`, `calibration_orchestrator_gui.py:20`, `imu_calibration_gui.py:32` import siblings | dormant; `tools/calibration/AUTONOMOUS_CALIBRATION.md:162` repeats the false daq_bridge claim (WP12) |
| `tools/postprocessing/**` | 10,403 + 698 | **live**: the webviewer is a production service (`daq-server-ci.yml:1045`, `publish-apps.yml:25,72`, `docker-compose.yml:417,449`, `deploy/caddy/Caddyfile:188-190` per BLOAT-MAP §8, `design-mcp/star_design_mcp/tools/daq.py:1`); `replay_past_db.sh:99` runs `npm run relay` (the consumer WP5's relay PARK was waiting to hear about) | out of scope except the three path strings of §1.3; `rename_hashes.py` "likely dead" (BLOAT-MAP) — unverified, parked |
| `tools/aliases.sh` | 11 | `scripts/setup_common.sh:300,306` greps users' rc files for it | keep |

---

## 3. Execution

One queue item, one commit (D25; nothing here needs bisecting):

- [ ] `tools/controller_lut/generate_engine_and_policy_lut.sh`: lines 6, 16, 17, 19, 20, 32, 41,
      58, 65 as §1.1.
- [ ] `tools/controller_lut/generate_and_export_policy_lut.sh`: lines 4, 13, 15, 25, 31.
- [ ] `tools/controller_lut/export_lut_for_fsw.py:13` docstring; `engine_lut_config.yaml:6-7`
      comment.
- [ ] `tools/debug/{compute_elodin_ids.js:2,test_vtable_subscription.js:2,repro_relay_race.sh:6,start_manual_no_tmux.sh:3}`.
- [ ] `tools/postprocessing/export_elodin_db.sh:12,69`, `tools/postprocessing/validate_export.py:5` (§1.3).
- [ ] Nothing deleted; no file outside `tools/` touched; no formatter run (S39: black only on new
      Python, and the two `.py` edits are docstring lines).

### 3.1 Verify

- [ ] `git diff --stat backend-remastered...HEAD` lists exactly the **10 files** above (4
      `controller_lut`, 4 `debug`, 2 `postprocessing`), **24 line edits** (17 + 4 + 3); `git diff -w`
      is `scripts` → `tools` path strings only — the twelve executed ones (module paths and
      `*_CONFIG=` assignments, §1.1), usage comments, docstrings, the YAML comment and the one `echo`
      string (§1.3) — nothing else;
      `git grep -n -E 'scripts/(postprocessing|calibration|debug|controller_lut|gui)|scripts\.(postprocessing|calibration|controller_lut)' -- daq-server/tools`
      → exactly `calibration_server.py:20,23,27,31` (parked, §2) and nothing else.
- [ ] `bash -n` on the five `.sh` (`controller_lut/generate_engine_and_policy_lut.sh`,
      `controller_lut/generate_and_export_policy_lut.sh`, `debug/repro_relay_race.sh`,
      `debug/start_manual_no_tmux.sh`, `postprocessing/export_elodin_db.sh`); `python3 -m py_compile`
      on the two `.py`.
- [ ] Resolution without running the tools' dependencies (numpy/yaml may be absent): from
      `daq-server/`, for each of `extract_thrust_curve_from_config`, `generate_controller_lut`,
      `export_lut_for_fsw`:
      `python3 -c "import importlib.util as u; o=u.find_spec('tools.controller_lut.<m>').origin; assert o.endswith('daq-server/tools/controller_lut/<m>.py'), o; print(o)"`
      — the assert matters: a regular `tools` package anywhere on `sys.path` (a site-packages
      `tools/__init__.py`) beats the namespace package in PEP 420 scan order and would make
      `python -m tools.controller_lut.…` fail on that box; the `controller_lut/__init__.py` docstring
      imports nothing, so `find_spec` needs no third-party module.
      `test -f tools/controller_lut/{engine_lut_config,engine_lut_config_small,policy_lut_fsw,policy_lut_fsw_small}.yaml`;
      `test -f engine_sim/configs/default.yaml` (through the symlink).
- [ ] Documented commands resolve (the DoD, read as: every `tools/…` path and every
      `python -m tools.…` module named in `tools/controller_lut/README.md`, the three `.sh` headers,
      the four `tools/debug` usage lines, `validate_export.py:5` and
      `docs/DEBUGGING_AND_TESTING_SCRIPTS.md:15,23,31,40` exists — **except** the parked
      `calibration_server.py:20-31` imports, §2) — a ~15-line check under `test/remaster-checks/` is
      fine (D44(4) precedent), or run the `test -f` list by hand and paste it into the merge row.
- [ ] If numpy and pyyaml are installed: `python3 -m tools.controller_lut.generate_controller_lut --help`
      and `python3 -m tools.controller_lut.export_lut_for_fsw --help` exit 0 from `daq-server/`
      (the first `python -m` that failed before). No LUT is generated; `output/lut/` is untouched
      (`controller_policy_fsw.bin` is the controller's input, BLOAT-MAP WP11 row).
- [ ] Gate: `--fast` is enough (no product code, no test harness touched: D19's full gate is for
      product code); tree-unchanged.

---

## 4. Must not change

| surface | why |
|---|---|
| `output/lut/controller_policy_fsw.bin` and the LUT binary format (`export_lut_for_fsw.py` body) | read by `controller_service` via `lut_path`; untracked here, live on the stand |
| every `tools/calibration/**`, `tools/gui/**`, `tools/postprocessing/**` file | Parked (§2); `tools/postprocessing/webviewer/` is production |
| `tools/aliases.sh` | `scripts/setup_common.sh:300,306` |
| `tools/**/*.md` | WP12's |
| `calibration_server.py:20-31` imports | a defect kept (D17), not a documented path |
| the relay-era lines in `tools/debug/*.sh` (§1.2 "recorded") | not fixable by a path edit; the relay is Parked |

---

## 5. Lines outside WP11's files

None outside `daq-server/`. Inside, for WP12: `tools/gui/README.md:60,160` (names a launcher WP4
deletes), `tools/calibration/AUTONOMOUS_CALIBRATION.md:162-163`, `tools/calibration/README_IMU.md`
(fine as written: commands run from the directory), `docs/DEBUGGING_AND_TESTING_SCRIPTS.md` (the
relay-era content of the two shell scripts), `scripts/README.md:31` ("Operator GUIs" row) — and the
`controller_lut/__init__.py` "submodule" wording if WP12 wants it.

---

## 6. Open questions

1. **Team decision on §2** (LEDGER Parked): delete `tools/gui/**` and the six never-imported
   calibration modules, or keep them? The import evidence above is what a deletion needs; the
   remaster does not decide it.
2. **The Python calibration sidecar** (`calibration_server.py`): BLOAT-MAP's WP11 DoD asks for "the
   decision on Python calibration sidecar recorded in LEDGER". Recorded here as: parked with its
   import defect (defect 1); every launcher that started it is deleted by WP4; the C++
   `calibration_service` is the operator path. Whether to delete it or fix its imports is the same
   team question as §6.1.
3. `tools/postprocessing/rename_hashes.py` — BLOAT-MAP calls it "likely dead" (pre-`set_component_name`
   DBs); nothing imports or documents it (`git grep rename_hashes` → only its own header and usage
   line, `:3,28`). Not touched (the tree is parked); a one-line team question.

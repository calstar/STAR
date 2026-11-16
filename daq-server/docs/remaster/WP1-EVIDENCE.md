# WP1 evidence: removing tracked generated/vendored junk

Branch `wp/WP1-junk` off `backend-remastered` @ `b2599617`. Every grep below ran from the repo
root (the whole monorepo, not only `daq-server/`) on `b2599617`, before the deletion, with
`git grep` over tracked files. `$X` stands for the excludes that keep the candidates from matching
themselves:

```
X=':!daq-server/node_modules' ':!daq-server/.cache' ':!daq-server/build-ci' \
  ':!daq-server/build-clang-ci' ':!daq-server/diablo_server/backend/dist' ':!daq-server/docs/remaster'
```

## What was removed

| path | files | lines | commit |
|---|---|---|---|
| `daq-server/node_modules/**` | 5,886 | 775,203 | `untrack the vendored root node_modules` |
| `daq-server/.cache/**` (clangd `.idx`) | 172 | binary | `untrack the clangd index cache` |
| `daq-server/build-ci/FSW/*` (11 ELF) + `build-clang-ci/{build.ninja,.ninja_deps,.ninja_log}` | 14 | 1,317 | `untrack stale build-ci binaries and build-clang-ci ninja files` |
| `daq-server/diablo_server/backend/dist/**` | 27 | 6,457 | `untrack the stale backend dist build` |
| `daq-server/output/lut/{controller_lut.bin,controller_lut_ddp_small.npz}` | 2 | binary | `untrack two unused example controller LUT outputs` |
| `daq-server/.gitignore`: `+build-ci/ +build-clang-ci/ +diablo_server/backend/dist/` | 1 | +3 | `ignore build-ci, build-clang-ci and backend dist` |

Each group was removed with `git rm -r --cached` **and** `rm -rf`, so the checks below ran against a
tree where the files are physically gone, not merely untracked.

`node_modules/`, `.cache/` and `output/` were already in `daq-server/.gitignore`; the three new
lines cover the rest:

```
$ git check-ignore -v --no-index daq-server/node_modules/x daq-server/.cache/clangd/index/a.idx \
    daq-server/build-ci/FSW/daq_bridge daq-server/build-clang-ci/build.ninja \
    daq-server/diablo_server/backend/dist/backend/src/server.js \
    daq-server/output/lut/controller_lut.bin daq-server/output/lut/controller_lut_ddp_small.npz
daq-server/.gitignore:64:node_modules/              daq-server/node_modules/x
daq-server/.gitignore:209:.cache/                  daq-server/.cache/clangd/index/a.idx
daq-server/.gitignore:7:build-ci/                  daq-server/build-ci/FSW/daq_bridge
daq-server/.gitignore:8:build-clang-ci/            daq-server/build-clang-ci/build.ninja
daq-server/.gitignore:9:diablo_server/backend/dist/ daq-server/diablo_server/backend/dist/backend/src/server.js
daq-server/.gitignore:145:output/                  daq-server/output/lut/controller_lut.bin
daq-server/.gitignore:145:output/                  daq-server/output/lut/controller_lut_ddp_small.npz
$ git check-ignore --no-index daq-server/diablo_server/shared/types.js   # (no output: still tracked/unignored)
```

History: every group arrived in the subtree import and was never touched as a source:
`git log --format='%h %ad %s' --date=short -- <path>` → `d1aff1df 2026-05-09 Add 'daq-server/'…`
(node_modules, build-ci, build-clang-ci, .cache, dist); `output/lut` additionally `ce5f3581 Mega commit (#22)`.

### Effect on other checkouts (the stand)

Removing a tracked file deletes it from every other checkout at its next pull. For these paths that
is the intent: none is read at runtime (below). The live LUT `output/lut/controller_policy_fsw.bin`
(config `lut_path`) is untracked and is not touched; git removes only the two named files, and
leaves a directory that still holds untracked files. The parked live stores are untouched (see
"Not deleted").

---

## 1. `build-ci/`, `build-clang-ci/`

```
$ git grep -n -E 'build-ci|build-clang-ci' -- . $X
Doxyfile:88:                         daq-server/build-ci \
Doxyfile:89:                         daq-server/build-clang-ci \
daq-server/test/test_ota_flash.py:57:        os.path.join(daq_root, "build-ci", "FSW", "ota_service"),
```

- `Doxyfile:88-89` (repo root) are `EXCLUDE` entries — harmless with the dirs gone. Not edited: the
  file is outside `daq-server/` (AGENT-RULES 10); BLOAT-MAP gives it to the orchestrator.
- **`test/test_ota_flash.py:57` is a real reference** (BLOAT-MAP said "nothing else"). It is the
  second of three fallback candidates in `find_ota_service()`:

  ```
  override = os.environ.get("OTA_SERVICE_BIN")      # checked first
  candidates = [build/bin/ota_service, build-ci/FSW/ota_service, build/FSW/ota_service]
  ```

  It is dead in every runner: CI sets the override
  (`.github/workflows/daq-server-ci.yml:540-543`: `OTA_SERVICE_BIN: ${{ env.BUILD_DIR }}/bin/ota_service`,
  `run: python3 test/test_ota_flash.py`), and every local build (`scripts/build.sh`, the gate) puts
  `ota_service` in `build/bin/`, the first candidate. The tracked file was an x86-64 Linux ELF
  with an RPATH into `/home/kush-mahajan/sensor_system/build-ci/…`, so it could not run here and
  would only have masked a missing build on an x86 Linux box. The line is left as is (a stale
  candidate in a test, WP4/WP12 territory); with the file gone, the lookup falls through as for any
  absent candidate.
- CMake, `scripts/build.sh`, `dev.sh`, `setup.sh`, `flake.nix` (builds into `build/`), all systemd
  units, `deploy/**`, the characterization harness and every workflow: no match (covered by the
  repo-wide grep above).

## 2. `.cache/` (clangd index)

```
$ git grep -n -E '\.cache/|clangd' -- . $X ':!**/package-lock.json'   # daq-server-relevant hits
.github/workflows/daq-server-ci.yml:359:            --exclude=".cache/" \              (semgrep exclude)
.github/workflows/daq-server-ci.yml:873,879:  ~/.cache/ms-playwright                     (home dir, unrelated)
daq-server/.gitignore:206:.cache/
daq-server/diablo_server/frontend/.gitignore:5:/playwright/.cache/                    (other dir)
daq-server/tools/postprocessing/webviewer/{.gitignore,.dockerignore,README.md}: .cache/ (webviewer's own dir)
firmware/Flight_Computer/CMakeLists.txt:24:# Enable compile command to ease indexing with e.g. clangd
```

(remaining hits are other apps' `~/.cache/ms-playwright` and `auth/Dockerfile`'s pip cache.) Only
excludes and ignores; nothing reads `daq-server/.cache`.

## 3. `diablo_server/backend/dist/`

```
$ git grep -n -E 'backend/dist|dist/server|dist/backend|"dist|dist/\*\*|/dist\b' -- . $X ':!**/package-lock.json'
daq-server/deploy/startup/stop_tmux.sh:37:pkill -f "${REPO_ROOT}/diablo_server/backend.*dist/server\.js" 2>/dev/null || true
daq-server/diablo_server/backend/package.json:5:  "main": "dist/server.js",
daq-server/diablo_server/backend/package.json:10:    "start": "USE_CPP_CONTROLLER=true node dist/server.js",
daq-server/diablo_server/backend/package.json:12:    "test": "vitest run --exclude 'dist/**'",
daq-server/diablo_server/backend/src/api-server.ts:12:// … but `node dist/server.js` (the systemd sim) does not …
daq-server/diablo_server/backend/tsconfig.json:14:  "exclude": ["node_modules", "dist"]
daq-server/diablo_server/frontend/tsconfig.json:32:    "dist",
daq-server/diablo_server/frontend/vitest.config.ts:12: exclude: [..., '**/dist/**'],
daq-server/diablo_server/shared/tsconfig.json:2: "//": "… the production backend (node dist/server.js) does …"
daq-server/test/characterization/gate.sh:67:  npx vitest run --exclude 'dist/**' …
daq-server/tools/postprocessing/webviewer/backend/main.py:241:_dist = … / "frontend" / "dist"   (webviewer's own)
```

Who starts the backend:

```
$ git grep -n -E 'ExecStart|WorkingDirectory' -- '*.service' 'deploy/**' 'daq-server/deploy/**' | grep -i -E 'backend|node|npm|tsx'
daq-server/deploy/systemd/sensor-backend.service:7:WorkingDirectory=%h/sensor_system/diablo_server/backend
daq-server/deploy/systemd/sensor-backend.service:8:ExecStart=/usr/bin/npm run dev        # "dev": "… tsx watch src/server.ts"
$ git grep -n -E 'npm (run )?start|node dist|"start"' -- daq-server deploy scripts .github setup.sh $X ':!**/package-lock.json'
  → only backend/package.json:10 itself, two comments (api-server.ts:12, calibration-profiles.ts:19),
    shared/tsconfig.json:2, and frontend's own "start": "vite preview" — no caller of the backend's `npm start`.
```

Every other launcher runs source: `start_tmux_dev.sh:225,408` and `test_integration.sh:834`
(`npx tsx src/server.ts`), `scripts/aliases.sh:135` (`npx tsx src/server.ts`), CI's systemd e2e job
installs `sensor-backend.service` (`npm run dev`). No workflow runs the backend `build` (`tsc`), so
nothing produces or consumes `dist/` in CI. The `api-server.ts:12` comment about "the systemd sim"
running `node dist/server.js` is stale: the unit runs `npm run dev`.

`stop_tmux.sh:37` is a `pkill` pattern — harmless, left. **`backend/package.json` is unchanged**:
`"main": "dist/server.js"` and `"start": "USE_CPP_CONTROLLER=true node dist/server.js"` already
pointed at a file the tracked tree did not contain (it was laid out as `dist/backend/src/server.js`);
that inconsistency is LEDGER Parked ("fixing it changes `npm start`").

## 4. `output/lut/controller_lut.bin`, `controller_lut_ddp_small.npz`

```
$ git grep -n -E 'controller_lut\.bin|controller_lut_ddp_small|lut_ddp_small|controller_lut\.npz' -- . $X
daq-server/tools/controller_lut/export_lut_for_fsw.py:13:  python -m scripts.controller_lut.export_lut_for_fsw --input output/lut/controller_lut_ddp_small.npz --output output/lut/controller_lut.bin
```

That line is a docstring usage example. The generators write other names
(`generate_and_export_policy_lut.sh:21-22`, `generate_engine_and_policy_lut.sh:26-29`:
`controller_policy_fsw.{npz,bin}`, `engine_performance.npz`, `thrust_curve.csv`), and every config
and launcher points at those: `lut_path = "output/lut/controller_policy_fsw.bin"` (config_base,
all profiles), `start_tmux_dev.sh:184` `CTRL_LUT="${LUT_PATH:-$PROJECT/output/lut/controller_policy_fsw.bin}"`.
No runtime code lists the `output/` dir:

```
$ git grep -n -E "'output'|\"output\"|output/" -- daq-server/diablo_server/{backend/src,services,lib/src,frontend/app,frontend/lib}
daq-server/diablo_server/services/controller/controller_main.cpp:42:/** Resolve path relative to config: paths like output/lut/... are relative to project root. */
```

Tests, CMake, scripts, deploy and workflows (`git grep -E 'output/lut|\.npz|lut_path'`) mention only
`controller_policy_fsw.bin`, `thrust_curve.csv` and `engine_performance.npz` (configs and their
goldens); EngineDesign's `output/cache/*.npz` is another app.

## 5. Root `daq-server/node_modules/`

### What it is

```
$ ls daq-server/package.json
ls: daq-server/package.json: No such file or directory
$ git ls-files '**/package.json' | grep daq-server | grep -v node_modules
daq-server/diablo_server/backend/package.json
daq-server/diablo_server/frontend/package.json
daq-server/diablo_server/shared/package.json
daq-server/tools/postprocessing/webviewer/frontend/package.json
$ git ls-files daq-server | grep -i gulpfile
daq-server/node_modules/20/gulpfile.js
daq-server/node_modules/20/webroot/news/gulpfile.js
$ git ls-files daq-server/node_modules | grep -E '^daq-server/node_modules/(ws|tsx|typescript|esbuild|@types)/' | awk -F/ '{print $3"/"$4}' | sort -u
@types/expect
@types/node
@types/vinyl
```

460 packages (gulp, imagemin, svgo, gifsicle, a package named `20` with its own gulpfiles); no
`ws`, `tsx`, `typescript` or `esbuild`. It does carry `@types/{node,expect,vinyl}` — see "Type
checking" below.

### Runtime module resolution never reaches it

Every bare import in daq-server's own JS/TS, intersected with the root tree's package names:

```
$ git ls-files -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.mts' '*.cts' ':!node_modules' ':!diablo_server/backend/dist' \
    | xargs grep -h -o -E "(from|import|require\()\s*['\"][^'\"./][^'\"]*['\"]" \
    | sed -E "s/.*['\"]([^'\"]+)['\"]/\1/" | sed -E 's#^(@[^/]+/[^/]+|[^/@][^/]*).*#\1#' \
    | grep -v '^node:' | sort -u > imports.txt            # (run in daq-server/)
$ git ls-files daq-server/node_modules | awk -F/ '{print ($3 ~ /^@/) ? $3"/"$4 : $3}' | sort -u > root_pkgs.txt
$ comm -12 imports.txt root_pkgs.txt
(empty)
```

Imported packages are `ws`, `axios`, `smol-toml`, `react*`, `recharts`, `uplot`, `zustand`, `vite`,
`vitest`, `@testing-library/*`, `@playwright/test`, `@vitejs/plugin-react`, `tailwindcss` plus
builtins; none is in the root tree, so no resolution can end there whatever the cwd or loader.

Call sites of the TS scripts that live outside a package (`test/*.ts`, `test/characterization/**`)
and their cwd:

| call site | cwd | module path |
|---|---|---|
| `test/test_integration.sh:1080-1083` (`udp_listener.ts`) | `(cd "$REPO_ROOT/diablo_server/backend" && …` | `NODE_PATH=…/backend/node_modules` |
| `test/test_integration.sh:1117-1120` (`ws_data_flow_test.ts`) | `(cd "$REPO_ROOT/diablo_server/backend" && …` | `NODE_PATH=…/backend/node_modules` |
| `test/test_integration.sh:834` (`src/server.ts`) | backend | backend's own |
| `test/test_session.sh:49-51` (`session_flow_test.ts`) | `( cd "$DAQ_DIR/diablo_server/backend"` | `NODE_PATH=…/backend/node_modules` |
| `test/characterization/pipeline/run.sh:90,233` (`session.ts`) | `(cd "$BACKEND" &&` | `NODE_PATH="$BACKEND/node_modules"`, `TSX="$BACKEND/node_modules/.bin/tsx"` |
| `test/characterization/config/check.sh:161-164` (`ts_dump.ts`) | `(cd "$backend" &&` | `npx --no-install tsx` (backend's) |
| `test/characterization/calibration/run.sh:39-41` (`ts_harness.mts`) | `(cd "$ROOT/diablo_server/backend" &&` | `npx --no-install tsx` |
| `backend/test/environmental-recovery.integration.ts:29,108-111` | `spawn(…, { cwd: backend })` | `--import tsx`, `NODE_PATH: join(backend,'node_modules')` |
| CI `daq-server-ci.yml:782-786` (`environmental-recovery`) | `working-directory: daq-server/diablo_server/backend` | `npx tsx` |

```
$ git grep -n -E 'NODE_PATH|--import tsx|npx tsx|tsx (watch )?[^ ]*\.ts' -- daq-server .github scripts setup.sh deploy $X ':!**/package-lock.json'
```
returns exactly the call sites above plus the backend's own `src/server.ts` launchers
(`start_tmux_dev*.sh`, `tools/debug/*.sh`, `scripts/aliases.sh:135`) and usage comments. CI installs
only in `diablo_server/backend` and `diablo_server/frontend` (`daq-server-ci.yml:102-109,162-163,659,768,868-871,972`).
Every `[ -d node_modules ]` check in `deploy/**` (`install_nodejs.sh:72,80`, `start_web_gui.sh:85`,
`start_fake_data_stack.sh:57`, `start_calibration_stack.sh:71`) runs after a `cd` into `backend`
or `frontend`.

### Where it *was* reached, and why removing it is still safe

The grep-level argument above is not the whole story. Two mechanisms walk up to
`daq-server/node_modules` from inside `diablo_server/*`:

1. **`npm run` / `npx` PATH.** npm's `@npmcli/run-script/lib/set-path.js` prepends
   `<dir>/node_modules/.bin` for the package dir *and every ancestor*. So `npm run dev` (production
   systemd unit), `npm test`, `npm run relay` and every `npx …` under `diablo_server/backend` had
   `daq-server/node_modules/.bin` on PATH, ahead of the system PATH. That `.bin` holds 18 shims:
   `cleancss color-support fxparser gifsicle gulp image-dimensions minimize mozjpeg optipng resolve
   rimraf seek-bunzip seek-table semver svgo uglifyjs uuid which` (all resolvable). A child process
   running any of those names would have got the Node shim. None is invoked:

   ```
   $ git grep -n -E '(^|[^A-Za-z0-9_.-])(cleancss|color-support|fxparser|gifsicle|gulp|image-dimensions|minimize|mozjpeg|optipng|rimraf|seek-bunzip|seek-table|svgo|uglifyjs)([^A-Za-z0-9_-]|$)' \
       -- daq-server deploy scripts .github setup.sh $X ':!**/package-lock.json'
   (empty)
   $ git grep -n -E '(^|[^A-Za-z0-9_.:/-])(which|semver|uuid|resolve)[ ]+[-a-zA-Z"$]' -- <daq-server shell/py/mjs, deploy, scripts, setup.sh, .github>
   → only English prose ("which board …") and .github/workflows/daq-server-ci.yml:63 `which clang-format`
     (a CI step, not under npm)
   ```

   What the backend and its tests actually spawn (`git grep -n -E '(spawn|exec|execFile|execSync|spawnSync|execFileSync)\w*\('`
   over `backend/src`, `backend/test`, `frontend`, `test`): `journalctl` (dhcp-status.ts:110,121),
   the built `state_script_check` (script-check.ts:86), `systemctl` and `python3`
   (service-controller.ts:109,120,268), `scutil` (video/service.ts:95), `pio`/`platformio`
   (ota-build.ts), `node video/agent.mjs`, `scripts/video-gateway.sh`, `ffmpeg`/`ffprobe`
   (video-gateway test), `python3` board sim (ws_data_flow_test.ts:3028,3597), and built binaries.
   None is one of the 18 names.

2. **TypeScript type resolution.** With no `types`/`typeRoots` in `backend/tsconfig.json` and
   `shared/tsconfig.json`, `tsc` auto-includes `node_modules/@types/*` from every ancestor, and
   resolves `undici-types`' `import 'buffer'` to the root `buffer` package. Measured before removal:

   ```
   backend$  npx tsc --noEmit -p . --listFiles | grep daq-server/node_modules/
     …/node_modules/buffer/index.d.ts, …/@types/expect/index.d.ts, …/@types/vinyl/index.d.ts
   shared$   ../backend/node_modules/.bin/tsc -p tsconfig.json --noEmit --listFiles | grep daq-server/node_modules/
     …/@types/expect, …/@types/node/** (≈90 files), …/undici-types/**, …/buffer/index.d.ts, …/@types/vinyl
   frontend$ npx tsc --noEmit --listFiles | grep daq-server/node_modules/
     …/node_modules/buffer/index.d.ts        (types: ["vite/client"] limits the rest)
   ```

   `shared/` has no `node_modules` of its own, so CI's "Verify shared types are in sync"
   (`npm run build:shared` → `tsc -p ../shared/tsconfig.json`, then `git diff`) was type-checking
   against the root tree's `@types/node`. Type information does not reach the emitted JS here, and
   this was checked rather than assumed:

   | check | before (root tree present) | after (removed, fresh `npm ci`) |
   |---|---|---|
   | backend `npx tsc --noEmit -p .` | exit 0, 0 errors | exit 0, 0 errors; 0 files from `daq-server/node_modules` |
   | frontend `npx tsc --noEmit` | exit 0, 0 errors | exit 0, 0 errors |
   | frontend `npm run build:shared` | exit 0 | exit 0; `git status` clean (emitted `shared/*.js/.d.ts/.map` byte-identical) |

   Nothing at runtime uses this: `tsx` strips types, and Vite resolves `buffer` from the frontend's
   own tree.

---

## Verification

| | what | result |
|---|---|---|
| (a) | `cmake -S daq-server -B /tmp/wp1-build-{before,after} -Wno-dev && cmake --build … -j8`, fresh dirs, before (`b2599617`) and after the deletion | both exit 0; 29 `warning:` lines each, identical after normalising the build dir (`diff` empty); `ls bin | sort` identical, 46 files. `git status` clean after each. |
| (b) | `rm -rf backend/node_modules frontend/node_modules`; `npm ci --no-audit --no-fund` in backend then frontend; `npm test` in each | `npm ci` exit 0 both. backend: 356 passed, 9 skipped, **1 failed** = "this machine's LAN name > on macOS is the Bonjour name", the AGENT-RULES known-red on this Mac. frontend: 50 files / 488 tests passed; `npm run test:build` exit 0. |
| (c) | `bash daq-server/test/characterization/linux/linux_gate.sh --areas pipeline,lifecycle wp/WP1-junk` (takes the stack lock itself), tree `35a8b40d` (the deletions + `.gitignore`) | `npm ok`, `build ok`, `characterization ok`: `LIFECYCLE: PASS`, `pipeline[pt]/[nocal]/[boards]: PASS`, `CHARACTERIZATION: PASS`, `LINUX GATE: PASS`. 1-min load after: 3.18. |
| (d) | `git ls-files daq-server/node_modules daq-server/.cache daq-server/build-ci daq-server/build-clang-ci daq-server/diablo_server/backend/dist daq-server/output/lut/controller_lut.bin daq-server/output/lut/controller_lut_ddp_small.npz \| wc -l` | `0` |

The Linux leg (c) exports the committed tree into a container and runs `npm ci` there, so it also
proves the clean-checkout case: no root `node_modules`, no `dist/`.

## Not deleted, and why

- `scripts/calibration/calibrations/{cubic_calibration.json,abort_thresholds.txt}` — still tracked
  (LEDGER Parked: untracking deletes the live stores on the stand at its next pull).
- `calibration/*.json` (13) — still tracked; the backend's PT-coefficient fallback dir (Parked).
- `diablo_server/shared/*.js|.d.ts|.map` (19 tracked files) — committed on purpose; CI checks them.
  Unchanged, including after `build:shared` against the new tree.
- `diablo_server/backend/package.json` — unchanged; `main`/`start` → missing `dist/server.js` is Parked.
- Repo-root `Doxyfile:88-89` (`EXCLUDE` of `daq-server/build-ci`, `build-clang-ci`) — outside
  `daq-server/`, the orchestrator's.
- `test/test_ota_flash.py:57` — its stale `build-ci/FSW/ota_service` fallback candidate (§1); left
  for WP4/WP12.
- `deploy/startup/stop_tmux.sh:37` — `pkill` pattern for `dist/server.js`; harmless.

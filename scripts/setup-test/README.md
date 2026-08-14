# setup-test — validate `setup.sh` from a clean slate

Test harness that runs `bash setup.sh --<project> --yes` in an isolated
environment, then runs a per-project smoke check. Catches drift between
`setup.sh` and the real per-project CI workflows, and lets a newcomer verify
their laptop before spending an afternoon debugging a broken clone.

## When to run

- **New to the repo?** Run it once after cloning to confirm your machine can
  build everything from a clean slate — before you sink an afternoon into
  debugging a half-broken setup.
- **Setup broke?** Reproduce it here in isolation (a scratch copy, never your
  real checkout) to see whether the problem is `setup.sh` itself or your local
  state.
- Before merging changes to any `setup.sh`, `scripts/setup_common.sh`, or a
  project's `requirements.txt` / `package.json`.
- When a coworker reports "setup didn't work on my machine" — reproduce it
  here first.
- Once a month, unprompted, to catch upstream package rot (NodeSource repo
  changes, brew formula moves, apt package renames).

## Two harnesses

| Script         | Runs on            | What it tests                                    |
| -------------- | ------------------ | ------------------------------------------------ |
| `run-docker.sh`| any host w/ Docker | Linux path (ubuntu:24.04 clean install)          |
| `run-macos.sh` | macOS (or Linux)   | Native macOS path — brew, Xcode CLT, ARM Python  |

Docker validates the Linux/WSL branch of `setup.sh`. It does **not** validate
macOS — Docker Desktop on Mac runs a Linux VM under the hood, so the
Homebrew branches never execute. Use `run-macos.sh` on an actual Mac to catch
those.

## Prerequisites

- **Fresh Mac:** `run-macos.sh` installs project dependencies through Homebrew
  but does **not** install Homebrew itself — it fails fast if `brew` is
  missing. On a brand-new machine, install it first: https://brew.sh
- **Docker path:** `run-docker.sh` needs Docker installed with its daemon
  running (start Docker Desktop first).

## Usage

```bash
# Linux path in a clean container:
bash scripts/setup-test/run-docker.sh pid-designer
bash scripts/setup-test/run-docker.sh daq-server
bash scripts/setup-test/run-docker.sh all

# macOS native (isolates to $HOME/STAR-setup-test):
bash scripts/setup-test/run-macos.sh pid-designer
bash scripts/setup-test/run-macos.sh all
```

Projects: `pid-designer` | `star-openrocket` | `engine-design` | `firmware` | `daq-server` | `all`

### Useful flags

`run-docker.sh`:
- `--keep` — don't remove the container after run
- `--shell` — drop into a shell in the container after setup + smoke
- `--no-cache` — force full image rebuild

`run-macos.sh`:
- `--scratch DIR` — use DIR instead of `$HOME/STAR-setup-test`
- `--keep` — auto-remove existing scratch dir (no prompt)

Before copying, `run-macos.sh` checks free disk against the size of the tree
and bails early with a clear "free up space" message if there isn't enough
room — so you get told up front instead of hitting a cryptic "No space left on
device" halfway through the copy.

## How it works

Both harnesses do the same three things:

1. **Copy the working tree into a scratch location** with build artifacts and
   caches excluded (`.venv`, `node_modules`, `build/`, `.tmp/`, `.next`,
   `dist`, `*.pyc`, `__pycache__`) — so we test a fresh install, not reuse
   whatever your host already has built. `.tmp/` matters especially: it holds
   elodin integration-test scratch — *sparse* database files that are tiny on
   disk (~50 MB) but advertise a huge logical size (multiple TB). A plain
   `rsync -a` would expand those holes into real zero-bytes and fill your disk,
   so the copy both excludes `.tmp/` and passes `-S` (sparse-aware). Don't trim
   these back out.
2. **Run `bash setup.sh --<project> --yes`** in the scratch dir.
3. **Run `scripts/setup-test/smoke/<project>.sh`** to verify the setup
   actually produced something usable — venv importable, node_modules with
   the right binaries, cmake-built binaries in `build/bin/`, PlatformIO on
   PATH, DAQv2-Comms symlink resolved, etc.

Docker uses `ubuntu:24.04` with only `sudo curl git ca-certificates rsync`
preinstalled — every other dep must come from `setup.sh`, which is the whole
point of the test.

## What it doesn't test

- A **truly** fresh macOS. If you already have brew + cmake + node installed,
  `run-macos.sh` won't uninstall them. It tests that `setup.sh` works on a
  normal developer laptop, not a factory-fresh Mac. To test the fresh-Mac
  path, uninstall the specific dep first (e.g. `brew uninstall cmake`).
- Windows. If you clone on Windows and hit symlink issues, the firmware
  smoke check will catch it — but you need to run it on Windows to see it.
- Elodin-DB actually starting. The daq-server smoke check verifies the
  binary is installed and runnable, not that a full DB comes up cleanly.

## Adding a project

1. Add `scripts/setup-test/smoke/<project>.sh` — assume CWD is the repo root
   and exit non-zero on failure.
2. Add `<project>` to the case statement in both `run-docker.sh` and
   `run-macos.sh`.
3. Add it to the `all` loop in `run-docker.sh` and `run-macos.sh`.

# setup-test — validate `setup.sh` from a clean slate

Test harness that runs `bash setup.sh --<project> --yes` in an isolated
environment, then runs a per-project smoke check. Catches drift between
`setup.sh` and the real per-project CI workflows, and lets a newcomer verify
their laptop before spending an afternoon debugging a broken clone.

## When to run

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

Projects: `pid-designer` | `engine-design` | `firmware` | `daq-server` | `all`

### Useful flags

`run-docker.sh`:
- `--keep` — don't remove the container after run
- `--shell` — drop into a shell in the container after setup + smoke
- `--no-cache` — force full image rebuild

`run-macos.sh`:
- `--scratch DIR` — use DIR instead of `$HOME/STAR-setup-test`
- `--keep` — auto-remove existing scratch dir (no prompt)

## How it works

Both harnesses do the same three things:

1. **Copy the working tree into a scratch location** with `.venv`,
   `node_modules`, and `build/` excluded — so we test a fresh install, not
   reuse whatever your host already has built.
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

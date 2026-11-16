# Rules for agents working on backend-remastered

Read this before anything else. It overrides anything in a task prompt. The decisions behind each
rule are in `LEDGER.md` (Dn numbers).

## Safety and git

1. **Hardware.** Run `hostname` and `ip -4 -o addr 2>/dev/null || ifconfig`. If the host is
   `star-rfs` or has a `192.168.2.x` address, stop and report. Read `daq-server/CLAUDE.md`. Only the
   hermetic and simulated stack; never run anything against `config/config.toml` /
   `config/profiles/server/` as a live target, never send to `192.168.2.x`. Every config you run a
   service against has its board/actuator IPs rewritten to `127.0.0.x`.
2. **Branching.** You are in a worktree created off `main`. First: `git checkout -b <your branch>
   backend-remastered`. Never commit to, merge into, rebase or push `main`. **Never push anything.**
   Never force-push. Never touch `backend-remastered`; the orchestrator merges.
3. **Commits.** Plain one-line messages as the repo's configured git user (`git commit -m "..."`).
   No `Co-Authored-By`, no AI attribution, no links to conversations or sessions, no trailers.
4. **The contract is frozen** (D5): board wire protocol (`lib/daq-protocol`, `diablo_server/transport`)
   byte for byte; TCP `:9998` and `:9999`; HTTP and WebSocket shapes; loading of `config/` TOMLs; the
   Elodin schema; state-machine transitions and actuator command streams. Frontend tests unmodified.
5. **Never edit a golden** under `test/characterization/*/golden/` to make a change pass. A golden
   that must change is a contract change: stop and report. A rework may only grow or keep a golden's
   line set; any removed line is accounted for in the area's audit (D20).
6. **Behaviour defects in `main` are reported, never fixed** in a refactor (they go to the ledger's
   Parked/Defects). Where a uniform design would change observable behaviour (e.g. SIGPIPE), keep each
   service's current behaviour as an explicit per-service setting (D17).

## Machine discipline (one machine, many agents)

7. **Stack lock.** Anything that binds ports — ctest, an area's `run.sh`, `test_integration.sh`,
   `dev.sh --sim`, a service binary, the simulator, a Linux container run, a stress pass — runs under
   `bash daq-server/test/characterization/with_stack_lock.sh <cmd>`. Never set
   `DAQ_STACK_LOCK_PRIORITY` (orchestrator only). At most one queued lock run per agent. Keep each hold
   short (≤ ~5–10 min): iterate on subsets (`CHAR_AREAS=…`, `CHAR_SEQ_ONLY=…`, `ctest -R …`); never a
   full `ctest`, never `gate.sh` — the full gate is the orchestrator's merge-queue job (D23, D36).
   `with_stack_lock.sh --status` shows the holder and waiters.
8. **Linux.** `bash daq-server/test/characterization/linux/linux_gate.sh --areas <a,b> <rev>` builds a
   full-tree export in an `ubuntu:24.04` container and runs only those areas (with the leftover
   checks). Agents use only `--areas`; the full leg is for `queue/*` and the tag candidate. A harness
   that hands a port from a listener to a child confirms the port binds before starting the child.
9. **Kill only PIDs you started.** Never `pkill`/`killall` by name. Stress (`yes` × ncpu) only inside a
   lock hold, killed when the hold ends.
10. **Don't run the repo-wide `./format.sh`** (it rewrites out-of-scope firmware Python on `main`).
    Format only what you touched, with the pinned tools:
    `export PATH=/Users/roshantaneja/Downloads/STAR/.git/remaster-tools/fmtvenv/bin:$PATH` (clang-format
    19.1.7, black 25.11.0), then `clang-format -i <files>` and `black <new .py files>`. Never commit
    files outside `daq-server/`.

## Environment

- Setup: `npm ci --no-audit --no-fund` in `daq-server/diablo_server/backend` and `.../frontend`; then
  `bash daq-server/scripts/build.sh`. No submodules. `elodin-db` 0.16.1 at `~/.cargo/bin/elodin-db`.
- Known red on this Mac, not caused by you: ctest `actuator_delays`, `script_positions`,
  `script_runtime`, `sequencer_concurrency`, `t7_integration` (macOS timer overshoot / harness, D34);
  backend vitest "on macOS is the Bonjour name". The republish-timing tests are judged on CI.
- Characterization conventions: `test/characterization/README.md`; each area's README.

## Report back

Branch, `git merge-base HEAD backend-remastered`, `git diff --stat backend-remastered...HEAD`, what you
ran and its results (with the 1-minute load where timing matters), mutation evidence for any test you
added (each deliberate break and what went red), anything you could not preserve, and any `main`
behaviour you believe is a defect (reported, not fixed).

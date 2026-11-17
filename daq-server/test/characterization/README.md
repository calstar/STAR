# Characterization suite (golden master)

These tests freeze what the DAQ backend **does today** so it can be restructured without changing
behaviour. They are not a specification: a golden records `main`'s output, defects included. If a
golden looks wrong, record it in `docs/remaster/LEDGER.md` under defects — do not change it.

```bash
bash scripts/build.sh                                  # or let gate.sh build build-gate/
bash test/characterization/run.sh                      # the whole suite
cd build && ctest -L characterization                  # the C++ half only
bash test/characterization/gate.sh [--fast]            # the full merge gate
```

Off the stand only (`daq-server/CLAUDE.md`). Anything that binds ports runs under
`with_stack_lock.sh`, which serialises stack runs across worktrees on one machine.

## Layout and conventions

- One subdirectory per area (`packets/`, `config/`, `calibration/`, `sequencer/`, `pipeline/`, …).
  An area owns only its own directory. A `CMakeLists.txt` in it is picked up automatically; a
  `run.sh` in it is run by `run.sh` here. C++ tests carry the CTest label `characterization`.
- Goldens live in `<area>/golden/`. They are text where the thing is text, and hex dumps
  (one field per line, with offsets) where it is bytes, so a diff names the field that moved.
- `CHAR_UPDATE=1` rewrites goldens instead of comparing. Only ever run it against `main`'s
  behaviour (the `remaster-baseline` tag). A package that needs a golden changed has changed the
  contract; that is a bug in the package until proven otherwise.
- Normalisation (stack goldens): wall-clock timestamps, PIDs, ports, temp paths, session and
  request IDs are replaced with stable placeholders by `pipeline/normalize` rules, written once and
  shared. Anything else that varies run to run is a flake to fix, not to mask.
- Every test was proven to fail. The deliberate breakages an area catches are listed in that
  area's README where it keeps one (`calibration`, `pipeline`, `sequencer`); for the others they are
  in the package's merge-log row in `docs/remaster/LEDGER.md` (the mutations each queue item was
  gated on). A test added later must bring its own: break the thing it guards, see it go red, revert.

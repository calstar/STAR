# Configuration Guide

How configuration is stored, edited, and applied on the DAQ server.

**The rule: an edit is a draft. Drafts apply when a session starts.** There are two deliberate
exceptions, both listed below. If you are reading this because something you changed did not take
effect, the answer is almost certainly "start a session".

---

## The three things called "config"

| | What it is | Who writes it | Tracked in git |
|---|---|---|---|
| `config/profiles/<name>/config.toml` | **The draft.** What the config editor reads and writes. | The editor, via `POST /api/config` | Yes |
| `config/config.toml` | **The deployed artifact.** What the C++ services actually read. Generated. | `deployActiveProfile()` only | No (gitignored) |
| `config/.active_profile` | One line naming the active profile. Machine-specific. | Profile switch | No (gitignored) |

The three state-machine CSVs (`state_machine_actuators.csv`,
`state_machine_actuator_delays.csv`, `state_transitions.csv`) live beside the profile's
`config.toml` and deploy with it. They are profile-owned; the copies in `config/` are generated
the same way.

Editing `config/config.toml` by hand is pointless — the next deploy overwrites it. Edit the
profile.

## The one apply point

`deployActiveProfile()` (`backend/src/routes/config-profiles.ts`) copies the active profile's
`config.toml` **and all its CSVs** into `config/`. It is all-or-nothing: every target is
snapshotted first and rolled back together if the new config does not parse, because a
half-applied deploy — new roles, old state table — is worse than no deploy.

It runs in two situations:

1. **At session start** (`session-manager.ts`), immediately before the pipeline units are
   started. This is the apply point that matters. If the deploy fails, **the session start fails**
   and nothing is started — a run on stale config with a green "session active" light is the worst
   available outcome.
2. **On save while idle.** With no session running there is nothing to protect, so a save deploys
   straight away. Convenience only; the model is unchanged.

During a session every write path degrades to a draft:

- `POST /api/config` and `/api/config/import` → write the profile, skip the deploy
- `POST /api/state-csv` → same
- `POST /api/config/profiles/switch` → **409**, you cannot swap rigs mid-run

The editor shows a freeze banner and a count of un-applied changes while this is in effect.

## Why the services can trust it

The session-gated pipeline units — `sensor-elodin`, `sensor-daq`, `sensor-calibration`,
`sensor-controller`, `sensor-actuator` — are stopped and started by the session. Each reads
`config.toml` **once at startup** and holds it for the life of the run. There is no reload verb
and no file watching; the sequencer's `RELOAD_CONFIG` was removed precisely because a hot-reload
path in the safety-critical services is machinery that can only surprise you.

`service-controller.ts` also snapshots the config each run was started with next to its Elodin
database (`<dbDir>.toml`), so a recorded run can always be read back with the config it was
produced under.

The **backend** is different: it is always-on and never restarts, so it must notice a deploy.
It does that with a cache invalidated in `deployActiveProfile()` (`readDeployedConfig()` in
`routes/config.ts`), plus a `CONFIG_UPDATED` broadcast that tells browsers to refetch. Same rule,
different mechanism, because the constraint is different.

---

## Exception 1 — board config broadcast

`config_broadcast_service` is **always-on, not session-gated, and re-reads `config.toml` on every
broadcast cycle** (~1 Hz). Board-level settings therefore reach hardware without a session:

- `[boards.*]` — `enabled`, `active_connectors`, `voltage_reference`, `necessary_for_abort`,
  `designated_survivor`, `enable_serial_printing`
- `[actuator_roles]` and the Vent / Engine-Abort columns of `state_machine_actuators.csv`
- **`[abort_pts]` — the autonomous overpressure trip thresholds the boards act on**

This is intentional. It is also worth understanding rather than assuming: the session freeze is
the only thing that currently stops someone changing an abort trip mid-run, and that is a
property of the freeze, not a decision the broadcaster makes.

The related endpoint `POST /api/board-log-mode` rides this exception — it surgically edits one
field so verbosity can be raised *during* the misbehaviour it is meant to diagnose. It writes both
`config.toml` (so the board gets it now) and the active profile (so the next deploy does not
silently revert it).

## Exception 2 — calibration

Calibration is not in `config.toml` at all. The live store is
`scripts/calibration/calibrations/cubic_calibration.json`, written only by `calibration_service`,
with named snapshots under `profiles/` and a `.active` pointer.

Capture, zero, clear and whole-profile load all apply **immediately**, mid-session, by design —
the capture-and-verify loop is the run. Loading a calibration profile publishes command 7 over
Elodin and the service re-reads its store live.

The config.toml keys calibration *does* read (`calibration_model_<board>`,
`calibration_full_scale_<board>`, `calibration_sense_resistor_<board>`, `[adc]`,
`[calibration.*]`) are ordinary boot-time config and follow the normal rule.

---

## What is not config

These are runtime commands, not configuration, and are unaffected by any of the above: state
transitions, manual actuator overrides, debug mode, extend fire, countdown target, session
start/stop/extend, and control unlock. They go over the WebSocket as `SEND_COMMAND` and are gated
by operator arming, not by the config freeze.

## Simulated runs

Simulated sessions do **not** deploy the profile. The sim pipeline reads `config/sim_config.toml`,
regenerated at session start from the frozen `config_base.toml` with `192.168.2.` rewritten to
`127.0.0.` So profile edits are invisible to sim runs.

This is deliberate rather than an oversight: the point of a sim run is that it behaves identically
on every box, which a per-box active profile would destroy. The cost is that "config applies at
session start" is not true on the sim path, so the session page says so when Simulated is selected.
If you are testing config behaviour, test it on a live-mode session or you will conclude the model
is broken.

## A trap on dev boxes

Session control is off unless `SESSION_SERVICE_MODE=systemd`, which is set only in
`deploy/systemd/sensor-backend.service`. On the tmux dev stack and on laptops the mode is `off`,
`sessionActive` is permanently `false`, and **every save deploys immediately** — the freeze is
inert there. Do not verify freeze behaviour on the dev stack and conclude it works.

## Related

- `docs/CONTROLLER_STACK_AND_DB_WRITES.md` — what each pipeline service does with the config
- `docs/SENSOR_ASSIGNMENT_SYSTEM.md` — **aspirational, not shipped**; the real path is the static
  `[boards.*]` table broadcast by `config_broadcast`
- `docs/IMPROVEMENTS.md` — known gaps

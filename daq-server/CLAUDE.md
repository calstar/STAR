# ⛔ HARDWARE SAFETY — READ THIS FIRST, IT OVERRIDES EVERYTHING BELOW

**This machine (`star-rfs`) IS the test stand.** The actuator boards sit on `192.168.2.0/24` and
are reachable. Anything that emits an actuator command moves a **real valve** on **real plumbing**
that may be pressurised, with people standing near it. There is no simulator in the way. There is
no dry-run mode. A command you send arrives.

## The default is NEVER

Do not run any of the following unless the user has, **in their most recent message, explicitly
asked for that specific action**:

- `build/bin/sequencer_service` — commands valves over UDP the moment it starts
- `build/bin/controller_service` — drives the PWM ignition gate
- Any `TRANSITION:`, `ACTUATOR:`, `DEBUG_MODE:`, `EXTEND_FIRE`, `RELOAD_CONFIG` sent to TCP `:9998`
- `FIRE_START` / `FIRE_STOP` to TCP `:9999`
- `systemctl --user start|restart|stop` of `sensor-actuator`, `sensor-controller`, `sensor-daq`,
  `sensor-elodin`, `sensor-calibration`, `sensor-simulator`
- `test/test_integration.sh` — launches the whole stack **and deletes the live calibration store**
- `test/e2e_guitest_playwright.sh` — same, plus a browser

**None of these are covered by a general instruction.** "Deploy", "test it", "make sure it works",
"verify", "check that", and "continue" are **NOT** permission to touch hardware. Neither is any
other line in this file. Permission is specific, in the current message, and it expires — approval
to do it once is not approval to do it again.

## "Verification" is not an exception

Running the real binary to satisfy yourself that a change works is exactly the failure this rule
exists to stop. It *feels* different from a deploy. It is not: `sequencer_service` against
`config/config.toml` on this box is the production article, and `TRANSITION:<state>` is a real
command to open real valves.

If a change needs proving, prove it with the hermetic tests. They are better evidence anyway — the
`actuator_delay_csv` bug on 2026-09-07 was caught by the integration harness's own patched config,
while the live run that opened the fuel path caught nothing at all.

## What you may do freely

- `ctest`, `npm test` (vitest), `npm run lint`, `cppcheck` — all hermetic
- `scripts/build.sh` — compiles only, starts nothing
- Reading anything: source, config, `journalctl`, logs
- Editing source and config files
- Restarting **only** `sensor-backend` / `sensor-frontend` — and only after the check below

## Before restarting ANY service

```bash
systemctl --user is-active sensor-elodin sensor-daq sensor-actuator sensor-calibration
```

If any is `active`, **a run is in progress**. Stop and ask. Do not restart the backend under a live
session either — it bounces every operator's GUI mid-run.

## If you believe you need hardware

State plainly what you want to run, what it will physically do, and why the hermetic tests cannot
answer it. Then **wait for an explicit yes**. Silence is not consent. Do not bundle it into a larger
command so it slips past a permission prompt.

---

### Why this file starts this way

**2026-09-07.** An agent ran `sequencer_service` against the deployed config to "verify" a timing
change, and commanded `Ready → Flow Test` — opening `Fuel Upstream`, then `Fuel Main` a second
later, on live reachable boards. Nobody asked for it. The operator's first sign was the engine
appearing to fire.

Earlier the same session, that agent ran `test/test_integration.sh` because the old first line of
this file said to after any big change. Line 604 of that script `rm`s the live cubic calibration
store with no backup. A day of calibration was gone; it was only recovered because a manual copy
happened to exist in `calibration_backups/`.

Both came from treating a live stand as a workstation. Neither was malicious and both were avoidable
by asking first.

---

# Testing

**Prefer the hermetic tests. They need no hardware and no permission:**

```bash
cd build && ctest --output-on-failure --parallel $(nproc)   # C++
cd diablo_server/frontend && npm test && npm run lint       # TS
```

**`test/test_integration.sh` and `test/e2e_guitest_playwright.sh` launch the full stack and touch
persistent state — see the rule above. Ask first, every time.** When the user does authorise the
integration test, be aware it deletes `scripts/calibration/calibrations/cubic_calibration.json`;
back it up first and say that you have.

Do not run `npx playwright test` alone unless a stack is already up and you intend to hit only the
browser tests.

Both scripts run the canonical full build (`bash scripts/build.sh`) themselves, so stale-binary
flakiness is fixed — no manual pre-build needed. `USE_SIM` is a **runtime env var** consumed by the
launch scripts / calibration_service, not a compile flag; sim and hardware use identical binaries.

# STYLE S8–S14 debate — round 1, advocate A: fail fast

**Position.** Not literal crash-only: `lifecycle/golden/shutdown.txt` freezes SIGTERM →
exit 0 and stays. The claim: a service that cannot be *correct* refuses to start with a distinct
status; one whose invariant breaks at runtime stops rather than continues; systemd and the boards'
watchdog do the rest.

## 1. The case

Every lead defect is a "continue" where a stop was due:

| defect | site | what continues |
|---|---|---|
| D-SLOT | `lib/src/config/Config.cpp:49-55` | `[Config] ERROR`, then the id wraps onto PT2.CH1: a live channel stolen, trace plausible |
| C2-4 | `Config.cpp:446-452` | `toml::parse_error` → `return Config{}` |
| D-CTL | `controller_main.cpp:141-147` | bind fails → thread `return`s; no fire gate, process up |
| D-BIND | `heartbeat_service_main.cpp:252` | `bindToDaqInterface` result dropped |
| D-SUB | `elodin-vtable-registry.ts:136` | accepted subscription, 0 packets forever; only *refused* ones retry |
| D-HB | heartbeat loop | SERVER_HEARTBEAT flows while the sequencer is wedged (C4-1) |
| C6-9 | `calibration_main.cpp:1544-1545` | the inverse: `return 1` on a *transient* |
| TS | `server.ts:1818-1829` | `uncaughtException` → "keeping server alive", justified by a `tsx watch` race the comment itself says no longer applies |

Degraded, and nothing outside can tell. Three layers read *absence* as unhealthy — systemd
(`Restart=`, `--failed`), the boards' 5 s watchdog (D-HB), the GUI's `dataFresh`
(`server.ts:738,1549,1775`) — and all three read presence as health. "Present and wrong" defeats
them; stopping turns an unknown state into the one every layer understands.

This finishes what the tree began: `Config.cpp:450-451` rethrows `invalid_argument` ("must not
become an empty/default configuration") — C2-12 is that choice reaching `main` uncaught, two
policies for one error. `sensor-t7.service:18-22` `RestartPreventExitStatus=2
3`; `sensor-elodin.service:4-8` `AssertPathExists` because `Restart=always` was "an invisible
spin"; `star-dhcp.service:19-20` `dnsmasq --test` "instead of crash-looping";
`star-dhcp-sync.service:13-16` refuses a bad config, journal on the Boards page; D41/H2 fails the
harness on `[Config] ERROR`. `research/cpp-service-plumbing.md` §4 gives the shape:
`validate(const Config&) -> vector<string>`, all errors, `exit(78)`, `RestartPreventExitStatus=78`.

## 2. Coexistence with the frozen contract

S8 wins everywhere in the remaster; nothing in §3 touches existing behaviour (research §4: even a
logging-only validator grows the config goldens). STYLE decides the *shape*, so each approved fix
is one line at a marked site: WP8 §2.3 returns `TcpListener::Failed` and §2.5 `ConfigFileChoice`
to the caller; D43(4) marks them `// Kept: D-CTL` / `// Kept: D-BIND`; the fix is the marker
becoming `return 1`, golden first. Adoptable today: the pure injectivity test over shipped profiles
(`research/subscription-robustness.md` Idea 1) — red on `config_base` + board 60, changes nothing,
and is what `validate()` later wires to 78.

## 3. Rewritten S8–S14

**S8 — The refactor preserves every failure mode.** Unchanged. The rules below shape new structure
and direct team-approved fixes: golden first, then fix and unit-file change as one package.

**S9 — Catch only where input enters, and a catch decides or rethrows.** Boundaries as drafted;
`SequencerService.cpp:94-105` is the model. A catch that cannot name its recovery (defaults,
refuse, drop the frame, retry) rethrows to the boundary that can, or stops. No "log and keep alive"
guards: `server.ts:1818-1829` is kept and labelled; the direction is exit non-zero and let
`sensor-backend.service` restart.

**S10 — One answer per request; every accepted subscription delivers or fails loudly.** As drafted.
Direction for D-SUB: check what was granted (Idea 2, the echoed `VTableMsg`, D-ECHO) and *recreate*
the connection, not re-send (Idea 3) — crash-only at subscription granularity; a channel dead past
a bound is shown dead, never a flat line.

**S11 — Classify the failure: refuse, retry or stop; never limp.**
(a) *Config and invariants knowable before a socket opens* — what retrying cannot fix: collect
**all** errors (C2-10's script parser is the sibling), print each, exit 78 before any bind.
Direction for D-SLOT, C2-4, C1-8, C2-5, C2-12 (one policy).
(b) *Environment transients* (Elodin down, NIC not up, port held, peer closed): bounded retry,
never fatal. At startup the supervisor *is* the retry: a socket or bind failure exits 1 and
`Restart=always` retries in 5 s, so the process never limps (the D-CTL/D-BIND direction). C6-9 is
fail-fast misapplied; its fix is the inverse of (a).
(c) *Runtime invariant broken* (lock re-entered, id map no longer injective, worker not consuming):
stop, saying why; `Restart=always` restores it. Wedged is strictly worse than absent (D-HB).
(d) *Runtime config re-read* — the deliberate departure: config_broadcast re-reads every cycle
(DESIGN-WP8 §1.4) and the backend writes `config.toml` in place (`star-dhcp-sync.path`). A re-read
that fails validation is **rejected, last validated config kept**, logged once, shown on the GUI:
an operator's save must not stop a service mid-burn. Fail fast is a startup and explicit-reload
rule.

**S12 — Preserved behaviour is explicit.** As drafted; the kept site also names its S11 class, so
a fix package is a search for the marker.

**S13 — Exit codes name the class.** 0 clean stop/`--help`; 1 startup failure (frozen); **78 =
refused config/invariant, never restarted** (`RestartPreventExitStatus=78` in every unit,
`StartLimitBurst` as `sensor-simulator.service:4-7`); abort (−6) only for a programming invariant,
never input. Frozen exceptions as drafted; only `main` exits. Today every failure is 1, so
`Restart=always` cannot tell a typo from a crash.

**S14 — A seam keeps its error style, and every status reaches a decider.** Status seams stay
(`{ok, reply}`, `bool` + `refusal_reason`); no exception crosses them. New: a returned status is
acted on or passed up — D-CTL and D-BIND are unconsumed returns; new helpers are `[[nodiscard]]`.

**Hotfire reality.** Heartbeat is the service whose *absence is a command*: boards abort at 5 s of
silence and daq_bridge never takes over (C6-3), so a heartbeat exit aborts the test inside
`RestartSec=5`. That is correct exactly when the sender is wedged, which makes D-HB (heartbeat
only while the sequencer worker is alive) the *precondition* for S11(c): a crashed sequencer under
a flowing heartbeat leaves valves as last commanded and nobody aborts. Its restart delay is a
safety parameter set with D-HB, not a default.

## 4. Objections and answers

**O1 — "Rules for code that cannot follow them; structure slips into behaviour (the `sendJson`
trap, the logging validator)."** Conceded; §2 answers it, and the goldens that catch a silent
D-API3 fix catch a silent exit-code change too.

**O2 — "Mid-run, an exit loses the fire gate, telemetry or the GUI at the worst moment."** D-CTL's
gate and D-SUB's channel are *already* gone; the process just does not say so. An exit makes the
loss visible, systemd restores it in 5 s, and the boards' watchdog, built for absence, covers the
gap. Conceded: transients retry (S11(b)), re-reads keep last-good (S11(d)), the backend is the
GUI's only server (C6-5: close 1006 on restart).

**O3 — "Start on defaults is the culture (subscription-robustness Q2); the operator wants it up to
see what is wrong."** The GUI cannot display an error the process does not know it made: D-SLOT's
symptom is a correct-looking PT2 trace. `star-dhcp-sync`'s refused config, journal on the Boards
page, *is* the visible version. Fail-loud (run + blocking notification) is acceptable only where
the degraded state cannot touch a live channel; D-SLOT does. Mitigation: a `--check-config` /
`ExecStartPre` validator (the `dnsmasq --test` precedent) finds a bad profile before fire day;
conceded, it changes `--help` (WP8 gap 4), a team package.

# STYLE S8–S14 — verdict

Paths under `daq-server/diablo_server/` unless prefixed; `backend-remastered` @ `85a02f9a`.

## 1. Fact rulings (re-read in the tree)

| claim | ruling |
|---|---|
| Boards abort at 5 s vs 5 + 10 s | **B**, from `Active`: 5000 ms → ConnectionLossDetected, 10000 ms grace → NoConnectionAbort (`actuator_config.h:10-12`; `main.cpp:421-425, 478-483`); a heartbeat inside the grace returns to Active (`:533-536`). Shorter paths: `StandardAbort` → no grace (`:428-430`); PT loss 3 s → StandaloneAbort (`:486-492`). |
| Watchdog unarmed until the first heartbeat | Per board boot only: `last_server_heartbeat_ms` resets in `setup()` (`:616`), not on a server restart. On a warm stand a heartbeat_service failing at startup never strokes → abort at 15 s. |
| Backend guard's `tsx watch` justification is stale | **False in production.** `sensor-backend.service` runs `npm run dev` = `tsx watch` (`package.json:8`; C5-7). The comment (`server.ts:1818-1822`) fits only the tmux pane (`start_tmux_dev.sh:225`, plain `tsx`); the nohup branch (`:408`) is `tsx watch`, unsupervised. |
| systemd supervises both launch configurations | **No.** `deploy/README.md:10-14`; `start_tmux_dev.sh:439` `remain-on-exit on`: a laptop exit is permanent. |
| A sequencer restart re-sends the boot batch | **True.** `SequencerService.cpp:603-610`; D35's `ACT_CMD.B2.CH7 {0}` is that row. |
| Heartbeat D-BIND | NIC resolve fails → `return 1` (`heartbeat_service_main.cpp:248-251`); bind result dropped (`:252`), destination subnet-directed. |
| `dataFresh` advances on any Elodin row | Any **entity row**, any producer (`server.ts:1775`); `[0x10]` heartbeats return first (`:1645-1648`); `shutdown.txt` freezes it false. |
| `ControllerService.cpp:139` "20×100 ms retry" | :139 is the log string; the loop is `:807-808`, an unbounded reconnect whose 2 s sleep is sliced 20×100 ms. Substance right, "bounded" wrong. |
| C4-1 "frozen in `digital-twin__scripts-load.txt`" | The wedge is frozen (`ERR` after 10 s, `char_sequencer.py:1011`); "SIGTERM does not exit" is documented, not frozen (WP10 §7.4). |
| config_broadcast re-reads in duty, aborts on a bad id | **True.** `while (g_running)` `:545` → `buildPackets` `:548` → `config::load` `:186`; no `catch` in the TU; `Config.cpp:450-451` rethrows. A parse error keeps last-good per the TU's comment (`:546-547`). |
| `hbloss.txt:4` is the server-heartbeat model | Misattributed: that is the **board**-heartbeat case. Under heartbeat_service SIGTERM the golden records 0 notifications (C6-3) on a sensor board; an actuator board under a 5 s restart is **uncharacterized**. |

## 2. Decision

**Synthesis: C's class × phase table carries the policy; A's exit-status discipline governs startup; B's surface rule and "most conservative class hosted" govern duty.** No single axis survives the facts: fail-fast is right for D-SLOT, wrong for C6-9; degrade the reverse (all conceded). An in-duty exit from a control or safety process is an event, not a reset: the boot batch moves valves, C4-1 cannot be exited, the laptop has no supervisor, heartbeat absence aborts at 15 s. At startup the exit status is the one policy the machine enforces unaided; "present and wrong" is met by refusing there and a keyed status in duty.

## 3. Best argument from each side

**A:** every lead defect is a "continue" where a stop was due; absence is the one state every layer reads, and D-SLOT's symptom is a plausible trace no notification sees.
**B:** a server exit is invisible to the safety layer and costs telemetry and the abort relay; main's error is silence, not survival; a restart is itself a valve command.
**C:** the tree runs four unnamed policies, sometimes in one function; a named class lets a `// Kept` tag name the broken rule.

## 4. Replacement text for STYLE §2

Slots keep today's meaning (`STYLE-S10`, `S12` are cited by WP6 §4.3, S37, D43); new rules get suffixes.

**S8 — The refactor preserves every failure mode.** Unchanged. S8a–S14a direct new structure and team-approved fixes: golden first, code and unit file in one package.

**S8a — Every path carries a criticality class and a phase; the pair decides the policy.** Phase is *startup* (before `main` starts its worker, opens its serve socket or sends its first packet) or *duty*. A new header or module names its classes (S36). A process hosting several classes takes the most conservative exit policy among them (daq_bridge, the sequencer, the backend).

| class — paths | startup fault | fault in duty | loud surface |
|---|---|---|---|
| **safety** — ABORT/ABORT_DONE, SERVER_HEARTBEAT, abort batch, FIRE_STOP/PWM close, ACTUATOR_CONFIG thresholds | exit 78 on config that makes the boards unreachable or a threshold wrong; socket/NIC exit 1 (warm stand: TQ3) | never exit, block or throw mid-send; bounded independent sends; degraded beats none | boards (D-HB), stacklight |
| **control** — sequencer worker, state machine, scripts, PressureFeed, controller loop, `:9998`/`:9999`, backend relay | exit 78 on config that moves a valve or lands a table; exit 1 on bind | refuse as a value with a reason; rig unchanged; never exit | `ERR:` + `refusal_reason`; `ERROR` to the sender |
| **observation** — daq_bridge ingest, calibration, backend WS/HTTP, registry, stacklight, t7 | transients retried, never fatal; exit 1 on argv/port | drop the row, keep the stream; one answer per request; dead subscription reported | keyed `ongoing` notification |
| **tooling** — ota, `/api/ota-flash` | exit 1 on argv/port | fail per request with `ERR:`; never touches safety or control | reply + log |

**S9 — Catch only where input enters; a catch decides or rethrows; a boundary catch ends one unit of work.** Boundaries as WP6 §4.3 (model `SequencerService.cpp:94-105`). A catch names its recovery or rethrows to the boundary that can; it never ends the thread serving the others, or the process. Spans move verbatim. No new keep-alive guard; `server.ts:1823-1829` is kept, labelled, its comment corrected in cleanup.

**S10 — Every request gets exactly one answer; every accepted subscription delivers or is reported dead.** D-API3, D-SUB kept as drafted; `sendJson` only on literal bodies (D39). D-SUB direction: classify by the echoed `VTableMsg` (Idea 2), re-send only a classified-dead pair, recreate the connection only when unclassifiable (Idea 3); a dead channel is shown dead.

**S11 — Startup: fail fast on what retrying cannot fix, with a status the unit will not loop on.** Collect every config error, print all, exit 78 before any socket opens — one policy for D-SLOT, C2-4, C1-8, C2-5, C2-12; `RestartPreventExitStatus=78` in the same package. Transients: bounded retry or exit 1 so the unit retries (C6-9 inverted).

**S11a — Duty: never exit from a safety or control path; a failed re-read is rejected, the last validated config kept, logged once, shown.** A wedge is answered by the boards through D-HB, not by a restart that commands the boot batch.

**S12 — Preserved behaviour is explicit, never a silent default of shared code.** Per-service settings at call sites (WP8 §2). A kept site reads `// Kept: <id> (D17) — <class>/<phase>: <rule violated>; loud half: <surface>` (supersedes D43(4)).

**S13 — Exit codes are frozen; 78 is reserved.** 0, 1, frozen exceptions as WP8 §4; −6 only for a programming invariant; 78 only for refused config, never restarted (precedent `sensor-t7.service:21-22`). Only `main` exits, in its startup block.

**S14 — A seam keeps its error style; a fault is a value that reaches a decider.** Status seams keep returning status (`{ok, reply}`, `bool` + `refusal_reason`, `TcpListener::Failed`); no exception crosses them. New helpers are `[[nodiscard]]`; a status is consumed or passed up, `(void)` only under `// Kept:`. Nothing reports an in-duty fault only in a log.

**S14a — Every degraded part is a keyed `ongoing` status on an operator surface, and the safety layer never depends on a service choosing to exit.** Model `markStaleBoards` (`server.ts:661-701`). The backend raises it from what it observes today (stale ingest, board heartbeats, WS close, `{ok:false}`); it does **not** observe SERVER_HEARTBEAT loss (C6-3), per-pair liveness (D-SUB) or any C++ in-duty fault; those need plumbing (C++ precedent: the Boards-page journal, `star-dhcp-sync.service:13-16`; TQ6).

## 5. Remaining disagreements

- **Runtime invariant in control → stop (A)?** Against: S11a (boot batch, C4-1, tmux).
- **Backend `uncaughtException` → exit (A) or keep + status (B)?** Keep + keyed status: control relay, no laptop supervisor, every GUI drops on 1006 (auto-reconnect unverified); exit is TQ2.
- **D-SUB:** B's ordering. **Heartbeat exit:** a hazard in duty, 15 s (TQ1, TQ3).

Team questions: **TQ1** health-gate SERVER_HEARTBEAT (D-HB): a stall during a hold aborts the stand at 15 s. **TQ2** after C5-7, should an uncaught backend error restart the process? **TQ3** heartbeat/config_broadcast D-BIND: continue unpinned (ruled for heartbeat) or exit. **TQ4** sequencer re-init after a crash or board abort. **TQ5** the fatal-check list for `validate()`; `--check-config`. **TQ6** surface for C++ in-duty rejections: Boards-page journal or Elodin status table. **TQ7** D-SUB reconnect during Fire.

## 6. Consequences for the design notes

- **WP8 §2.3/§4, D43(4):** `kListen` and the two ignored binds take the S12 long form (`// Kept: D-CTL (D17) — control/startup: bind failure continues; becomes exit 1`; heartbeat `D-BIND — safety/startup: ruled continue, TQ3`). §1.4 marks the re-read in-duty safety (S11a); §2.1 names classes.
- **WP8 §7.2 gaps:** actuator-board state under a heartbeat restart; a bad board id saved mid-run; abort while wedged.
- **WP6 §4.3:** "process → crash guards" row relabelled "today, kept; S9/S14a, TQ2"; cleanup corrects the guard's comment. **WP7:** the router catch replies 500 only while headers are unsent; `sendJson` restriction stands (S10).
- **WP9:** `// Kept: C6-9 (D17) — observation/startup: fatal on a transient; becomes retry`. **WP10:** `// FROZEN C4-1` tags carry "control blocking safety".
- **Research, LEDGER:** teststand Idea 3 "within 5 s" and D-HB's "5 s watchdog" → 15 s; C5-7 precedes TQ2.

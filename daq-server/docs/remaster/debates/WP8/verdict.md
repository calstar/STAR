# WP8 verdict

Lines are `backend-remastered` (product = `main` @ 15b5a0c5), paths under
`daq-server/diablo_server/` unless said; every ruling was checked with `git show`.

## 1. Fact rulings

1. **Bind-failure order (B): true at all three callers.** Log, `close`, return — `sequencer_main.cpp:267-269`,
   `ota_service_main.cpp:425-427`, `controller_main.cpp:142-145`. The A stub ("closed by the callee" on
   `kBind`) closes before the caller's `bind() failed` line on all three. Unobservable; not statement for
   statement. A conceded.
2. **Accept loops (A, C): identical in effect, not in text.** `sequencer_main.cpp:303-349` and
   `controller_main.cpp:171-214` share every syscall and branch (reap; 10 ms `select`; `accept`; reap; cap;
   `send` `MSG_NOSIGNAL`; cerr; `close`; spawn; shutdown-all; join-all). Textual differences: `tv` declared
   before `fd_set` in the controller (174-177 vs 307-310), `timeval` init style, variable and constant
   names, `::` qualifiers, prefix bytes, capture `&svc`/`svc`. None has an effect.
3. **Followers (A): identical control flow.** Loops `heartbeat_service_main.cpp:106-151` vs
   `stacklight_service_main.cpp:102-135`: connect → `sleep_for(2 s)` → subscribe → cerr+disconnect → timeout →
   cout → `read_packet` → `n < 0` disconnect → `n < 8` → `buf[5]/buf[6]`, `n >= 17`. Differences: three
   literals, the timeout, and the `n < 0` branch (heartbeat 135-137 prints
   `… read failed (" << last_error() << ") — reconnecting`; stacklight 123 is silent).
4. **`AbortBroadcaster.cpp` in the ctests (C): six executables, two timing-judged.** `lib/CMakeLists.txt:259`
   (`sequencer_elodin`, `add_test` 380), 281, 304, 330, 406-412 (`sequencer_concurrency`, `abort_ordering`);
   `timing_ctests.txt` lists `script_runtime` and `sequencer_concurrency`. `sequencer_main.cpp` and
   `controller_main.cpp` build only their binaries (`services/CMakeLists.txt:15,36`); stacklight's main is
   `#include`d by `char_config_services.cpp:22` (§7.3 applies).
5. **config_broadcast's fill (A round 2): true.** `inet_pton` at 554, `sin_port` at 558, zero and family once at
   529-531. `ipv4Destination` (zero, family, port, `inet_pton`) is a third user only by reordering.
6. **`std::thread` decay-copy (A): true, conclusion not forced.** `std::atomic<bool>` is non-copyable, so
   `std::thread(f, …, running(), …)` does not compile; `std::ref(running())` fixes it without a wrapper,
   which nobody said. The wrapper is a choice (271/295 stay byte-identical).
7. **Uninterruptible back-off (C): true.** `sleep_for(2 s)` at heartbeat 109 / stacklight 105 is not sliced on
   the flag. `shutdown.txt` records stacklight `[0, 1.2] s` *before* elodin-db is killed; the bound holds
   only with the db up.
8. **D45 (B): verified verbatim** — "one `send_msg` (log text a parameter; nullptr = silent, the two copies
   differ)".
9. **D32 (A, B): batching is real; gaps 1-3 (`lifecycle/`), 5 (`sequencer/`), 7 (`packets/`), 4/8 (`config/`)
   are disjoint.** Unsaid by all: `packets/` is on `queue/C1`, so gap 7 follows C1's merge.
10. **DESIGN-WP10:53-54 (C): WP10 touches neither `sequencer_main.cpp` nor `controller_main.cpp`.** A's "WP10
    inherits gaps 5-7" is false.
11. **`AbortBroadcaster.cpp:125` closes before the summary cout 127-133 (B):** research §5's "yes identical"
    is wrong under D5's letter.
12. **EINTR (A):** `TCPClient.cpp:219-221` retries `read_exact`, 147-149 `_write_all`.

## 2. Decision

Casing per S1 as D43(2) ruled: `fsw::service` and `fsw::net` camelCase, `fsw::elodin` snake_case.

| shared | users (today's lines) | pass | gate |
|---|---|---|---|
| `fsw::service::running()`, `installStopHandlers` — §2.1 verbatim, `::signal`, install points of §1.2 | the seven WP8 services; calibration (WP9), daq_bridge (WP10) | **1** | gaps 1, 2, 3 |
| `fsw::net::serveTcpClients` + `TcpServeOptions`; `Conn`, `reap_finished` verbatim from 284-301; `on_client` only through public enqueueing API (D42 binding 1) | sequencer 303-349, controller 171-214 | **2** | gap 5 |
| `fsw::elodin::follow_sequencer_state` + `SequencerStateFollowerText`, via each main's file-static wrapper | heartbeat 103-152, stacklight 99-136 | **2** | gap 7 |
| file-static `parseArgs` per main (§6.2 item 2, t7's `exit(2)` verbatim) | seven mains | 2 | gap 4 |
| `// Kept:` tags, S12 long form (D46) | `controller_main.cpp:147` (D-CTL); heartbeat 252, config_broadcast 526 (D-BIND) | 2 | — |

**Stays per service, every `close()` on its line:** listener setup (sequencer 252-276, controller 128-147,
ota 410-434); UDP sockets and destinations (heartbeat 232-263, stacklight 268-282, config_broadcast 509-531,
554-558); `AbortBroadcaster.cpp`; the config-path blocks (heartbeat 202-213, stacklight 211-228,
config_broadcast 468-485, controller 276-301 — a second open plus the controller's four lines rebuilt from
flags, which no golden needs: struck under D49); per-client readers; `trim`; encoders. ota: `StopSignals`
only.

**Gates.** Pass 1: one queue item, prerequisite gaps 1-3 (`lifecycle/`). Pass 2: one queue item,
prerequisites gaps 4, 5, 7 as one D32 batch (`config/`, `sequencer/`, `packets/`; gap 7 after C1). Pass-2
commits run helper TU → each (helper, service) adoption → `parseArgs` → tags, so a bisect names its
commit (D12e). **Fallback:** pass 2 ships whichever of `serveTcpClients` / `follow_sequencer_state` has
its gap merged green; a piece whose gap is ejected (D32) stays in its mains, with a ledger entry; if both,
pass 2 is `parseArgs` + tags. Pass 1 never waits on gaps 5-7. Gaps 6 and 8 become "worth writing, not
gating" (gap 6 is D-CTL's only characterization). This re-cut supersedes "Open questions 2" and §6's
taxonomy; the orchestrator ratifies it under D39. Timing-ctest exposure: `t7_integration` only (pass 1,
step 2; CI-judged, D34).

## 3. Rulings

**Raw fd vs `UniqueFd`: raw, now.** With `openTcpListener` out no helper returns an fd; every socket is
opened and closed in its main as today, zero `reset()`s. B's own §3 concedes it. `UniqueFd` is the header
the D-FD/D-CTL fix package mints; B's round-1 §2 close table is its guide.

**`serveTcpClients`: pass 2.** Only `StopSignals` is WP9/WP10's prerequisite (ruling 10); gap 5 is the
timing-bearing case (64 held connections under D27 load, doubled-period mutation); a statement-identical
move loses nothing by waiting. A is right that D32 equalises gate count; C is right that an ejected member
would stall the one piece others wait on.

**`follow_sequencer_state`: in, pass 2.** The nullptr text field is **data**. S34's "configuration knob"
selects control flow — §0's rejections were retry policy, back-off, table lists, fatal vs retry. A
literal-or-nothing in a per-service struct is the explicit setting S12 and D17's boundary clause
*require*: the shape of `StopSignals`' `line` (which C keeps) and of D45's `send_msg`. `on_state` and
`on_client` are callback types by D43(3) and pass because both users agree observably. C's "net ≈ 0" is
conceded: the thinnest margin here. It stays because design review accepted it (D39, D45), research §3's
follower proposal then lands once, and the fallback makes it ejectable without stalling anything.

**D-FD fix shape (team note).** B is right that a `closed` flag only narrows the window: flag read →
`shutdown()` still races the handler's `close()` at 221/124. Shape: the handler never closes; the owning
`Conn` closes after the shutdown/join loop (`UniqueFd` or an `int` closed at reap — the team's call). FIN
moves ≤ 10 ms; observable; its own package (S8); lands once.

## 4. The best argument from each side

**A:** the two accept loops and two followers agree in every statement of control flow, their literal
differences are S12's call-site settings, and D32 turns the extra gaps into authoring cost, not gate count.
**B:** "every `close()` stays put — none by construction" failed on A's own stub at three callers; who
closes, and in what order relative to the caller's log lines, must be a stated contract — and a `closed`
flag cannot fix D-FD. **C:** against doing nothing (D49), each shared socket piece buys ~10-75 net lines
for a characterization package guarding a surface only WP8's move disturbs; and touching
`AbortBroadcaster.cpp` put a two-statement saving under the sequencer's flakiest ctests — A and B reversed.

## 5. Edits required

**DESIGN-WP8.md:** (1) §0 table — delete the `openUdpSocket`, `ipv4Destination`, `openTcpListener`,
`findConfigFile` rows; add each to "Rejected" with its reason (kBind inversion, one-user `kListen`, three
ladders; `openUdpSocket(true)` one user, 554-558 reorder; second open + controller rebuild, D49).
(2) §2.2, §2.5 marked WITHDRAWN. (3) §2.3 — `TcpListener`/`openTcpListener` removed; `serveTcpClients`
borrows an `int`; doc states `on_client` outlives every client thread (joined before return), "Must not
know `fsw::service`", and that the busy-literal split (`"[Sequencer] "` + `"client limit ("`) is listed in
the commit (S15). (4) §2.4 — call form (wrapper or `std::ref`), "Must not know `fsw::service`", the 2 s
back-off as a latency fact. (5) §6 taxonomy reworded; §6.1 = steps 1-8; delete 9, 10, 14; steps 12-13
keep only their loop halves and move with 15-16 to §6.2; §6.2 item 1 deleted; tags in S12 long form.
(6) §7.2: 1-3 before pass 1; 4, 5, 7 before pass 2; 6, 8 worth writing; gap 7 after C1; research §1's
second-SIGTERM case added to gap 2. (7) §3/§4 rows for dropped pieces → "unchanged"; §6.3 EINTR amendment
→ "does not touch `sendPacket`"; §8 → only `t7_integration`; §C.1 step 1 owner `sequencer_main`; §C.3
sockets owned by the main; §A "Decision: A" gains an AMENDMENT (debate verdict) naming the kBind
inversion; §B stub table; "Open questions 2" superseded.

**Stubs:** delete `UdpSocket.hpp`, `ConfigFile.hpp`; `TcpCommandServer.hpp` loses `TcpListener`,
`openTcpListener` and their Owns/Errors paragraphs; `SequencerStateFollower.hpp` adds call form,
must-not-know, back-off fact; `StopSignals.hpp`: "nullptr **iff** `kSilent`"; `README.md` WP8 row.

**STYLE.md:** S21's good example (`openTcpListener`, "callee closes on socket/bind failure") is wrong
twice — the helper is gone and its contract inverted the order; S14's `TcpListener::Failed` example too.

## 6. Remaining team questions

1. Who writes gap 6, the only D-CTL characterization, now that no WP owes it?
2. Add research §1's second-SIGTERM case (catches `SA_RESETHAND`) to gap 2?
3. Ratify the D-FD shape above, and that `UniqueFd` arrives with that package?
4. Self-pipe: the follower's wake needs `ElodinClient` to expose its fd — in the proposal's scope?
5. Should `shutdown.txt` gain a db-down follower case, given the 2 s back-off makes stacklight's `[0, 1.2] s`
   conditional?

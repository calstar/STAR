# WP8 round 2 — C (signals only): conceded where beaten, one piece admitted to pass 2

Lines: `backend-remastered` @ 5a897ac7 (= DESIGN's b2599617).

## 1. Conceded

- **A's line counts.** ~330 gross / ~130 net stands as an estimate; C nets ~0. I argued lines per
  gate, not lines; A wins lines outright.
- **A's `std::thread` / `std::atomic` finding (A §4.1)** is correct: `std::thread` decay-copies and
  `std::atomic<bool>` is non-copyable, so each main keeps a file-static wrapper around
  `follow_sequencer_state`. I use it below — it cuts the follower's saving, it does not refute A.
- **Gaps 1-3 gate C too** (A O3). Said in round 1; A's marginal cost is gaps 5-7 only. Further
  concession: D32 lets test-only, directory-disjoint packages share one gate, and gaps 5/6
  (`sequencer/`, `lifecycle/`) and 7 (`packets/`) are disjoint. "Three gates" in round 1 overstated
  it: one batched gate plus three authoring efforts, one of them timing-bearing (gap 5: 64 held
  connections, `SO_RCVTIMEO` 5 s, under D27 load, with a doubled-period mutation).
- **B's close table (B §2)** is correct line for line, and its `openTcpListener` finding is real:
  today the order is log → `close` → `return 1` (`sequencer_main.cpp:267-269`, `:273-275`;
  `ota_service_main.cpp:425-427`; `controller_main.cpp:142-144`), and A's stub closes on `kBind`
  inside the callee, before the caller's `bind() failed` line. Unobservable black-box (the fd was
  never bound), but not statement for statement.
- **`serveTcpClients` passes S34** (A O1): the two loops agree in every statement; prefix bytes and
  backlog are outside the call. Admitted to WP8 — see §4.

## 2. A's weakest point: "behaviour risk — none by construction"

A §3 claims the shared code *is* the replaced statements. Four counter-examples, two from A's own
file:

1. B's inversion above: `openTcpListener` closes before the log at three callers.
2. `strerror(l.err)` for `strerror(errno)` (`controller_main.cpp:130-131`, `:142-143`): same value
   in practice, different evaluation point — the class of edit D-ERRNO is about.
3. A's own concession: the handler `switch` is "equivalent, not literally identical".
4. The follower: with A §4.1's wrapper, each main keeps ~15 lines (wrapper, three literals, the
   lambda, the timeout constant) and the .so holds the ~30-line connect/subscribe/read skeleton —
   the skeleton `PressureFeed::runLoop` and `ControllerService::elodinSubscriberLoop` also have,
   which §0 rejected sharing because the knobs differ. The two followers' knobs differ at
   `heartbeat_service_main.cpp:135-137` vs `stacklight_service_main.cpp:123`. Net saving after the
   wrapper: ~90 − 30 − (header + TU ≈ 60) ≈ 0.

None is a golden change. All are what a reviewer must check by hand in a package whose premise is
that nothing needs checking. C has zero such items because it moves zero such statements.

**"WP10 inherits them whether or not WP8 ships" (A O3) is false.** DESIGN-WP10:54-55: "WP10 does
not touch `sequencer_main.cpp` or `controller_main.cpp`." No later package touches
`heartbeat_service_main.cpp` or `stacklight_service_main.cpp`. Gaps 5-7 guard surfaces only WP8's
own sharing moves; they are A's cost, not the programme's.

**Self-pipe (A §5)** overstates its reach: A's sharing puts the fd into two functions; every other
loop (ota `:439-445`, heartbeat `:291-292`, stacklight, config_broadcast `:600`, t7, calibration,
daq_bridge) stays per-main under both options, and the follower's wake needs `ElodinClient` to
expose an fd (A concedes). The handler half is identical in both.

## 3. B's weakest point: a type whose benefit it says no one can see

B §2: "No golden observes an fd close instant… the resets serve D5's letter; the area stays
uncovered." B §4: "a missing `reset()` moves a close past a log line or a join, which no golden
sees." So B adds a type whose value is invisible and whose failure mode is invisible — a new
silent-risk class with a six-line manual gate. DESIGN §A's test (citing S34) applies: a type
bypassed by explicit `reset()` at six of B's fourteen rows (heartbeat `:295`, stacklight `:343`, config_broadcast
`:604`, sequencer `:351`, ota `:456`, AbortBroadcaster `:125`) is not the abstraction. "Seven
owners agree observably" (B O1) is vacuous when, by B's own sentence, nothing observes them. The
20-line ctest tests `UniqueFd`, not the stand. B's `TcpListener{UniqueFd}` does fix A's inversion
— by adding a type where C simply leaves `:267-275` where they are.

Conceded to B: its table is the right review artefact for *any* option that moves a `close()`,
and `ElodinClient::disconnect()` is indeed the codebase's `reset()`.

## 4. Revised design

| piece | pass | gate | change from round 1 |
|---|---|---|---|
| `fsw::service::running()`, `installStopHandlers` (§2.1, stub as is; A §4.4's "`line` is `nullptr` iff `kSilent`" adopted) | 1 | gaps 1, 2, 3 | none |
| `fsw::net::serveTcpClients` — `Conn` + `reap_finished` verbatim from `sequencer_main.cpp:284-301`, `on_client` only through public enqueueing API (D42 binding 1), the two callers at `:303-349` and `controller_main.cpp:171-214` | **2** | gap 5 joins gaps 4 and 8 as "before pass 2" | **admitted**, moved off pass 1's path |
| `openTcpListener`, `openUdpSocket`, `ipv4Destination`, `follow_sequencer_state`, `find_config_file` | — | — | still out: B's inversion, ~0 net after the wrapper, knobs for two users, double open |
| pass 2 also: §6.2 item 2 (`parseArgs`), D43(4) `// Kept:` tags | 2 | gaps 4, 8 | none |

Why this split: by §6's taxonomy `serveTcpClients` is pass-1 material (statement-identical). C
re-cuts the passes by what gates them — pass 1 = what gaps 1-3 guard, pass 2 = what gap 5 guards —
and asks the orchestrator to accept that re-cut under D39 (each pass is already its own gated
queue item). Pass 1 ships WP9/WP10's prerequisite — one flag, one install point — the day gaps 1-3
land; pass 2 may queue after WP9/WP10 if gap 5 lags, with gap 2's sequencer/controller shutdown
bounds already in place. Its three flows are A's
(SIGTERM: `select` EINTR or 10 ms → shutdown all → join all; 65th client: inside the loop, bytes
untouched; follower: untouched in the mains). Timing-test exposure stays C's: no WP8 pass touches
`AbortBroadcaster.cpp`, so none of the six sequencer ctests compiled from it
(`lib/CMakeLists.txt` 259, 281, 304, 330, 412) enters WP8's gate.

Proposals: self-pipe lands in `StopSignals` plus each loop that opts in (after pass 2, two of
those loops are one function); exit 78 is orthogonal; D-FD lands once in `serveTcpClients`
(A §5, now shared).

## 5. Remaining disagreements

- **A:** the follower, UDP and listener helpers are worth gaps 6-7 and the four hand-checked
  non-identities in §2; C says ~0 net lines do not earn either.
- **A:** `serveTcpClients` belongs in pass 1; C says pass 2, so WP9/WP10's prerequisite does not
  wait on gap 5.
- **A:** "WP10 inherits gaps 5-7"; DESIGN-WP10:54-55 says it does not.
- **B:** an fd owner whose effect no golden sees is still worth six `reset()` lines and a type; C
  says a type bypassed at half its sites is prose with a destructor.
- **B:** the `openTcpListener` inversion should be fixed by `UniqueFd`; C says by not moving
  `:264-276`.
- **Both:** gaps 5-7 are "contract surfaces uncharacterized today" and therefore owed; C says owed
  by whoever moves them — gap 5 by WP8 pass 2, gaps 6-7 by nobody yet.

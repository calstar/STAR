# WP8 round 2 — A (free functions): concede B1 and the listener, keep the two loops

Lines: `backend-remastered` @ b2599617.

## 1. Conceded, and what it changes

**B's `kBind` finding is correct.** The A stub closes the fd inside `openTcpListener` on `kBind`;
today the log comes first (`sequencer_main.cpp:267-268`, `ota_service_main.cpp:425-426`,
`controller_main.cpp:142-144`). Unobservable, but not statement for statement — and review missed
it. B's fix (fd returned open, caller closes after its log) is right; but with C's knob critique
(`TcpListener::Failed` exists so three callers rebuild three ladders; `kListen` open-fd serves
D-CTL's one user) and the arithmetic — sequencer 252-276, ota 410-434, controller 128-147 ≈ 70
lines, replaced by ~25 shared + three ladders ≈ 35 — the helper nets ~10 lines for one review-only
defect and a gate (gap 6). **Dropped.** ota adopts `StopSignals` only. Gap 6 stays worth writing:
it is the only characterization of D-CTL.

**C's timing-test point is correct.** `AbortBroadcaster.cpp` is compiled into `test_sequencer_elodin`,
`hold_rules`, `script_states`, `script_runtime` (`lib/CMakeLists.txt:259,281,304,330`) and
`sequencer_concurrency`; `script_runtime` and `sequencer_concurrency` are in `timing_ctests.txt`,
CI-only under D34. Two statements (`:80-87`) are not worth D31's 10× rule. **AbortBroadcaster is
untouched.** That leaves `openUdpSocket(bool)` with one `true` user — C's knob — and
`ipv4Destination` with two identical users, because config_broadcast's per-packet fill is
`inet_pton` *then* `sin_port` (`:554-558`) with the zero/family done once (`:529-531`): a third
user only by reordering. **`UdpSocket.hpp` dropped.** B1 stays in the mains.

**C's gap arithmetic is correct as counted: six → three** (1-3 guard the handler C shares; 5, 6, 7
are A's). With the listener gone it is **two** (5, 7). And they are not three gates: D32 stacks
directory-disjoint test-only packages into one `queue/char-batch-<n>` gated once — gaps 1-3 land in
`lifecycle/`, gap 5 in `sequencer/`, gap 7 in `packets/`. A's marginal gate cost over C is zero
gates; the cost is authoring two cases, both of which C concedes are "worth writing".

**C's S34 knob argument, item by item.** `kListen` and `openUdpSocket(bool)`: conceded, gone.
`read_failed_prefix == nullptr`: not conceded — §3.

## 2. Revised design

| piece | users | gate | replaces |
|---|---|---|---|
| `service/StopSignals` (§2.1 verbatim, per-service table) | 7 now; calibration WP9, daq_bridge WP10 | gaps 1-3 (C needs them too) | 9 flags + 9 handlers |
| `net/TcpCommandServer` — **`serveTcpClients` only**, `TcpServeOptions{max_clients, busy_log_prefix}` | sequencer, controller | gap 5 | `sequencer_main.cpp:282-349`, `controller_main.cpp:151-214` |
| `elodin/follow_sequencer_state` | heartbeat, stacklight | gap 7 | `:103-152`, stacklight `:99-136` |
| pass 2: `config/find_config_file`, `read_file_text`; `parseArgs`; `// Kept:` tags | 4 / 7 / 3 | gap 8 (pass 2 only) | B6 blocks |

Listener setup, UDP sockets and destinations stay in their mains; every `close()` stays on its
line. Pass 1 = §6.1 steps 1-8, 11 (header without `openTcpListener`), 12-13 (listener code
untouched, accept loop → `serveTcpClients`), 15-16 (file-static wrapper, round 1 §4.1). Steps 9,
10, 14 deleted. WP8 now touches no TU in the sequencer ctest set (`lib/CMakeLists.txt 254-342,
406-416`; DESIGN §8); `sequencer_main.cpp` and `controller_main.cpp` are executables only. The one
timing-ctest exposure left is `t7_integration` from step 2, which C shares. Gross deletion ≈ 55 + 120 + 90 = 265, shared ≈ 150,
net ≈ 115 — less than round 1's 130 and honestly counted.

Round-1 improvements stand: the follower wrapper (`std::thread` decay-copies; `std::atomic`
non-copyable), "Must not know `fsw::service`" in both headers, the 282-283 comment at the call
site, `line == nullptr` iff `kSilent`. One addition from B's catch: every shared helper's doc
comment now states the **order** of its side effects relative to the caller's log lines, not only
who closes.

## 3. B's weakest point: a type whose destructor fires on zero new paths

B's §2 table is the case against B. "Pure" means the destructor closes at the instant today's
`close()` already does; the six non-pure sites each get an explicit `reset()` on today's line.
So on every path the destructor either duplicates an explicit call or runs where the old code
already ran — B says it: "destructor at a new instant: zero paths". The type adds nothing a path
can observe and costs a header, six `reset()`s B itself calls review items, and ~15 `.get()`s at
every `select`/`accept`/`sendto`. The one fd whose ownership is actually muddled — `Conn::fd`,
D-FD — B leaves `int`. The type lands where it is unneeded and is withheld where it would matter.
B's 20-line ctest is not a second user (D43(3), D48(2)); B's four "later users" are WP10 and
transport files. Concede `grep UniqueFd` as a clarity gain; reject the premise that nine `close();
return 1;` lines are a problem any golden or operator has seen.

B also writes that research §5's "yes identical" at `AbortBroadcaster:125` is wrong under D5's
letter because the summary cout follows the close. Agreed — one more reason that TU is untouched.

## 4. C's weakest point: the `nullptr` knob argument indicts C's own piece

C: `read_failed_prefix == nullptr` is "a behavioural knob with one user per value — an abstraction
by S34's definition". Apply that test to `installStopHandlers(ShutdownNotice, line, Sigpipe)`:
`kSilent` has one user (t7_bridge), `kStopThenPrint` one (daq_bridge), `line == nullptr` one.
C's only shared piece is three one-user-per-value knobs, and C is right to keep it — because the
§0 rejections were about **control flow** (retry policy, back-off, table lists, fatal vs retry),
while a notice kind or a "print this line or none" field is **data** in a per-service table, which
is exactly what D17's boundary clause prescribes ("an explicit per-service setting"). The follower's
two users share every statement of control flow (`:106-151` vs `:102-135`: connect → 2 s →
subscribe → timeout → read → `n < 0` disconnect → `n < 8` continue → `buf[5]/buf[6]`); they differ
in three literals, one integer and whether one cerr line is emitted. Either both pieces pass S34 or
neither does.

**C's S8 argument** ("the shared loop belongs in the D-FD fix package") confuses consolidation
with a fix. S8 forbids a refactor *applying a new policy*; `serveTcpClients` applies none. D12(e)
and D19 require the opposite packaging: move-only merged alone, behaviour change separately — a
fix package carrying a consolidation is the unbisectable shape the remaster rules out. And D17(b),
orchestrator-adopted, names "socket setup" in WP8's remit; C's WP8 is signals only. C concedes
`serveTcpClients` "passes S34 cleanly" and that the duplicates are copies: the only question left
is *when*, and the remaster's one consolidation slot is now.

**C's grep point** (the busy line's second half moves into the .so): S15 freezes bytes, not
location; the literal-multiset check will show one split (`"[Sequencer] "` + `"client limit ("`),
listed in the pass-1 commit. A review note, not a defect.

C's warning for gap 7's author — the 2 s connect back-off (`:109`, stacklight `:105`) is
uninterruptible, so `shutdown.txt:7`'s `[0, 1.2] s` holds only with the db up — is correct and
should go in the lifecycle README with the case.

## 5. Remaining disagreements

- **vs C:** `serveTcpClients` and `follow_sequencer_state` land in WP8 pass 1 (A) or wait for a
  team fix package that may never come (C).
- **vs C:** gaps 5 and 7 gate pass 1 (A: one D32 batch with gaps 1-3) or are ungated extras (C).
- **vs C:** a "print or `nullptr`" text field is per-service data like `kSilent` (A) or an
  abstraction (C).
- **vs B:** raw fds with explicit `close()` on today's lines (A) or `UniqueFd` + six `reset()`s
  (B), when the destructor fires on no new path.
- **vs B:** a `UniqueFd` ctest is a second user (B) or not (A, D43(3)).
- **Agreed by all three:** `StopSignals` as §2.1; `::signal`; detached threads stay detached; no
  thread-owning objects; gaps 1-3 before pass 1; `AbortBroadcaster.cpp` untouched (now A too).

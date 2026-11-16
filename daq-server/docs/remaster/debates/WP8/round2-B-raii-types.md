# WP8 round 2 — B (RAII types): rebuttal and revised design

Lines: `backend-remastered` @ 5a897ac7 (product code = `main` @ 15b5a0c5).

## 1. Against A

**A's weakest point is its own guarantee.** Round 1 §1: "every `close()` stays put"; §3: "none
by construction: the shared code *is* the replaced statements". Both fail on the bind-failure
paths. Today the order is log, close, return — `sequencer_main.cpp:267-269`
(`cerr << "bind() failed on port"`, `close(listen_fd)`, `return 1`), `ota_service_main.cpp:425-427`,
`controller_main.cpp:142-145`. A's `openTcpListener` ("on socket or bind failure the fd is
closed", §2.3, stub `fd = -1 // open unless failed is kSocket or kBind`) closes *inside the
callee*, so the caller's `bind() failed` line now prints after the close on all three. Same class
of slip A's §3 charges B with on heartbeat `:295`; same visibility (none to a golden); same
remedy A's §6.1 says it never needs. The fix is free: hand the fd back open and let the caller's
`return` close it — which is an owner, not a raw `int` plus a who-closes paragraph.

**A's O2 attacks a design B did not propose.** `Conn::fd` stays `int` in pass 1 (round 1 §2);
the owning `Conn` is named only as the D-FD fix's shape (§5). A's "`reset()` gives back ~20"
lines is six (round 1 §2 table).

**Where A is right:** the §2.1 table is the contract's home; the `std::thread` decay-copy catch
(step 16 wrapper) is real and B adopts it; `TcpCommandServer.hpp` must not know `fsw::service`.

## 2. Against C

**Gap arithmetic — the mapping is right, the count is not.** C's table is correct: gaps 5, 6, 7
exist only for shared socket code; gaps 1-3 gate C too. But "three gates" assumes three queue
items. D32: "ready, test-only, directory-disjoint characterization packages are stacked in one
`queue/char-batch-<n>` and gated once", disjointness checked by `git diff --name-only`. Gap 5 is
`sequencer/`, gap 7 `packets/`, gaps 1-3 `lifecycle/`, and gap 6 fits `lifecycle/` (§7.2 names
no area); D32's rule for two packages in one directory is one line of history, as C4/C4b were. One
batch, one gate, and it carries C's three gaps as well. The marginal cost of A's scope is authoring three cases whose
surfaces — `:9998` where every fire and abort starts, the controller's gate port, the followers —
are uncharacterized today and inherited by WP10 either way (A's O3; C concedes they are "worth
writing"). C's own gap-7 caveat (the uninterruptible 2 s back-off, `:109`) is the kind of fact
only writing the case surfaces.

**Timing-test exposure — conceded, and B acts on it.** `AbortBroadcaster.cpp` is compiled into
six ctests (`lib/CMakeLists.txt:259,281,304,330`, and `:412`'s `sequencer_concurrency`,
`abort_ordering`); D34 judges `script_runtime` on CI only. B's round 1 touched that TU at five
tokens plus a `reset()`. For two statements that is the wrong trade. **B2 leaves `AbortBroadcaster.cpp` untouched in WP8**; its `openUdpSocket(true)` and
`UniqueFd` adoption rides WP10's queue item, which already edits `ActuatorCommander.cpp` (the
same five targets plus `actuator_delays`/`script_positions`) and already requires a CI run (D47).
WP8 then edits no TU under a timing ctest except `t7_bridge_main.cpp`, as C does.

**S34 against `follow_sequencer_state` — the precedent is already ruled.** C: `read_failed_prefix
== nullptr` meaning "print nothing" is a behavioural knob with one user per value. D45 accepted
exactly that shape for WP3: "one `send_msg` (log text a parameter; nullptr = silent, the two
copies differ)". Either both stand or D45 reopens; C cannot cite S34 against one and not the other.
The follower's remaining differences are three literals and a timeout the callers already own.

**C's D-FD direction narrows the race; it does not close it.** "A `closed` flag per `Conn`":
main's `if (!c->closed) shutdown(c->fd)` is a flag read followed by a syscall; between them the
handler can run its `close()` (`sequencer_main.cpp:221`) — on either side of its flag write — and
the kernel can hand the number to another thread before `shutdown()` executes. The window shrinks
from close → `done = true` (`:221` → `:338`) to read → `shutdown`; it stays open. Only "the handler
never closes" closes it: fds stay open through the shutdown loop and the owner closes after the
join. That is a `UniqueFd` member of `Conn`, and it is why the type belongs to that package (§3).

**Where C is right:** `find_config_file` is not move-only (A files it under pass 2); the D49/D51
standard — each piece against *doing nothing* — is the one to apply; C's pass 1 is the zero-risk
floor and A's named fallback.

## 3. Does `UniqueFd` earn its place if C's scope wins?

Honestly: **not in WP8.** Against doing nothing it is nine early-return `close()`s deleted, five
`reset()`s added, a 35-line header, zero gates, and one new review item (a `reset()` on the wrong
line is invisible to every golden). D49 would strike it, as it struck WP6's 2.10. Its value lands
where the owner question *is* the fix: the D-FD package (§2, the `Conn` owner) and D-CTL
(`kListen` → log-and-return closes by construction). Under C, `UniqueFd` is the header those
packages introduce, with round 1's §2 table as its adoption guide; under A it earns its place now,
because `openTcpListener` must return an owner anyway (§1) and the type then costs nothing extra.

## 4. Revised design (B2)

| piece | B2 |
|---|---|
| `StopSignals` | A/C verbatim, §2.1 table, `::signal`, install points of §1.2 |
| `openTcpListener(port, backlog) -> TcpListener{UniqueFd fd; Failed; int err}` | fd returned **open on `kBind` and `kListen`**; the caller logs, then `return` closes — today's order on all three bind paths and on the controller's `kListen` fall-through (`// Kept: D-CTL` in pass 2) |
| `serveTcpClients(int listen_fd, …)` | A verbatim: borrows `l.fd.get()`, `Conn::fd` an `int`, D-FD frozen, 10 ms select a constant, `on_client` only through public enqueueing API |
| `openUdpSocket(bool) -> UniqueFd`, `ipv4Destination` | heartbeat, stacklight, config_broadcast; **not AbortBroadcaster in WP8** — three users, one `true`: the piece B2 trades next if C's "bool selecting one statement" carries |
| explicit `reset()` | heartbeat `:295`, stacklight `:343`, config_broadcast `:604`, sequencer `:351`, ota `:456` — five, each on today's close line; destructor at a new instant on zero paths |
| `follow_sequencer_state` | A verbatim, via the file-static wrapper (A §4.1) |
| gaps | 5, 6, 7 authored as one D32 batch with 1-3, before pass 1 |
| pass 2 | A's §6.2 plus `// Kept:` tags (D43(4)); `find_config_file` stays pass 2 |
| timing ctests | WP8 edits no TU compiled into a sequencer ctest |

If the judge takes C's scope: B2 collapses to C plus a recorded note that the first package to
mint `openTcpListener` returns an owner and that D-FD's fix is the owning `Conn`.

## 5. Remaining disagreements

- **A vs B:** whether `TcpListener` carries a raw `int` with a callee-closes contract or an owner — B says the three bind paths decide it.
- **C vs A/B:** whether `serveTcpClients`, `openTcpListener`, `follow_sequencer_state` enter in WP8 or in the D-FD/self-pipe fix package — B says WP8, once the gap batch is one gate.
- **C vs B:** whether `read_failed_prefix == nullptr` is an S34 knob — B says D45 already allowed it.
- **C vs B:** the D-FD fix shape — a `closed` flag or an owning `Conn`.
- **All three:** whether gaps 5-7 are prerequisites or "worth having"; the orchestrator's classification stands unless reopened.
- **B's own concession:** `UniqueFd` does not earn a WP8 slot under C's scope; it earns one under A's.

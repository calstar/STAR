# WP8 round 1 — C (signals only): share what is identical, leave the rest where a golden can see it

Position: share the stop flag and the handler installer (DESIGN-WP8 §2.1, stub `StopSignals.hpp`),
nothing else. Sockets, listeners, accept loops, followers and config discovery stay in their mains.
Lines: `backend-remastered` @ 5a897ac7 (product code = DESIGN's b2599617).

## 1. Design

| shared | shape | where | adopters |
|---|---|---|---|
| `running()`, `installStopHandlers(notice, line, sigpipe)` | two free functions, two enums, one constant-initialised atomic (S26) | `lib/include/service/StopSignals.hpp` + `lib/src/service/StopSignals.cpp`, appended to `FSW_SOURCES` (`lib/CMakeLists.txt:4`) | pass 1: the seven WP8 services, §6.1 steps 1-8 verbatim; WP9/WP10 cleanup: calibration, daq_bridge |

Pass 1 is §6.1 steps 1-8 and stops. Pass 2 is §6.2 item 2 only (file-static `parseArgs`, t7's
`exit(2)` lambda verbatim) plus D43(4)'s `// Kept:` tags. No other header. §2.1's per-service table
is the contract, as in A; its skeleton is D17(b)'s "one pattern" — documented, not compiled.

## 2. The three flows — nothing moves but the flag's address

**SIGTERM during a blocked `recv`** (sequencer client thread, `SO_RCVTIMEO` 5 s,
`sequencer_main.cpp:199-200`). The handler is today's body (`:55-58`) in the .so: print, then
clear. On the client thread the `recv` returns EINTR regardless of `SA_RESTART` (research §0.2)
and `handleClient` breaks at `:207`; on Linux the signal usually lands on main, whose 10 ms
`select` (`:311`) returns, `:303` reads `running()` false, `shutdown(c->fd)` at `:346` wakes the
client, join, `close(listen_fd)`, `[Sequencer] Stopped.` (`:352`). Diff to today: `:203` and
`:303` read `fsw::service::running()`.

**65th client.** `sequencer_main.cpp:322-329` and `controller_main.cpp:188-195` untouched: reap,
cap, `ERR:too many connections\n` with `MSG_NOSIGNAL`, both busy lines (U+26A0 U+FE0F, em dash)
where `grep` finds them today. Gap 5 is characterization worth having, not a gate.

**Heartbeat follower reconnect.** `heartbeat_service_main.cpp:106-138` untouched: db closes →
`TCPClient::read_exact` sees `r == 0`, clears `connected_` (`TCPClient.cpp:241`) → `read_packet`
returns −1 (`ElodinClient.cpp:190-195`) →
`Elodin read failed (Socket closed unexpectedly) — reconnecting` (`:135-137`), `disconnect`, 2 s
sleep (`:109`), re-subscribe, `Elodin connected…`. Stacklight does the same silently
(`stacklight_service_main.cpp:123`). Diff: `:106` / `:102` read `running()`. Gap 7 is not a gate.

## 3. Why C beats A and B

B (RAII types) fails on its own: heartbeat's `close(sock)` before `join` (`:295-296`) becomes an
explicit `reset()`, and the detached control thread (`controller_main.cpp:501`) cannot be owned —
RAII in name only (§A, research §5). Against A:

**Clarity.** A reader of `sequencer_main.cpp` still sees the accept loop, the busy line and the
shutdown order in one file; the only thing a main no longer shows is the handler body, and §2.1's
call names it.

**Gap arithmetic — the first axis.** §7.2's six must-close gaps, mapped to the shared piece that
makes each a *prerequisite*:

| gap | guards | needed by C? |
|---|---|---|
| 1 SIGPIPE `kill -PIPE` ×9 | `Sigpipe` setting | yes |
| 2 sequencer/controller/t7 SIGTERM exit + latency | the moved handler | yes |
| 3 `Shutting down` bytes and position | the moved handler | yes |
| 5 65th client, busy bytes, two ports | `serveTcpClients` only | no |
| 6 three listener failure ladders | `openTcpListener` only | no |
| 7 follower reconnect + refused subscribe | `follow_sequencer_state` only | no |

Three test-only packages (each a lock hold, Linux leg, mutation, ≈45 min gate under D19/D32; gap 5
holds 64 idle connections under D27 load; gap 7 needs new stand-in-db code in `packets/`) sit on
WP8's critical path, and WP8 sits on WP9's and WP10's. What they buy, by §A's own estimate: ~330
gross − ~200 shared ≈ 130 net lines, less the five S36 header comments in the stubs (~40 each). I
concede A nets more lines than C (~55 deleted, ~50 added — about zero). The axis is lines per
gate: three gates for ~75 net lines of socket code.

**Timing-test exposure.** A's step 10 replaces `AbortBroadcaster.cpp:80-87` (two statements:
`socket()`, `SO_BROADCAST`). That TU is compiled into six sequencer ctests (`lib/CMakeLists.txt`
259, 281, 304, 330, 412: `sequencer_elodin`, `hold_rules`, `script_states`, `script_runtime`,
`sequencer_concurrency`, `abort_ordering`). D34 makes `script_runtime` CI-only; D31's 10× rule can
trigger. C edits no TU in that set — only `t7_bridge_main.cpp` (→ `t7_integration`, already
CI-judged). A two-statement saving should not put a package under the sequencer's flakiest gate.

**S34, applied as §0 already applies it.** §0 rejected `ServiceMain`, the argv parser,
`SubscriberLoop`, `UdpSender` and a shared `trim()` because the users differ observably — it did
not propose `trim(strip_quotes)`. The survivors pass only by turning the difference into a knob:

- `follow_sequencer_state`: three text literals, a timeout, and `read_failed_prefix == nullptr`
  meaning *print nothing*. The followers differ observably on the very event gap 7 tests
  (heartbeat `:135-137` logs, stacklight `:123` is silent): a behavioural knob with one user per
  value — an abstraction by S34's definition.
- `openTcpListener`: `TcpListener{fd, failed, err}` exists so three callers can rebuild three
  ladders; `kListen`-with-open-fd is a return state for one user (`controller_main.cpp:147`,
  D-CTL). `strerror(l.err)` for `strerror(errno)` is "same value", not statement for statement.
- `openUdpSocket(bool broadcast)`: a bool selecting one statement, 2 true / 2 false; net ≈ 10 lines.
- `find_config_file`: opens the file twice and rebuilds the controller's four log lines from
  flags (§2.5) — not move-only by the note's own account.

**Behaviour-preservation risk.** C changes zero EINTR sites (research §0.2), zero `close()`/`join()`
positions (heartbeat `:295-296`, stacklight `:343-345`), zero detached lifetimes (S22), and only
the handler line in any file's string-literal multiset (S15). A moves the busy line's second half
into the .so and keeps the D-FD race (`:345-349`) in code two services now depend on.

**Testability and goldens.** Identical for A and C (D20 black-box, §7.1); §7.3's rules bind one
new TU, not five. **Research:** §0.1/§1 agree, `::signal`; §0.4 ota's `pio` still inherits
`SIG_IGN` through `kIgnore`; §3 no shared loop or follower, so no `jthread` trap; §5 no RAII.

## 4. Positioning the proposals

- **Self-pipe** (research §2a): lands in `StopSignals` — handler does `running=false; write(pipe)`
  with errno saved, plus a `stop_fd()` accessor — and in each loop that chooses to select on it,
  a per-service choice (ota's 1 s select vs heartbeat's `usleep` slices) C keeps in the mains.
- **Fail-fast exit 78** (S11): a `validate(const Config&)` in `fsw_daq_lib` after `config::load`;
  orthogonal to discovery and sockets.
- **D-FD**: a `closed` flag per `Conn`, identical in both loops. S8's sequence — golden first,
  then the fix "as its own package" — puts gap 5 and the shared accept loop *in that fix package*,
  where the self-pipe fd also joins the `select`. (D47's admission rule is scoped to collaborator
  objects; its principle — structure arrives with the fix that is its reason to exist — is what C
  applies through S8.)

## 5. Objections

**O1 — "~250 duplicated lines; every fix is doubled."** A frozen duplicate costs nothing a golden
sees; a shared one costs three gates now. The fixes that would double (D-FD, D-CTL, self-pipe) are
team packages, and S8 puts their structure in those packages, after their goldens.

**O2 — "D17(b) says one pattern for lifecycle, config, signals *and* sockets."** D17's boundary
clause and §0's five rejections are this test applied one step further; the pattern is §2.1's
skeleton, followed without shared socket code.

**O3 — "C already lost in §A."** §A gave one reason ("doubles every future fix") and predates
D49/D51 (each piece earns its cost against *doing nothing*, not against the other candidates).
Re-weighed: `serveTcpClients` does not earn three characterization packages and a sequencer-ctest
CI exposure now.

## 6. Concessions

- `serveTcpClients` passes S34 cleanly: `sequencer_main.cpp:282-349` and `controller_main.cpp:151-214`
  differ only in prefix bytes, `::` qualifiers and the capture (`&svc` vs `svc`). Right piece,
  wrong package: it belongs to the D-FD/self-pipe fix package, after gap 5 (S8).
- A shared loop makes the self-pipe `select` edit one change for two services. True — that
  package can share it.
- Gaps 5-7 are worth writing; C removes them from WP8's gate, not from the plan.
- For gap 7's author: the followers' 2 s connect back-off (`:109`, `:105`) is uninterruptible, so
  stacklight's `[0, 1.2] s` shutdown bound holds only with the db up; keep the reconnect case apart
  from any shutdown measurement.

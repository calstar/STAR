# WP8 round 1 — A (free functions): share what POSIX does, keep every setting at the call site

Position: DESIGN-WP8 as reviewed and amended (D45, D43(2)). Share the statement sequences whose
users agree observably; every per-service difference is data at the call; raw fds owned by the
caller; nothing else moves. Lines: `backend-remastered` @ b2599617 (= `main` @ 15b5a0c5).

## 1. The design

| piece (target path, `fsw_daq_lib`) | shape | pass 1 users | later | replaces |
|---|---|---|---|---|
| `service/StopSignals` — `running()`, `installStopHandlers(ShutdownNotice, line, Sigpipe)` | constant-initialised atomic; one handler, `switch` on notice | heartbeat, stacklight, config_broadcast, ota, sequencer, controller, t7_bridge | calibration (WP9), daq_bridge (WP10) | 9 flags + 9 handlers (§1.3) |
| `net/UdpSocket` — `openUdpSocket(bool)`, `ipv4Destination` | fd / bool, logs nothing | heartbeat, stacklight, config_broadcast, AbortBroadcaster | WP10 may adopt | B1 blocks (§1.5) |
| `net/TcpCommandServer` — `openTcpListener(port, backlog)` → `TcpListener{fd, failed, err}` | status struct, fd open on `kListen` | sequencer, controller, ota | — | §1.6 socket/bind/listen |
| `serveTcpClients(fd, running, {max, prefix}, on_client)` | accept loop verbatim, 10 ms select a constant | sequencer, controller | — | `sequencer_main.cpp:282-349`, `controller_main.cpp:151-214` |
| `elodin/follow_sequencer_state(host, port, running, timeout, text, on_state)` | `heartbeat_service_main.cpp:103-152` verbatim | heartbeat, stacklight | — | two `[0x50,0x00]` threads |
| `config/find_config_file`, `read_file_text` | **pass 2 only** (second open) | heartbeat, stacklight, config_broadcast, controller | — | B6 fallback blocks |

Non-negotiables, by construction: `::signal` (research §0.1: glibc `signal` = `sigaction` with
`SA_RESTART`); the call sits where today's `signal()` lines are — sequencer 241 before `svc.init`
245, controller 490 between `initialize` 462 and `start` 494, ota 406, heartbeat 228; the
`Sigpipe` column is §1.3's (ota, sequencer, t7 `kIgnore`; the rest `kDefault`); handler cases are
today's bodies statement for statement, daq_bridge's flag-then-print included; backlogs 10/4/5 are
arguments; busy bytes (`sequencer_main.cpp:325-328`, `controller_main.cpp:191-194`) and the
`size_t` 64 are the same stream inserts; every `close()` stays put (heartbeat `close(sock)` 295
**before** `join` 296; sequencer 351 after the joins; controller's listener leaked on `kListen`,
D-CTL).

## 2. Three flows through it

**SIGTERM during a blocked `recv` (sequencer).** The handler prints `\n[Sequencer] Shutting
down...` and clears `running()`. Two cases, both today's (research §0.2). Signal on the leader
(Linux's usual choice): `serveTcpClients`' `select` returns EINTR or times out within 10 ms →
loop exits → `shutdown(fd, SHUT_RDWR)` every tracked `Conn` (D-FD kept verbatim) → the client's
`recv` (`SO_RCVTIMEO` 5 s, `:205`) returns ≤ 0 → `handleClient` closes `:221` → join all → caller
`close(listen_fd)` → `[Sequencer] Stopped.`. Signal on a client thread: that `recv` fails EINTR at
once (`SO_RCVTIMEO` sockets are never restarted) → break; main's `select` times out within 10 ms.
Same end state. The heartbeat follower is the slow case: `read_exact` retries EINTR
(`TCPClient.cpp:219-221`), so it leaves within `kElodinRecvTimeoutMs`, kept in the main because
`shutdown.txt:27` cites it (`[0, 3.6] s`; stacklight `:7`). Sequencer/controller bounds do not
exist yet — gap 2 writes them before pass 1, C4-1's wedge as a frozen note.

**A 65th client on :9998.** reap → `select` → `accept` → reap again (`:318-320`) →
`conns.size() >= 64` → `send("ERR:too many connections\n", MSG_NOSIGNAL)` → `cerr << "[Sequencer] "
<< "client limit (" << 64 << ") reached — refusing connection"` → `close` → `continue`. The
controller passes `"[ControllerService] ⚠️  "` (two spaces). The 64 idle peers fall off at 5 s; a
66th is served. Gap 5 is the golden.

**Heartbeat follower reconnect.** elodin-db drops → `read_packet` returns −1 → heartbeat prints
`read_failed_prefix << last_error() << ") — reconnecting"`, stacklight (`nullptr`) nothing →
`disconnect()` → `connect` fails → 2 s → connects → `subscribe_tables` (bytes untouched inside
`ElodinClient`) → `set_recv_timeout_ms` → `connected` line → `on_state(buf[16])` resumes. Gap 7
freezes the second identical subscribe request.

## 3. Why A beats B and C

| | A | B (RAII types) | C (signals only) |
|---|---|---|---|
| clarity | mains read top to bottom in today's order; `controller_main.cpp:64` says "mirrors sequencer_main.cpp's accept loop" — A makes the mirror one function | ownership in the type, but close/join/shutdown order moves into destructors | nine mains keep ~250 duplicated lines |
| lines deleted (DESIGN §A) | ~330 gross, ~130 net | similar; `reset()` calls give back ~20 | ~55 |
| behaviour risk | none by construction: the shared code *is* the replaced statements | identical only where `close` is already at scope end (research §5); heartbeat 295-296, the lifecycle-watched listener and D-CTL's leak need `reset()`/bypass — RAII in name only | zero |
| testability / goldens | black-box unchanged; no harness edit (§7.3) | a destructor at a new point moves output the `#include`d-main harness captures | unchanged |

C is the floor and A's named fallback if a pass-1 gap cannot close. Conceded: B's single-site
clarity is real, and `UniqueFd` at `AbortBroadcaster::sendPacket` (`:80-125`, one exit) is
byte-identical — one WP8 user, so S34 says no.

## 4. Four improvements, evidence-backed

1. **Step 16: the file-static wrapper, not `std::thread(follow_sequencer_state, …)`.**
   `std::thread` decay-copies its arguments and `std::atomic<bool>` is non-copyable; the wrapper
   keeps lines 271/295 byte-identical and the three literals beside their tag (S16).
2. **`TcpCommandServer.hpp` "Must not know" adds `fsw::service`.** It is why `running` is a
   parameter; without it S34's "same value → constant" invites a later reviewer to inline
   `fsw::service::running()` and couple `net` to `service`. Same for the follower.
3. **The sequencer's comment 282-283** (threads tracked so `svc` outlives them) stays at the call
   site; the TU carries only the mechanism comment (S38).
4. **Header doc:** `line` is `nullptr` iff `kSilent`.

## 5. Positioning the team's proposals (none made now)

- **Self-pipe (research §2a):** one install site for the handler body; the pipe fd goes into
  *two* loops (`serveTcpClients`, `follow_sequencer_state`) instead of four mains. Honest cost: the
  follower's wake needs `ElodinClient` to expose an fd.
- **Fail-fast config, exit 78 (S11, S13):** `find_config_file` returns `found/fell_back`, the
  caller decides; a validator slots into the skeleton's "locate and load config" step. WP8 never
  touches `config::load` (C2-4, C2-12 frozen).
- **D-FD:** whatever shape the team picks (skip-on-`done`, or the `Conn` owning the close), it
  lands once in `serveTcpClients` for both users.
- **SIGPIPE:** one enum flip per row of §2.1; gap 1 goes red per service.

## 6. Three objections

**O1 (C): `serveTcpClients` with `std::function` and an options struct is an abstraction with two
users, and S34 says two is not enough.** D43(3) rules: a shared behaviour needs ≥ 2 users *that
agree observably*. These two agree in every statement; the differences are prefix bytes and a
backlog outside the call. The §0 rejections (`SubscriberLoop`, a shared parser) failed that test;
this passes it. Two copies double every future edit to the cap, the busy reply and D-FD.

**O2 (B): raw fds are leak-prone and D-FD is an ownership bug RAII would prevent.** Close points
are observable (§3), and a `UniqueFd` inside `Conn` would move the close from `handleClient` `:221`
to the reaper — a fix to a parked defect, not a refactor (D17).

**O3 (cost): pass 1 waits on gaps C never needs.** C shares the `StopSignals` TU, so gaps 1-3
(SIGPIPE, SIGTERM exit, shutdown lines) gate C too. A's marginal cost is three tests — a 65th
client, a pre-bound control port, a follower reconnect — each a contract surface uncharacterized
*today* that WP10 inherits whether or not WP8 ships. A makes closing them mandatory now.

Concession on the handler: the `switch` is equivalent, not literally identical. Per-service handler
pointers would be more literal; rejected because the §2.1 table — one row per service — is where
the contract is read and where gap 1's mutation lands.

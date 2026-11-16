# WP8 round 1 — B (RAII types): one `UniqueFd`, `reset()` at today's close lines

Position: keep every shape in DESIGN-WP8 §2 (functions, per-service settings, `::signal`,
`serveTcpClients` borrowing an `int`) and change one thing — **an fd whose lifetime is a scope is
held by an owner type, not an `int`** (STYLE-S21). Where today's `close()` precedes something
else, it stays on that line as `reset()`. Lines: `backend-remastered` @ 85a02f9a.

Conceded up front: **no thread-owning objects** (`TcpCommandServer`, `SequencerStateFollower`) —
the controller's control thread (`controller_main.cpp:500-501`) and ota's clients
(`ota_service_main.cpp:451-453`) are detached by design, so S21's "lifetime is a scope" fails for
threads; a joining destructor is the research §3 trap. **No `SignalGuard`/`StopFlag`** —
`::signal` restores nothing; §2.1 stands verbatim. **No `UdpSocket` class** — config_broadcast
fills `dest` per packet (`:554-558`). **No `jthread`.**

## 1. What is shared

| piece | shape | home | pass |
|---|---|---|---|
| `UniqueFd` | header-only, move-only; `constexpr UniqueFd()` (fd −1, S26), `explicit UniqueFd(int)`, destructor closes if ≥ 0, `get()`, `reset()`, `release()`, `explicit operator bool`. No implicit `operator int` (Android's needs a `close()` poison macro). No identifier `main` (§7.3) | `lib/include/net/UniqueFd.hpp`, `fsw::net` (camelCase dir, S1) | 1 |
| `openUdpSocket(bool) -> UniqueFd` | §2.2 otherwise unchanged | as A | 1 |
| `TcpListener{UniqueFd fd; Failed; int err}` | §2.3; the callee closes nothing — the fd comes back open on `kBind` and `kListen`; the caller's `return` closes it *after* its log line, as today. A's stub closes on `kBind` inside the callee, before `bind() failed` prints (sequencer `:267-268`, ota `:425-426`, controller `:142-144`) | as A | 1 |
| `serveTcpClients(int, …)`, `follow_sequencer_state`, `StopSignals`, `ConfigFile` | exactly A | as A | as A |

## 2. Every close site in WP8's files

The behaviour-preservation argument is this table. "Pure" = nothing stands between today's
`close()` and the scope exit: the destructor fires at the same instant.

| site | today | B |
|---|---|---|
| heartbeat `:249`, `:261` | `close(sock); return 1;` | pure (`return 1;`) |
| heartbeat `:295` | close, then `elodin_thread.join()` `:296` | **`sock.reset();`** on `:295` |
| stacklight `:280` | close + `return 1` | pure |
| stacklight `:343` | close, then join `:344-345` | **`reset()`** |
| config_broadcast `:523` | close + `return 1` | pure |
| config_broadcast `:604` | close, then `Stopped.` `:605` | **`reset()`** |
| sequencer `:268` (bind), `:274` (listen) | log, close, `return 1` | pure; on `:268` B keeps log-then-close where A's callee-close inverts it |
| sequencer `:351` | close, then `Stopped.` `:352` | **`reset()`** |
| ota `:426`, `:432` | close + `return 1` | pure |
| ota `:456` | close, then `Stopped.` | **`reset()`** |
| controller `:144` | `::close; return;` | pure |
| controller `:216` | `::close(listen_fd); }` | pure — the closing brace |
| AbortBroadcaster `:125` | close, then the `Sent … broadcast` cout `:127-133` | **`reset()`** — research §5 calls this "yes identical"; under D5's letter it is not: the summary line follows the close |
| ActuatorCommander `:363`, `:388` (WP10's file) | close + return | pure |

Destructor at a new instant: **zero paths.** Six `reset()` lines, each on today's close line. No
golden observes an fd close instant (`shutdown.txt` sees only `command port still accepting:
False` after exit): the resets serve D5's letter; the area stays uncovered, named as gap 6 names
`socket()`/`listen()`. `Conn::fd` stays `int` in pass 1 — the handler closes it
(`sequencer_main.cpp:221`, `controller_main.cpp:124`; D-FD frozen).

Cost: ~10 `close()` lines gone, 6 `reset()` added, ~15 `.get()` tokens, +~35-line header. Lines
deleted: net ≈ 0 — conceded.

## 3. The three flows (identical to A; the B-specific line follows each)

**SIGTERM during a blocked `recv`.** Handler per §2.1 prints, clears `running()`. The client
thread sits in `recv` under `SO_RCVTIMEO` 5 s; the signal lands on the leader on Linux, `select`
returns EINTR (or its 10 ms timeout), the loop ends, `shutdown(c->fd, SHUT_RDWR)` for all, join
all (`:345-349`) — `Conn::fd` an `int`, D-FD intact. Then `listen_fd.reset()` on `:351`,
`Stopped.`, `return 0`. ota: 1 s select, `reset()` on `:456`; detached clients keep raw `int`s
(D-OTA2 frozen).

**65th client.** Inside `serveTcpClients`, moved verbatim: reap, `accept`, reap, `conns.size()
>= 64` → `ERR:too many connections\n` with `MSG_NOSIGNAL`, busy cerr line, `close(client_fd)`,
`continue` (`:322-331`). B touches none of it; `accept` runs on `l.fd.get()`.

**Heartbeat follower reconnect.** `follow_sequencer_state` owns an `ElodinClient` on its stack —
A already relies on RAII here. Read fails → cerr → `client.disconnect()` (`:135-137`: today's
`reset()` at today's position) → `connect` → the second identical subscribe `len=6 ty=0
id=[0x11,0x0d] 50 00` (gap 7) → `set_recv_timeout_ms(3000)` → connected line. B changes nothing.

## 4. Why B beats A and C

**Clarity.** A's ownership lives in comments: the `TcpCommandServer` stub needs a paragraph for
"callee closes on socket/bind failure, caller owns otherwise, fd returned OPEN on kListen"; the
`UdpSocket` stub says "Owns: nothing … the caller owns it". In B the struct owns it on every path
and `grep UniqueFd` lists every owner. The mains still read top to bottom in §1.2's order.

**The codebase already does this at the class level.** S21's own "good" examples are
owner-with-explicit-close-plus-destructor-backstop: `ElodinClient.cpp:14` (`~ElodinClient` →
`disconnect()`; both followers also call `disconnect()` explicitly), `TCPClient::disconnect`
`:76-83` + `~TCPClient` `:20-22`, `ControllerService::~ControllerService` `:74-78`. A puts raw
`int`s in seven mains and the pattern in prose. S21's escape clause should read: "keep the
explicit close where it is — as `reset()` on the owner; helpers return the owner".

**Risk and goldens.** A's, plus one item: a missing `reset()` moves a close past a log line or a
join, which no golden sees; §2's table is the gate — six lines. Gaps: §7.2 as A (1-3, 5-7 before
pass 1). The config harness (`char_config_services.cpp` `#include`s the stacklight and
config_broadcast mains) is untouched: `UniqueFd` has no statics, prints nothing, needs no
`_CFG_INCLUDES` edit.

**Testability.** Black-box as A (D20), plus WP8's one pure unit: a 20-line ctest (move leaves
−1, `release()` does not close, two `reset()`s close once; `fcntl(F_GETFD)` checks).

**C** is the floor; it keeps two accept loops and two followers duplicated (A's §A, accepted).

## 5. Later fixes (none made now)

| proposal | B's effect |
|---|---|
| D-FD | positive: the fix is "the owner closes at reap" — `Conn{UniqueFd fd}`, handler borrows `get()`, shutdown only while owned. FIN shifts ≤ 10 ms, so team-approved |
| D-CTL | positive: when `kListen` becomes log-and-return, the `return` closes by construction; open-on-kListen is the struct's default |
| stop_callback → `shutdown(fd)` on followers (research §3) | `UniqueFd socket_fd_` in `TCPClient` exposes `get()`; not WP8's file |
| self-pipe (research §2a) | neutral: the handler reads a plain `int` global |
| exit 78 (S11) | neutral: validation precedes any socket |
| D-FORK | neutral: `posix_spawn` file actions replace the pipe closes; `:248` stays an explicit `reset()` |

## 6. Objections

1. **S34/D17(d): a type for a one-line saving.** Seven owners in WP8's files (§2), four more
   later (`ActuatorCommander::sendBatch`, `ControllerService::udp_socket_fd_`,
   `TCPClient::socket_fd_`, `BackendLogForwarder`), all agreeing observably: one close, at a
   named line or scope exit. A itself mints `TcpListener` and `TcpServeOptions`.
2. **"`reset()` is RAII in name only."** It still deletes nine early-return closes and the
   callee-closes contract, and it is the shape of S21's good examples:
   `ElodinClient::disconnect()` *is* `reset()`.
3. **"A destructor at a different point moves an observable."** §2: zero paths, six resets, one
   review item; no golden observes the area.

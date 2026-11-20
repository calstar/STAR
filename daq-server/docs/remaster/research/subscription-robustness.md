# Research: subscription robustness (D-SUB, D-SLOT)

Scope: why an Elodin subscription can be accepted and deliver nothing forever, what comparable
systems do about it, and which remaster structure makes a later fix cheap. **Every fix below
that changes wire traffic, logs an operator sees, or retry behaviour is a PROPOSAL for the
team, not a remaster change** (AGENT-RULES 4 and 6). Paths are relative to `daq-server/`
unless they start with `elodin/` (= github.com/elodin-sys/elodin at tag `v0.16.1`, commit
`ddb87b6a`, the version pinned in AGENT-RULES; source read locally from a shallow clone).

## 0. What elodin-db 0.16.1 actually does (the spine)

1. **A subscription binds to components, not to a packet id.** `VTableStream { id }` looks up
   the vtable registered for `id` *at that moment*, clones it and spawns a stream task
   (`elodin/libs/db/src/lib.rs:2205-2216`). The task resolves every field to a concrete
   `Component` via `get_component(component_id)` and parks a `RealTimeStage { component }` on it
   (`elodin/libs/db/src/vtable_stream.rs:52-60`). Rows go out only when *every* field has been
   written since the last row (`wait_ready` → `filled_fields.all_set()`, `vtable_stream.rs:217-222`).
2. **Re-registration is last-wins and notifies nobody.** `insert_vtable` overwrites
   `vtable_registry.map[id]` (`lib.rs:857`) and bumps `vtable_gen` (`lib.rs:855`); the only
   reader of `vtable_gen` is the replication follower (`follow_stream.rs:66-67`, which re-sends
   vtables when it changes). Live TCP stream tasks keep the components they resolved.
3. **There is no unsubscribe.** The stream task ends only when a `tx.send` fails
   (`vtable_stream.rs:170-176`). A task parked on a component nobody writes never sends, so it
   never notices even a closed socket: it leaks until the DB restarts.
4. **TCP `VTableStream` has no idempotency guard; `UdpVTableStream` does**
   (`lib.rs:2228-2230`: `if state.udp_vtable_streams.contains(&(addr, id)) return Ok(())`).
   Hence C6-2: each duplicate TCP subscribe is one more task and one more copy of every row.
5. **Accepted ≠ streaming.** The handler replies `ErrorResponse` only when the id is not
   registered (`ok_or(Error::InvalidMsgId)`, `lib.rs:2209`). Everything after the spawn fails
   silently: `ComponentNotFound`, schema/len mismatch (`vtable_stream.rs:57-60,140-157`) end
   the spawned task, whose `JoinHandle` is dropped (`elodin/libs/stellarator/src/lib.rs:214-220`).
6. **But the DB does acknowledge what it granted.** Before streaming, the task sends the bound
   `VTableMsg { id, vtable }` back to the subscriber with the subscription's request id
   (`vtable_stream.rs:160-168`). That vtable carries the component ids the stream is attached
   to. Under the blanket `Msg` impl (`elodin/libs/impeller2/src/types.rs:588-590`) its msg id is
   the FNV-16 of `"VTableMsg"`; the backend's own `computeMsgId` gives `[0x47, 0xB7]` (computed,
   not yet captured on the wire). `ElodinClient` drops it: it is `ty=MSG` and 0x47 is not in
   `isLikelyDataPacket` (`diablo_server/backend/src/elodin-client.ts:187-203,283-289`).

**D-SUB, stated with those facts.** With board 60 in slot 10, `(10-1)*0x20+0x10+1` wraps to
`0x31` in a `uint8_t` (`diablo_server/lib/src/elodin/DatabaseConfig.cpp:371`; raw at `:272`),
so `PT10_Cal.CH1` and `PT2_Cal.CH1` are both registered at `[0x20,0x31]`; `Config.cpp:49-53`
only logs. The registrar writes PT10 then PT2 (last-wins). A backend subscribe landing between
the two binds to PT10's components. daq_bridge/calibration publish rows by packet id, the DB
decodes them with the *current* vtable and writes PT2's components, PT10's are never written
again, and the early stream waits forever. The DB returned no error, so
`noteSubscriptionRejected` (`elodin-vtable-registry.ts:136`) never fires; the pair stays in
`subscribedVTableStreamPairs` and is skipped by every later pass (`:391`). The window exists
only when a re-registration *changes content*: re-registering byte-identical vtables resolves
to the same component ids and is harmless. Registrars: daq_bridge at
`daq_bridge/daq_bridge_main.cpp:578,584` and again on reconnect `:759,762`; calibration at
`services/calibration/calibration_main.cpp:1484`.

Not applicable: InfluxDB line protocol and QuestDB ILP are write-only ingestion with no
server-push subscription, so they offer no liveness model to borrow
(https://docs.influxdata.com/influxdb/v2/reference/syntax/line-protocol/,
https://questdb.com/docs/reference/api/ilp/overview/).

---

## Idea 1 — Identity, not name: make the table-id map injective and fail closed (D-SLOT)

**Source.** Kafka KIP-516 gives every topic a 128-bit id because a topic deleted and recreated
under the same name could be "confused with a previous topic with that name"; the protocol
then validates against ids rather than names
(https://cwiki.apache.org/confluence/display/KAFKA/KIP-516%3A+Topic+Identifiers). Our packet id
plays the name; the DB-side component set plays the identity, and we let two entities share a
name.

**Maps onto.** The id is computed in three languages: C++ `DatabaseConfig.cpp:272,371`
(`uint8_t lo = (board_number-1)*0x20 + …`), the backend's `((n-1)%8)+1` fold
(`elodin-vtable-registry.ts:249`, `sensor-config.ts:59,116`, `api-server.ts:97`), and the
frontend copy. `Config.cpp:40-55` already *detects* both collisions (same slot, slot > 8) and
only `cerr`s. Two registrars for calibrated tables double the chance that the two writes of one
id differ.

**Proposal (behaviour change).** (a) Reject the config: slot > 8 or a duplicate slot exits
non-zero (as H2 now does in the harness by failing on `[Config] ERROR`). (b) Before sending any
`VTableMsg`, the registrar builds the full `{packet id → entity}` map and refuses to start if it
is not injective. (c) One registrar per table family, or a check that both registrars emit
byte-identical `VTableMsg` bytes for every shared id. Cost: small C++; changes startup
behaviour of a misconfigured stand (C2-4 class), so it is the team's call.

**Inside the remaster (behaviour-preserving).** WP5's single `boardSlot()` helper and WP3's
per-family split of `DatabaseConfig.cpp` should expose one *pure* `tableIdFor(family, slot, ch,
calibrated) -> std::optional<std::pair<uint8_t,uint8_t>>` used by both `register_tables` and
`register_calibrated_tables`, with the current wrap reproduced exactly (the optional is always
engaged today). WP10's `registerAllTables()` is then the one call site where (b) lands later. *(Superseded: WP10 keeps the two registration sites separate, LEDGER D49(10); a later D-SLOT fix puts its check in `table_id_for`/DatabaseConfig.)*
A characterization *test* (not a golden edit) can enumerate the shipped profiles
(`test/characterization/config/golden/cpp/config/profiles__*.toml.txt` already print
`boards[i].slot()`) and assert the id map is injective — it documents D-SLOT without changing
it, and goes red on `config_base` + board 60 as a mutation check.

## Idea 2 — Check what was granted, not just that nothing was refused (D-SUB detector)

**Source.** MQTT 5 answers every SUBSCRIBE with a SUBACK carrying one reason code per topic
filter: below 0x80 is "granted QoS n", 0x80+ is a failure
(OASIS MQTT 5.0 §3.9.3, https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901178).
The client learns per subscription what it was given. elodin-db has the same thing in a
different shape: the echoed `VTableMsg` (§0.6).

**Maps onto.** Today the backend's only per-subscription signal is the negative one
(`dbError` → `noteSubscriptionRejected`, `elodin-client.ts:268-277`, `server.ts:1614-1620`),
bracketed by the GetEarliestTimestamp fence (`elodin-client.ts:262-266,371-395`). A
subscription that is accepted then binds wrongly (D-SUB) or dies in the spawned task (§0.5)
is indistinguishable from a healthy, quiet one. The echo distinguishes all three:

| after the fence + grace | meaning |
|---|---|
| `ErrorResponse` for the req id | refused (handled today) |
| no `VTableMsg` echo for that packet id | accepted, task died (ComponentNotFound / schema) |
| echo whose field component ids ≠ the ids for the entity the config names (e.g. `PT2_Cal.CH1.*`) | **D-SUB: bound to a stale registration** |
| echo matching config | healthy (may still be quiet) |

The echo is attributable by its `id` field, so the 1-byte req-id space (`:60-74`) is not a
problem. Component ids are `fnv1a64(name) & !(1<<63)` (`impeller2/src/types.rs:40-44`) and the C++
registrar names them `<entity>.<field>`, e.g. `PT2_Cal.CH1.pressure_psi`
(`DatabaseConfig.cpp:106-110`), so the expected ids are computable from config alone. A cheaper, parse-free variant: one `DumpMetadata` after a pass
(`lib.rs:1759-1775`) lists component metadata by name; the mere existence of a `PT10_Cal.*`
component on a config with no board 10 is the collision signal.

**Proposal.** Parse the echo (needs a postcard VTable decoder in TS — the old encoder was
deleted precisely because it never matched this DB, `elodin-vtable-registry.ts:37-43`, so a
decoder must be tested against captured bytes) and on a stale binding take the Idea 3 remedy.
Also the C++ side: `PressureFeed` sends req id 0 and reads no replies
(`services/sequencer/PressureFeed.cpp:17-30`) while calibration has `SubscriptionTracker`
(`calibration_main.cpp:1512-1520,1582-1594`); neither sees the echo.

**Inside the remaster.** WP6's `server/elodin-link.ts` should own one internal seam — e.g.
`ElodinClient` emitting a `control` event for `ty=MSG` packets it currently drops — with no
listener attached. That is invisible on every contract surface, but check that
`__tests__/elodin-protocol.test.ts` does not assert non-emission first, and keep the
`isLikelyDataPacket` filter and the fence/ErrorResponse branches byte-identical in order.

## Idea 3 — Recreate, don't re-send: the only duplicate-free remedy is a new connection

**Source.** NATS JetStream ordered consumers track each delivery's stream sequence; when a gap
appears or "its heartbeats stop because it was deleted, lost on a reconnect, or dropped in a node
restart — the library throws the old consumer away and creates a fresh one", starting at the next
expected sequence (https://docs.nats.io/learn/jetstream/ordered-consumer). The heartbeat is the
consumer config's `idle_heartbeat` (NATS ADR-9,
https://github.com/nats-io/nats-server/blob/main/doc/adr/0009-js-idle-heartbeat.md).

**Maps onto.** "Throw the old one away" has no per-subscription form in elodin-db 0.16.1 (§0.3).
Re-sending a pair on the same connection is safe **only** when the existing task is provably
dead: refused (handled), died after accept, or bound to components nobody will write (D-SUB).
In those cases the new subscribe binds to the current vtable and the old task stays silent — no
doubling. Re-sending a pair whose task is merely quiet doubles it permanently (C6-2,
`test/test_duplicate_subscription.ts`: ~2× and 5×). For a pair we cannot classify, the only
clean remedy is the whole-connection one the backend already has: `clearSubscriptionState()` +
`client.disconnect()` (`elodin-vtable-registry.ts:113-123,464-468`), i.e. the NATS "fresh
consumer" at connection granularity. A make-before-break variant (open a second `ElodinClient`,
run passes to completion, swap, close the old) avoids the GUI gap; the registry's
`subscriptionGeneration` (`:77,114`) is already the generation guard such a swap needs.

**Hazard found while reading.** `PressureFeed::runLoop` re-subscribes every 1 s every table
that has produced nothing (`PressureFeed.cpp:118-146`) on the stated premise "a table that has
delivered nothing cannot be duplicated". That is false for an *accepted, quiet* table: a
calibrated PT whose board is registered but not yet writing gets one more stream task per
second, and when it starts writing PressureFeed receives N copies per row. This also happens
to *heal* D-SUB for PressureFeed. Suspected, unproven: reproduce with the stand-in DB (register,
subscribe ×N with no writes, then write once, count rows). If confirmed it goes to Defects,
not into a WP.

**Cost.** Reconnect: one pass is ≤254 subscriptions per fenced batch
(`SUBSCRIPTION_REQ_ID_SPACE`, `:76`), ~18 batches for the 4485-pair list, plus a data gap on the
GUI unless make-before-break. Leaked dead tasks in the DB remain until it restarts (harmless,
but unbounded under a flapping remedy — rate-limit it).

**Inside the remaster.** Nothing to change; WP6 must keep `onElodinDisconnected` calling
`clearSubscriptionState()` before the next connect, and keep the generation check in
`registerVTables` (`:363-369`) — it is what a later make-before-break relies on.

## Idea 4 — Per-subscription liveness with an independent "is it being written" signal

**Source.** gRPC keepalive is explicitly connection-only: "keepalive is only about the
*connection*", service health is separate (https://grpc.io/docs/guides/keepalive/). Kafka KIP-62
split the consumer's session heartbeat from a separate processing timeout
(`max.poll.interval.ms`) because one signal conflated them
(https://cwiki.apache.org/confluence/display/KAFKA/KIP-62%3A+Allow+consumer+to+send+heartbeats+from+a+background+thread).
Prometheus marks a series stale when a scrape stops returning it, and the standard alert pairs
`absent_over_time(metric)` with `up == 1` so "source alive, series missing" is told apart from
"source down" (https://prometheus.io/docs/prometheus/latest/querying/basics/#staleness,
https://grafana.com/docs/grafana/latest/alerting/guides/missing-data/).

**Maps onto.** Our only data-liveness signal is global: `dataFresh = now - lastIngestMs <
3000` (`server.ts:738,1549,1775`). One dead channel among 100 never flips it, which is why D-SUB
is invisible on the GUI. `deliveredPairs` (`elodin-vtable-registry.ts:87,108`) is half of a
per-pair model: it records *that* a pair delivered, not *when*. The `up == 1` half exists too:
for a calibrated channel, its raw sibling (`[0x20,0x21]` for `[0x20,0x31]`) delivering while the
calibrated pair has delivered nothing since subscribe is strong evidence of a dead stream
(D41's signature: PT2.CH1 raw present, PT2_Cal.CH1 absent). For families with no sibling the
independent signal is the DB itself: `GetTimeSeries` on the component (`impeller2/wkt` msgs
`GetTimeSeries`) shows whether it is being written while our stream is silent.

**Caveat (must be in any proposal).** "No packet for T" is not "dead" for sparse families —
heartbeats `[0x10,*]`, self-test `0x60-0x6F`, `_SEQUENCER_STATE` `[0x50,0x00]` — and a wrong
"dead" verdict followed by a re-send creates a live duplicate that only a reconnect removes
(Idea 3). So: per-family expected period, verdict only with a positive sibling/DB signal, remedy
by Idea 2 classification or reconnect, never a blind re-send.

**Proposal.** Per-pair `lastDeliveredMs`, a per-family staleness rule, and a "channel X has not
delivered since subscribe while its raw/DB counterpart has" notification. Observable (new
notification/status field), so team's call.

**Inside the remaster.** WP6's `server/ingest.ts` should call one registry function per row
(today `notePairDelivered(high, low)`, `server.ts:1642`) before any family dispatch — keep it
the first statement of `handleElodinPacket`. Then turning the `Set` into a `Map<key, ms>` later
is a one-file change. Do not scatter delivery bookkeeping into `board-status.ts` etc.

## Idea 5 — Make the subscription decision a pure function of observed state

**Source.** Same as Ideas 2–4: every system above reduces "should I (re)subscribe X now?" to a
function of (granted?, refused?, last delivery, generation). Kubernetes-style level-triggered
reconciliation is the general form: compare desired vs observed each pass, act on the
difference (https://kubernetes.io/docs/concepts/architecture/controller/).

**Maps onto.** `subscribeVTables` already computes `due` from (subscribed, parked, rejected
backoff, now) inline (`elodin-vtable-registry.ts:383-401`) and mixes it with I/O, logging and
the fence. Desired = `buildVTableStreamSubscriptionList(cfg)`; observed = the module-level sets.

**Inside the remaster (adoptable, behaviour-preserving).** In WP5/WP6, extract
`duePairs(desired, state, now): {due, skipped}` as a pure function with the current three
clauses, covered by the existing `__tests__/vtable-subscriptions.test.ts`,
`subscription-fence.test.ts`, `elodin-reconnect.test.ts` unchanged. A later fix then adds one
clause (`stale-bound` from Idea 2, `dead` from Idea 4) and one unit test, instead of another
edit to the 120-line I/O function. Mutation check for the extraction: swap the
`subscribedVTableStreamPairs.has` clause off and confirm `vtable-subscriptions.test.ts` goes red.

---

## Goldens and tests these ideas touch

- `test/characterization/pipeline` (D35 `boards` session, PT2.CH1 miss; board 60 frozen in the
  fixture, see D41) — Idea 1(a) changes it; Ideas 2–5 seams must not.
- `test/characterization/lifecycle` startup ordering — Idea 3's make-before-break would add a
  second DB connection; any such change is a contract discussion.
- `test/characterization/config/golden/cpp/config/*` — read-only input for the Idea 1 injectivity test.
- Backend vitest: `vtable-subscriptions`, `subscription-fence`, `elodin-reconnect`,
  `elodin-protocol` — must stay green and unedited through WP5/WP6.
- `test/test_integration.sh` Sensor Info check `[HPT] … PT2_Cal.CH1` (D41) — the live symptom.
- `test/test_duplicate_subscription.ts` (WP4 deletes it as unreferenced): it is the only C6-2
  reproducer and the natural harness for the PressureFeed hypothesis — suggest PARK, not delete.

## Questions for the debate advocates

1. With H2 freeing slot 10 in the harness, is D-SUB still reachable on the stand? Only if some
   registration changes content for an existing id: a config edit + service restart while the
   backend stays connected, or daq_bridge and calibration_service disagreeing on a calibrated
   vtable. Has anyone diffed their `VTableMsg` bytes for a shared id?
2. Should a misconfigured slot be fail-closed (exit) or fail-loud (run, but the GUI shows a
   blocking notification)? Fail-closed contradicts C2-4's "start on defaults" culture; fail-loud
   still lets a pressure channel be stolen during a test.
3. Is a reconnect (GUI gap of a few hundred ms) an acceptable remedy during Fire, or must any
   remedy be make-before-break or deferred until a non-dynamic state?
4. Is parsing the echoed `VTableMsg` in TS worth a postcard decoder that the team has already
   once gotten wrong, versus the coarse `DumpMetadata` name check?
5. Does WP4 deleting `test_duplicate_subscription.ts` lose the only C6-2 reproducer?
6. Should the PressureFeed duplicate hypothesis be tested before WP10 moves the sequencer into
   TUs, so the move is not blamed for a pre-existing multiplication?
7. Upstream: would elodin accept TCP `VTableStream` idempotency (as `UdpVTableStream` has) and
   re-binding streams on `vtable_gen` change? Either removes D-SUB at the source; is a fork or
   a version bump in scope for this team at all?

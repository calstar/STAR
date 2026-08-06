# Future improvement: lossless live ingestion from Elodin DB

**Status: proposed, not implemented.** Decided 2026-07-17 to document and defer.

## Problem

Elodin DB's real-time subscriber streams (`VTableStream`, `Stream` with
`RealTime` behavior) are **latest-value-at-wake, not lossless** — verified in
elodin-db source (`libs/db/src/vtable_stream.rs`, `RealTimeStage::next` calls
`time_series.latest()` on each wake). When boards batch chunks
(`SENSOR_MAX_CHUNKS_BEFORE_SEND` > 1), each UDP packet writes N rows per
channel back-to-back and the DB forwards ~1–2 of them; the rest are coalesced
away *from the live stream only*.

Measured in the integration gauntlet (3 chunks/packet, 20 ms jitter), sim sent
vs backend ingested:

| group | delivery |
|-------|----------|
| pt1   | 77% |
| pt2   | 64% |
| tc    | 71% |
| rtd   | 71% |
| lc    | 66% |
| act   | 78% |
| enc (50 Hz) | 55% |

What is **not** at risk:

- **DB storage** — append-only per component (`time_series.rs push_buf`);
  every row is retained and queryable (`GetTimeSeries`, SQL/Arrow). Post-run
  data is complete.
- **Controller** — latest-value at wake is the correct semantics for a
  feedback loop (freshest sample, no stale queue).
- **Plot continuity** — at least one row per channel per packet survives
  (asserted by integration Test 15 in `ws_data_flow_test.ts`).

What **is** lost: live-GUI spike capture between chunk boundaries. The
min/max envelope can only see rows that reach the backend, so a transient
confined to a coalesced-away chunk row never reaches a live plot (it is still
in the DB for post-run analysis). `chunks=1` firmware config eliminates this
but floods the network — that trade-off is why chunking exists.

## Proposed fix: migrate backend sensor ingestion to FollowStream

elodin-db ships a second, lossless streaming protocol used for DB→DB
replication: **`FollowStream`** (`libs/db/src/follow_stream.rs`). It streams
contiguous `get_range` chunks from per-component server-side cursors — every
stored sample, batched into ~1500-byte TCP writes.

Wire facts (verified against elodin source at workspace version 0.17.4-alpha):

- **Initiate**: single MSG packet, fixed id `[224, 37]`, postcard-encoded body
  `{ target_packet_size: u32 }` (default 1500). No auth/handshake — any TCP
  client may send it.
- **No filtering, full backfill**: there is no component filter and no
  client-supplied start cursor. The server streams *everything* (all
  components + message logs + metadata) from the beginning of each log.
  Client must filter, and must dedupe by per-component high-water timestamp
  after reconnect (server restarts from scratch per connection).
- **New parsing required**: data arrives as `PacketTy::TimeSeries` (=2)
  packets — `[count:u64][timestamps…][samples…]` columnar chunks referencing
  per-component VTables announced at stream start — **not** the TABLE packets
  our `elodin-client.ts` parses today. Outer length-delimited framing is
  unchanged.
- **Dedicated connection**: after `FollowStream`, the connection stops
  serving normal requests. The backend would keep its existing connection for
  commands/subscriptions and open a second one for the follow stream.
- **Version gate**: `--follow` landed in elodin-db **v0.16.1** (the version
  CI pins), but the protocol evolved through 0.17.x. Before implementing,
  probe the deployed binary (unknown msg IDs return ErrorResponse, so sending
  `[224,37]` is a safe capability check) and pin a version.

### Sketch

1. New `elodin-follow-client.ts`: second TCP connection, sends `FollowStream`,
   parses `TimeSeries` chunks + `VTableMsg` id→component mapping, keeps
   per-component high-water timestamps, emits the same parsed-update events
   `server.ts` consumes today.
2. `server.ts` feeds envelope/history from the follow stream for sensor
   streams; VTableStream can remain for event streams or be dropped.
3. Full-backfill cost on connect grows with DB size (it replays the whole
   log): fine for cold start (history warm-up for the GUI), but reconnect
   mid-run replays everything — dedupe makes it correct, bandwidth makes it
   local-only. Consider `target_packet_size` tuning.
4. Test 15 then tightens from "≥95% of packets × channels" back to
   "≥95% of all samples sent" — the gauntlet becomes a strict end-to-end
   conservation proof.

## Alternatives considered

- **Cursor polling (`GetTimeSeries` ranges)** — backend polls rows since a
  cursor each plot period. Workable (skeleton in `elodin-query.ts`), but
  permanent client-side cursor/boundary edge cases and a standing request
  loop; FollowStream does the same job push-based with the DB owning the
  cursor.
- **Bridge-side extremes sidecar** — bridge sees every chunk; publish
  per-packet min/max to dedicated `.spike_min`/`.spike_max` components (one
  write each per packet → immune to coalescing). No DB/protocol work, but adds
  schema + GUI wiring. Fallback if FollowStream versioning proves painful.
- **Firmware adaptive flush** — flush the chunk batch early when a sample
  deviates past a threshold. Best network/latency trade-off, but firmware
  scope.
- **chunks=1** — already tried; floods the network. Rejected.
- **Fork elodin-db** to make VTableStream lossless — rejected; FollowStream
  already exists, a fork is a permanent maintenance tax.

## References

- `docs/adding-sensor-streams.md` — "VTableStream is NOT lossless" note.
- Integration Test 15 (`test/ws_data_flow_test.ts`) — current invariant +
  per-group delivery table printed every run.
- elodin-db source: `libs/db/src/vtable_stream.rs` (coalescing),
  `libs/db/src/follow_stream.rs` (lossless protocol),
  `libs/db/src/time_series.rs` (append-only storage).

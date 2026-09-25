# Adding a New Sensor Stream (Thin Backend)

How to add a new sensor type so data flows from hardware to the frontend GUI.

## Architecture Overview

```
Hardware Board (ESP32)
  → UDP packets
  → DAQ Bridge (C++)
  → Elodin DB (stores as VTable entries)
  → Elodin Relay (Node.js, WebSocket bridge)
  → server.ts (parses, throttles, broadcasts)
  → Frontend (WebSocket → DataCache → TimeSeriesPlot)
```

Each sensor type gets a **VTable ID** — a two-byte tuple `[high, low]` that uniquely identifies the data stream in Elodin. The relay must **subscribe** to each VTable ID it wants to receive.

## Current VTable ID Map

| High | Low Range | Type | Component | Layout |
|------|-----------|------|-----------|--------|
| `0x10` | `0x01-0x40` | Board heartbeats | - | Custom |
| `0x20` | `0x01-0x0E` | PT raw | `raw_adc_counts` | 21 bytes |
| `0x20` | `0x11-0x1E` | PT calibrated | `pressure_psi` | 21 bytes |
| `0x21` | `0x01-0x20` | TC raw | `raw_adc_counts` | 21 bytes |
| `0x21` | `0x11-0x24` | TC calibrated | `temperature_c` | 21 bytes |
| `0x22` | `0x01-0x04` | RTD raw | `raw_resistance` | 21 bytes |
| `0x22` | `0x11-0x14` | RTD calibrated | `temperature_c` | 21 bytes |
| `0x23` | `0x01-0x14` | LC raw | `raw_adc_counts` | 21 bytes |
| `0x23` | `0x11-0x24` | LC calibrated | `force_units` | 21 bytes |
| `0x24` | `0x01-0x14` | Encoder raw | `raw_adc_counts` | 21 bytes |
| `0x24` | `0x11-0x24` | Encoder calibrated | `position_deg` | 21 bytes |
| `0x25` | `0x01-0xFF` (full board ID) | Environmental BME280 | `temperature_c`, `pressure_pa`, `humidity_rh` | 24 bytes |
| `0x30` | `0x01-0x0A` | Actuator feedback | `raw_adc_counts` | 21 bytes |
| `0x31` | `0x01-0x14` | Actuator state (current-sense) | `actuator_state` | 10 bytes |
| `0x32` | `0x01-0x14` | Actuator commanded state | `actuator_state_commanded` | 10 bytes |
| `0x40` | `0x00` | Controller actuation | - | 19 bytes |
| `0x41` | `0x00` | Controller diagnostics | - | 62 bytes |
| `0x42` | `0x00` | Controller measurement | - | 80 bytes |
| `0x43` | `0x00` | PSM state transition | - | 11 bytes |
| `0x44` | `0x00` | FIRE state | - | 18 bytes |
| `0x46` | `0x00` | CalibrationCommand (backend → calibration_service) | `type` + `sensor_id` + `reference_value` | 16 bytes |
| `0x50` | `0x00` | SequencerState | state + bitmask + debug | **17 bytes** (see below) |
| `0x50` | `0x60-0x66` | PSM actuator commands | - | 15 bytes |
| `0x60` | `0x01-0xFF` | Self-test results | `sensor_id` + `result` | 10 bytes |

**Raw vs Calibrated convention:** Raw channels use `low = channel_id` (1-based). Calibrated channels use `low = 0x10 + channel_id`. Example: PT channel 3 raw = `[0x20, 0x03]`, calibrated = `[0x20, 0x13]`.

**Free high bytes**, if you need a new stream: `0x45`, `0x47`–`0x4F`, `0x51`–`0x5F`. Anything
`>= 0x80` is off limits: by convention a high byte of `0x80` or above is a VTable **registration
ACK** rather than data, and `calibration_main.cpp` reads it that way (see its `type_hi < 0x80`
packet filter). Add a row here when you take one, or the next person reads a stale map
(this table sat without `0x24` and `0x46` for a while, which is how you end up debugging a
collision instead of picking a free byte).

## Environmental board `[0x25, board_id]`

The BME280 firmware sends packet type 13 to UDP port 5006 at 5 Hz. `lib/daq-protocol/src/DiabloPacketUtils.h` provides the parser. `SensorFramePipeline` decodes the packet, and `daq_bridge` resolves its source IP against enabled `ENVIRONMENTAL` boards before publishing it. Unknown sources, disabled boards, wrong protocol versions, incorrect packet lengths, non-finite values, humidity outside 0–100 %RH, and zero pressure do not produce rows.

Each board has one BME280 on logical connector 1. Configure `active_connectors = [1]`; an empty list disables its data stream. The firmware streams on its own and does not use `SENSOR_CONFIG` or ADC calibration. The readings already use °C, absolute Pa, and %RH. The bridge preserves the pressure as `uint32`, including its units.

Environmental tables use the **full board ID** as the low byte, rather than the channel-slot scheme. Board 25 publishes `[0x25, 0x19]` under entity `ENV25`. Board 35 publishes a separate `ENV35` entity. There is no raw/calibrated pair.

Enabled environmental boards need distinct integer IDs from 1 to 255. The shared configuration validator reports invalid IDs and duplicate IDs as errors. The C++ loader rejects them before narrowing an ID to a byte, and the bridge exits with a configuration error before connecting to the database. Disabled environmental boards do not claim IDs.

| Offset | Type | Component |
|--------|------|-----------|
| 0 | `u64` | `timestamp_ns` (server arrival time, Unix epoch) |
| 8 | `f32` | `temperature_c` |
| 12 | `u32` | `pressure_pa` (absolute) |
| 16 | `f32` | `humidity_rh` |
| 20 | `u32` | `sample_ts_ms` (firmware clock) |

`EnvironmentalMessage`, `DatabaseConfig::register_environmental_tables()`, and `parseElodinPacket()` must agree on this 24-byte layout. The bridge registers the schema at startup and after reconnecting. The backend and relay subscribe using enabled boards in the deployed configuration, then emit three `SENSOR_UPDATE` values with a shared timestamp.

The tracked `config/config_base.toml` and `config/profiles/default/config.toml` include board 25 at `192.168.2.25`, matching `firmware/Environmental Tracker/src/main.h`. `config/config.toml` is a generated, gitignored runtime file. For an existing installation, copy `[boards.environmental_board]` into its active profile and deploy that profile. The Environmental view is available under **All Views → Environmental**, at `/environmental`, and can be pinned with `environmental` in `[gui].tabs`. It shows separate readouts and plots for each measurement; stale readouts show “Waiting for fresh data.” Heartbeats appear in Boards.

The board simulator supports `--only-type ENVIRONMENTAL` with the firmware's 5 Hz default rate. Use a loopback simulation config for local testing. To test the real database and backend path without hardware, build `daq_bridge`, install the backend dependencies, then run from `diablo_server/backend`:

```sh
ELODIN_DB=/absolute/path/to/elodin-db \
DAQ_BRIDGE=/absolute/path/to/daq_bridge \
npx tsx test/environmental.integration.ts
```

This test starts an isolated Elodin database, bridge, and backend on local ports. The bridge also requires its existing UDP config port 5008 to be free. The test verifies UDP-to-WebSocket values, units, epoch timestamps, heartbeat attribution, and malformed packet rejection, then stops its processes. Run the backend unit tests with `npm test -- --exclude 'dist/**'` to exclude the repository's compiled test copies. Run the frontend tests with `npm test` from `diablo_server/frontend`.

Set `BACKEND_FIRST=1` for the startup-order and recovery test. It waits for Elodin to reject the environmental subscription before starting the bridge, verifies that readings arrive after a retry, then replaces the database with a fresh instance and checks that readings resume without restarting the bridge or backend. Both modes check that invalid and duplicate environmental IDs make the bridge exit with status 1. These tests use simulated packets, not physical hardware.

## CalibrationCommand `[0x46, 0x00]`

The one operator-command channel into `calibration_service`. **Strictly one-way**: the service
subscribes and never publishes a reply, so nothing can wait on an acknowledgement. Callers learn
what happened by reading the file the service writes — `cubic_calibration.json` for captures,
`lc_tare.json` for tares — which is also why a UI must never assume a command landed because it
was sent. A command published while the service is down is silently dropped.

Layout (16 bytes, and note byte 9 is covered by no field, so Elodin zeroes it — `sensor_id` sits at
the even offset 10 precisely so its high byte survives, since `uid = board_id*100 + connector`
exceeds 255):

```
Offset  Size  Type    Field
0       8     uint64  timestamp_ns
8       1     uint8   type          (cmd_type, below)
9       1     -       padding (NOT a field — always arrives 0)
10      2     uint16  sensor_id     (uid = board_id*100 + connector; 0 = "all")
12      4     float32 reference_value
```

| cmd | name | `sensor_id` | `reference_value` | effect |
|---|---|---|---|---|
| 0 | Zero / Zero All | uid, or 0 for all | — | Captures a **real** 0 reference point into the shared fit. Correct for a vented PT; see the note below for why it is not a load-cell tare. |
| 1 | Capture Reference | uid | reference | Feeds the robust learner only (PT). |
| 2 | Save | — | — | Persists robust adjustments. |
| 3 | Capture cubic point | uid | reference | Legacy; equivalent to 5 without the capture-quality record. |
| 4 | Clear channel | uid | — | Drops points + curve. |
| 5 | Capture point | uid | reference | The unified capture the UI uses; routed by the channel's configured model. |
| 6 | New calibration | uid | — | Unified clear. |
| 7 | Reload live store | — | — | Re-read `cubic_calibration.json` after the backend swapped a profile. |
| 8 | **LC tare** | uid, or 0 for all | `0` = set, `1` = clear | Display-only zero for a load cell. Never enters a fit, never reaches control or abort, never changes what Elodin records. |

**Why a load-cell tare is command 8 and not command 0.** A vented PT genuinely *is* at 0 psig, so
capturing a zero on one is a true reference point and belongs in the shared fit. A load cell
holding a tank is *not* at 0 kg: the same capture would inject a false point, and because the fit
is least-squares over every point it would tilt the whole cubic rather than shift its intercept.

The tare is therefore stored as the **ADC code** it was taken at, never as kilograms — `offset_kg`
in `lc_tare.json` is a cache the service re-derives on every capture, clear and profile swap. Tare
a 20 kg tank against a poor two-point fit that reads it as 18, then improve the fit until the same
tank evaluates to 20, and a frozen 18 kg offset would display 2 kg for a tank that never moved.
Re-deriving from the code gives 20 − 20 = 0. `test/ws_data_flow_test.ts`'s `cal_lc_tare` check
proves this through the full stack; `diablo_server/lib/test/test_lc_tare.cpp` pins the store.

## Standard 21-Byte Sensor Message Layout

All raw and calibrated sensor messages use this layout:

```
Offset  Size    Type      Field
0       8       uint64    timestamp_ns (nanoseconds, monotonic)
8       1       uint8     channel_id (1-based)
9       3       -         padding
12      4       uint32/f32  value (raw: uint32 ADC counts, cal: float32)
16      4       uint32    sample_timestamp_ms (firmware clock)
20      1       uint8     status_flags / calibration_status
```

## Elodin VTable wire alignment (general rule)

Elodin DB validates each VTable row’s **byte offsets**. In practice:

- Any **`u32` or `f32` must start at a 4-byte-aligned offset** (0, 4, 8, 12, …).
- Any **`u64` must start at an 8-byte-aligned offset** (0, 8, 16, …) when the schema expects it; the common **21-byte sensor row** still uses the “`u8` at 8, then pad, then `u32` at 12” pattern so the value field is 4-aligned.
- **`comms::CommsMessage` serializes packed** (memcpy fields in order, **no** automatic C++ `struct` padding). So if you place a `u8` and then a `u32`, **you** must insert explicit **padding bytes** on the wire (often **3 bytes of zeros**) so the `u32` lands on a multiple of 4.

If alignment is wrong, publishes may succeed at the TCP layer but **Elodin will not stream `TABLE` rows** for that packet id — subscribers see nothing (silent failure). The SequencerState case below is the canonical example.

## Elodin row alignment and SequencerState `[0x50, 0x00]`

**Same rule as above, applied after `timestamp_ns` (`u64` ends at offset 8):** the next `u32` cannot start at offset 9. Match the 21-byte sensor pattern: **`u8` at 8, then three padding bytes, then `u32` at 12.**

### What went wrong with a 14-byte SequencerState

An earlier layout packed fields with no gap:

| Field | Offset | Size |
|-------|--------|------|
| `timestamp_ns` | 0 | 8 (`u64`) |
| `current_state` | 8 | 1 (`u8`) |
| `allowed_bitmask` | **9** | 4 (`u32`) ← **misaligned** (9 is not a multiple of 4) |
| `debug_mode` | 13 | 1 (`u8`) |

**Total: 14 bytes on the wire.** `comms::CommsMessage` already serializes fields **packed** (no hidden C++ `struct` padding), so the bug was not “wrong sizeof” — it was **semantic layout**.

- **`[0x43, 0x00]`** (state transition: `u64` + three `u8`s) kept working: every field after the timestamp is a single byte, so alignment was never violated.
- **`[0x50, 0x00]`** failed end-to-end: the C++ client’s `publish()` wrote bytes to TCP successfully (no socket error, no “Failed to publish” path), but **Elodin did not emit `TABLE` rows for `[0x50, 0x00]`** to subscribers. The relay log showed many `TABLE [0x43, …] len=11` lines and **none** for `0x50`, and integration checks that grep `[ThinServer] SequencerState from relay` stayed at zero.

### Correct 17-byte SequencerState layout

Match the sensor pattern: **`u8` at 8, then three padding bytes, then `u32` at 12.**

| Field | Offset | Size | Notes |
|-------|--------|------|--------|
| `timestamp_ns` | 0 | 8 | `u64` |
| `current_state` | 8 | 1 | `u8` |
| *(padding)* | 9 | 3 | **Must be present on the wire** (zeros); not always listed as separate VTable “schema” fields — see `DatabaseConfig.cpp` |
| `allowed_bitmask` | 12 | 4 | `u32`, 4-byte aligned |
| `debug_mode` | 16 | 1 | `u8` |

**Total: 17 bytes.** After this change, the relay sees e.g. `TABLE [0x50, 0x0] len=17` and thin server can parse and log SequencerState.

### Files that must stay in lockstep

If you change this layout, update **all** of the following in one change set:

1. **`diablo_server/services/sequencer/SequencerService.cpp`** — `SequencerStateMsg` type and `publishState()` (e.g. `CommsMessage<u64, u8, std::array<u8,3>, u32, u8>` with explicit zero padding).
2. **`diablo_server/lib/src/elodin/DatabaseConfig.cpp`** — `register_sequencer_vtable()`: `raw_field` offsets and lengths for `[0x50, 0x00]`.
3. **`diablo_server/backend/src/elodin-protocol.ts`** — `parseElodinPacket()` branch for `high === 0x50 && low === 0x00`: `payload.length` minimum and `readUInt32LE` / `readUInt8` offsets.
4. **`diablo_server/services/heartbeat/heartbeat_service_main.cpp`** (if still relevant) — any comment or parser that documents byte offsets; code that only reads **current state at payload byte 8** remains valid.

The relay still needs **`[0x50, 0x00]` in `SENSOR_SUBSCRIPTIONS`** in `elodin-vtable-registry.ts`; schema registration for this table is done by the **sequencer** via `DatabaseConfig::register_non_sensor_tables`, not necessarily by `registerControllerVTables()`.

## Files to Modify (in order)

### 1. C++ — DAQ Bridge Sensor Routing

**`diablo_server/lib/src/routing/SensorRouter.cpp`**

Add a routing function for the new type. This extracts samples from incoming UDP frames and packages them into Elodin messages with the correct VTable ID.

```cpp
// Example: route strain gauge samples
auto sg_msgs = route_sg_samples(batch, receive_timestamp_ns);
for (auto& [vtable_id, msg] : sg_msgs) {
    elodin_.publish(vtable_id, msg);
}
```

**`diablo_server/lib/src/elodin/DatabaseConfig.cpp`**

Register the VTable schemas with Elodin so it accepts TABLE publishes:

```cpp
// Raw: [0x25, 0x01] through [0x25, 0x06]
for (int ch = 1; ch <= 6; ++ch) {
    register_sensor_vtable(client, {0x25, (uint8_t)ch}, "SG_raw", ch);
}
// Calibrated: [0x25, 0x11] through [0x25, 0x16]
for (int ch = 1; ch <= 6; ++ch) {
    register_sensor_vtable(client, {0x25, (uint8_t)(0x10 + ch)}, "SG_cal", ch);
}
```

### 2. Relay — Register Schema AND Subscribe

**`diablo_server/backend/src/elodin-vtable-registry.ts`**

Two things are required in this file, and **both must be done or data will silently not flow**:

#### 2a. Register the VTable schema (`registerControllerVTables`)

Elodin DB will not accept TABLE publishes or stream data for a VTable ID unless the schema has been registered first. If the DAQ bridge already registers the schema (it does for sensor types 0x20-0x23, 0x30), you can skip this. For other streams, whoever **first** publishes must register the schema (e.g. **SequencerState `[0x50, 0x00]`** is registered by `sequencer_service` via `DatabaseConfig::register_non_sensor_tables` — the relay only needs `SENSOR_SUBSCRIPTIONS` unless you also publish that ID from Node and must register there too).

Add to the `vtables` array in `registerControllerVTables()`:

```typescript
{ name: 'StrainGauge', buf: encodeVTable([0x25, 0x00], [
  { offset: 0,  size: 8, type: 'u64', component: 'SG.timestamp_ns' },
  { offset: 8,  size: 1, type: 'u8',  component: 'SG.channel_id' },
  { offset: 9,  size: 3, type: 'pad', component: 'SG.padding' },
  { offset: 12, size: 4, type: 'u32', component: 'SG.raw_adc_counts' },
  { offset: 16, size: 4, type: 'u32', component: 'SG.sample_timestamp_ms' },
  { offset: 20, size: 1, type: 'u8',  component: 'SG.status_flags' },
])},
```

**If you skip this:** Elodin silently ignores the subscription AND the publisher's data. No errors anywhere. This is the hardest bug to diagnose.

#### 2b. Subscribe to the VTable IDs (`SENSOR_SUBSCRIPTIONS`)

Add every `[high, low]` pair to the `SENSOR_SUBSCRIPTIONS` array:

```typescript
const SENSOR_SUBSCRIPTIONS: Array<[number, number]> = [
  // ... existing entries ...

  // SG Raw (0x25, 0x01-0x06)
  ...[1,2,3,4,5,6].map(ch => [0x25, ch] as [number, number]),
  // SG Calibrated (0x25, 0x11-0x16)
  ...[0x11,0x12,0x13,0x14,0x15,0x16].map(ch => [0x25, ch] as [number, number]),
];
```

This sends `VTableStream` subscription messages to Elodin when the relay connects. Each subscription is a 2-byte payload `[high, low]` sent as a MSG packet with a message ID computed from `fnv1a("VTableStream")`.

**If you skip this:** The relay won't receive the data even though Elodin has it.

**VTableStream is NOT lossless (by design).** Verified against elodin-db source
(`libs/db/src/vtable_stream.rs` `RealTimeStage::next`): the streamer task wakes on a
write and forwards `time_series.latest()` — the newest value only. Rows written to the
same component while a send is in flight are coalesced away. With multi-chunk board
packets (N samples per channel per UDP packet, which real firmware sends via
`SENSOR_MAX_CHUNKS_BEFORE_SEND`), a subscriber typically receives ~1 of N rows per
burst. DB **storage** appends every row regardless — `GetTimeSeries`/SQL queries see
everything; only the live push stream thins. If a consumer ever needs every sample
live, elodin-db's `FollowStream` replication protocol streams contiguous ranges
losslessly. Integration Test 15 (`ws_data_flow_test.ts`) asserts the resulting
invariant: at least one row per channel per packet must reach the backend.

### 3. Protocol Parser — Parse the Binary Payload

**`diablo_server/backend/src/elodin-protocol.ts`**

Add parsing logic in the `parseElodinPacket()` dispatcher function. Use the existing shared helpers for standard 21-byte layouts:

```typescript
// ── SG Raw: [0x25, 0x01..0x06] ──
if (high === 0x25 && low >= 0x01 && low <= 0x06) {
  const chId = low;
  const entity = maps.sgChannelToEntityMap?.[chId] ?? `SG.SG_CH${chId}`;
  return [parseRawSensorPayload(payload, chId, entity, 'raw_adc_counts')].filter(Boolean) as ParsedSensorData[];
}

// ── SG Calibrated: [0x25, 0x11..0x16] ──
if (high === 0x25 && low >= 0x11 && low <= 0x16) {
  const chId = low - 0x10;
  const entity = maps.sgChannelToEntityMap?.[chId]?.replace('SG.', 'SG_Cal.') ?? `SG_Cal.SG_CH${chId}`;
  return [parseCalibratedSensorPayload(payload, chId, entity, 'strain_ue')].filter(Boolean) as ParsedSensorData[];
}
```

**Key:** The `parseElodinPacket` function returns `ParsedSensorData[]` — an array of `{ entity, component, value, timestamp }` objects. For standard sensors this is a single-element array. For composite packets (like SequencerState) it can be multiple.

If the high byte isn't handled, the packet is silently dropped (or logged if `ELODIN_DEBUG=1`).

### 4. Config — Map Channel IDs to Human-Readable Names

**`config/config.toml`**

Add a `[sg_roles]` section (or similar) mapping channel IDs to names:

```toml
[sg_roles]
"Thrust_Frame_1" = 1
"Thrust_Frame_2" = 2
"LOX_Tank_1" = 3
```

**`diablo_server/backend/src/routes/config.ts`**

Add a loader function (similar to `loadSensorRoleMap`) that reads the TOML section and returns a `Record<number, string>` mapping channel ID → entity name.

**`diablo_server/backend/src/server.ts`**

Pass the new entity map to `parseElodinPacket` via the `EntityMaps` parameter.

### 5. server.ts — No Changes Needed (Usually)

The relay `'packet'` handler in server.ts already:
1. Calls `parseElodinPacket()` for every packet
2. Skips `_SEQUENCER_STATE` (special case for state updates)
3. Broadcasts everything else as `MessageType.SENSOR_UPDATE`
4. Applies 10 Hz per-entity throttle

As long as `parseElodinPacket` returns valid `ParsedSensorData`, the new sensor will automatically flow to the frontend as `SENSOR_UPDATE` messages. No routing changes needed.

**Exception:** If the new data type needs a different `MessageType` (like `STATE_UPDATE` or `ACTUATOR_UPDATE`), add a check for the entity prefix in the packet handler, similar to the `_SEQUENCER_STATE` block.

### 6. Frontend — Display the Data

**`diablo_server/shared/types.ts`**

Add the sensor type to `SensorType` enum if needed:

```typescript
export enum SensorType {
  // ... existing ...
  SG = 'SG',
  SG_CAL = 'SG_Cal',
}
```

**`diablo_server/frontend/lib/store.ts`** (ALIASES)

Add alias mappings if the entity names might come in different forms:

```typescript
export const ALIASES: Record<string, string[]> = {
  // ... existing ...
  'SG_Cal.Thrust_Frame_1.strain_ue': ['SG_Cal.SG_CH1.strain_ue'],
};
```

**Frontend plot component:**

```tsx
<TimeSeriesPlot
  title="Strain Gauges"
  entities={['SG_Cal.Thrust_Frame_1', 'SG_Cal.Thrust_Frame_2']}
  component="strain_ue"
  colors={['#FF6B6B', '#4ECDC4']}
  yLabel="Strain (microstrain)"
/>
```

No subscription call is needed — `DataCache` has a single global `SENSOR_UPDATE` listener that caches ALL entities automatically. `TimeSeriesPlot` reads from the cache by entity name.

## How the 10 Hz Throttle Works

`server.ts` maintains a `Map<string, number>` of `entityKey → lastBroadcastMs`. For each parsed entity update:

1. Increment `stats.relayEntityUpdatesReceived` (pre-throttle count)
2. Check if `Date.now() - lastBroadcast < 100ms` — if so, skip
3. Otherwise, broadcast and increment `stats.sensorUpdatesBroadcast`

This means the backend ingests data at full rate (100+ Hz per sensor) but only sends 10 updates/second per entity to WebSocket clients. The frontend `DataCache` deduplicates within a 40ms window on its end as well.

## How the Relay Subscription Works

The backend and relay call `registerVTables()` when they connect to Elodin. It builds a deduplicated list from board configuration and fallback streams, then sends each two-byte stream ID in a `VTableStream` message.

Elodin 0.16.1 rejects a subscription if the publisher has not registered its table. The registry matches the error to the requested stream and makes that stream eligible for the next five-second retry. Accepted subscriptions stay deduplicated even when no data arrives. Concurrent registration passes share one operation.

The wire request ID is one byte. Each batch uses IDs 1 through 254 once, followed by a read-only `GetEarliestTimestamp` request on reserved ID 255. Elodin processes these requests in order and sends errors before the timestamp reply. That reply acts as a fence: the registry can reuse request IDs after receiving it without confusing delayed errors with a later batch. If the fence fails or times out, the client closes the connection so retries cannot duplicate subscriptions whose acceptance is unknown.

## Common Pitfalls

1. **Missing schema or subscription**: C++ publishers register VTable schemas; `elodin-vtable-registry.ts` subscribes to those tables. Both are required. Check the backend or relay log for subscription rejections. A successful socket write alone does not prove that Elodin accepted the request.

   **This applies to the C++ subscribers too, and it has already bitten one.** `heartbeat_service`
   read `[0x50, 0x00]` and subscribed with a helper called `subscribe_stream()` whose doc comment
   promised "all stream data" but which actually sent the calibration service's table list. It
   received 481 tables it discarded, never `[0x50, 0x00]`, and broadcast `engine_state = 0`
   through every state transition for the life of the process — no error, no CPU, nothing to see.
   `subscribe_stream()` is gone; use `ElodinClient::subscribe_tables()` with
   `fsw::elodin::raw_sensor_tables()` / `calibrated_sensor_tables()` / the `kTable*` constants in
   `DatabaseConfig.hpp`, and name exactly what your service reads.

2. **Entity name mismatch** — The entity string in `parseElodinPacket` must match what the frontend expects. Use `config.toml` sensor roles for consistency.

3. **Wrong payload size check** — Standard sensor messages are 21 bytes. If your message has a different layout, update the size check.

4. **Signed vs unsigned ADC** — LC and some PT boards use signed ADC (ADS1262). Use `readInt32LE` not `readUInt32LE` or negative values show as ~4 billion.

5. **Calibrated value range check** — `parseCalibratedSensorPayload` rejects values outside hardcoded bounds (e.g., pressure_psi: -100 to 10000). Add appropriate bounds for your sensor type or they'll be silently dropped.

6. **Channel IDs are 1-based** — Channel 0 is unused. Low byte `0x01` = channel 1.

7. **`u32` / `f32` after a `u8` without padding** — If Elodin stops streaming `TABLE` packets for your ID but TCP publish appears to succeed, check that multi-byte fields are **4-byte aligned** (use a 3-byte gap before the first `u32`/`f32` after an 8-byte `u64` + 1-byte `u8`, same as the standard 21-byte sensor layout). See **Elodin row alignment and SequencerState** above.

## Testing

The integration test (`test/test_integration.sh`) verifies the full pipeline. New sensor types will automatically appear in Test 1 (Sensor Data Flow) if:
- The simulator (`sim/board_simulator.py`) sends data for the new type
- The DAQ bridge routes it to Elodin
- The relay subscribes to the VTable
- The protocol parser handles the packet ID

Check the backend log for `[Elodin] Unmapped packet id=` warnings — set `ELODIN_DEBUG=1` to see packets that arrive but have no parser.

With `sequencer_service` and the thin backend, the integration script also checks that **`[ThinServer] SequencerState from relay`** appears in the backend log (proof that `[0x50, 0x00]` rows are stored in Elodin and relayed). Optional: run with `INTEGRATION_SAVE_LOGS=1` to copy `integration_*.log` to `/tmp/integration_logs/` before cleanup (see `test/test_integration.sh`).

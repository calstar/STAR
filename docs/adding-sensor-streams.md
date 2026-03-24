# Adding a New Sensor Stream (Thin Backend)

How to add a new sensor type so data flows from hardware to the frontend GUI.

## Architecture Overview

```
Hardware Board (ESP32)
  → UDP packets
  → DAQ Bridge (C++)
  → Elodin DB (stores as VTable entries)
  → Elodin Relay (Node.js, WebSocket bridge)
  → server-thin.ts (parses, throttles, broadcasts)
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
| `0x30` | `0x01-0x0A` | Actuator feedback | `raw_adc_counts` | 21 bytes |
| `0x31` | `0x01-0x14` | Actuator state | - | 21 bytes |
| `0x40` | `0x00` | Controller actuation | - | 19 bytes |
| `0x41` | `0x00` | Controller diagnostics | - | 62 bytes |
| `0x42` | `0x00` | Controller measurement | - | 80 bytes |
| `0x43` | `0x00` | PSM state transition | - | 11 bytes |
| `0x44` | `0x00` | FIRE state | - | 18 bytes |
| `0x50` | `0x00` | SequencerState | state + bitmask + debug | 14 bytes |
| `0x50` | `0x60-0x66` | PSM actuator commands | - | 15 bytes |

**Raw vs Calibrated convention:** Raw channels use `low = channel_id` (1-based). Calibrated channels use `low = 0x10 + channel_id`. Example: PT channel 3 raw = `[0x20, 0x03]`, calibrated = `[0x20, 0x13]`.

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

## Files to Modify (in order)

### 1. C++ — DAQ Bridge Sensor Routing

**`FSW/src/routing/SensorRouter.cpp`**

Add a routing function for the new type. This extracts samples from incoming UDP frames and packages them into Elodin messages with the correct VTable ID.

```cpp
// Example: route strain gauge samples
auto sg_msgs = route_sg_samples(batch, receive_timestamp_ns);
for (auto& [vtable_id, msg] : sg_msgs) {
    elodin_.publish(vtable_id, msg);
}
```

**`FSW/src/elodin/DatabaseConfig.cpp`**

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

### 2. Relay — Subscribe to the New VTable IDs

**`web-gui/backend/src/elodin-vtable.ts`** (line ~16, `SENSOR_SUBSCRIPTIONS`)

The relay only receives packets for VTables it explicitly subscribes to. If you skip this step, the relay will never see your data.

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

### 3. Protocol Parser — Parse the Binary Payload

**`web-gui/backend/src/elodin-protocol.ts`**

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

**`web-gui/backend/src/routes/config.ts`**

Add a loader function (similar to `loadSensorRoleMap`) that reads the TOML section and returns a `Record<number, string>` mapping channel ID → entity name.

**`web-gui/backend/src/server-thin.ts`**

Pass the new entity map to `parseElodinPacket` via the `EntityMaps` parameter.

### 5. server-thin.ts — No Changes Needed (Usually)

The relay `'packet'` handler in server-thin.ts already:
1. Calls `parseElodinPacket()` for every packet
2. Skips `_SEQUENCER_STATE` (special case for state updates)
3. Broadcasts everything else as `MessageType.SENSOR_UPDATE`
4. Applies 10 Hz per-entity throttle

As long as `parseElodinPacket` returns valid `ParsedSensorData`, the new sensor will automatically flow to the frontend as `SENSOR_UPDATE` messages. No routing changes needed.

**Exception:** If the new data type needs a different `MessageType` (like `STATE_UPDATE` or `ACTUATOR_UPDATE`), add a check for the entity prefix in the packet handler, similar to the `_SEQUENCER_STATE` block.

### 6. Frontend — Display the Data

**`web-gui/shared/types.ts`**

Add the sensor type to `SensorType` enum if needed:

```typescript
export enum SensorType {
  // ... existing ...
  SG = 'SG',
  SG_CAL = 'SG_Cal',
}
```

**`web-gui/frontend/lib/store.ts`** (ALIASES)

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

`server-thin.ts` maintains a `Map<string, number>` of `entityKey → lastBroadcastMs`. For each parsed entity update:

1. Increment `stats.relayEntityUpdatesReceived` (pre-throttle count)
2. Check if `Date.now() - lastBroadcast < 100ms` — if so, skip
3. Otherwise, broadcast and increment `stats.sensorUpdatesBroadcast`

This means the backend ingests data at full rate (100+ Hz per sensor) but only sends 10 updates/second per entity to WebSocket clients. The frontend `DataCache` deduplicates within a 40ms window on its end as well.

## How the Relay Subscription Works

When the relay connects to Elodin, it calls `registerVTables()` which:

1. Computes a message ID: `fnv1a_hash_16_xor("VTableStream")` → `[low, high]`
2. For each `[high, low]` in `SENSOR_SUBSCRIPTIONS`:
   - Creates a 2-byte `Buffer` with `[high, low]`
   - Sends it as a MSG packet to Elodin via `sendRawMessage()`
3. Elodin begins streaming TABLE packets for those VTable IDs

If a VTable isn't registered by the DAQ bridge yet when the relay subscribes, the subscription is silently ignored. The relay has retry logic (every 5 seconds, up to 24 attempts) that re-sends subscriptions for any VTable groups that haven't delivered data yet.

## Common Pitfalls

1. **Forgot to add to `SENSOR_SUBSCRIPTIONS`** — The relay won't receive the data. This is the most common miss. Elodin only streams VTables you explicitly subscribe to.

2. **Entity name mismatch** — The entity string in `parseElodinPacket` must match what the frontend expects. Use `config.toml` sensor roles for consistency.

3. **Wrong payload size check** — Standard sensor messages are 21 bytes. If your message has a different layout, update the size check.

4. **Signed vs unsigned ADC** — LC and some PT boards use signed ADC (ADS1262). Use `readInt32LE` not `readUInt32LE` or negative values show as ~4 billion.

5. **Calibrated value range check** — `parseCalibratedSensorPayload` rejects values outside hardcoded bounds (e.g., pressure_psi: -100 to 10000). Add appropriate bounds for your sensor type or they'll be silently dropped.

6. **Channel IDs are 1-based** — Channel 0 is unused. Low byte `0x01` = channel 1.

## Testing

The integration test (`scripts/test/test_integration.sh`) verifies the full pipeline. New sensor types will automatically appear in Test 1 (Sensor Data Flow) if:
- The fake data generator (`scripts/fake_sensor_generator/`) sends data for the new type
- The DAQ bridge routes it to Elodin
- The relay subscribes to the VTable
- The protocol parser handles the packet ID

Check the backend log for `[Elodin] Unmapped packet id=` warnings — set `ELODIN_DEBUG=1` to see packets that arrive but have no parser.

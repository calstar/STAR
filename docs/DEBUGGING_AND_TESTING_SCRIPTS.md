# Debugging and Testing Scripts

This document describes the various utility and diagnostic scripts used to verify the Elodin stack, debug protocol issues, and test race conditions.

## Location
All scripts are located in `scripts/debug/`.

## Scripts

### 1. `compute_elodin_ids.js`
A utility to compute the FNV-1a hash-based message IDs used by the Elodin DB. This is useful for verifying that the TypeScript relay and C++ services are using identical IDs for VTable subscriptions.

**Usage:**
```bash
node scripts/debug/compute_elodin_ids.js "VTableStream"
```

### 2. `test_vtable_subscription.js`
A standalone TypeScript client that connects to the Elodin DB and subscribes to a specific VTable group. Use this to verify that the DB is responding to subscriptions and broadcasting data independently of the full relay stack.

**Usage:**
```bash
node scripts/debug/test_vtable_subscription.js [host] [port]
```

### 3. `start_manual_no_tmux.sh`
Starts the core components of the GUI stack (DB, Relay, Backend, DAQ Bridge, and Simulator) as background processes WITHOUT using tmux. This is useful for debugging in environments where tmux is unavailable or when you need to capture all logs in a single terminal session.

**Usage:**
```bash
USE_SIM=1 bash scripts/debug/start_manual_no_tmux.sh
```
*Logs are saved to `/tmp/manual_logs/`.*

### 4. `repro_relay_race.sh`
A reproduction script for the Relay resubscription race condition. It intentionally delays the DAQ Bridge by 130 seconds to ensure the Relay exceeds its initial 2-minute retry limit. This verifies that the Relay correctly recovers and established subscriptions once the bridge finally starts.

**Usage:**
```bash
bash scripts/debug/repro_relay_race.sh
```

## Troubleshooting Data Flow
If sensor data is not reaching the frontend:
1. Verify `daq_bridge` is publishing (`DB: ✅ ok` in its logs).
2. Check `relay.log` for "Missing groups" messages. If it stays at attempt #1 and never receives data, verify the simulator is running.
3. Use `curl http://localhost:8081/stats` to check if the backend is receiving updates from the relay (`relayEntityUpdatesReceived`).

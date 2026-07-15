# Data Flow Architecture

## Overview

The React GUI pulls **all data from Elodin DB**. There is no direct connection between React and the FSW.

## Data Flow Diagram

```
FSW (C++) 
  ↓ (UDP/TCP packets)
DAQ Bridge
  ↓ (registers components)
Elodin DB (Rust)
  ↓ (TCP binary protocol, port 2240)
Node.js Backend (WebSocket Server)
  ↓ (WebSocket, port 8081)
React Frontend (Browser)
```

## Detailed Flow

### 1. Sensor Data Collection
- Boards collect sensor readings (PT, actuators, etc.)
- Boards send data to the **DAQ Bridge** via UDP (DiabloAvionics protocol)
- **DAQ Bridge** registers components in **Elodin DB** using board-namespaced,
  channel-based entity names like:
  - `PT1.CH3` (raw), `PT1_Cal.CH3` (calibrated)
  - `ACT4.CH5`
  - `TC1.CH2`, etc.

### 2. Elodin DB Storage
- **Elodin DB** stores all sensor data in tables
- Each table has a `packet_id` (e.g., `[0x20, 0x13]` for calibrated PT board 1, CH3)
- **Elodin DB** streams data to connected TCP clients

### 3. Backend Connection
- **Node.js Backend** (`elodin-client.ts`) connects to Elodin DB on port 2240
- Backend listens for incoming packets
- Backend parses packets using `elodin-protocol.ts`, whose packet IDs use a
  board-aware `[high, low]` scheme (`low = (board-1)*0x20 + channel` for raw,
  `+0x10` for calibrated; `board = board_id % 10`):
  - Raw PT board 1 CH3: `[0x20, 0x03]` → `PT1.CH3.raw_adc_counts`
  - Calibrated PT board 1 CH3: `[0x20, 0x13]` → `PT1_Cal.CH3.pressure_psi`
  - Actuator board 4 CH5: `[0x30, 0x45]` → `ACT4.CH5.raw_adc_counts`

### 4. WebSocket Broadcasting
- Backend (`server.ts`) broadcasts parsed data to all connected WebSocket clients
- Each update includes:
  - Entity name (e.g., `PT_Cal.Fuel_Upstream`)
  - Component name (e.g., `pressure_psi`)
  - Value
  - Timestamp

### 5. React Frontend
- React connects to WebSocket server (port 8081)
- React subscribes to sensor updates
- React stores data in Zustand store (`lib/store.ts`)
- React components read from store and display data

## Command Flow (Reverse)

Commands do **not** travel back through Elodin DB. State transitions and actuator
commands go over a separate TCP control path to the `sequencer_service`, which
emits the UDP packets to boards:

```
React Frontend
  ↓ (WebSocket command)
Node.js Backend (server.ts)
  ↓ (TCP text command, port 9998: "TRANSITION:<state>", "ACTUATOR:<role>:<0|1>")
sequencer_service (ActuatorCommander)
  ↓ (UDP ACTUATOR_COMMAND, port 5005)
Boards
```

### Commands Supported
- **State Transitions**: Change system state (IDLE → ARMED → FIRE, etc.)
- **Actuator Commands**: Open/close valves (ON/OFF)
- **PWM Commands**: Set duty cycle for PWM actuators (future)

## Key Points

1. **All data comes from Elodin DB** - React never talks directly to FSW
2. **Backend is a bridge** - Converts Elodin binary protocol ↔ WebSocket JSON
3. **Real-time updates** - Data flows continuously as Elodin DB receives it
4. **No polling** - WebSocket provides push-based updates (<30ms latency)

## Packet IDs Reference

The authoritative mapping lives in `diablo_server/backend/src/elodin-protocol.ts`.
The high byte selects the sensor family; the low byte encodes the board and
channel: `low = (board-1)*0x20 + channel` (raw) or `+0x10` (calibrated), where
`board = board_id % 10`.

| Packet ID (example) | Description | Entity (example) |
|---------------------|-------------|------------------|
| `[0x20, 0x03]` | Raw PT board 1, CH3 | `PT1.CH3.raw_adc_counts` |
| `[0x20, 0x13]` | Calibrated PT board 1, CH3 | `PT1_Cal.CH3.pressure_psi` |
| `[0x30, 0x45]` | Actuator board 4, CH5 | `ACT4.CH5.raw_adc_counts` |

## Controller Frequency

**PWM Frequency** is a **hardware configuration parameter**, not a runtime control.

- Frequency determines how fast the PWM signal switches (e.g., 10 Hz = 10 switches/second)
- **Controller only adjusts duty cycle** (0-100% on-time)
- Frequency is set once in `config.toml` or hardware initialization
- GUI shows frequency as **read-only** information

Example:
- Frequency: 10 Hz (set in config)
- Duty Cycle: 50% (controlled by controller)
- Result: Valve is ON for 50ms, OFF for 50ms, repeating every 100ms

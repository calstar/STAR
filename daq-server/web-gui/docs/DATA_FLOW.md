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
- **FSW** collects sensor readings (PT, actuators, etc.)
- **FSW** sends data to **DAQ Bridge** via UDP/TCP
- **DAQ Bridge** registers components in **Elodin DB** using entity names like:
  - `PT_Cal.Fuel_Upstream`
  - `PT_Cal.Ox_Upstream`
  - `ACT.LOX_Main`
  - etc.

### 2. Elodin DB Storage
- **Elodin DB** stores all sensor data in tables
- Each table has a `packet_id` (e.g., `[0x20, 0x10]` for calibrated PT data)
- **Elodin DB** streams data to connected TCP clients

### 3. Backend Connection
- **Node.js Backend** (`elodin-client.ts`) connects to Elodin DB on port 2240
- Backend listens for incoming packets
- Backend parses packets using `elodin-protocol.ts`:
  - Raw PT: `[0x01, 0x00]` → `PT.*.raw_adc_counts`
  - Calibrated PT: `[0x01, 0x01]` → `PT_Cal.*.pressure_psi`
  - Actuator: `[0x12, 0x00]` → `ACT.*.raw_adc_counts`

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

```
React Frontend
  ↓ (WebSocket command)
Node.js Backend
  ↓ (TCP command to Elodin DB)
Elodin DB
  ↓ (message routing)
FSW (via DAQ Bridge or direct)
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

Based on `DatabaseConfig.cpp` and `config.toml`:

| Packet ID | Description | Entity Pattern |
|-----------|-------------|----------------|
| `[0x20, 0x00]` | Raw PT ADC counts | `PT.*.raw_adc_counts` |
| `[0x20, 0x10]` | Calibrated PT pressure | `PT_Cal.*.pressure_psi` |
| `[0x30, 0x00]` | Actuator status | `ACT.*.raw_adc_counts` |

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

# High-Fidelity Web GUI Implementation Plan

## Overview
Build a modern, cross-platform (web/mobile/desktop) React-based GUI with <30ms latency, replacing the Elodin editor KDL interface with a sleek, professional dashboard.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    React/Next.js Frontend                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Web App    │  │  Mobile Web  │  │  Electron    │     │
│  │  (Browser)   │  │  (Responsive)│  │  (Desktop)   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└───────────────────────┬─────────────────────────────────────┘
                        │ WebSocket (binary protocol)
                        │ <10ms latency
┌───────────────────────▼─────────────────────────────────────┐
│              Node.js WebSocket Server                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Elodin DB Bridge (Rust FFI or TCP client)           │   │
│  │  - Streams sensor data (PT, TC, RTD, LC, ACT)        │   │
│  │  - Handles commands (state transitions, actuators)    │   │
│  │  - Query historical data                             │   │
│  └──────────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────────┘
                        │ TCP/IP
                        │ Elodin Protocol
┌───────────────────────▼─────────────────────────────────────┐
│                  Elodin Database                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  - Sensor telemetry (PT_Cal.*, PT.*, ACT.*)          │   │
│  │  - Command queue (command.state_transition, etc.)    │   │
│  │  - Historical data storage                           │   │
│  └──────────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        │
┌───────────────────────▼─────────────────────────────────────┐
│              FSW / DAQ Bridge                                 │
└───────────────────────────────────────────────────────────────┘
```

## Technology Stack

### Frontend
- **Framework**: Next.js 14+ (App Router) with React 18+
- **UI Library**: shadcn/ui + Tailwind CSS
- **Plotting**: uPlot (ultra-lightweight, <30ms render) or Plotly.js
- **State Management**: Zustand or Jotai
- **WebSocket**: Native WebSocket API with binary protocol
- **Desktop**: Electron 28+ (wraps Next.js app)
- **Mobile**: Responsive design with PWA support

### Backend
- **Runtime**: Node.js 20+ with TypeScript
- **WebSocket**: `ws` library (binary protocol support)
- **Elodin Client**: Rust FFI bindings or TCP client in Node.js
- **Data Processing**: Efficient binary serialization (MessagePack or custom)

## Features to Implement

### 1. Real-Time Pressure Plots
- **LOX Graphs**: Ox_Upstream, Ox_Downstream (calibrated + raw)
- **FUEL Graphs**: Fuel_Upstream, Fuel_Downstream (calibrated + raw)
- **GSE Graphs**: GSE_Low, GSE_Mid (calibrated + raw)
- **GN2 Graphs**: GN2_Regulated (calibrated + raw)
- **All Actuators**: Combined actuator feedback graphs
- **Features**:
  - Smooth scrolling time-series (10s window, configurable)
  - Color-coded lines matching current KDL
  - Auto-scaling Y-axis
  - Zoom/pan controls
  - Export to CSV

### 2. State Machine Control
- **Layout**: Vertical flow with horizontal Press/Vent pairs
- **States**:
  - DEBUG/IDLE (horizontal pair)
  - ARMED (single)
  - Fuel FILL / OX FILL (horizontal pair)
  - GN2 Low Press / GN2 Vent (horizontal pair)
  - Fuel Press / Fuel Vent (horizontal pair)
  - OX Press / OX Vent (horizontal pair)
  - GN2 High Press / GN2 High Vent (horizontal pair)
  - CALIBRATE → READY → FIRE (vertical sequence)
  - VENT / ABORT (emergency, bottom)
- **Features**:
  - Visual state highlighting (current state highlighted)
  - Disabled states for invalid transitions
  - Confirmation dialogs for critical states (FIRE, ABORT)
  - State transition history log

### 3. Actuator Control
- **Layout**: Each actuator shows:
  - **State Display**: Current status (OPEN/CLOSED) with visual indicator
  - **Toggle Buttons**: OPEN/CLOSE buttons (highlight active state)
- **Actuators**:
  - LOX Main, Fuel Main
  - LOX Vent, Fuel Vent
  - LOX Press, Fuel Press
  - GN2 Vent (GSE_Low_Vent)
- **Features**:
  - Real-time state feedback (from ACT.*.raw_adc_counts)
  - Visual status indicators (green=open, red=closed)
  - Toggle buttons that reflect current state
  - Command confirmation for safety-critical actuators

### 4. Top Bar Dashboard
- **Pressure Readouts**: Large, color-coded displays
  - GN2 (green), FUEL (blue), LOX (red)
  - GSE Low (orange), GSE Mid (purple)
- **Current State**: Prominent display of active state machine state
- **System Status**: Connection status, data rate, timestamp

### 5. Status Tables
- **Pressure Table**: All calibrated pressure readings
- **Actuator Table**: All actuator states and raw ADC counts
- **Raw ADC Table**: All raw sensor readings
- **Features**: Sortable, filterable, exportable

### 6. Settings & Configuration
- **Sensor Configuration**: Labels, calibration parameters
- **Display Settings**: Y-axis limits, window size, colors
- **Network Settings**: Elodin DB connection, WebSocket port
- **Theme**: Dark/light mode toggle

## File Structure

```
sensor_system/
├── web-gui/
│   ├── frontend/                    # Next.js React app
│   │   ├── app/
│   │   │   ├── layout.tsx          # Root layout
│   │   │   ├── page.tsx            # Main dashboard
│   │   │   ├── plots/
│   │   │   │   ├── lox/page.tsx    # LOX graphs
│   │   │   │   ├── fuel/page.tsx   # FUEL graphs
│   │   │   │   ├── gse/page.tsx    # GSE graphs
│   │   │   │   └── gn2/page.tsx    # GN2 graphs
│   │   │   ├── controls/page.tsx    # State machine + actuators
│   │   │   └── settings/page.tsx    # Settings page
│   │   ├── components/
│   │   │   ├── ui/                  # shadcn/ui components
│   │   │   ├── plots/
│   │   │   │   ├── TimeSeriesPlot.tsx
│   │   │   │   └── MultiSeriesPlot.tsx
│   │   │   ├── controls/
│   │   │   │   ├── StateMachinePanel.tsx
│   │   │   │   ├── StateButton.tsx
│   │   │   │   ├── ActuatorControl.tsx
│   │   │   │   └── ActuatorToggle.tsx
│   │   │   ├── dashboard/
│   │   │   │   ├── TopBar.tsx
│   │   │   │   ├── PressureGauge.tsx
│   │   │   │   └── StatusTable.tsx
│   │   │   └── websocket/
│   │   │       └── WebSocketProvider.tsx
│   │   ├── lib/
│   │   │   ├── websocket.ts         # WebSocket client
│   │   │   ├── elodin-protocol.ts   # Protocol definitions
│   │   │   └── store.ts             # Zustand store
│   │   ├── styles/
│   │   │   └── globals.css          # Tailwind + custom
│   │   ├── package.json
│   │   └── next.config.js
│   │
│   ├── backend/                     # Node.js WebSocket server
│   │   ├── src/
│   │   │   ├── server.ts            # WebSocket server
│   │   │   ├── elodin-client.ts     # Elodin DB client
│   │   │   ├── protocol/
│   │   │   │   ├── encoder.ts       # Binary encoding
│   │   │   │   └── decoder.ts      # Binary decoding
│   │   │   └── handlers/
│   │   │       ├── sensor-stream.ts # Sensor data streaming
│   │   │       ├── commands.ts      # Command handling
│   │   │       └── queries.ts       # Historical queries
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── electron/                    # Electron wrapper
│   │   ├── main.ts                  # Electron main process
│   │   ├── preload.ts               # Preload script
│   │   └── package.json
│   │
│   └── shared/                      # Shared types
│       └── types.ts                 # TypeScript definitions
│
└── docs/
    └── WEB_GUI_IMPLEMENTATION_PLAN.md (this file)
```

## Implementation Steps

### Phase 1: Backend Infrastructure
1. **Elodin DB Bridge** (Node.js)
   - TCP client to connect to Elodin DB
   - Implement Elodin protocol (packet encoding/decoding)
   - Stream sensor data (subscribe to components)
   - Handle command sending (state transitions, actuators)
   - Query historical data

2. **WebSocket Server**
   - Binary WebSocket protocol for efficiency
   - Client connection management
   - Data streaming (sensor updates every 10-50ms)
   - Command queue handling
   - Error handling and reconnection

### Phase 2: Frontend Core
1. **Next.js Setup**
   - Initialize Next.js 14 with TypeScript
   - Configure Tailwind CSS + shadcn/ui
   - Set up routing structure
   - Configure PWA for mobile

2. **WebSocket Client**
   - WebSocket connection management
   - Binary protocol handling
   - Auto-reconnect logic
   - State management (Zustand)

3. **UI Foundation**
   - Dark theme (sleek, modern)
   - Responsive layout system
   - Component library setup

### Phase 3: Core Components
1. **Plotting System**
   - uPlot integration (or Plotly.js)
   - Time-series plot component
   - Multi-series support
   - Real-time data streaming
   - Performance optimization (<30ms render)

2. **State Machine Panel**
   - Vertical/horizontal layout
   - State buttons with highlighting
   - Transition validation
   - Command sending

3. **Actuator Controls**
   - State display (OPEN/CLOSED indicators)
   - Toggle buttons
   - Real-time state updates
   - Command confirmation

4. **Top Bar Dashboard**
   - Pressure gauges (large, color-coded)
   - Current state display
   - System status indicators

### Phase 4: Advanced Features
1. **Status Tables**
   - Real-time data tables
   - Sortable/filterable columns
   - Export functionality

2. **Settings Page**
   - Configuration management
   - Theme switching
   - Connection settings

3. **Historical Data**
   - Time range selection
   - Historical plot viewing
   - Data export

### Phase 5: Desktop & Mobile
1. **Electron Integration**
   - Wrap Next.js app in Electron
   - Native window management
   - System tray integration
   - Auto-updater setup

2. **Mobile Optimization**
   - Responsive design refinement
   - Touch-optimized controls
   - PWA installation
   - Offline capability

## Performance Targets

- **Latency**: <30ms end-to-end (Elodin DB → Frontend display)
- **Plot Rendering**: <10ms per frame (60 FPS capable)
- **WebSocket Overhead**: <5ms
- **Memory**: <200MB for frontend, <100MB for backend
- **Data Rate**: Handle 100+ sensor updates/second

## UI/UX Design Principles

1. **Clean & Sleek**: Minimalist design, plenty of whitespace
2. **High Fidelity**: Sharp graphics, smooth animations
3. **Elegant**: Professional color scheme, consistent typography
4. **Easy to Use**: Intuitive layout, clear visual hierarchy
5. **Responsive**: Works beautifully on desktop, tablet, mobile
6. **Accessible**: WCAG 2.1 AA compliance

## Color Scheme

Based on current KDL:
- **GN2**: Green (#27AE60)
- **FUEL**: Blue (#3498DB)
- **LOX**: Red (#E74C3C)
- **GSE Low**: Orange (#F39C12)
- **GSE Mid**: Purple (#9B59B6)
- **Background**: Dark (#1A1A1A)
- **Cards**: Dark gray (#2D2D2D)
- **Text**: Light gray (#E0E0E0)

## Next Steps

1. Set up project structure
2. Implement Elodin DB bridge (Node.js)
3. Build WebSocket server
4. Create Next.js frontend skeleton
5. Implement core plotting
6. Add state machine controls
7. Add actuator controls
8. Polish UI/UX
9. Electron integration
10. Mobile optimization
11. Testing & refinement




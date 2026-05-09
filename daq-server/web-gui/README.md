# Sensor System Web GUI

A high-fidelity, cross-platform (web/mobile/desktop) React-based GUI for real-time sensor monitoring and control with <30ms latency.

## Architecture

- **Frontend**: Next.js 14 + React 18 + Tailwind CSS
- **Backend**: Node.js WebSocket server
- **Desktop**: Electron wrapper (coming soon)
- **Mobile**: Responsive PWA (coming soon)

## Features

- ✅ Real-time pressure plots (LOX, FUEL, GSE, GN2)
- ✅ State machine control (vertical flow, horizontal pairs)
- ✅ Actuator controls with state display
- ✅ Status tables
- ✅ WebSocket-based communication (<30ms latency)
- ✅ Dark theme with sensor color coding

## Quick Start

### Prerequisites

- Node.js 20+
- Elodin DB running on `localhost:2240`

### Option 1: Quick Start Script

```bash
./start.sh
```

This will start both backend and frontend automatically.

### Replay a past run (load existing Elodin DB)

Replay uses **elodin-db's `--replay`** flag: the DB streams stored data as live telemetry (SITL-style replay). No daq_bridge, simulator, or controller.

```bash
# Standalone script (stops any existing DB on 2240, starts past DB with --replay)
./replay_past_db.sh daq_20260306_043134

# Or via start.sh (by DB name under ~/.local/share/elodin/)
./start.sh --replay daq_20260306_043134

# Or set env and use --replay
ELODIN_DB_NAME=daq_20260306_043134 ./start.sh --replay
```

Past DBs are created when you run the full stack with `ELODIN_DB_NAME=daq_YYYYMMDD_HHMMSS` (e.g. `scripts/startup/start_tmux_dev.sh`). With `--replay`, elodin-db runs with that DB path and streams recorded data to the relay/GUI like a live run.

### Testing lag (demo mode, no hardware)

To test real-time data feed and lag fixes without hardware:

```bash
# Demo mode: synthetic PT sweep + actuator data at 50 Hz
./start.sh --demo
```

Then:
1. Open the dashboard (e.g. http://localhost:3000)
2. Watch the pressure gauges sweep (0 → POP → 0 over ~60 s)
3. Toggle actuators in DEBUG mode — actuator state updates appear in real time
4. Let it run **5–10 minutes** — if lag builds up, the sweep becomes choppy or the UI freezes

**Load test (hammer the GUI):**
```bash
# 2000 Hz demo + 200 Hz broadcast (bypasses normal 50 Hz throttle)
LOAD_TEST=1 DEMO_RATE_HZ=2000 ./start.sh --demo
```

Or max stress (4000 Hz input, 200 Hz to frontend):
```bash
LOAD_TEST=1 DEMO_RATE_HZ=4000 ./start.sh --demo
```

Run for 10+ minutes while toggling actuators and watching gauges — if lag builds, the sweep gets choppy or UI freezes.

### Option 2: Manual Setup

**Backend:**
```bash
cd backend
npm install
npm run dev
```

The WebSocket server will start on port `8081`.

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

The Next.js app will start on `http://localhost:3000`.

## Project Structure

```
web-gui/
├── backend/          # Node.js WebSocket server
│   ├── src/
│   │   ├── server.ts        # WebSocket server
│   │   └── elodin-client.ts # Elodin DB TCP client
│   └── package.json
│
├── frontend/         # Next.js React app
│   ├── app/          # Next.js app router pages
│   ├── components/   # React components (to be created)
│   └── package.json
│
├── electron/         # Electron wrapper (to be created)
└── shared/           # Shared TypeScript types
    └── types.ts
```

## Development Status

### ✅ Completed
- Project structure setup
- Backend WebSocket server with Elodin DB TCP client
- Elodin protocol parsing (RawPT, CalibratedPT, Actuator messages)
- Frontend Next.js setup with Tailwind CSS
- Shared TypeScript types
- WebSocket client with auto-reconnect
- Zustand state management
- High-performance plotting with uPlot
- Real-time time-series plots (LOX, FUEL, GSE, GN2)
- State machine control panel (vertical flow, horizontal pairs)
- Actuator controls with state display and toggle buttons
- Top bar dashboard with pressure gauges
- Status tables (Pressure, Actuators, Raw ADC)
- All plot pages (LOX, FUEL, GSE, GN2)
- Controls page
- Status page

### 📋 TODO
- Electron integration for desktop app
- Mobile optimization (responsive design, PWA)
- Historical data queries
- Settings page
- Enhanced error handling
- Performance optimizations

## Configuration

### Environment Variables

**Backend** (`backend/.env`):
```
ELODIN_HOST=127.0.0.1
ELODIN_PORT=2240
WS_PORT=8081
```

**Frontend** (`frontend/.env.local`):
```
NEXT_PUBLIC_WS_URL=ws://localhost:8081
```

## Next Steps

1. **Complete Elodin Protocol Parsing**: Parse incoming Elodin packets to extract sensor data
2. **Implement Plotting**: Add uPlot-based time-series plots
3. **Build Control UI**: Create state machine and actuator control components
4. **Add Top Bar**: Implement pressure gauges and status display
5. **Electron Integration**: Wrap Next.js app for desktop
6. **Mobile Optimization**: Responsive design and PWA features

## Performance Targets

- **Latency**: <30ms end-to-end (Elodin DB → Frontend)
- **Plot Rendering**: <10ms per frame (60 FPS capable)
- **WebSocket Overhead**: <5ms
- **Memory**: <200MB frontend, <100MB backend

## Color Scheme

- **GN2**: Green (#27AE60)
- **FUEL**: Blue (#3498DB)
- **LOX**: Red (#E74C3C)
- **GSE Low**: Orange (#F39C12)
- **GSE Mid**: Purple (#9B59B6)
- **Background**: Dark (#1A1A1A)
- **Cards**: Dark gray (#2D2D2D)

## License

MIT

# EngineDesign Web UI

React + Vite + TypeScript frontend for the pintle-injector rocket engine design and optimization pipeline. It talks to the FastAPI backend in [`../backend`](../backend) and provides an interactive interface for forward/inverse solving, the multi-layer optimizer, time-series and flight analysis, chamber geometry visualization, and the robust DDP controller.

## Overview

The UI is organized into tabs (see `src/App.tsx`), including:

- **Forward** – tank pressures → performance (thrust, Pc, Isp, mixture ratio)
- **Time Series** – transient pressure-curve analysis and plotting
- **Flight** – RocketPy flight-simulation results
- **Geometry** – chamber/nozzle contour and thermal graphics
- **Optimizer** – multi-layer design optimization (Layers 1–4)
- **Controller** – robust DDP control simulation with flight coupling
- **Config** – load/edit/upload engine configuration YAML

Charts are rendered with `recharts`; styling uses Tailwind CSS.

## Backend connection

The app calls the backend under the `/api` prefix (`API_BASE = '/api'` in `src/api/client.ts`). In development, Vite proxies `/api` to `http://localhost:8000` (see `vite.config.ts`), where the FastAPI server (`backend/main.py`) must be running.

## Quick start

The simplest way to run the full stack is the development script in the project root, which starts both the backend and this frontend together:

```bash
cd ..
./dev.sh
```

This launches the FastAPI backend on http://localhost:8000 and the frontend dev server on http://localhost:5173 (it installs frontend dependencies automatically if missing).

To run the frontend on its own (backend must be started separately):

```bash
npm install   # first time only
npm run dev
```

Then open http://localhost:5173.

## Scripts

- `npm run dev` – start the Vite dev server with HMR
- `npm run build` – type-check (`tsc -b`) and build for production
- `npm run preview` – preview the production build
- `npm run lint` – run ESLint

## Requirements

Node.js 20.19+ or 22.12+ (required by Vite). See `../STARTUP_GUIDE.md` and `../TROUBLESHOOTING.md` for setup notes.

# Quick Start

The fastest path is the dev script, which starts the backend and frontend together
(and enables the native C kernel automatically):

```bash
./dev.sh
```

Then open http://localhost:5173 in your browser.

## Manual startup

Run these from the `EngineDesign/` project root.

### Backend (FastAPI)

```bash
uvicorn backend.main:app --reload --port 8000
```

API docs: http://localhost:8000/docs · health check: http://localhost:8000/api/health

### Frontend (React + Vite)

```bash
cd frontend
npm install   # first time only
npm run dev
```

Then open http://localhost:5173 in your browser.

See `STARTUP_GUIDE.md` for first-time setup, expected warnings, and troubleshooting.

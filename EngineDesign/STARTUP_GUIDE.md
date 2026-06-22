# Startup Guide

## Quick Start

Run the development script:
```bash
./dev.sh
```

This will start:
- **Backend** (FastAPI) on http://localhost:8000
- **Frontend** (React) on http://localhost:5173

Open http://localhost:5173 in your browser.

## What the Warnings Mean

### 1. "reading cea isp data files for LOX / CH4 9800 times"

This is **normal** - it happens when:
- The CEA cache file doesn't exist yet and needs to be built
- RocketCEA library is reading ISP data files to build the cache
- This only happens once when the cache is first created (can take a few minutes)

**Solution**: Wait for it to complete. The cache will be saved to `output/cache/` (e.g. `cea_cache_LOX_CH4_3D.npz` for the default LOX/CH4 config; the exact name follows the propellants in the config) and won't need rebuilding.

### 2. "Warning: Could not load default config"

This happens when:
- The backend tries to load `configs/default.yaml` on startup
- The config references a CEA cache file that doesn't exist yet
- This is **not critical** - you can still load configs manually in the UI

**Solution**: 
- The cache directory has been created: `output/cache/`
- Once the CEA cache is built (from warning #1), this warning will go away
- Or load a config file manually in the web UI

## Manual Startup (Alternative)

If `./dev.sh` doesn't work, start services manually:

### Backend
```bash
cd /path/to/EngineDesign   # repo root
uvicorn backend.main:app --reload --port 8000
```

### Frontend (in another terminal)
```bash
cd /path/to/EngineDesign/frontend
npm run dev
```

## First-Time Setup

1. **Check Node.js version** (REQUIRED):
   ```bash
   node --version
   ```
   **Node 18+ is required** (the frontend uses Vite 5; Node 18.0+ or 20.0+ recommended). If your Node is older, upgrade first (see TROUBLESHOOTING.md)

2. **Install frontend dependencies** (REQUIRED):
   ```bash
   cd frontend
   npm install
   ```
   This creates `node_modules/` - **required before starting frontend**

3. **Create cache directory**:
   ```bash
   mkdir -p output/cache
   ```

4. **Install Python dependencies** (if not done):
   ```bash
   pip install -r requirements.txt
   ```

**Note**: The `dev.sh` script will now automatically install frontend dependencies if missing.

## Troubleshooting

### Port Already in Use
If port 8000 or 5173 is already in use:
- Kill existing processes: `pkill -f uvicorn` or `pkill -f "npm run dev"`
- Or change ports in `dev.sh`

### CEA Cache Building Takes Forever
- This is normal for first-time setup (can take 5-10 minutes)
- The cache is ~100MB and contains thermochemistry data for all pressure/MR combinations
- Once built, it's cached and won't rebuild unless you delete it

### Backend Not Connecting
- Check backend is running: `curl http://localhost:8000/api/health`
- Check frontend console for connection errors
- Verify ports match in `dev.sh`


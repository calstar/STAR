# Troubleshooting Guide

## Frontend Not Starting

### Issue: "MESA: error: ZINK: failed to choose pdev"
**Cause**: OpenGL/MESA graphics errors in WSL2 (Windows Subsystem for Linux)  
**Solution**: These are **harmless warnings** - the frontend should still work. They're suppressed in `dev.sh`.

If you see these errors but frontend still doesn't work:
1. Check if `node_modules` exists: `ls frontend/node_modules`
2. If missing, install: `cd frontend && npm install`
3. Try starting manually: `cd frontend && npm run dev`

### Issue: Frontend dependencies not installed
**Symptoms**: 
- No `node_modules/` directory in `frontend/`
- Vite fails to start
- Port 5173 not listening

**Solution**:
```bash
cd frontend
npm install
```

The `dev.sh` script now automatically installs dependencies if missing.

## Node Version Issues (CRITICAL)

### Error: "Vite requires Node.js version 20.19+ or 22.12+"
**Cause**: Vite 7 requires Node 20.19+ or 22.12+, but you have Node 18.x  
**Impact**: Frontend **will not start** - this is a hard requirement

### Solution: Upgrade Node.js

**Option 1: Using nvm (Recommended)**
```bash
# Install nvm if not installed
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc

# Install and use Node 20
nvm install 20
nvm use 20
nvm alias default 20  # Set as default

# Verify
node --version  # Should show v20.x.x
```

**Option 2: Using NodeSource (Ubuntu/Debian)**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # Should show v20.x.x
```

**Option 3: Downgrade Vite (Not Recommended)**
If you can't upgrade Node, downgrade Vite to version 5.x (compatible with Node 18):
```bash
cd frontend
npm install vite@^5.0.0 --save-dev
```

**After upgrading Node:**
```bash
cd frontend
rm -rf node_modules package-lock.json
npm install
npm run dev
```

## Backend Not Responding

### Check if backend is running:
```bash
curl http://localhost:8000/health
```

### Check if port 8000 is in use:
```bash
netstat -tuln | grep 8000
# or
ss -tuln | grep 8000
```

### Kill existing backend:
```bash
pkill -f uvicorn
```

## Port Already in Use

If you get "Address already in use":
```bash
# Find process using port
lsof -i :8000  # or :5173
# Kill it
kill <PID>
```

## CEA Cache Building Takes Forever

**Normal** - first-time cache build takes 5-10 minutes. The "reading cea isp data files" messages are expected.

Once built, cache is saved to `output/cache/` and won't rebuild.

## Frontend Shows "Backend not connected"

1. Verify backend is running: `curl http://localhost:8000/health`
2. Check browser console for errors
3. Verify ports match:
   - Backend: 8000 (in `dev.sh`)
   - Frontend: 5173 (Vite default)

## WSL2 Specific Issues

### Graphics/OpenGL Errors
- MESA errors are harmless in WSL2
- Suppressed in `dev.sh` with `LIBGL_ALWAYS_SOFTWARE=1`
- Frontend should still work

### Network Issues
- If `localhost` doesn't work, try `127.0.0.1`
- WSL2 networking can be tricky - check Windows firewall

## Still Having Issues?

1. **Check logs**: Look at terminal output from `./dev.sh`
2. **Check processes**: `ps aux | grep -E "(vite|uvicorn|node)"`
3. **Check ports**: `netstat -tuln | grep -E ":(8000|5173)"`
4. **Restart**: Kill all processes and run `./dev.sh` again


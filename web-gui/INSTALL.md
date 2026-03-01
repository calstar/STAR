# Installation Guide

## Prerequisites

- **Node.js 20+**: [Download](https://nodejs.org/)
- **npm**: Comes with Node.js
- **Elodin DB**: Running on `localhost:2240`

## Quick Install

```bash
# Install all dependencies
npm run install:all

# Or install manually:
cd backend && npm install
cd ../frontend && npm install
```

## Development

### Start Backend
```bash
cd backend
npm run dev
```

### Start Frontend
```bash
cd frontend
npm run dev
```

### Or use the tmux script:
```bash
./scripts/startup/start_tmux.sh
```

## Production Build

```bash
# Build backend
cd backend
npm run build

# Build frontend
cd frontend
npm run build
npm start
```

## Network Access

The GUI is configured to allow external connections by default.

### From Same Machine
- Frontend: `http://localhost:3000`
- WebSocket: `ws://localhost:8081`

### From Other Devices
1. Find server IP: `hostname -I` (Linux) or `ipconfig getifaddr en0` (macOS)
2. Open browser on remote device: `http://<server-ip>:3000`
3. WebSocket will auto-connect to `<server-ip>:8081`

### Firewall
```bash
# Linux (ufw)
sudo ufw allow 3000/tcp
sudo ufw allow 8081/tcp

# Linux (firewalld)
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --add-port=8081/tcp --permanent
sudo firewall-cmd --reload
```

## Troubleshooting

### Port Already in Use
```bash
# Kill processes on ports 3000 and 8081
lsof -ti:3000 | xargs kill -9
lsof -ti:8081 | xargs kill -9
```

### Dependencies Not Installing
```bash
# Clear npm cache
npm cache clean --force

# Delete node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

### WebSocket Connection Fails
- Check firewall settings
- Verify backend is running
- Check WebSocket URL in browser console

## Next Steps

- See `docs/ELECTRON_INTEGRATION_PLAN.md` for desktop app setup
- See `docs/MOBILE_OPTIMIZATION_PLAN.md` for mobile optimization
- See `docs/NETWORK_ACCESS.md` for network configuration

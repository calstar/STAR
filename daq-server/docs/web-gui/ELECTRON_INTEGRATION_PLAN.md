# Electron Integration Plan

## Overview
Package the Next.js web GUI as a native desktop application using Electron, providing a standalone executable for Windows, macOS, and Linux.

## Architecture

```
┌─────────────────────────────────────────┐
│         Electron Main Process          │
│  - Window management                   │
│  - Auto-updater                        │
│  - System tray                         │
│  - Native menus                        │
└──────────────┬──────────────────────────┘
               │ IPC
┌──────────────▼──────────────────────────┐
│      Electron Renderer Process        │
│  (Next.js app running locally)        │
│  - React components                   │
│  - WebSocket client                   │
│  - UI rendering                       │
└────────────────────────────────────────┘
               │ WebSocket
┌──────────────▼──────────────────────────┐
│      WebSocket Server (Backend)        │
│  - Elodin DB bridge                   │
│  - Data streaming                     │
└────────────────────────────────────────┘
```

## Implementation Steps

### Phase 1: Basic Electron Setup

1. **Create Electron Main Process** (`electron/main.ts`)
   - Create BrowserWindow
   - Load Next.js dev server (dev) or built app (prod)
   - Handle window lifecycle
   - Implement auto-updater

2. **Create Preload Script** (`electron/preload.ts`)
   - Expose safe APIs to renderer
   - Bridge between main and renderer processes

3. **Update Next.js Config**
   - Configure for Electron environment
   - Handle routing in Electron context
   - Optimize bundle size

4. **Build Configuration**
   - Electron Builder for packaging
   - Multi-platform builds (Windows, macOS, Linux)
   - Code signing (optional)

### Phase 2: Native Features

1. **System Tray**
   - Minimize to tray
   - Tray icon with status indicator
   - Quick actions from tray menu

2. **Native Menus**
   - File menu (Settings, Quit)
   - View menu (Zoom, DevTools)
   - Help menu (About, Documentation)

3. **Window Management**
   - Remember window size/position
   - Fullscreen support
   - Multi-window support (optional)

4. **Auto-Updater**
   - Check for updates on startup
   - Download and install updates
   - Progress notifications

### Phase 3: Integration & Polish

1. **Backend Integration**
   - Bundle backend as separate process
   - Auto-start backend with Electron
   - Process management

2. **Configuration**
   - Store settings in Electron's app data
   - User preferences persistence
   - Connection settings

3. **Error Handling**
   - Crash reporting
   - Error dialogs
   - Recovery mechanisms

## File Structure

```
web-gui/
├── electron/
│   ├── main.ts              # Main process
│   ├── preload.ts           # Preload script
│   ├── updater.ts           # Auto-updater logic
│   └── tray.ts              # System tray
│
├── frontend/                # Next.js app (unchanged)
│   └── ...
│
├── electron-builder.yml     # Build configuration
└── package.json             # Electron scripts
```

## Dependencies

### Electron
```json
{
  "electron": "^28.0.0",
  "electron-builder": "^24.9.1",
  "electron-updater": "^6.1.7"
}
```

### Dev Dependencies
```json
{
  "@types/node": "^20.11.0",
  "concurrently": "^8.2.2",
  "wait-on": "^7.2.0"
}
```

## Build Scripts

```json
{
  "scripts": {
    "electron:dev": "concurrently \"npm run dev\" \"wait-on http://localhost:3000 && electron .\"",
    "electron:build": "next build && electron-builder",
    "electron:build:win": "next build && electron-builder --win",
    "electron:build:mac": "next build && electron-builder --mac",
    "electron:build:linux": "next build && electron-builder --linux"
  }
}
```

## Configuration

### electron-builder.yml
```yaml
appId: com.sensorsystem.gui
productName: Sensor System Control Panel
directories:
  output: dist
files:
  - frontend/.next/**
  - frontend/public/**
  - electron/**
  - package.json
win:
  target: nsis
  icon: assets/icon.ico
mac:
  target: dmg
  icon: assets/icon.icns
  category: public.app-category.utilities
linux:
  target: AppImage
  icon: assets/icon.png
  category: Utility
```

## Features

### 1. Auto-Start Backend
- Electron main process spawns backend Node.js process
- Monitor backend health
- Restart on crash

### 2. System Tray
- Minimize to tray instead of closing
- Status indicator (connected/disconnected)
- Quick actions menu

### 3. Native Notifications
- Alert on critical state changes
- Connection status notifications
- Error alerts

### 4. File System Access
- Export data to CSV/JSON
- Import configurations
- Save screenshots

### 5. Keyboard Shortcuts
- Global shortcuts for critical actions
- Customizable hotkeys
- Emergency abort shortcut

## Security Considerations

1. **Context Isolation**: Enable context isolation
2. **Node Integration**: Disable in renderer
3. **Preload Script**: Only expose necessary APIs
4. **Content Security Policy**: Strict CSP headers
5. **Code Signing**: Sign executables (optional)

## Distribution

### Windows
- NSIS installer (.exe)
- Portable version (.zip)
- Auto-updater support

### macOS
- DMG package
- Code signing required for distribution
- Notarization for Gatekeeper

### Linux
- AppImage (universal)
- .deb package (Debian/Ubuntu)
- .rpm package (Fedora/RHEL)

## Timeline

- **Week 1**: Basic Electron setup, window management
- **Week 2**: Native features (tray, menus, notifications)
- **Week 3**: Backend integration, auto-updater
- **Week 4**: Testing, packaging, distribution

## Next Steps

1. Install Electron dependencies
2. Create main process file
3. Set up build configuration
4. Test in development mode
5. Create installers for all platforms

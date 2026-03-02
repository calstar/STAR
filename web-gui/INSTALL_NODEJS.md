# Node.js Installation Guide

## Quick Install (Automated)

```bash
cd /path/to/Diablo-FSW/web-gui
./install_nodejs.sh
```

## Manual Installation

### Ubuntu/Debian

```bash
# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node -v  # Should show v20.x.x or higher
npm -v   # Should show version number
```

### Fedora/RHEL/CentOS

```bash
# Install Node.js 20.x
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
# OR for newer Fedora:
sudo dnf install -y nodejs

# Verify installation
node -v
npm -v
```

### Arch/Manjaro

```bash
sudo pacman -S nodejs npm

# Verify installation
node -v
npm -v
```

### macOS

```bash
# Using Homebrew
brew install node@20

# Or download from https://nodejs.org/
```

### Generic Linux (Binary Install)

```bash
# Download and install Node.js 20.x
cd /tmp
wget https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-x64.tar.xz
tar -xf node-v20.11.0-linux-x64.tar.xz
sudo cp -r node-v20.11.0-linux-x64/* /usr/local/

# Add to PATH (if not already)
export PATH=/usr/local/bin:$PATH

# Verify
node -v
npm -v
```

## Install Web GUI Dependencies

After Node.js is installed:

```bash
cd /path/to/Diablo-FSW/web-gui

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

## Verify Everything Works

```bash
# Check Node.js version (should be 20+)
node -v

# Check npm version
npm -v

# Test backend
cd web-gui/backend
npm run dev
# Should start WebSocket server on port 8081

# Test frontend (in another terminal)
cd web-gui/frontend
npm run dev
# Should start Next.js on port 3000
```

## Troubleshooting

### "node: command not found"
- Node.js is not in PATH
- Try: `export PATH=/usr/local/bin:$PATH`
- Or reinstall Node.js

### "npm: command not found"
- npm didn't install with Node.js
- Try: `sudo apt-get install npm` (Ubuntu/Debian)
- Or reinstall Node.js

### Permission Errors
- Don't use `sudo npm install` (causes issues)
- Fix npm permissions: `sudo chown -R $(whoami) ~/.npm`
- Or use a Node version manager (nvm)

### Port Already in Use
```bash
# Kill processes on ports 3000 and 8081
sudo lsof -ti:3000 | xargs kill -9
sudo lsof -ti:8081 | xargs kill -9
```

## Using Node Version Manager (nvm) - Recommended

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Reload shell
source ~/.bashrc

# Install Node.js 20
nvm install 20
nvm use 20
nvm alias default 20

# Verify
node -v
npm -v
```

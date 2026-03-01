<#
.SYNOPSIS
    Setup script for the Sensor System on Windows.
    This script initializes submodules, sets up a Python virtual environment,
    installs Python dependencies, and installs Node.js dependencies for the Web GUI.

.DESCRIPTION
    Running this script will:
    1. Initialize and update Git submodules.
    2. Create a Python virtual environment (.venv).
    3. Install Python dependencies from requirements.txt.
    4. Install Node.js dependencies for the Backend.
    5. Install Node.js dependencies for the Frontend.
    6. (Optional) Provide information on building C++ components.
#>

# Stop script on error
$ErrorActionPreference = "Stop"

# Helper for headers
function Write-Header($msg) {
    Write-Host "`n" + ("=" * 50) -ForegroundColor Cyan
    Write-Host " $msg" -ForegroundColor Cyan -NoNewline
    Write-Host (" " + ("=" * (49 - $msg.Length))) -ForegroundColor Cyan
}

Write-Header "Starting Sensor System Setup (Windows)"

# ---------------------------------------------------------
# Check for Prerequisites
# ---------------------------------------------------------
Write-Header "Checking Prerequisites"

function Check-Command($cmd, $helpUrl) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        Write-Host " [OK] $cmd is installed." -ForegroundColor Green
    } else {
        Write-Host " [!] $cmd is NOT found in PATH." -ForegroundColor Red
        Write-Host " Please install $cmd and restart this script." -ForegroundColor Yellow
        Write-Host " Visit: $helpUrl" -ForegroundColor Gray
        exit 1
    }
}

Check-Command "git" "https://git-scm.com/"

# Check Python (could be 'python' or 'py')
$pythonCmd = "python"
if (-not (Get-Command "python" -ErrorAction SilentlyContinue)) {
    if (Get-Command "py" -ErrorAction SilentlyContinue) {
        $pythonCmd = "py"
    } else {
        Write-Host " [!] Python is NOT found." -ForegroundColor Red
        Write-Host " Please install Python 3.8+ (ensure 'Add to PATH' is checked)." -ForegroundColor Yellow
        exit 1
    }
}
Write-Host " [OK] Using $pythonCmd for Python operations." -ForegroundColor Green

Check-Command "node" "https://nodejs.org/"
Check-Command "npm" "https://nodejs.org/"

# ---------------------------------------------------------
# Step 1: Initialize Submodules
# ---------------------------------------------------------
Write-Header "Step 1: Initializing Git Submodules"
try {
    Write-Host " Running: git submodule update --init --recursive"
    git submodule update --init --recursive
    Write-Host " Submodules initialized successfully." -ForegroundColor Green
} catch {
    Write-Host " [!] Submodule initialization failed. Check your internet connection or SSH keys." -ForegroundColor Yellow
}

# ---------------------------------------------------------
# Step 2: Set up Python Virtual Environment
# ---------------------------------------------------------
Write-Header "Step 2: Setting up Python Environment"
$venvDir = ".venv"

if (-not (Test-Path $venvDir)) {
    Write-Host " Creating virtual environment in $venvDir..."
    & $pythonCmd -m venv $venvDir
} else {
    Write-Host " Virtual environment already exists."
}

Write-Host " Upgrading pip and installing requirements..."
# Use python -m pip to ensure it uses the venv when called properly
& "$venvDir\Scripts\python.exe" -m pip install --upgrade pip
& "$venvDir\Scripts\python.exe" -m pip install -r requirements.txt

Write-Host " Python environment setup complete." -ForegroundColor Green

# ---------------------------------------------------------
# Step 3: Set up Web GUI (Node.js)
# ---------------------------------------------------------
Write-Header "Step 3: Setting up Node.js Environments"

# Backend
Write-Host " Setting up Backend (web-gui/backend)..."
Push-Location "web-gui/backend"
npm install
Pop-Location

# Frontend
Write-Host " Setting up Frontend (web-gui/frontend)..."
Push-Location "web-gui/frontend"
npm install
Pop-Location

Write-Host " Node.js dependencies installed successfully." -ForegroundColor Green

# ---------------------------------------------------------
# Step 4: C++ Build Hint
# ---------------------------------------------------------
Write-Header "Step 4: C++ Build Information"

if (Get-Command "cmake" -ErrorAction SilentlyContinue) {
    Write-Host " CMake is available. To build C++ components, you can run:" -ForegroundColor Gray
    Write-Host "   mkdir build; cd build; cmake ..; cmake --build ." -ForegroundColor Cyan
} else {
    Write-Host " [!] CMake is not installed. C++ components will not be built automatically." -ForegroundColor Yellow
    Write-Host " [!] These components are mostly required for Flight Software logic." -ForegroundColor Yellow
}

# ---------------------------------------------------------
# Summary
# ---------------------------------------------------------
Write-Header "Setup Complete!"
Write-Host " To start the system:" -ForegroundColor Cyan
Write-Host " 1. Activate Python: .\.venv\Scripts\Activate.ps1" -ForegroundColor Gray
Write-Host " 2. Start Backend:   cd web-gui\backend; npm run dev" -ForegroundColor Gray
Write-Host " 3. Start Frontend:  cd web-gui\frontend; npm run dev" -ForegroundColor Gray
Write-Host " 4. Start Control:   python scripts\calibration\calibration_server.py" -ForegroundColor Gray
Write-Host "`n Enjoy your Sensor System setup!`n" -ForegroundColor Green

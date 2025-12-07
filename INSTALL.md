# Installation Guide

## System Requirements

- **Operating System**: Linux (Ubuntu 20.04+), macOS (10.15+)
- **Python**: 3.8 or higher
- **C++ Compiler**: GCC 10+ or Clang 12+ (for C++ components)
- **CMake**: 3.16 or higher
- **Memory**: 4 GB RAM minimum, 8 GB recommended
- **Disk Space**: 500 MB for installation + data storage

## Quick Install

### 1. Clone Repository

```bash
git clone <repository-url>
cd sensor_system
```

### 2. Install Python Dependencies

```bash
pip install -r requirements.txt
```

Or with virtual environment (recommended):

```bash
python3 -m venv venv
source venv/bin/activate  # On Linux/macOS
# venv\Scripts\activate  # On Windows
pip install -r requirements.txt
```

### 3. Build C++ Components

```bash
mkdir build && cd build
cmake ..
make -j$(nproc)
cd ..
```

### 4. Install Elodin Database

Follow the Elodin installation instructions from the official repository.

## Detailed Installation

### Python Dependencies

#### Core Dependencies (Required)

```bash
pip install numpy>=1.21.0
pip install scipy>=1.7.0
pip install PyQt6>=6.4.0
pip install pyqtgraph>=0.13.0
pip install matplotlib>=3.5.0
pip install pyserial>=3.5
pip install psutil>=5.9.0
```

#### Platform-Specific Notes

**Linux (Ubuntu/Debian)**:
```bash
# Install system dependencies first
sudo apt update
sudo apt install -y python3-dev python3-pip build-essential cmake
sudo apt install -y libgl1-mesa-glx  # For PyQt6 graphics
sudo apt install -y libxkbcommon-x11-0  # For Qt keyboard support

# Then install Python packages
pip install -r requirements.txt
```

**macOS**:
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Python and dependencies
brew install python@3.10
brew install cmake

# Install Python packages
pip3 install -r requirements.txt
```

**macOS with Apple Silicon (M1/M2)**:
```bash
# Use Rosetta for compatibility if needed
arch -arm64 pip3 install -r requirements.txt

# Or install native ARM versions
pip3 install --platform=macosx_11_0_arm64 --only-binary=:all: -r requirements.txt
```

### C++ Build Dependencies

**Linux**:
```bash
sudo apt install -y build-essential cmake g++ gcc
sudo apt install -y libc++-dev libc++abi-dev  # For Clang
```

**macOS**:
```bash
xcode-select --install  # Install Xcode Command Line Tools
brew install cmake
```

### Verify Installation

```bash
# Check Python version
python3 --version  # Should be 3.8+

# Check installed packages
pip list | grep -E "numpy|scipy|PyQt6|pyqtgraph|matplotlib|pyserial|psutil"

# Check C++ build
cd build
ls -la  # Should see compiled binaries
```

## Calibration System Setup

### Initial Configuration

1. **Create necessary directories**:
```bash
cd scripts
mkdir -p calibration_backups calibration_logs
```

2. **Initialize system configuration**:
```bash
python3 start_calibration_system.py --mode test
# This creates system_config.json automatically
```

3. **Verify robustness module**:
```bash
python3 test_robustness_system.py
# Should see: "Total tests: 7, Passed: 7 ✅"
```

## Troubleshooting

### Common Issues

#### 1. "ModuleNotFoundError: No module named 'PyQt6'"

**Solution**:
```bash
pip install PyQt6 pyqtgraph
```

If still fails on Linux:
```bash
sudo apt install -y python3-pyqt6 python3-pyqt6.sip
```

#### 2. "ImportError: libGL.so.1: cannot open shared object file"

**Solution** (Linux):
```bash
sudo apt install -y libgl1-mesa-glx libglib2.0-0
```

#### 3. "numpy.core._multiarray_umath failed to import"

**Solution**:
```bash
pip uninstall numpy
pip install numpy==1.24.3
```

#### 4. Serial port permission denied

**Solution** (Linux):
```bash
sudo usermod -a -G dialout $USER
# Log out and log back in for changes to take effect
```

#### 5. CMake version too old

**Solution** (Ubuntu 18.04/20.04):
```bash
sudo apt remove cmake
sudo snap install cmake --classic
```

#### 6. PyQt6 crashes on startup

**Solution**:
```bash
# Try using PyQt5 instead (modify imports in scripts)
pip uninstall PyQt6
pip install PyQt5 pyqtgraph
# Update imports: from PyQt6 → from PyQt5
```

### Development Environment Setup

For contributors and developers:

```bash
# Install development dependencies
pip install pytest pytest-cov black flake8 mypy

# Run tests
cd scripts
python3 -m pytest

# Format code
black .

# Lint code
flake8 . --max-line-length=120

# Type checking
mypy . --ignore-missing-imports
```

## Virtual Environment Setup (Recommended)

### Using venv (Built-in)

```bash
# Create virtual environment
python3 -m venv sensor_env

# Activate
source sensor_env/bin/activate  # Linux/macOS
# sensor_env\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt

# Deactivate when done
deactivate
```

### Using conda

```bash
# Create environment
conda create -n sensor_system python=3.10

# Activate
conda activate sensor_system

# Install dependencies
pip install -r requirements.txt

# Deactivate
conda deactivate
```

## System Verification

Run the full system check:

```bash
cd scripts
python3 << 'EOF'
import sys
import importlib

print(f"Python version: {sys.version}")
print("\nChecking dependencies:")

dependencies = [
    'numpy', 'scipy', 'PyQt6', 'pyqtgraph', 
    'matplotlib', 'serial', 'psutil'
]

for dep in dependencies:
    try:
        mod = importlib.import_module(dep)
        version = getattr(mod, '__version__', 'unknown')
        print(f"  ✅ {dep:15s} {version}")
    except ImportError:
        print(f"  ❌ {dep:15s} NOT INSTALLED")

print("\nSystem check complete!")
EOF
```

Expected output:
```
Python version: 3.10.x
Checking dependencies:
  ✅ numpy           1.24.3
  ✅ scipy           1.10.1
  ✅ PyQt6           6.5.1
  ✅ pyqtgraph       0.13.3
  ✅ matplotlib      3.7.1
  ✅ serial          3.5
  ✅ psutil          5.9.5
System check complete!
```

## Docker Installation (Optional)

For containerized deployment:

```dockerfile
# Dockerfile
FROM ubuntu:22.04

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3.10 python3-pip \
    build-essential cmake \
    libgl1-mesa-glx \
    && rm -rf /var/lib/apt/lists/*

# Copy project
WORKDIR /app
COPY requirements.txt .
RUN pip3 install -r requirements.txt

COPY . .

# Build C++ components
RUN mkdir build && cd build && cmake .. && make

# Run calibration system
CMD ["python3", "scripts/channel_plotter.py"]
```

Build and run:
```bash
docker build -t sensor_system .
docker run -it --rm sensor_system
```

## Post-Installation

### Test the System

1. **Test Python GUI**:
```bash
cd scripts
python3 channel_plotter.py
# GUI should launch without errors
```

2. **Test robustness features**:
```bash
python3 test_robustness_system.py
# All 7 tests should pass
```

3. **Test autonomous learning**:
```bash
python3 autonomous_calibration_engine.py
# Should see demo output
```

### Configure for Your Hardware

1. Edit `config/esp32_config.toml` for your ESP32 setup
2. Update serial port in scripts if needed
3. Adjust sensor ranges in `channel_plotter.py`

## Getting Help

- **Documentation**: See `docs/` directory
- **Issues**: Check GitHub issues
- **Email**: See project maintainers

## Next Steps

After successful installation:

1. Read `README.md` for system overview
2. Review `docs/AUTONOMOUS_CALIBRATION_SYSTEM.md` for calibration guide
3. Run `scripts/start_calibration_system.py` to begin
4. See `docs/QUICK_START.md` for usage examples

## Uninstall

To completely remove the system:

```bash
# Remove Python packages
pip uninstall -y numpy scipy PyQt6 pyqtgraph matplotlib pyserial psutil

# Remove virtual environment (if used)
rm -rf venv/ sensor_env/

# Remove build files
rm -rf build/

# Remove data files (careful!)
rm -rf scripts/calibration_backups/
rm -rf scripts/calibration_logs/
rm -f scripts/*.json
```

---

**Installation Date**: December 2025  
**Version**: 3.0  
**Status**: ✅ Production Ready


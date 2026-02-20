# How to Pull All Submodules and Updates

This repository has **4 submodules**:
- `engine_sim` - Engine simulation code
- `external/DAQv2-Comms` - Communication library
- `external/DiabloAvionics` - Avionics code and GUIs
- `external/flash` - Flash utilities

## Quick Start (Easiest Method)

**Use the provided script:**
```bash
./scripts/setup/pull_all.sh
```

## Initial Clone (First Time)

If you're cloning the repository for the first time, use:

```bash
# Clone with all submodules recursively
git clone --recurse-submodules https://github.com/calstar/Diablo-FSW.git
cd Diablo-FSW

# OR if you already cloned without submodules:
git clone https://github.com/calstar/Diablo-FSW.git
cd Diablo-FSW
git submodule update --init --recursive
```

## Updating Existing Repository

If you already have the repository cloned, use these commands:

### Option 1: Pull Everything (Recommended)
```bash
# Pull main repository changes
git pull

# Update all submodules to latest commits
git submodule update --remote --recursive

# OR pull recursively in one command
git pull --recurse-submodules
```

### Option 2: Step by Step
```bash
# 1. Pull main repository
git pull

# 2. Initialize submodules if needed
git submodule update --init --recursive

# 3. Update all submodules to their latest commits
git submodule update --remote --recursive

# 4. Pull changes in each submodule
git submodule foreach git pull
```

### Option 3: One-Liner (Most Complete)
```bash
# Pull main repo and all submodules recursively
git pull --recurse-submodules && git submodule update --remote --recursive
```

## Common Commands Reference

```bash
# Check submodule status
git submodule status

# Initialize all submodules
git submodule init

# Update submodules to commit referenced by main repo
git submodule update

# Update submodules to latest on their remote branches
git submodule update --remote

# Recursively handle nested submodules
git submodule update --recursive

# Pull in each submodule
git submodule foreach git pull

# Update submodule to specific branch
git submodule update --remote --merge
```

## Troubleshooting

If submodules are out of sync:

```bash
# Reset submodules to match main repo references
git submodule update --init --recursive --force

# If submodule has local changes, you may need to:
cd external/DiabloAvionics  # or other submodule
git stash
git pull
git stash pop
```

## Quick Reference Card

**First time setup:**
```bash
git clone --recurse-submodules <repo-url>
```

**Regular updates:**
```bash
git pull --recurse-submodules
git submodule update --remote --recursive
```

**Check what needs updating:**
```bash
git submodule status
```


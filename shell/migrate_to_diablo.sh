#!/usr/bin/env bash
set -euo pipefail

# Migration script for moving sensor system to Diablo-FSW repository

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

DIABLO_REPO_URL="git@github.com:calstar/Diablo-FSW.git"
DIABLO_DIR="$HOME/Diablo-FSW"
SENSOR_TARGET_DIR="$DIABLO_DIR/telemetry/sensor_system"

print_banner() {
    echo -e "${CYAN}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║                🚀 DIABLO-FSW MIGRATION 🚀              ║${NC}"
    echo -e "${CYAN}║                                                        ║${NC}"
    echo -e "${CYAN}║    Moving sensor system to Diablo-FSW repository       ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════╝${NC}"
    echo
}

check_prerequisites() {
    echo -e "${BLUE}🔍 Checking prerequisites...${NC}"

    # Check if we're in the right directory (should be shell/ directory)
    if [[ ! -f "../startup.sh" || ! -d "../scripts" || ! -d "../config" ]]; then
        echo -e "${RED}❌ Please run this script from the shell/ directory${NC}"
        echo -e "${YELLOW}💡 Usage: cd shell && ./migrate_to_diablo.sh${NC}"
        exit 1
    fi

    # Check if git is available
    if ! command -v git &> /dev/null; then
        echo -e "${RED}❌ Git is not installed${NC}"
        exit 1
    fi

    # Check SSH key for GitHub
    if ! ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
        echo -e "${YELLOW}⚠️  Warning: GitHub SSH authentication may not be set up${NC}"
        echo -e "${BLUE}   You may need to enter credentials during clone${NC}"
    fi

    echo -e "${GREEN}✅ Prerequisites check complete${NC}"
    echo
}

clone_or_update_diablo() {
    echo -e "${BLUE}📥 Setting up Diablo-FSW repository...${NC}"

    if [[ -d "$DIABLO_DIR" ]]; then
        echo -e "${YELLOW}📁 Diablo-FSW directory already exists${NC}"
        read -p "Update existing repository? [Y/n]: " update_repo
        if [[ ! "$update_repo" =~ ^[Nn]$ ]]; then
            echo -e "${BLUE}🔄 Updating existing repository...${NC}"
            cd "$DIABLO_DIR"
            git pull origin main || git pull origin master
            cd - > /dev/null
        fi
    else
        echo -e "${BLUE}📥 Cloning Diablo-FSW repository...${NC}"
        git clone "$DIABLO_REPO_URL" "$DIABLO_DIR"
    fi

    echo -e "${GREEN}✅ Diablo-FSW repository ready${NC}"
    echo
}

copy_sensor_system() {
    echo -e "${BLUE}📋 Copying sensor system files...${NC}"

    # Create target directory
    mkdir -p "$SENSOR_TARGET_DIR"

    # Copy all directories
    echo -e "${BLUE}  📁 Copying directories...${NC}"
    for dir in scripts config comms utl shell groundstation external; do
        if [[ -d "$dir" ]]; then
            echo -e "${BLUE}    $dir/ → telemetry/sensor_system/$dir/${NC}"
            cp -r "$dir" "$SENSOR_TARGET_DIR/"
        fi
    done

    # Copy root files
    echo -e "${BLUE}  📄 Copying root files...${NC}"
    files_to_copy=(
        "quick_start.sh"
        "shutdown_system.sh"
        "startup.sh"
        "CMakeLists.txt"
        "build.sh"
        "README.md"
        "QUICK_START.md"
        "DEPLOYMENT.md"
        "MIGRATION_TO_DIABLO.md"
        ".gitignore"
    )

    for file in "${files_to_copy[@]}"; do
        if [[ -f "$file" ]]; then
            echo -e "${BLUE}    $file → telemetry/sensor_system/$file${NC}"
            cp "$file" "$SENSOR_TARGET_DIR/"
        fi
    done

    echo -e "${GREEN}✅ Files copied successfully${NC}"
    echo
}

update_paths_for_diablo() {
    echo -e "${BLUE}🔧 Updating paths for Diablo-FSW structure...${NC}"

    # Update startup.sh
    if [[ -f "$SENSOR_TARGET_DIR/startup.sh" ]]; then
        echo -e "${BLUE}  📝 Updating startup.sh paths...${NC}"
        sed -i.bak "s|ROOT_SENSOR_DIR=.*|ROOT_SENSOR_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"|g" "$SENSOR_TARGET_DIR/startup.sh"
    fi

    # Make scripts executable
    echo -e "${BLUE}  🔧 Making scripts executable...${NC}"
    chmod +x "$SENSOR_TARGET_DIR"/*.sh
    chmod +x "$SENSOR_TARGET_DIR/config/generate_configs.py"

    echo -e "${GREEN}✅ Path updates complete${NC}"
    echo
}

update_diablo_gitignore() {
    echo -e "${BLUE}📝 Updating Diablo-FSW .gitignore...${NC}"

    local diablo_gitignore="$DIABLO_DIR/.gitignore"

    # Add sensor system specific entries to main .gitignore
    if [[ -f "$diablo_gitignore" ]]; then
        # Check if sensor system section already exists
        if ! grep -q "# Sensor System" "$diablo_gitignore"; then
            echo -e "${BLUE}  Adding sensor system entries to main .gitignore...${NC}"
            cat >> "$diablo_gitignore" <<EOF

# Sensor System / Telemetry
telemetry/sensor_system/build/
telemetry/sensor_system/logs/
telemetry/sensor_system/**/*.log
telemetry/sensor_system/shell/last_run.txt
telemetry/sensor_system/groundstation/scripts/last_run.txt
telemetry/sensor_system/scripts/fake_sensor_generator
telemetry/sensor_system/scripts/fake_sensor_generator_remote

# Elodin Database
**/.local/share/elodin/
*_metadata/

# Generated configs
telemetry/sensor_system/config/config_dev.toml
telemetry/sensor_system/config/config_prod.toml
telemetry/sensor_system/config/config_jetson_enhanced.toml
telemetry/sensor_system/config/config_groundstation_enhanced.toml
EOF
        else
            echo -e "${YELLOW}  Sensor system entries already exist in .gitignore${NC}"
        fi
    else
        echo -e "${BLUE}  Creating new .gitignore for Diablo-FSW...${NC}"
        cp "$SENSOR_TARGET_DIR/.gitignore" "$diablo_gitignore"
    fi

    echo -e "${GREEN}✅ .gitignore updated${NC}"
    echo
}

create_diablo_integration() {
    echo -e "${BLUE}🔗 Creating Diablo-FSW integration files...${NC}"

    # Create telemetry README
    cat > "$DIABLO_DIR/telemetry/README.md" <<EOF
# Diablo-FSW Telemetry System

Real-time telemetry collection and monitoring for the Diablo Flight Software.

## Components

### Sensor System (\`sensor_system/\`)
Comprehensive sensor data collection with support for:
- PT (Pressure/Temperature) sensors
- TC (Thermocouple) sensors
- RTD (Temperature) sensors
- IMU (Inertial Measurement Unit)
- Barometer sensors
- GPS position/velocity

### Quick Start
\`\`\`bash
cd sensor_system
./quick_start.sh
\`\`\`

### Clean Shutdown
\`\`\`bash
cd sensor_system
./shutdown_system.sh
\`\`\`

See \`sensor_system/README.md\` for detailed documentation.
EOF

    # Update main Diablo-FSW README if it exists
    if [[ -f "$DIABLO_DIR/README.md" ]]; then
        echo -e "${BLUE}  📝 Updating main Diablo-FSW README...${NC}"

        # Add telemetry section if it doesn't exist
        if ! grep -q "telemetry" "$DIABLO_DIR/README.md"; then
            cat >> "$DIABLO_DIR/README.md" <<EOF

## Telemetry System

Real-time sensor data collection and visualization system.

### Quick Start
\`\`\`bash
cd telemetry/sensor_system
./quick_start.sh
\`\`\`

See \`telemetry/README.md\` for detailed documentation.
EOF
        fi
    fi

    echo -e "${GREEN}✅ Integration files created${NC}"
    echo
}

print_migration_summary() {
    echo -e "${GREEN}🎉 Migration Complete!${NC}"
    echo
    echo -e "${CYAN}📊 Migration Summary:${NC}"
    echo -e "${BLUE}  Source: $(pwd)${NC}"
    echo -e "${BLUE}  Target: $SENSOR_TARGET_DIR${NC}"
    echo -e "${BLUE}  Repository: $DIABLO_REPO_URL${NC}"
    echo
    echo -e "${CYAN}🚀 Next Steps:${NC}"
    echo -e "${BLUE}  1. cd $DIABLO_DIR${NC}"
    echo -e "${BLUE}  2. git add telemetry/${NC}"
    echo -e "${BLUE}  3. git commit -m \"Add sensor telemetry system\"${NC}"
    echo -e "${BLUE}  4. git push origin main${NC}"
    echo
    echo -e "${CYAN}🧪 Test the Migration:${NC}"
    echo -e "${BLUE}  cd $SENSOR_TARGET_DIR${NC}"
    echo -e "${BLUE}  ./quick_start.sh diablo_test${NC}"
    echo
    echo -e "${YELLOW}💡 Don't forget to update team documentation!${NC}"
}

main() {
    print_banner

    echo -e "${CYAN}This script will migrate the sensor system to the Diablo-FSW repository.${NC}"
    echo -e "${YELLOW}Target location: $SENSOR_TARGET_DIR${NC}"
    echo

    read -p "Continue with migration? [Y/n]: " confirm
    if [[ "$confirm" =~ ^[Nn]$ ]]; then
        echo -e "${RED}❌ Migration cancelled${NC}"
        exit 0
    fi

    check_prerequisites
    clone_or_update_diablo
    copy_sensor_system
    update_paths_for_diablo
    update_diablo_gitignore
    create_diablo_integration
    print_migration_summary
}

main "$@"

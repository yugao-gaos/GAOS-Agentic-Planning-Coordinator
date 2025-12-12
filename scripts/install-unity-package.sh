#!/bin/bash
# install-unity-package.sh
# Installs the APC Unity Bridge package into a Unity project's Packages folder
#
# Usage:
#   ./install-unity-package.sh [project-path]
#
# If project-path is not specified, uses the current directory if it's a Unity project.

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  APC Unity Bridge Package Installer   ${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Find script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(dirname "$SCRIPT_DIR")"

# Find Unity package source
PACKAGE_SOURCE="$EXTENSION_ROOT/unity-package/com.gaos.apc.bridge"

if [ ! -d "$PACKAGE_SOURCE" ]; then
    echo -e "${RED}Error: Unity package not found at: $PACKAGE_SOURCE${NC}"
    echo -e "${RED}Make sure you're running this from the APC extension directory.${NC}"
    exit 1
fi

echo -e "${CYAN}Package source: $PACKAGE_SOURCE${NC}"

# Determine Unity project path
PROJECT_PATH="$1"

if [ -z "$PROJECT_PATH" ]; then
    # Check if current directory is a Unity project
    if [ -d "./Assets" ]; then
        PROJECT_PATH="$(pwd)"
        echo -e "${CYAN}Detected Unity project: $PROJECT_PATH${NC}"
    else
        echo "Enter the path to your Unity project (must contain 'Assets' folder):"
        read -r PROJECT_PATH
    fi
fi

# Expand path
PROJECT_PATH="$(cd "$PROJECT_PATH" 2>/dev/null && pwd)" || {
    echo -e "${RED}Error: Invalid path: $PROJECT_PATH${NC}"
    exit 1
}

# Validate Unity project
if [ ! -d "$PROJECT_PATH/Assets" ]; then
    echo -e "${RED}Error: '$PROJECT_PATH' is not a Unity project (no 'Assets' folder found)${NC}"
    exit 1
fi

PACKAGES_PATH="$PROJECT_PATH/Packages"
if [ ! -d "$PACKAGES_PATH" ]; then
    echo -e "${CYAN}Creating Packages folder...${NC}"
    mkdir -p "$PACKAGES_PATH"
fi

# Target path for the package
TARGET_PATH="$PACKAGES_PATH/com.gaos.apc.bridge"

# Check if already installed
if [ -d "$TARGET_PATH" ]; then
    echo -e "${YELLOW}APC Unity Bridge package already exists at: $TARGET_PATH${NC}"
    echo "Do you want to reinstall? (y/n)"
    read -r response
    if [ "$response" != "y" ] && [ "$response" != "Y" ]; then
        echo -e "${CYAN}Installation cancelled.${NC}"
        exit 0
    fi
    echo -e "${CYAN}Removing existing installation...${NC}"
    rm -rf "$TARGET_PATH"
fi

# Copy the package
echo -e "${CYAN}Installing APC Unity Bridge package...${NC}"
cp -r "$PACKAGE_SOURCE" "$TARGET_PATH"

# Verify installation
if [ -f "$TARGET_PATH/package.json" ]; then
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Installation Successful!              ${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "${CYAN}Package installed to: $TARGET_PATH${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Open or refresh your Unity project"
    echo "  2. The APC status icon should appear in the toolbar"
    echo "  3. Click the icon to open settings and connect to the daemon"
    echo ""
else
    echo -e "${RED}Error: Installation failed - package.json not found${NC}"
    exit 1
fi


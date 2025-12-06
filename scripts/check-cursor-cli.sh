#!/bin/bash
# Shell script to check Cursor CLI installation and dependencies
# Works on macOS, Linux, and WSL
# This script checks both the basic 'cursor' command and the new 'cursor-agent' CLI

set -o pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Emoji/Symbols
CHECK_MARK="✓"
CROSS_MARK="✗"
INFO="ℹ"
WARNING="⚠"

# Helper functions
write_success() { echo -e "${GREEN}${CHECK_MARK} $1${NC}"; }
write_error() { echo -e "${RED}${CROSS_MARK} $1${NC}"; }
write_info() { echo -e "${CYAN}${INFO} $1${NC}"; }
write_warning() { echo -e "${YELLOW}${WARNING} $1${NC}"; }
write_header() { echo -e "${MAGENTA}$1${NC}"; }

ALL_PASSED=true
VERBOSE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [-v|--verbose] [-h|--help]"
            echo "  -v, --verbose    Show detailed information"
            echo "  -h, --help       Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

write_header "\n=== Cursor CLI Dependency Checker ==="
echo "Checking Cursor CLI installation and configuration..."
echo ""

# ============================================================================
# Check 1: Basic Cursor Command
# ============================================================================
write_info "Checking 'cursor' command (basic Cursor CLI)..."
if command -v cursor &> /dev/null; then
    CURSOR_PATH=$(which cursor)
    CURSOR_VERSION=$(cursor --version 2>&1 | head -n1)
    write_success "Cursor command found at: $CURSOR_PATH"
    write_success "Version: $CURSOR_VERSION"
else
    write_error "Cursor command not found in PATH"
    write_warning "The basic 'cursor' command is required to open Cursor from command line"
    write_info "To install: Open Cursor → Command Palette (Cmd/Ctrl+Shift+P) → Type 'Install cursor command'"
    ALL_PASSED=false
fi

# ============================================================================
# Check 2: Cursor Agent CLI (New feature)
# ============================================================================
echo ""
write_info "Checking 'cursor-agent' command (Cursor Agent CLI)..."
if command -v cursor-agent &> /dev/null; then
    CURSOR_AGENT_PATH=$(which cursor-agent)
    CURSOR_AGENT_VERSION=$(cursor-agent --version 2>&1)
    write_success "Cursor Agent command found at: $CURSOR_AGENT_PATH"
    write_success "Version: $CURSOR_AGENT_VERSION"
else
    write_error "Cursor Agent CLI (cursor-agent) not found"
    write_error "This is REQUIRED for the project to function properly"
    write_info "To install:"
    echo -e "  ${YELLOW}curl https://cursor.com/install -fsS | bash${NC}"
    write_info "See: https://cursor.com/docs/cli/installation"
    ALL_PASSED=false
fi

# ============================================================================
# Check 3: PATH Configuration
# ============================================================================
echo ""
write_info "Checking PATH configuration..."

if [ -d "$HOME/.local/bin" ]; then
    write_success "~/.local/bin directory exists"
    
    if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
        write_success "~/.local/bin is in PATH"
    else
        write_warning "~/.local/bin exists but is not in PATH"
        write_info "Add to PATH by running:"
        echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
        echo "  source ~/.bashrc"
    fi
else
    write_info "~/.local/bin directory does not exist (normal if cursor-agent not installed)"
fi

# ============================================================================
# Check 4: Shell Configuration
# ============================================================================
echo ""
write_info "Checking shell configuration..."
SHELL_NAME=$(basename "$SHELL")
write_info "Current shell: $SHELL_NAME"

case "$SHELL_NAME" in
    bash)
        SHELL_RC="$HOME/.bashrc"
        ;;
    zsh)
        SHELL_RC="$HOME/.zshrc"
        ;;
    fish)
        SHELL_RC="$HOME/.config/fish/config.fish"
        ;;
    *)
        SHELL_RC=""
        ;;
esac

if [ -n "$SHELL_RC" ] && [ -f "$SHELL_RC" ]; then
    write_success "Shell config found: $SHELL_RC"
    
    if $VERBOSE; then
        if grep -q "\.local/bin" "$SHELL_RC" 2>/dev/null; then
            write_info "  PATH configuration for ~/.local/bin found in $SHELL_RC"
        else
            write_info "  No PATH configuration for ~/.local/bin in $SHELL_RC"
        fi
    fi
fi

# ============================================================================
# Check 5: Cursor Installation Directory
# ============================================================================
echo ""
write_info "Checking Cursor installation..."
CURSOR_INSTALLED=false

# macOS paths
if [[ "$OSTYPE" == "darwin"* ]]; then
    if [ -d "/Applications/Cursor.app" ]; then
        write_success "Cursor found at: /Applications/Cursor.app"
        CURSOR_INSTALLED=true
        
        if $VERBOSE; then
            CURSOR_VERSION_PLIST="/Applications/Cursor.app/Contents/Info.plist"
            if [ -f "$CURSOR_VERSION_PLIST" ]; then
                VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$CURSOR_VERSION_PLIST" 2>/dev/null)
                if [ -n "$VERSION" ]; then
                    write_info "  Version: $VERSION"
                fi
            fi
        fi
    fi
# Linux/WSL paths
else
    LINUX_PATHS=(
        "$HOME/.cursor"
        "$HOME/.local/share/cursor"
        "/opt/cursor"
        "/usr/share/cursor"
    )
    
    for path in "${LINUX_PATHS[@]}"; do
        if [ -d "$path" ]; then
            write_success "Cursor installation found at: $path"
            CURSOR_INSTALLED=true
            break
        fi
    done
fi

if ! $CURSOR_INSTALLED; then
    write_warning "Cursor installation directory not found in common locations"
    write_info "If Cursor is installed elsewhere, this is not necessarily an issue"
fi

# ============================================================================
# Check 6: MCP Configuration (for Unity MCP)
# ============================================================================
echo ""
write_info "Checking MCP configuration..."
MCP_CONFIG="$HOME/.cursor/mcp.json"

if [ -f "$MCP_CONFIG" ]; then
    write_success "MCP config file found at: $MCP_CONFIG"
    
    if $VERBOSE && command -v jq &> /dev/null; then
        SERVER_COUNT=$(jq '.mcpServers | length' "$MCP_CONFIG" 2>/dev/null || echo "0")
        write_info "  Configured MCP servers: $SERVER_COUNT"
        
        if jq -e '.mcpServers.UnityMCP' "$MCP_CONFIG" &>/dev/null; then
            write_success "  Unity MCP server configured"
        else
            write_warning "  Unity MCP server not configured"
        fi
    elif $VERBOSE; then
        write_info "  Install 'jq' to see detailed MCP config info"
    fi
else
    write_warning "MCP config file not found at: $MCP_CONFIG"
    write_info "This is normal if you haven't configured any MCP servers yet"
fi

# ============================================================================
# Check 7: Node.js (Required for running this extension)
# ============================================================================
echo ""
write_info "Checking Node.js (required for extension development)..."
if command -v node &> /dev/null; then
    NODE_PATH=$(which node)
    NODE_VERSION=$(node --version 2>&1)
    write_success "Node.js found: $NODE_VERSION at $NODE_PATH"
else
    write_error "Node.js not found"
    write_info "Install from: https://nodejs.org/"
    ALL_PASSED=false
fi

# ============================================================================
# Check 8: npm (Required for extension development)
# ============================================================================
echo ""
write_info "Checking npm..."
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version 2>&1)
    write_success "npm found: v$NPM_VERSION"
else
    write_error "npm not found"
    ALL_PASSED=false
fi

# ============================================================================
# Check 9: Platform-specific dependencies
# ============================================================================
echo ""
write_info "Checking platform-specific dependencies..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    write_info "macOS detected - AppleScript support available"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    write_info "Linux detected"
    
    if command -v xdotool &> /dev/null; then
        write_success "xdotool found (for UI automation)"
    else
        write_warning "xdotool not found (optional, for UI automation)"
        write_info "Install with: sudo apt-get install xdotool"
    fi
fi

# ============================================================================
# Summary
# ============================================================================
write_header "\n=== Summary ==="

if $ALL_PASSED && command -v cursor &> /dev/null && command -v cursor-agent &> /dev/null; then
    echo -e "${GREEN}✓ All required dependencies are installed!${NC}"
    echo ""
    echo -e "${GREEN}Core Requirements Met:${NC}"
    echo -e "${GREEN}  • Cursor CLI (cursor command): Installed${NC}"
    echo -e "${GREEN}  • Cursor Agent CLI (cursor-agent): Installed${NC}"
    echo -e "${GREEN}  • Node.js: Installed${NC}"
    echo -e "${GREEN}  • npm: Installed${NC}"
else
    echo -e "${RED}✗ Some dependencies are missing or not configured properly${NC}"
    echo ""
    echo -e "${YELLOW}Required Actions:${NC}"
    
    if ! command -v cursor &> /dev/null; then
        echo -e "${YELLOW}  1. Install Cursor CLI:${NC}"
        echo "     → Open Cursor → Cmd/Ctrl+Shift+P → 'Install cursor command'"
    fi
    
    if ! command -v cursor-agent &> /dev/null; then
        echo -e "${YELLOW}  2. Install Cursor Agent CLI (REQUIRED):${NC}"
        echo "     → curl https://cursor.com/install -fsS | bash"
        echo "     → Docs: https://cursor.com/docs/cli/installation"
    fi
    
    if ! command -v node &> /dev/null; then
        echo -e "${YELLOW}  3. Install Node.js from: https://nodejs.org/${NC}"
    fi
fi

echo ""
write_info "For more information, see: https://cursor.com/docs/cli/installation"
echo ""

# Exit with appropriate code
if $ALL_PASSED; then
    exit 0
else
    exit 1
fi


#!/bin/bash
# Auto-install script for Cursor Agent CLI (Unix-like systems)

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Helper functions
write_success() { echo -e "${GREEN}[OK] $1${NC}"; }
write_error() { echo -e "${RED}[ERROR] $1${NC}"; }
write_info() { echo -e "${CYAN}[INFO] $1${NC}"; }
write_warning() { echo -e "${YELLOW}[WARN] $1${NC}"; }
write_step() { echo -e "\n${MAGENTA}=== $1 ===${NC}"; }

echo ""
echo "================================================"
echo "  Cursor Agent CLI Auto-Installer"
echo "================================================"
echo ""

# Check if already installed
if command -v cursor-agent &> /dev/null; then
    VERSION=$(cursor-agent --version 2>&1 | head -n1)
    write_success "cursor-agent is already installed!"
    write_info "Version: $VERSION"
    echo ""
    read -p "Reinstall/update? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Installation cancelled."
        exit 0
    fi
fi

# Check platform
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    write_error "Windows detected - Please use the PowerShell script:"
    echo "  powershell -ExecutionPolicy Bypass -File scripts/install-cursor-agent.ps1"
    exit 1
fi

# Check for curl
if ! command -v curl &> /dev/null; then
    write_error "curl is not installed"
    echo ""
    write_info "Install curl:"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "  brew install curl"
    else
        echo "  sudo apt-get install curl  # Debian/Ubuntu"
        echo "  sudo yum install curl      # RedHat/CentOS"
    fi
    exit 1
fi

# Install cursor-agent
write_step "Installing Cursor Agent CLI"

write_info "Downloading installer..."
curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh

write_info "Running installer..."
bash /tmp/cursor-install.sh

# Configure PATH
write_step "Configuring PATH"

SHELL_NAME=$(basename "$SHELL")
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
        SHELL_RC="$HOME/.profile"
        ;;
esac

if [ -f "$SHELL_RC" ]; then
    if ! grep -q '.local/bin' "$SHELL_RC"; then
        write_info "Adding ~/.local/bin to PATH in $SHELL_RC"
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
        write_success "PATH configured"
    else
        write_info "PATH already configured"
    fi
fi

# Source the shell RC to update current session
if [ -f "$SHELL_RC" ]; then
    source "$SHELL_RC" 2>/dev/null || true
fi

# Verify installation
write_step "Verifying Installation"

# Try to find cursor-agent
if command -v cursor-agent &> /dev/null; then
    VERSION=$(cursor-agent --version 2>&1 | head -n1)
    write_success "cursor-agent installed successfully!"
    write_info "Version: $VERSION"
elif [ -f "$HOME/.local/bin/cursor-agent" ]; then
    # Found but not in PATH yet (will be after restart/new shell)
    VERSION=$("$HOME/.local/bin/cursor-agent" --version 2>&1 | head -n1)
    write_success "cursor-agent installed!"
    write_info "Version: $VERSION"
    write_warning "Restart your terminal or run: source $SHELL_RC"
else
    write_error "cursor-agent not found after installation"
    write_info "Installation may have failed. Check output above for errors."
    echo ""
    echo "================================================"
    echo "  Installation Failed - Press Enter to close"
    echo "================================================"
    read -p ""
    exit 1
fi

# Cleanup
rm -f /tmp/cursor-install.sh

# Summary
echo ""
echo "================================================"
echo "  Installation Complete!"
echo "================================================"
echo ""
write_success "Cursor Agent CLI has been installed"
echo ""
write_info "Next steps:"
echo "  1. Restart your terminal (or run: source $SHELL_RC)"
echo "  2. Verify: cursor-agent --version"
echo "  3. In VS Code/Cursor, click 'Refresh' in Agentic Planning sidebar"
echo ""

echo "================================================"
echo "  Press Enter to close..."
echo "================================================"
read -p ""

exit 0

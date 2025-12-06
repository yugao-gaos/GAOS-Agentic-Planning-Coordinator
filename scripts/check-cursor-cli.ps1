# PowerShell script to check Cursor CLI installation and dependencies
# This script checks both the basic 'cursor' command and the new 'cursor-agent' CLI

param(
    [switch]$Verbose,
    [switch]$Install
)

$ErrorActionPreference = "SilentlyContinue"

# Color output helpers
function Write-Success { param($Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Error { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }
function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Cyan }
function Write-Warning { param($Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }

Write-Host "`n=== Cursor CLI Dependency Checker ===" -ForegroundColor Magenta
Write-Host "Checking Cursor CLI installation and configuration...`n"

$allPassed = $true

# ============================================================================
# Check 1: Basic Cursor Command
# ============================================================================
Write-Info "Checking 'cursor' command (basic Cursor CLI)..."
$cursorPath = $null
$cursorVersion = $null

try {
    $cursorPath = (Get-Command cursor -ErrorAction Stop).Source
    $versionOutput = & cursor --version 2>&1 | Out-String
    $cursorVersion = ($versionOutput -split "`n")[0].Trim()
    
    Write-Success "Cursor command found at: $cursorPath"
    Write-Success "Version: $cursorVersion"
} catch {
    Write-Error "Cursor command not found in PATH"
    Write-Warning "The basic 'cursor' command is required to open Cursor from command line"
    Write-Info "To install: Open Cursor, then Command Palette (Ctrl+Shift+P), Type 'Install cursor command'"
    $allPassed = $false
}

# ============================================================================
# Check 2: Cursor Agent CLI (New feature)
# ============================================================================
Write-Host ""
Write-Info "Checking 'cursor-agent' command (Cursor Agent CLI)..."
$cursorAgentPath = $null
$cursorAgentVersion = $null

try {
    $cursorAgentPath = (Get-Command cursor-agent -ErrorAction Stop).Source
    $agentVersionOutput = & cursor-agent --version 2>&1 | Out-String
    $cursorAgentVersion = $agentVersionOutput.Trim()
    
    Write-Success "Cursor Agent command found at: $cursorAgentPath"
    Write-Success "Version: $cursorAgentVersion"
} catch {
    Write-Error "Cursor Agent CLI (cursor-agent) not found"
    Write-Error "This is REQUIRED for the project to function properly"
    Write-Info "To install on Windows:"
    Write-Host "  1. Install WSL if not already installed: wsl --install" -ForegroundColor Yellow
    Write-Host "  2. Restart computer (if first-time WSL setup)" -ForegroundColor Yellow
    Write-Host "  3. Open WSL terminal and run: curl https://cursor.com/install -fsS | bash" -ForegroundColor Yellow
    $installUrl = "https://cursor.com/docs/cli/installation"
    Write-Host "  4. Or see manual installation: $installUrl" -ForegroundColor Yellow
    $allPassed = $false
}

# ============================================================================
# Check 3: PATH Configuration
# ============================================================================
Write-Host ""
Write-Info "Checking PATH configuration..."
$pathEntries = $env:PATH -split ';'
$cursorInPath = $false

foreach ($entry in $pathEntries) {
    if ($entry -like "*cursor*") {
        Write-Success "Cursor path found in PATH: $entry"
        $cursorInPath = $true
    }
}

if (-not $cursorInPath -and $cursorPath) {
    Write-Warning "Cursor executable found but its directory may not be in PATH permanently"
    Write-Info "Consider adding to system PATH: $(Split-Path $cursorPath)"
}

# ============================================================================
# Check 4: Cursor Installation Directory
# ============================================================================
Write-Host ""
Write-Info "Checking Cursor installation..."
$cursorInstallPaths = @(
    "$env:LOCALAPPDATA\Programs\cursor",
    "$env:ProgramFiles\cursor",
    "${env:ProgramFiles(x86)}\cursor"
)

$cursorInstalled = $false
foreach ($installPath in $cursorInstallPaths) {
    if (Test-Path $installPath) {
        Write-Success "Cursor installation found at: $installPath"
        $cursorInstalled = $true
        
        if ($Verbose) {
            $cursorExe = Join-Path $installPath "Cursor.exe"
            if (Test-Path $cursorExe) {
                $version = (Get-Item $cursorExe).VersionInfo
                Write-Info "  Product: $($version.ProductName)"
                Write-Info "  Version: $($version.FileVersion)"
            }
        }
        break
    }
}

if (-not $cursorInstalled) {
    Write-Warning "Cursor installation directory not found in common locations"
    Write-Info "If Cursor is installed elsewhere, this is not necessarily an issue"
}

# ============================================================================
# Check 5: MCP Configuration (for Unity MCP)
# ============================================================================
Write-Host ""
Write-Info "Checking MCP configuration..."
$mcpConfigPath = Join-Path $env:USERPROFILE ".cursor\mcp.json"

if (Test-Path $mcpConfigPath) {
    Write-Success "MCP config file found at: $mcpConfigPath"
    
    if ($Verbose) {
        try {
            $mcpConfig = Get-Content $mcpConfigPath -Raw | ConvertFrom-Json
            if ($mcpConfig.mcpServers) {
                $serverCount = ($mcpConfig.mcpServers | Get-Member -MemberType NoteProperty).Count
                Write-Info "  Configured MCP servers: $serverCount"
                
                if ($mcpConfig.mcpServers.UnityMCP) {
                    Write-Success "  Unity MCP server configured"
                } else {
                    Write-Warning "  Unity MCP server not configured"
                }
            }
        } catch {
            Write-Warning "  Could not parse MCP config: $_"
        }
    }
} else {
    Write-Warning "MCP config file not found at: $mcpConfigPath"
    Write-Info "This is normal if you haven't configured any MCP servers yet"
}

# ============================================================================
# Check 6: Node.js (Required for running this extension)
# ============================================================================
Write-Host ""
Write-Info "Checking Node.js (required for extension development)..."
try {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $nodeVersion = & node --version 2>&1
    Write-Success "Node.js found: $nodeVersion at $nodePath"
} catch {
    Write-Error "Node.js not found"
    Write-Info "Install from: https://nodejs.org/"
    $allPassed = $false
}

# ============================================================================
# Check 7: npm (Required for extension development)
# ============================================================================
Write-Host ""
Write-Info "Checking npm..."
try {
    $npmVersion = & npm --version 2>&1
    Write-Success "npm found: v$npmVersion"
} catch {
    Write-Error "npm not found"
    $allPassed = $false
}

# ============================================================================
# Summary
# ============================================================================
Write-Host "`n=== Summary ===" -ForegroundColor Magenta

if ($allPassed -and $cursorPath -and $cursorAgentPath) {
    Write-Host "[OK] All required dependencies are installed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Core Requirements Met:" -ForegroundColor Green
    Write-Host "  - Cursor CLI (cursor command): Installed" -ForegroundColor Green
    Write-Host "  - Cursor Agent CLI (cursor-agent): Installed" -ForegroundColor Green
    Write-Host "  - Node.js: Installed" -ForegroundColor Green
    Write-Host "  - npm: Installed" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Some dependencies are missing or not configured properly" -ForegroundColor Red
    Write-Host ""
    Write-Host "Required Actions:" -ForegroundColor Yellow
    
    if (-not $cursorPath) {
        Write-Host "  1. Install Cursor CLI:" -ForegroundColor Yellow
        Write-Host "     - Open Cursor, then Ctrl+Shift+P, Type 'Install cursor command'" -ForegroundColor White
    }
    
    if (-not $cursorAgentPath) {
        Write-Host "  2. Install Cursor Agent CLI (REQUIRED):" -ForegroundColor Yellow
        Write-Host "     - Use WSL: wsl --install (if needed), then:" -ForegroundColor White
        Write-Host "     - curl https://cursor.com/install -fsS | bash" -ForegroundColor White
        $installDocUrl = "https://cursor.com/docs/cli/installation"
        Write-Host "     - Docs: $installDocUrl" -ForegroundColor White
    }
    
    if (-not $nodePath) {
        Write-Host "  3. Install Node.js from: https://nodejs.org/" -ForegroundColor Yellow
    }
}

Write-Host ""
$docUrl2 = "https://cursor.com/docs/cli/installation"
Write-Info "For more information, see: $docUrl2"
Write-Host ""

# Exit with appropriate code
if ($allPassed) {
    exit 0
} else {
    exit 1
}

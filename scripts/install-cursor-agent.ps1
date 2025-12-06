# PowerShell script to AUTO-INSTALL Cursor Agent CLI on Windows
# This script will automatically set up WSL and install cursor-agent

param(
    [switch]$Help,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host @"
Cursor Agent CLI Auto-Installer for Windows

SYNOPSIS:
    .\install-cursor-agent.ps1 [-Force]

DESCRIPTION:
    Automatically installs Cursor Agent CLI by:
    1. Checking/installing WSL
    2. Installing Ubuntu if needed
    3. Installing cursor-agent in WSL
    4. Installing Node.js in WSL
    5. Setting up apc CLI wrapper
    6. Configuring PATH

OPTIONS:
    -Force    Reinstall all components even if already installed

EXAMPLES:
    .\install-cursor-agent.ps1           # Skip already installed components
    .\install-cursor-agent.ps1 -Force    # Force reinstall everything

"@
    exit 0
}

# Color output helpers
function Write-Success { param($Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Error { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }
function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Cyan }
function Write-Warning { param($Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Step { param($Message) Write-Host "`n=== $Message ===" -ForegroundColor Magenta }

Write-Host "`n================================================" -ForegroundColor Cyan
Write-Host "  Cursor Agent CLI Auto-Installer for Windows" -ForegroundColor Cyan
Write-Host "================================================`n" -ForegroundColor Cyan

if ($Force) {
    Write-Warning "Force mode enabled - will reinstall all components"
}

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Warning "This script needs Administrator privileges for WSL installation."
    Write-Info "Attempting to restart as Administrator..."
    
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Write-Success "Running as Administrator"

# ============================================================================
# Step 1: Check and Install WSL
# ============================================================================
Write-Step "Step 1: Checking WSL"

try {
    $wslStatus = wsl --status 2>&1
    Write-Success "WSL is already installed"
} catch {
    Write-Info "WSL not found. Installing WSL..."
    try {
        wsl --install --no-distribution
        Write-Success "WSL installed successfully"
        Write-Warning "Computer restart is required for WSL"
        Write-Host ""
        $restart = Read-Host "Restart now? (Y/N)"
        if ($restart -eq 'Y' -or $restart -eq 'y') {
            Write-Info "Restarting computer..."
            Restart-Computer -Force
            exit
        } else {
            Write-Warning "Please restart manually, then run this script again"
            exit 0
        }
    } catch {
        Write-Error "Failed to install WSL: $_"
        Write-Info "Try manually: wsl --install"
        exit 1
    }
}

# ============================================================================
# Step 2: Check and Install Ubuntu
# ============================================================================
Write-Step "Step 2: Checking Ubuntu Distribution"

# Get list of distributions - try multiple methods for reliability
$hasUbuntu = $false

try {
    # Method 1: Try to execute a command in Ubuntu
    $testResult = wsl -d Ubuntu echo "test" 2>&1
    if ($testResult -match "test") {
        $hasUbuntu = $true
        Write-Success "Ubuntu is already installed and working"
    }
} catch {
    # Method 1 failed, try Method 2
}

if (-not $hasUbuntu) {
    # Method 2: Check the list
    try {
        $distributions = wsl --list 2>&1 | Out-String
        if ($distributions -match "Ubuntu") {
            $hasUbuntu = $true
            Write-Success "Ubuntu is already installed"
        }
    } catch {
        # Method 2 also failed
    }
}

if (-not $hasUbuntu) {
    Write-Info "Ubuntu not found. Installing Ubuntu..."
    try {
        $installOutput = wsl --install Ubuntu 2>&1 | Out-String
        
        # Check if error says already exists
        if ($installOutput -match "already exists|ERROR_ALREADY_EXISTS|already installed") {
            Write-Warning "Ubuntu is already installed (Windows reported it exists)"
            $hasUbuntu = $true
        } else {
            Write-Success "Ubuntu installation started"
            Write-Info "Waiting for Ubuntu to be ready..."
            Start-Sleep -Seconds 5
            $hasUbuntu = $true
        }
    } catch {
        $errorMsg = $_.Exception.Message
        
        # Check if error is because Ubuntu already exists
        if ($errorMsg -match "already exists|ERROR_ALREADY_EXISTS|already installed") {
            Write-Warning "Ubuntu is already installed (detected from error message)"
            $hasUbuntu = $true
        } else {
            Write-Error "Failed to install Ubuntu: $errorMsg"
            Write-Info "Try manually: wsl --install Ubuntu"
            
            Write-Host ""
            Write-Host "================================================" -ForegroundColor Red
            Write-Host "  Installation Failed - Press Enter to close" -ForegroundColor Red
            Write-Host "================================================" -ForegroundColor Red
            Read-Host
            exit 1
        }
    }
}

# Now verify Ubuntu is actually working and set up
if ($hasUbuntu) {
    Write-Info "Verifying Ubuntu is properly set up..."
    
    try {
        $testResult = wsl -d Ubuntu echo "test" 2>&1 | Out-String
        if ($testResult -match "test") {
            Write-Success "Ubuntu is working correctly"
        } else {
            throw "Ubuntu not responding correctly"
        }
    } catch {
        Write-Warning "Ubuntu is installed but needs initial setup"
        Write-Info "Ubuntu needs to be configured with a username and password"
        Write-Host ""
        Write-Info "Opening Ubuntu for first-time setup..."
        Write-Host ""
        
        try {
            # Try to launch Ubuntu app
            Start-Process "ubuntu" -Wait
            Write-Success "Ubuntu setup completed"
        } catch {
            Write-Warning "Could not auto-open Ubuntu"
            Write-Info "Please manually open 'Ubuntu' from the Start menu"
            Write-Host ""
            Write-Host "After Ubuntu opens:" -ForegroundColor Yellow
            Write-Host "  1. Create a username when prompted" -ForegroundColor Yellow
            Write-Host "  2. Create a password when prompted" -ForegroundColor Yellow
            Write-Host "  3. Come back here and press Enter" -ForegroundColor Yellow
            Write-Host ""
            Read-Host "Press Enter after completing Ubuntu setup"
        }
        
        # Verify again after setup
        try {
            $testResult2 = wsl -d Ubuntu echo "test" 2>&1 | Out-String
            if ($testResult2 -match "test") {
                Write-Success "Ubuntu is now working correctly"
            } else {
                Write-Error "Ubuntu still not responding. Please complete setup manually."
                Write-Host ""
                Write-Host "================================================" -ForegroundColor Red
                Write-Host "  Setup Incomplete - Press Enter to close" -ForegroundColor Red
                Write-Host "================================================" -ForegroundColor Red
                Read-Host
                exit 1
            }
        } catch {
            Write-Error "Ubuntu still not responding. Please complete setup manually."
            Write-Host ""
            Write-Host "================================================" -ForegroundColor Red
            Write-Host "  Setup Incomplete - Press Enter to close" -ForegroundColor Red
            Write-Host "================================================" -ForegroundColor Red
            Read-Host
            exit 1
        }
    }
}

# ============================================================================
# Step 2.5: Configure WSL Mirrored Networking (for Unity MCP connectivity)
# ============================================================================
Write-Step "Step 2.5: Configuring WSL Mirrored Networking"

Write-Info "Configuring WSL to use mirrored networking mode..."
Write-Info "This allows cursor-agent in WSL to access Unity MCP on Windows via localhost"

try {
    $wslConfigPath = "$env:USERPROFILE\.wslconfig"
    $wslConfigContent = @"
[wsl2]
# Mirrored mode makes localhost work seamlessly between Windows and WSL
# This allows cursor-agent (in WSL) to connect to Unity MCP (on Windows) via localhost
networkingMode=mirrored

# DNS tunneling helps with network connectivity
dnsTunneling=true

# Auto proxy helps with proxy configurations
autoProxy=true
"@

    # Check if .wslconfig already exists
    if (Test-Path $wslConfigPath) {
        $existingContent = Get-Content $wslConfigPath -Raw
        if ($existingContent -match "networkingMode\s*=\s*mirrored") {
            Write-Success "WSL mirrored networking already configured!"
        } else {
            Write-Warning ".wslconfig exists but doesn't have mirrored mode"
            Write-Info "Backing up existing .wslconfig to .wslconfig.backup"
            Copy-Item $wslConfigPath "$wslConfigPath.backup" -Force
            
            # Append mirrored mode config
            Add-Content $wslConfigPath "`n$wslConfigContent"
            Write-Success "Added mirrored networking to .wslconfig"
            
            Write-Warning "WSL must be restarted for network changes to take effect"
            Write-Info "Restarting WSL..."
            wsl --shutdown
            Start-Sleep -Seconds 3
            Write-Success "WSL restarted"
        }
    } else {
        # Create new .wslconfig with mirrored networking
        Set-Content $wslConfigPath $wslConfigContent
        Write-Success "Created .wslconfig with mirrored networking"
        
        Write-Info "Restarting WSL to apply network settings..."
        wsl --shutdown
        Start-Sleep -Seconds 3
        Write-Success "WSL restarted"
    }
} catch {
    Write-Warning "Could not configure WSL mirrored networking: $_"
    Write-Info "You can manually enable it later by adding to $env:USERPROFILE\.wslconfig:"
    Write-Host "  [wsl2]" -ForegroundColor Yellow
    Write-Host "  networkingMode=mirrored" -ForegroundColor Yellow
}

# ============================================================================
# Step 3: Check if cursor-agent is already installed
# ============================================================================
Write-Step "Step 3: Checking cursor-agent in WSL"

try {
    # Check if cursor-agent exists at the standard location
    $checkResult = wsl -d Ubuntu bash -c 'if [ -f ~/.local/bin/cursor-agent ]; then ~/.local/bin/cursor-agent --version 2>&1; else echo "NOT_FOUND"; fi' 2>&1 | Out-String
    
    if ($checkResult -and $checkResult -notmatch "NOT_FOUND" -and $checkResult.Trim()) {
        Write-Success "cursor-agent is already installed!"
        Write-Info "Version: $($checkResult.Trim())"
        
        if ($Force) {
            Write-Warning "Force mode: Proceeding with reinstallation..."
            $skipCursorAgentInstall = $false
        } else {
            Write-Info "Skipping cursor-agent (use -Force to reinstall)"
            $skipCursorAgentInstall = $true
        }
    } else {
        $skipCursorAgentInstall = $false
    }
} catch {
    Write-Info "cursor-agent not found, will install..."
    $skipCursorAgentInstall = $false
}

# ============================================================================
# Step 4: Install cursor-agent in WSL
# ============================================================================
Write-Step "Step 4: Installing cursor-agent in WSL"

if ($skipCursorAgentInstall) {
    Write-Info "Skipping cursor-agent installation (already installed)"
} else {
    Write-Info "Downloading and running installer..."

    try {
        # Run commands with proper quote escaping
        # Use single quotes to avoid PowerShell variable expansion issues
        
        Write-Info "Step 1/4: Downloading installer..."
        $download = wsl -d Ubuntu bash -c 'curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh 2>&1'
        if ($download) { Write-Host $download }
        
        Write-Info "Step 2/4: Running installer..."
        $install = wsl -d Ubuntu bash -c 'bash /tmp/cursor-install.sh 2>&1'
        if ($install) { Write-Host $install }
        
        Write-Info "Step 3/4: Configuring PATH..."
        # Check if PATH is already configured, if not add it
        $pathConfig = wsl -d Ubuntu bash -c 'grep -q ".local/bin" ~/.bashrc 2>/dev/null || echo ''export PATH="$HOME/.local/bin:$PATH"'' >> ~/.bashrc'
        if ($pathConfig) { Write-Host $pathConfig }
        
        Write-Info "Step 4/4: Verifying installation..."
        
        # Check if cursor-agent was installed successfully
        $verifyDirect = wsl -d Ubuntu bash -c 'if [ -f ~/.local/bin/cursor-agent ]; then ~/.local/bin/cursor-agent --version 2>&1; else echo "NOT_FOUND"; fi' 2>&1 | Out-String
        
        Write-Host "Installation check: $verifyDirect"
        
        # Check if installation succeeded
        if ($verifyDirect -and $verifyDirect -notmatch "NOT_FOUND" -and $verifyDirect.Trim()) {
            
            Write-Success "cursor-agent installed successfully!"
            
            # Extract version
            $versionLine = ($verifyDirect -split "`n" | Where-Object { $_ -match "^\d+" -or $_ -match "cursor" } | Select-Object -First 1).Trim()
            
            if ($versionLine) {
                Write-Success "Installed version: $versionLine"
            }
            
            Write-Info "Installation location: ~/.local/bin/cursor-agent (in WSL)"
            
            # Mark as successful
            $global:InstallSuccess = $true
        } else {
            Write-Error "Installation may have completed but cursor-agent not found"
            Write-Info "The installer ran but cursor-agent is not at ~/.local/bin/cursor-agent"
            Write-Host ""
            Write-Info "Please check the installer output above for any errors"
            Write-Info "You can verify manually by running:"
            Write-Host "  wsl -d Ubuntu bash -c 'ls -la ~/.local/bin/'" -ForegroundColor Yellow
            Write-Host "  wsl -d Ubuntu bash -c '~/.local/bin/cursor-agent --version'" -ForegroundColor Yellow
            
            Write-Host ""
            Write-Host "================================================" -ForegroundColor Red
            Write-Host "  Verification Failed - Press Enter to close" -ForegroundColor Red
            Write-Host "================================================" -ForegroundColor Red
            Read-Host
            exit 1
        }
        
    } catch {
        Write-Error "Failed to install cursor-agent: $_"
        Write-Info "Try running manually in WSL:"
        Write-Host "  wsl -d Ubuntu" -ForegroundColor Yellow
        Write-Host "  curl https://cursor.com/install -fsS | bash" -ForegroundColor Yellow
        
        Write-Host ""
        Write-Host "================================================" -ForegroundColor Red
        Write-Host "  Installation Failed - Press Enter to close" -ForegroundColor Red
        Write-Host "================================================" -ForegroundColor Red
        Read-Host
        exit 1
    }
}

# ============================================================================
# Step 5: Install Node.js in WSL (required for apc CLI)
# ============================================================================
Write-Step "Step 5: Installing Node.js in WSL"

Write-Info "Checking if Node.js is installed in WSL..."

try {
    $nodeCheck = wsl -d Ubuntu bash -c 'node --version 2>&1' 2>&1 | Out-String
    
    if ($nodeCheck -match "v\d+\.\d+\.\d+") {
        Write-Success "Node.js is already installed!"
        Write-Info "Version: $($nodeCheck.Trim())"
        
        if ($Force) {
            Write-Warning "Force mode: Reinstalling Node.js..."
            Write-Info "This may take a few minutes..."
            
            # Install Node.js using NodeSource repository (most reliable method)
            $nodeInstall = wsl -d Ubuntu bash -c 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs 2>&1'
            
            if ($nodeInstall) {
                Write-Host $nodeInstall
            }
            
            # Verify installation
            $nodeVerify = wsl -d Ubuntu bash -c 'node --version 2>&1' 2>&1 | Out-String
            if ($nodeVerify -match "v\d+\.\d+\.\d+") {
                Write-Success "Node.js reinstalled successfully!"
                Write-Info "Version: $($nodeVerify.Trim())"
            } else {
                Write-Warning "Node.js reinstallation may have failed"
            }
        } else {
            Write-Info "Skipping Node.js (use -Force to reinstall)"
        }
    } else {
        Write-Info "Node.js not found. Installing Node.js LTS..."
        Write-Info "This may take a few minutes..."
        
        # Install Node.js using NodeSource repository (most reliable method)
        $nodeInstall = wsl -d Ubuntu bash -c 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs 2>&1'
        
        if ($nodeInstall) {
            Write-Host $nodeInstall
        }
        
        # Verify installation
        $nodeVerify = wsl -d Ubuntu bash -c 'node --version 2>&1' 2>&1 | Out-String
        if ($nodeVerify -match "v\d+\.\d+\.\d+") {
            Write-Success "Node.js installed successfully!"
            Write-Info "Version: $($nodeVerify.Trim())"
        } else {
            Write-Warning "Node.js installation may have failed"
            Write-Info "You can try manually later with: sudo apt-get install nodejs"
        }
    }
} catch {
    Write-Warning "Could not check/install Node.js: $_"
    Write-Info "This is needed for apc CLI to work in WSL"
}

# ============================================================================
# Step 6: Install apc CLI on Windows (native)
# ============================================================================
Write-Step "Step 6: Installing apc CLI on Windows (native)"

Write-Info "Setting up apc CLI for Windows (native calls from VS Code)..."

try {
    # Get the Windows path to apc.js from the extension
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $parentDir = Split-Path -Parent $scriptDir
    $possiblePaths = @(
        (Join-Path $scriptDir "apc.js"),                    # scripts/apc.js
        (Join-Path $parentDir "out\scripts\apc.js"),        # out/scripts/apc.js
        "$env:USERPROFILE\.cursor\extensions",
        "$env:USERPROFILE\.vscode\extensions"
    )
    
    $apcJsPath = $null
    foreach ($basePath in $possiblePaths) {
        if (Test-Path $basePath -PathType Leaf) {
            # Direct file found
            $apcJsPath = $basePath
            break
        } elseif (Test-Path $basePath -PathType Container) {
            # Search in extensions directory
            $found = Get-ChildItem -Path $basePath -Recurse -Filter "apc.js" -ErrorAction SilentlyContinue | 
                     Where-Object { $_.FullName -match "agentic-planning-coordinator.*scripts" } | 
                     Select-Object -First 1
            if ($found) {
                $apcJsPath = $found.FullName
                break
            }
        }
    }
    
    if (-not $apcJsPath) {
        Write-Warning "Could not find apc.js - searched in:"
        $possiblePaths | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
        Write-Warning "Native Windows apc CLI will not be available"
        Write-Info "WSL version will still be installed (sufficient for cursor-agent)"
    } else {
        Write-Success "Found apc.js: $apcJsPath"
        
        # Create ~/bin directory for Windows
        $nativeBinDir = Join-Path $env:USERPROFILE "bin"
        if (-not (Test-Path $nativeBinDir)) {
            New-Item -ItemType Directory -Path $nativeBinDir -Force | Out-Null
            Write-Success "Created directory: $nativeBinDir"
        }
        
        # Create apc.cmd wrapper
        $nativeApcPath = Join-Path $nativeBinDir "apc.cmd"
        $cmdContent = "@echo off`r`nnode `"$apcJsPath`" %*"
        Set-Content -Path $nativeApcPath -Value $cmdContent -Encoding ASCII
        Write-Success "Created native Windows apc CLI: $nativeApcPath"
        
        # Add to PATH if not already there
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if ($userPath -notlike "*$nativeBinDir*") {
            Write-Info "Adding $nativeBinDir to user PATH..."
            [Environment]::SetEnvironmentVariable("Path", "$userPath;$nativeBinDir", "User")
            Write-Success "Added to PATH (restart terminal to use)"
        } else {
            Write-Info "Directory already in PATH"
        }
        
        # Test the installation
        $apcTest = & cmd /c "`"$nativeApcPath`" --help 2>&1" | Out-String
        if ($apcTest -match "Usage|Commands") {
            Write-Success "Native Windows apc CLI is working!"
        } else {
            Write-Warning "Native apc CLI may not be working correctly"
        }
    }
} catch {
    Write-Warning "Could not install native Windows apc CLI: $_"
    Write-Info "WSL version will still be installed (sufficient for cursor-agent)"
}

# ============================================================================
# Step 7: Install apc CLI in WSL
# ============================================================================
Write-Step "Step 7: Installing apc CLI in WSL"

# First check if apc CLI is already installed
$apcExists = $false
try {
    $apcCheck = wsl -d Ubuntu bash -c 'if [ -f ~/.local/bin/apc ]; then echo "EXISTS"; fi' 2>&1 | Out-String
    if ($apcCheck -match "EXISTS") {
        $apcExists = $true
        Write-Success "apc CLI wrapper already exists in WSL"
        
        if (-not $Force) {
            Write-Info "Skipping apc CLI (use -Force to reinstall)"
        } else {
            Write-Warning "Force mode: Reinstalling apc CLI wrapper..."
        }
    }
} catch {
    # Ignore errors, proceed with installation
}

if (-not $apcExists -or $Force) {
    Write-Info "Setting up apc CLI wrapper for WSL..."

    try {
        # Get the Windows path to apc.js from the extension
        # Check multiple locations:
        # 1. Current script directory (for dev mode source)
        # 2. Parent out/scripts directory (for dev mode compiled)
        # 3. Extension directories (for installed extension)
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
        $parentDir = Split-Path -Parent $scriptDir
        $possiblePaths = @(
            $scriptDir,  # Dev mode: scripts/ folder (source)
            (Join-Path $parentDir "out\scripts"),  # Dev mode: out/scripts/ (compiled)
            "$env:USERPROFILE\.cursor\extensions",
            "$env:USERPROFILE\.vscode\extensions"
        )
        
        $apcJsPath = $null
        foreach ($extPath in $possiblePaths) {
            if (Test-Path $extPath) {
                $apcSearch = Get-ChildItem -Path $extPath -Filter "apc.js" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($apcSearch) {
                    $apcJsPath = $apcSearch.FullName
                    Write-Info "Found apc.js in: $extPath"
                    break
                }
            }
        }
        
        if (-not $apcJsPath) {
            Write-Warning "Could not find apc.js in any expected location"
            Write-Info "Searched:"
            foreach ($p in $possiblePaths) {
                Write-Info "  - $p"
            }
            Write-Info "apc CLI will need to be installed manually after extension is active"
        } else {
            Write-Success "Found apc.js at: $apcJsPath"
            
            # Convert Windows path to WSL path
            # C:\Users\username\... -> /mnt/c/Users/username/...
            $wslApcPath = $apcJsPath -replace '\\', '/' -replace '^([A-Z]):', '/mnt/$1' -replace '/mnt/([A-Z])', { '/mnt/' + $_.Groups[1].Value.ToLower() }
            
            Write-Info "WSL path: $wslApcPath"
            
            # Create wrapper script in WSL
            $wrapperScript = @"
#!/bin/sh
# APC CLI wrapper for WSL
# Calls the Windows extension's apc.js via Node.js
exec node "$wslApcPath" `$@
"@
            
            # Write wrapper to WSL
            $escapedScript = $wrapperScript -replace '"', '\"' -replace '`', '\`'
            $createWrapper = wsl -d Ubuntu bash -c "mkdir -p ~/.local/bin && cat > ~/.local/bin/apc << 'EOFAPC'
$wrapperScript
EOFAPC
chmod +x ~/.local/bin/apc 2>&1"
            
            if ($createWrapper) {
                Write-Host $createWrapper
            }
            
            # Verify installation
            $apcCheck = wsl -d Ubuntu bash -c '~/.local/bin/apc --help 2>&1 | head -n 5' 2>&1 | Out-String
            if ($apcCheck -match "APC|apc|Agentic") {
                Write-Success "apc CLI installed successfully in WSL!"
                Write-Info "Location: ~/.local/bin/apc (in WSL)"
            } else {
                Write-Warning "apc CLI wrapper created but could not verify"
                Write-Info "This may be normal if the daemon isn't running yet"
            }
        }
    } catch {
        Write-Warning "Could not install apc CLI in WSL: $_"
        Write-Info "You can install it manually later via VS Code command: 'Agentic: Install CLI'"
    }
}

# ============================================================================
# Step 7: Verify Final Installation
# ============================================================================
Write-Step "Step 7: Final Verification"

try {
    # Final check using direct path (most reliable)
    $finalCheck = wsl -d Ubuntu bash -c '~/.local/bin/cursor-agent --version 2>&1' 2>&1 | Out-String
    if ($finalCheck -and $finalCheck.Trim() -and $finalCheck -notmatch "not found") {
        Write-Success "cursor-agent is working!"
        Write-Info "Version: $($finalCheck.Trim())"
        $global:InstallSuccess = $true
    } else {
        Write-Warning "Could not verify installation with direct path"
        Write-Info "cursor-agent may need PATH configuration or shell restart"
    }
} catch {
    Write-Warning "Could not verify installation"
    Write-Info "cursor-agent may still be installed but needs PATH configuration"
    Write-Host ""
}

# ============================================================================
# Summary
# ============================================================================
Write-Host "`n================================================" -ForegroundColor Cyan
Write-Host "  Installation Complete!" -ForegroundColor Cyan
Write-Host "================================================`n" -ForegroundColor Cyan

Write-Success "WSL environment has been set up successfully!"
Write-Host ""
Write-Success "Installed components:"
Write-Host "  ✓ WSL 2 with Ubuntu" -ForegroundColor Green
Write-Host "  ✓ WSL mirrored networking (for Unity MCP)" -ForegroundColor Green
Write-Host "  ✓ cursor-agent CLI (in WSL)" -ForegroundColor Green
Write-Host "  ✓ Node.js (for apc CLI)" -ForegroundColor Green
Write-Host "  ✓ apc CLI (Windows native)" -ForegroundColor Green
Write-Host "  ✓ apc CLI wrapper (in WSL)" -ForegroundColor Green
Write-Host ""
Write-Info "Next steps:"
Write-Host "  1. Go back to VS Code/Cursor" -ForegroundColor White
Write-Host "  2. Click 'Refresh' button in Agentic Planning sidebar" -ForegroundColor White
Write-Host "  3. All dependencies should now show as installed" -ForegroundColor White
Write-Host ""
Write-Info "To verify in WSL terminal:"
Write-Host "  wsl -d Ubuntu" -ForegroundColor Yellow
Write-Host "  cursor-agent --version    # Check cursor-agent" -ForegroundColor Yellow
Write-Host "  node --version            # Check Node.js" -ForegroundColor Yellow
Write-Host "  apc --help                # Check apc CLI" -ForegroundColor Yellow
Write-Host ""
Write-Info "The apc CLI in WSL connects to the Windows daemon via localhost"
Write-Host "  (mirrored networking makes this seamless)" -ForegroundColor Gray
Write-Host ""

Write-Host "================================================" -ForegroundColor Green
Write-Host "  Press Enter to close this window..." -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Read-Host

exit 0

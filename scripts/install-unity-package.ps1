# install-unity-package.ps1
# Installs the APC Unity Bridge package into a Unity project's Packages folder
#
# Usage:
#   .\install-unity-package.ps1 [-ProjectPath <path>]
#
# If ProjectPath is not specified, uses the current directory if it's a Unity project,
# or prompts for a path.

param(
    [Parameter(Mandatory=$false)]
    [string]$ProjectPath
)

$ErrorActionPreference = "Stop"

# Colors for output
function Write-Success { param($Message) Write-Host $Message -ForegroundColor Green }
function Write-Warning { param($Message) Write-Host $Message -ForegroundColor Yellow }
function Write-Error { param($Message) Write-Host $Message -ForegroundColor Red }
function Write-Info { param($Message) Write-Host $Message -ForegroundColor Cyan }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  APC Unity Bridge Package Installer   " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Find the script's directory (where the extension is)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtensionRoot = Split-Path -Parent $ScriptDir

# Find the Unity package source
$PackageSource = Join-Path $ExtensionRoot "unity-package\com.gaos.apc.bridge"

if (-not (Test-Path $PackageSource)) {
    Write-Error "Error: Unity package not found at: $PackageSource"
    Write-Error "Make sure you're running this from the APC extension directory."
    exit 1
}

Write-Info "Package source: $PackageSource"

# Determine Unity project path
if (-not $ProjectPath) {
    # Check if current directory is a Unity project
    $CurrentDir = Get-Location
    if (Test-Path (Join-Path $CurrentDir "Assets")) {
        $ProjectPath = $CurrentDir
        Write-Info "Detected Unity project: $ProjectPath"
    } else {
        # Ask user for path
        Write-Host "Enter the path to your Unity project (must contain 'Assets' folder):"
        $ProjectPath = Read-Host "Project path"
    }
}

# Validate Unity project
$AssetsPath = Join-Path $ProjectPath "Assets"
if (-not (Test-Path $AssetsPath)) {
    Write-Error "Error: '$ProjectPath' is not a Unity project (no 'Assets' folder found)"
    exit 1
}

$PackagesPath = Join-Path $ProjectPath "Packages"
if (-not (Test-Path $PackagesPath)) {
    Write-Info "Creating Packages folder..."
    New-Item -ItemType Directory -Path $PackagesPath | Out-Null
}

# Target path for the package
$TargetPath = Join-Path $PackagesPath "com.gaos.apc.bridge"

# Check if already installed
if (Test-Path $TargetPath) {
    Write-Warning "APC Unity Bridge package already exists at: $TargetPath"
    Write-Host "Do you want to reinstall? (y/n)"
    $response = Read-Host
    if ($response -ne "y" -and $response -ne "Y") {
        Write-Info "Installation cancelled."
        exit 0
    }
    Write-Info "Removing existing installation..."
    Remove-Item -Recurse -Force $TargetPath
}

# Copy the package
Write-Info "Installing APC Unity Bridge package..."
Copy-Item -Recurse -Path $PackageSource -Destination $TargetPath

# Verify installation
if (Test-Path (Join-Path $TargetPath "package.json")) {
    Write-Host ""
    Write-Success "========================================" 
    Write-Success "  Installation Successful!              "
    Write-Success "========================================" 
    Write-Host ""
    Write-Info "Package installed to: $TargetPath"
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  1. Open or refresh your Unity project"
    Write-Host "  2. The APC status icon should appear in the toolbar"
    Write-Host "  3. Click the icon to open settings and connect to the daemon"
    Write-Host ""
} else {
    Write-Error "Error: Installation failed - package.json not found"
    exit 1
}


# APC CLI Installation Script for Windows
# Works for both extension development and installed extension
# Creates wrapper scripts in npm global bin directory

param(
    [switch]$Uninstall,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Get npm global bin directory
$npmPrefix = npm config get prefix
$npmBin = Join-Path $npmPrefix "node_modules\.bin"
if (-not (Test-Path $npmBin)) {
    $npmBin = "$env:APPDATA\npm"
}

$linkPath = Join-Path $npmBin "apc.cmd"
$linkPathPs1 = Join-Path $npmBin "apc.ps1"

# Find the apc.js script - check multiple locations
$scriptLocations = @(
    # Development: running from source
    (Join-Path $PSScriptRoot "apc.js"),
    (Join-Path $PSScriptRoot "..\out\scripts\apc.js"),
    # Installed extension locations
    "$env:USERPROFILE\.cursor\extensions\gaos.agentic-planning-coordinator-*\out\scripts\apc.js",
    "$env:USERPROFILE\.vscode\extensions\gaos.agentic-planning-coordinator-*\out\scripts\apc.js"
)

function Find-ApcScript {
    foreach ($loc in $scriptLocations) {
        $resolved = Get-Item -Path $loc -ErrorAction SilentlyContinue
        if ($resolved) {
            return $resolved.FullName | Select-Object -First 1
        }
    }
    return $null
}

if ($Uninstall) {
    Write-Host "Uninstalling APC CLI..." -ForegroundColor Cyan
    
    if (Test-Path $linkPath) {
        Remove-Item $linkPath -Force
        Write-Host "Removed: $linkPath" -ForegroundColor Green
    }
    if (Test-Path $linkPathPs1) {
        Remove-Item $linkPathPs1 -Force
        Write-Host "Removed: $linkPathPs1" -ForegroundColor Green
    }
    
    Write-Host ""
    Write-Host "[OK] APC CLI uninstalled" -ForegroundColor Green
    exit 0
}

# Find the script
$apcScript = Find-ApcScript
if (-not $apcScript) {
    Write-Host "Error: Could not find apc.js in any expected location" -ForegroundColor Red
    Write-Host "Searched locations:" -ForegroundColor Yellow
    foreach ($loc in $scriptLocations) {
        Write-Host "  - $loc" -ForegroundColor Gray
    }
    exit 1
}

Write-Host "Installing APC CLI..." -ForegroundColor Cyan
Write-Host "  Source: $apcScript" -ForegroundColor Gray
Write-Host "  Target: $linkPath" -ForegroundColor Gray

# Check if already exists
if ((Test-Path $linkPath) -and -not $Force) {
    Write-Host ""
    Write-Host "CLI already installed. Use -Force to reinstall." -ForegroundColor Yellow
    exit 0
}

# Ensure npm bin directory exists
if (-not (Test-Path $npmBin)) {
    New-Item -ItemType Directory -Path $npmBin -Force | Out-Null
}

# Escape path for batch file
$escapedPath = $apcScript.Replace('\', '\\')

# Create cmd wrapper content
$cmdLines = @(
    '@ECHO off',
    'SETLOCAL',
    "node `"$apcScript`" %*"
)

# Create ps1 wrapper content
$ps1Lines = @(
    '#!/usr/bin/env pwsh',
    "node `"$apcScript`" `$args"
)

# Remove old files if they exist
if (Test-Path $linkPath) { Remove-Item $linkPath -Force }
if (Test-Path $linkPathPs1) { Remove-Item $linkPathPs1 -Force }

# Write the wrapper scripts
$cmdLines -join "`r`n" | Set-Content -Path $linkPath -Encoding ASCII -NoNewline
$ps1Lines -join "`r`n" | Set-Content -Path $linkPathPs1 -Encoding UTF8 -NoNewline

Write-Host ""
Write-Host "[OK] APC CLI installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Usage:" -ForegroundColor Cyan
Write-Host "  apc help                    Show all commands"
Write-Host "  apc daemon status           Check daemon status"
Write-Host '  apc plan new "<prompt>"     Start a planning session'

# Verify PATH includes npm bin
$pathDirs = $env:PATH -split ';'
$npmBinNormalized = $npmBin.TrimEnd('\')
$inPath = $pathDirs | Where-Object { $_.TrimEnd('\') -eq $npmBinNormalized }

if (-not $inPath) {
    Write-Host ""
    Write-Host "NOTE: $npmBin is not in your PATH" -ForegroundColor Yellow
    Write-Host "Add it to use 'apc' from anywhere, or use the full path:" -ForegroundColor Yellow
    Write-Host "  $linkPath" -ForegroundColor Gray
}

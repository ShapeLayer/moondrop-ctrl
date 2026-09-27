# Windows release build: CLI, C ABI library, and Tauri installers.
#
# Prerequisites: Rust (MSVC toolchain), Visual Studio Build Tools with "Desktop development with C++",
# Node.js, and WebView2 (preinstalled on Windows 10/11).
#
# Usage (from any directory):
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Bundles nsis
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -SkipApp
param(
    [string]$Bundles = "nsis,msi",
    [switch]$SkipApp
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

function Invoke-Step([string]$Title, [scriptblock]$Command) {
    Write-Host "==> $Title" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Title failed (exit code $LASTEXITCODE)" }
}

Invoke-Step "Rust tests" { cargo test --release -p moondrop-core -p moondrop-ffi -p moondrop-cli }
Invoke-Step "CLI and C ABI library" { cargo build --release -p moondrop-cli -p moondrop-ffi }

$Out = Join-Path $Root "target\release"
Write-Host ""
Write-Host "CLI:       $Out\moondrop-ctrl.exe"
Write-Host "C library: $Out\moondrop_ctrl.lib (header: crates\moondrop-ffi\include\moondrop_ctrl.h)"

if ($SkipApp) { exit 0 }

Set-Location (Join-Path $Root "app")
if (-not (Test-Path "node_modules")) {
    Invoke-Step "npm ci" { npm ci }
}
Invoke-Step "Tauri bundle ($Bundles)" { npm run tauri build -- --bundles $Bundles }

Write-Host ""
Write-Host "Installers:"
Get-ChildItem -Path (Join-Path $Out "bundle") -Recurse -Include *.exe, *.msi |
    ForEach-Object { Write-Host "  $($_.FullName)" }

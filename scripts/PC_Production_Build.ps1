# Lions Creek Rewards - Local Production Build (Windows / PowerShell)
# Purpose: run the same "production build" that Lightsail runs, locally,
# so SSR export mistakes (missing exports, server-only imports, etc.) are caught early.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\PC_Production_Build.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\PC_Production_Build.ps1 -UseCI
#
# Notes:
# - This script does NOT start a tunnel or run "shopify app dev".
# - It intentionally runs "react-router build" (SSR + client) to mimic Lightsail.

param(
  [switch]$UseCI
)

$ErrorActionPreference = "Stop"

Write-Host "==== Preflight ===="
Write-Host ("Repo: " + (Get-Location))
Write-Host ("Node: " + (& node -v))
Write-Host ("NPM:  " + (& npm -v))

Write-Host ""
Write-Host "==== Install dependencies ===="
if ($UseCI) {
  & npm ci
} else {
  & npm install
}

Write-Host ""
Write-Host "==== Prisma generate ===="
& npm run generate

Write-Host ""
Write-Host "==== Production build (SSR + client) ===="
& npm run build

Write-Host ""
Write-Host "✅ Production build succeeded."

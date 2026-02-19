# Lions Creek Rewards - Local Production Build (Windows / PowerShell)
# Purpose: run the same production build as Lightsail (SSR + client) to catch SSR/export issues early.

param(
  [switch]$UseCI
)

function ExecOrThrow([string]$Cmd, [string[]]$Args) {
  Write-Host ("`n> " + $Cmd + " " + ($Args -join " "))
  & $Cmd @Args
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE: $Cmd $($Args -join ' ')"
  }
}

$ErrorActionPreference = "Stop"

Write-Host "==== Preflight ===="
Write-Host ("Repo: " + (Get-Location))
ExecOrThrow "node" @("-v")
ExecOrThrow "npm"  @("-v")

Write-Host "`n==== Install dependencies ===="
if ($UseCI) {
  ExecOrThrow "npm" @("ci")
} else {
  ExecOrThrow "npm" @("install")
}

Write-Host "`n==== Prisma generate ===="
ExecOrThrow "npm" @("run", "generate")

Write-Host "`n==== Production build (SSR + client) ===="
ExecOrThrow "npm" @("run", "build")

Write-Host "`n✅ Production build succeeded."

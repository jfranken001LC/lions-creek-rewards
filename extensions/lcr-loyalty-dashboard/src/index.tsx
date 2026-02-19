# PC_Production_Build.ps1
$ErrorActionPreference = "Stop"

function ExecOrThrow {
    param(
        [Parameter(Mandatory=$true)][string]$Cmd,
        [Parameter(Mandatory=$false)][string[]]$Args = @()
    )

    Write-Host ">> $Cmd $($Args -join ' ')" -ForegroundColor Cyan
    & $Cmd @Args
    if ($LASTEXITCODE -ne 0) {
        throw ("Command failed with exit code {0}: {1} {2}" -f $LASTEXITCODE, $Cmd, ($Args -join ' '))
    }
}

# Clean build outputs
Remove-Item -Recurse -Force .\build -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .\.react-router -ErrorAction SilentlyContinue

# Install dependencies (prefer npm ci when lock exists)
if (Test-Path ".\package-lock.json") {
    ExecOrThrow "npm" @("ci")
} else {
    ExecOrThrow "npm" @("install")
}

# Prisma + build
ExecOrThrow "npm" @("run", "setup")
ExecOrThrow "npm" @("run", "build")

Write-Host "✅ Production build completed." -ForegroundColor Green

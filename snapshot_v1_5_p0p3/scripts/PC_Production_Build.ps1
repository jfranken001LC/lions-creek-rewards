Param(
  [switch]$UseCI
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ExecOrThrow([string]$Cmd, [string[]]$Args = @()) {
  & $Cmd @Args
  if ($LASTEXITCODE -ne 0) {
    $argText = if ($Args -and $Args.Count -gt 0) { $Args -join " " } else { "" }
    throw ("Command failed with exit code {0}: {1} {2}" -f ${LASTEXITCODE}, $Cmd, $argText)
  }
}

Write-Host "==== PC Production Build ===="
Write-Host "Repo: $PSScriptRoot\.."

Push-Location (Join-Path $PSScriptRoot "..")

Write-Host "`n==== Clean install deps ===="
if ($UseCI) {
  ExecOrThrow "npm" @("ci")
} else {
  ExecOrThrow "npm" @("install")
}

Write-Host "`n==== Prisma generate ===="
ExecOrThrow "npm" @("run", "generate")

Write-Host "`n==== Build ===="
ExecOrThrow "npm" @("run", "build")

Write-Host "`n==== Done ===="
Pop-Location

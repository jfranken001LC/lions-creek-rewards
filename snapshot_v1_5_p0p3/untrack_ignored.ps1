# Run at repo root
Write-Host "==== Tracked files that are now ignored (preview) ===="
$files = git ls-files -ci --exclude-standard
$files | ForEach-Object { Write-Host $_ }

Write-Host ""
Write-Host "==== Removing them from the index (keeping files on disk) ===="
foreach ($f in $files) {
  if (![string]::IsNullOrWhiteSpace($f)) {
    git rm -r --cached --ignore-unmatch -- "$f"
  }
}

Write-Host ""
Write-Host "==== Status ===="
git status --porcelain

Write-Host ""
Write-Host "Next:"
Write-Host "  git commit -m `"chore: stop tracking ignored build artifacts`""

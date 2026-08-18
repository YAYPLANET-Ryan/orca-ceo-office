$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot 'orca-weekly-release-install.ps1'
. $scriptPath -TestMode

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  Write-Host "PASS: $Message"
}

$testRoot = Join-Path $env:TEMP "orca-updater-tests-$([guid]::NewGuid().ToString('N'))"
$installRoot = Join-Path $testRoot 'install'
$backupRoot = Join-Path $testRoot 'backups'
New-Item -ItemType Directory -Force -Path $installRoot, $backupRoot | Out-Null

try {
  Set-Content -LiteralPath (Join-Path $installRoot 'locked.txt') -Value 'original'
  $lock = [IO.File]::Open((Join-Path $installRoot 'locked.txt'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    Assert-True (-not (Invoke-RenameProbe)) 'rename probe refuses a locked install tree'
    Assert-True ((Get-Content (Join-Path $installRoot 'locked.txt')) -eq 'original') 'locked tree remains untouched'
  } finally { $lock.Dispose() }

  Assert-True (Invoke-RenameProbe) 'rename probe succeeds after the lock closes'

  $old = Join-Path $testRoot 'old'
  $backup = Join-Path $backupRoot 'app-old'
  New-Item -ItemType Directory -Force -Path $old, $backup | Out-Null
  Set-Content (Join-Path $old 'version.txt') 'new-install'
  Set-Content (Join-Path $backup 'version.txt') 'old-install'
  Remove-Item $installRoot -Recurse -Force
  Move-Item $old $installRoot
  function global:Assert-InstallTree {
    param([string]$Path, [string]$ExpectedVersion, [int]$MinimumFileCount)
    $count = @(Get-ChildItem -LiteralPath $Path -Recurse -File).Count
    if ($count -lt $MinimumFileCount) { throw 'test tree too small' }
    return $count
  }
  function global:Read-AsarVersion { param([string]$AsarPath) return 'old' }
  $backupInfo = Get-Item $backup
  Assert-True (Invoke-SafeRollback -Backup $backupInfo -ExpectedVersion 'old' -MinimumFileCount 1) 'swap rollback restores a verified backup'
  Assert-True ((Get-Content (Join-Path $installRoot 'version.txt')) -eq 'old-install') 'rollback restored the previous tree'
  Assert-True (@(Get-ChildItem "$installRoot-swap-*" -ErrorAction SilentlyContinue).Count -eq 0) 'validated swap is removed only after restore'

  Remove-Item $installRoot -Recurse -Force
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Set-Content (Join-Path $installRoot 'version.txt') 'new-install'
  function global:Assert-InstallTree {
    throw 'forced smoke verification failure'
  }
  Assert-True (-not (Invoke-SafeRollback -Backup $backupInfo -ExpectedVersion 'old' -MinimumFileCount 1)) 'failed rollback verification returns manual intervention'
  Assert-True ((Get-Content (Join-Path $installRoot 'version.txt')) -eq 'new-install') 'failed rollback restores the original swap'

  function global:Test-OrcaBusy { return $true }
  Assert-True (-not (Stop-OrcaAndDrainDaemon -GraceSeconds 0)) 'active session path defers without closing processes'
  $synthetic = @(
    [pscustomobject]@{ Name = 'orca-terminal-daemon.exe'; ProcessId = 1; ParentProcessId = 0 }
  )
  Assert-True ((Get-OrcaDaemonPtyCount $synthetic) -eq 0) 'daemon PTY count reaches zero only with no children'
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

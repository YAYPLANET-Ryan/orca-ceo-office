$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot 'orca-weekly-release-install.ps1'
. $scriptPath -TestMode
$realTestOrcaBusy = (Get-Command Test-OrcaBusy -CommandType Function).ScriptBlock
$realTestOrcaSessionsIdle = (Get-Command Test-OrcaSessionsIdle -CommandType Function).ScriptBlock
$testNotifications = @()
function Notify {
  param([string]$Message)
  $script:testNotifications += $Message
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  Write-Host "PASS: $Message"
}

$testRoot = Join-Path $env:TEMP "orca-updater-tests-$([guid]::NewGuid().ToString('N'))"
$installRoot = Join-Path $testRoot 'install'
$backupRoot = Join-Path $testRoot 'backups'
New-Item -ItemType Directory -Force -Path $installRoot, $backupRoot | Out-Null

try {
  $processGuard = $false
  try { [void](Get-ProcessSnapshot) } catch { $processGuard = $_.Exception.Message -match 'TestMode process snapshot' }
  Assert-True $processGuard 'TestMode blocks real process snapshots before mocks are installed'

  function Invoke-RenameProbe { return $false }
  Assert-True (-not (Invoke-RenameProbe)) 'rename probe mock refuses a locked install tree'
  function Invoke-RenameProbe { return $true }
  Assert-True (Invoke-RenameProbe) 'rename probe succeeds after the lock closes'

  $old = Join-Path $testRoot 'old'
  $backup = Join-Path $backupRoot 'app-old'
  New-Item -ItemType Directory -Force -Path $old, $backup | Out-Null
  Set-Content (Join-Path $old 'version.txt') 'new-install'
  New-Item -ItemType Directory -Force -Path (Join-Path $old 'resources') | Out-Null
  Set-Content (Join-Path $old 'resources\app.asar') 'old'
  Set-Content (Join-Path $backup 'version.txt') 'old-install'
  New-Item -ItemType Directory -Force -Path (Join-Path $backup 'resources'), (Join-Path $backup 'build\Release\obj') | Out-Null
  Set-Content (Join-Path $backup 'resources\app.asar') 'old'
  Set-Content (Join-Path $backup 'build\Release\obj\legacy.obj') 'legacy-build-artifact'
  Remove-Item $installRoot -Recurse -Force
  Move-Item $old $installRoot
  function Read-AsarVersion { param([string]$AsarPath) return 'old' }
  $backupInfo = Get-Item $backup
  $sourceCount = Get-InstallFileCount $installRoot
  Assert-True ((Assert-InstallTree -Path $backup -ExpectedVersion 'old' -MinimumFileCount $sourceCount -SkipArtifactCheck) -ge $sourceCount) 'backup validation accepts legacy build artifacts'
  $artifactRejected = $false
  try { [void](Assert-InstallTree -Path $backup -ExpectedVersion 'old' -MinimumFileCount $sourceCount) } catch { $artifactRejected = $true }
  Assert-True $artifactRejected 'new-install validation still rejects native build artifacts'
  Assert-True (Invoke-SafeRollback -Backup $backupInfo -ExpectedVersion 'old' -MinimumFileCount 1 -SkipArtifactCheck) 'swap rollback restores a verified legacy backup'
  Assert-True ((Get-Content (Join-Path $installRoot 'version.txt')) -eq 'old-install') 'rollback restored the previous tree'
  Assert-True (Test-Path (Join-Path $installRoot 'build\Release\obj\legacy.obj')) 'rollback preserves legacy build artifacts'
  Assert-True (@(Get-ChildItem "$installRoot-swap-*" -ErrorAction SilentlyContinue).Count -eq 0) 'validated swap is removed only after restore'

  Remove-Item $installRoot -Recurse -Force
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Set-Content (Join-Path $installRoot 'version.txt') 'new-install'
  function Assert-InstallTree {
    param([string]$Path, [string]$ExpectedVersion, [int]$MinimumFileCount, [switch]$SkipArtifactCheck)
    throw 'forced smoke verification failure'
  }
  Assert-True (-not (Invoke-SafeRollback -Backup $backupInfo -ExpectedVersion 'old' -MinimumFileCount 1 -SkipArtifactCheck)) 'failed rollback verification returns manual intervention'
  Assert-True ((Get-Content (Join-Path $installRoot 'version.txt')) -eq 'new-install') 'failed rollback restores the original swap'

  function Get-ProcessSnapshot { return @() }
  function Test-OrcaBusy { return $true }
  Assert-True (-not (Stop-OrcaAndDrainDaemon -GraceSeconds 0)) 'active session path defers without closing processes'

  $busyCalls = 0
  function Test-OrcaBusy {
    $script:busyCalls++
    return ($script:busyCalls -le 2)
  }
  function Test-OrcaSessionsIdle { return $true }
  Assert-True (Stop-OrcaAndDrainDaemon -GraceSeconds 0 -DrainDeadlineMinutes 1 -DrainPollSeconds 0) 'busy session drains after becoming idle before the deadline'

  function Test-OrcaBusy { return $true }
  function Test-OrcaSessionsIdle { return $false }
  function Invoke-ForceOrcaShutdown { return $true }
  $forcedNow = [datetime]::Now
  $forcedDateCalls = 0
  function Get-Date {
    $script:forcedDateCalls++
    if ($script:forcedDateCalls -eq 1) { return $script:forcedNow }
    return $script:forcedNow.AddMinutes(2)
  }
  $drainForced = $false
  Assert-True (Stop-OrcaAndDrainDaemon -GraceSeconds 0 -DrainDeadlineMinutes 1 -DrainPollSeconds 0) 'deadline path enters forced shutdown without waiting indefinitely'
  Assert-True $drainForced 'deadline path records drain-forced state'

  $agentTree = @(
    [pscustomobject]@{ Name = 'Orca.exe'; ProcessId = 100; ParentProcessId = 0 },
    [pscustomobject]@{ Name = 'orca-terminal-daemon.exe'; ProcessId = 101; ParentProcessId = 100 },
    [pscustomobject]@{ Name = 'powershell.exe'; ProcessId = 102; ParentProcessId = 101 },
    [pscustomobject]@{ Name = 'gemini.exe'; ProcessId = 103; ParentProcessId = 102 },
    [pscustomobject]@{ Name = 'conhost.exe'; ProcessId = 104; ParentProcessId = 101 }
  )
  function Get-ProcessSnapshot { return $script:agentTree }
  Set-Item -Path Function:\Test-OrcaBusy -Value $realTestOrcaBusy
  Assert-True (Test-OrcaBusy) 'agent-agnostic busy detection catches a gemini child process'
  $script:agentTree = @(
    [pscustomobject]@{ Name = 'Orca.exe'; ProcessId = 100; ParentProcessId = 0 },
    [pscustomobject]@{ Name = 'orca-terminal-daemon.exe'; ProcessId = 101; ParentProcessId = 100 },
    [pscustomobject]@{ Name = 'powershell.exe'; ProcessId = 102; ParentProcessId = 101 }
  )
  Assert-True (-not (Test-OrcaBusy)) 'childless shell-only tree is treated as idle infrastructure'

  function Get-ProcessSnapshot { return @() }
  function Get-OrcaCliPath { return $null }
  Set-Item -Path Function:\Test-OrcaSessionsIdle -Value $realTestOrcaSessionsIdle
  $cpuSample = 0
  function Get-OrcaAgentCpuSnapshot {
    $script:cpuSample++
    if ($script:cpuSample -eq 1) { return @{ 123 = 10.0 } }
    return @{ 123 = 10.1 }
  }
  Assert-True (Test-OrcaSessionsIdle -CpuSampleSeconds 0 -CpuThresholdSeconds 0.5) 'CLI failure falls back to an idle CPU sample'

  $statePath = Join-Path $testRoot 'installed.json'
  Write-InstallState -State 'installed-pending-smoke' -StateVersion 'test' -Sha256 'abc' -FileCount 1 -Reason 'smoke pending'
  $pendingState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  Assert-True ($pendingState.status -eq 'installed-pending-smoke') 'pending smoke state is persisted before the smoke phase'
  Write-InstallState -State 'installed' -StateVersion 'test' -Sha256 'abc' -FileCount 1 -Reason '' -DrainForced:$true -ServeWasRunning:$true -ServeRestarted:$true -ServeListening:$true
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $expectedHostname = if (-not [string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { $env:COMPUTERNAME } else { [Environment]::MachineName }
  Assert-True ($state.hostname -eq $expectedHostname) 'installed state records the computer hostname'
  Assert-True ($state.'drainForced' -eq $true) 'installed state records drain-forced metadata'
  Assert-True ($state.serveWasRunning -and $state.serveRestarted -and $state.serveListening) 'installed state records serve restart and port recovery'

  $synthetic = @(
    [pscustomobject]@{ Name = 'orca-terminal-daemon.exe'; ProcessId = 1; ParentProcessId = 0 }
  )
  Assert-True ((Get-OrcaDaemonPtyCount $synthetic) -eq 0) 'daemon PTY count reaches zero only with no children'
  Assert-True ($testNotifications.Count -gt 0) 'TestMode notifications are captured by the mock sink'
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

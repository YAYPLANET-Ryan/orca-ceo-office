[CmdletBinding()]
param(
  [string]$Version,
  [int]$SmokeSeconds = 90,
  [int]$DaemonGraceSeconds = 120,
  [switch]$TestMode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = 'YAYPLANET-Ryan/orca-ceo-office'
$root = Join-Path $env:LOCALAPPDATA 'orca-updater\verified'
$backupRoot = Join-Path $env:LOCALAPPDATA 'orca-backups'
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\orca'
$logRoot = Join-Path $env:LOCALAPPDATA 'orca-updater\weekly'
$statePath = Join-Path $env:LOCALAPPDATA 'orca-updater\installed.json'
$fatalLog = Join-Path $env:APPDATA 'orca\bootstrap-fatal.log'
$installStarted = $false
$actual = ''
$transcriptStarted = $false
$mutex = New-Object System.Threading.Mutex($false, 'Local\OrcaWeeklyReleaseInstall')
$mutexOwned = $false

function Notify([string]$Message) {
  Write-Host $Message
  try {
    if (Get-Module -ListAvailable -Name BurntToast) {
      Import-Module BurntToast -ErrorAction Stop
      New-BurntToastNotification -Text 'Orca update', $Message | Out-Null
      return
    }
  } catch { }
  try { & msg.exe * $Message 2>$null } catch { }
}

function Write-InstallState {
  param(
    [string]$State,
    [string]$StateVersion,
    [string]$Sha256,
    [int]$FileCount,
    [string]$Reason
  )
  try {
    $payload = [ordered]@{
      version = $StateVersion
      sha256 = $Sha256
      installedAt = (Get-Date).ToUniversalTime().ToString('o')
      hostname = $env:COMPUTERNAME
      fileCount = $FileCount
      status = $State
    }
    if ($Reason) { $payload.reason = $Reason }
    $temp = "$statePath.tmp-$([guid]::NewGuid().ToString('N'))"
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $statePath -Force
  } catch {
    Write-Warning "Could not write updater state: $($_.Exception.Message)"
  }
}

function Invoke-WithRetry([scriptblock]$Action, [string]$Name) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try { & $Action; return } catch {
      if ($attempt -eq 3) { throw }
      Write-Warning "$Name failed (attempt $attempt/3): $($_.Exception.Message)"
      Start-Sleep -Seconds ([math]::Pow(2, $attempt))
    }
  }
}

function Read-AsarVersion([string]$AsarPath) {
  $bytes = [IO.File]::ReadAllBytes($AsarPath)
  if ($bytes.Length -lt 16) { throw "Invalid app.asar header: $AsarPath" }
  $jsonSize = [BitConverter]::ToUInt32($bytes, 12)
  $jsonStart = 16
  if ($jsonStart + $jsonSize -gt $bytes.Length) { throw "Invalid app.asar header length: $AsarPath" }
  $header = ([Text.Encoding]::UTF8.GetString($bytes, $jsonStart, $jsonSize) | ConvertFrom-Json)
  $package = $header.files.'package.json'
  if (-not $package) { throw "package.json is missing from app.asar: $AsarPath" }
  $packageStart = $jsonStart + $jsonSize + [int64]$package.offset
  $packageBytes = [Text.Encoding]::UTF8.GetString($bytes, $packageStart, [int]$package.size)
  $match = [regex]::Match($packageBytes, '"version"\s*:\s*"([^"]+)"')
  if (-not $match.Success) { throw "package.json version is missing from app.asar: $AsarPath" }
  $match.Groups[1].Value
}

function Get-ArchiveFileCount([string]$Path) {
  $command = Get-Command 7z.exe, 7za.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  $sevenZip = if ($command) { $command.Path } else { $null }
  if (-not $sevenZip) {
    $message = '7z.exe/7za.exe was not found; archive file-count verification is unavailable.'
    Write-Warning $message
    Notify $message
    return -1
  }
  @(& $sevenZip l '-slt' $Path 2>$null | Where-Object { $_ -match '^Path = ' -and $_ -notmatch '\\$' }).Count
}

function Get-ProcessSnapshot {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
}

function Get-OrcaDaemonInfo([object[]]$AllProcesses) {
  @($AllProcesses | Where-Object Name -ieq 'orca-terminal-daemon.exe' | ForEach-Object {
      [pscustomobject]@{
        ProcessId = [int]$_.ProcessId
        ParentProcessId = [int]$_.ParentProcessId
        CommandLine = [string]$_.CommandLine
      }
    })
}

function Get-OrcaDaemonPtyCount([object[]]$AllProcesses) {
  $daemonIds = @(Get-OrcaDaemonInfo $AllProcesses | Select-Object -ExpandProperty ProcessId)
  if ($daemonIds.Count -eq 0) { return 0 }
  @($AllProcesses | Where-Object { $daemonIds -contains [int]$_.ParentProcessId }).Count
}

function Get-OrcaLockSummary {
  $items = @(Get-Process -Name Orca,orca-terminal-daemon -ErrorAction SilentlyContinue | ForEach-Object {
      "$($_.ProcessName)#$($_.Id)"
    })
  if ($items.Count -eq 0) { return 'none' }
  $items -join ', '
}

function Test-OrcaBusy {
  $all = Get-ProcessSnapshot
  $roots = @($all | Where-Object Name -ieq 'Orca.exe' | Select-Object -ExpandProperty ProcessId)
  $roots += @(Get-OrcaDaemonInfo $all | Select-Object -ExpandProperty ProcessId)
  if ($roots.Count -eq 0) { return $false }
  $frontier = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($id in $roots) { [void]$frontier.Add([int]$id) }
  do {
    $found = @($all | Where-Object { $frontier.Contains([int]$_.ParentProcessId) -and -not $frontier.Contains([int]$_.ProcessId) })
    foreach ($child in $found) { [void]$frontier.Add([int]$child.ProcessId) }
  } while ($found.Count -gt 0)
  @($all | Where-Object { $frontier.Contains([int]$_.ProcessId) -and $_.Name -match '^(claude|codex|hermes|node)(\.exe)?$' }).Count -gt 0
}

function Send-DaemonIdleShutdown([object]$Daemon) {
  $match = [regex]::Match($Daemon.CommandLine, '--socket\s+(?<socket>\S+)\s+--token\s+(?<token>\S+)')
  if (-not $match.Success) { return $false }
  $socketPath = $match.Groups['socket'].Value
  $tokenPath = $match.Groups['token'].Value
  if (-not (Test-Path -LiteralPath $tokenPath)) { return $false }
  $pipeName = $socketPath -replace '^\\\\\?\\pipe\\', ''
  if (-not $pipeName) { return $false }
  $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  $clientId = [guid]::NewGuid().ToString()
  $pipes = @()
  try {
    foreach ($role in @('control', 'stream')) {
      $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
      $pipe.Connect(2000)
      $pipe.ReadTimeout = 3000
      $writer = [IO.StreamWriter]::new($pipe, [Text.Encoding]::UTF8, 4096, $true)
      $writer.AutoFlush = $true
      $reader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 4096, $true)
      $hello = @{ type = 'hello'; version = 32; token = $token; clientId = $clientId; role = $role } | ConvertTo-Json -Compress
      $writer.WriteLine($hello)
      $helloResponse = $reader.ReadLine() | ConvertFrom-Json
      if (-not $helloResponse.ok) { throw 'Daemon hello was rejected.' }
      $pipes += [pscustomobject]@{ Pipe = $pipe; Writer = $writer; Reader = $reader }
    }
    $request = @{ id = "orca-updater-$([guid]::NewGuid().ToString('N'))"; type = 'shutdownIfIdle'; payload = @{} } | ConvertTo-Json -Compress
    $pipes[0].Writer.WriteLine($request)
    $response = $pipes[0].Reader.ReadLine() | ConvertFrom-Json
    return [bool]$response.payload.retiring
  } catch {
    Write-Warning "Daemon idle shutdown RPC unavailable: $($_.Exception.Message)"
    return $false
  } finally {
    foreach ($item in $pipes) {
      try { $item.Reader.Dispose() } catch { }
      try { $item.Writer.Dispose() } catch { }
      try { $item.Pipe.Dispose() } catch { }
    }
  }
}

function Stop-OrcaAndDrainDaemon {
  param([int]$GraceSeconds)
  if (Test-OrcaBusy) {
    Notify 'Orca has an active agent session; update deferred without closing the app.'
    return $false
  }
  Get-Process -Name orca -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
  Start-Sleep -Seconds 30
  $running = Get-Process -Name orca -ErrorAction SilentlyContinue
  if ($running) {
    & taskkill.exe /IM Orca.exe /T /F | Out-Null
    Start-Sleep -Seconds 3
  }
  if (Get-Process -Name orca -ErrorAction SilentlyContinue) {
    Notify "Orca remains running; update deferred. Locks: $(Get-OrcaLockSummary)"
    return $false
  }

  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  do {
    $all = Get-ProcessSnapshot
    $daemons = @(Get-OrcaDaemonInfo $all)
    if ($daemons.Count -eq 0) { return $true }
    foreach ($daemon in $daemons) { [void](Send-DaemonIdleShutdown $daemon) }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  $all = Get-ProcessSnapshot
  $daemons = @(Get-OrcaDaemonInfo $all)
  $ptyCount = Get-OrcaDaemonPtyCount $all
  if ($daemons.Count -eq 0) { return $true }
  if ($ptyCount -gt 0) {
    Notify "Orca daemon still has $ptyCount PTY process(es); update deferred. Locks: $(Get-OrcaLockSummary)"
    return $false
  }
  foreach ($daemon in $daemons) {
    & taskkill.exe /PID $daemon.ProcessId /F | Out-Null
  }
  Start-Sleep -Seconds 3
  if (@(Get-OrcaDaemonInfo (Get-ProcessSnapshot)).Count -gt 0) {
    Notify "Orca daemon could not be stopped; manual intervention required. Locks: $(Get-OrcaLockSummary)"
    return $false
  }
  return $true
}

function Invoke-RenameProbe {
  if (-not (Test-Path -LiteralPath $installRoot)) { return $true }
  $probe = "$installRoot-probe-$([guid]::NewGuid().ToString('N'))"
  try {
    Move-Item -LiteralPath $installRoot -Destination $probe -ErrorAction Stop
    Move-Item -LiteralPath $probe -Destination $installRoot -ErrorAction Stop
    return $true
  } catch {
    if ((Test-Path -LiteralPath $probe) -and -not (Test-Path -LiteralPath $installRoot)) {
      try { Move-Item -LiteralPath $probe -Destination $installRoot -ErrorAction Stop } catch { }
    }
    Notify "Install tree is locked; manual intervention required: $(Get-OrcaLockSummary)"
    return $false
  }
}

function Get-InstallFileCount([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  @(Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction Stop).Count
}

function Copy-TreeContents([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force -ErrorAction Stop
}

function Assert-InstallTree {
  param([string]$Path, [string]$ExpectedVersion, [int]$MinimumFileCount)
  $asar = Join-Path $Path 'resources\app.asar'
  $actualVersion = Read-AsarVersion $asar
  if ($actualVersion -ne $ExpectedVersion) { throw "Tree version $actualVersion does not match $ExpectedVersion." }
  $count = Get-InstallFileCount $Path
  if ($MinimumFileCount -gt 0 -and $count -lt $MinimumFileCount) { throw "Tree file count $count is below expected minimum $MinimumFileCount." }
  $badFiles = @(Get-ChildItem -LiteralPath $Path -Recurse -File | Where-Object { $_.Extension -match '^\.(tlog|obj|pdb|ilk|exp|lib|iobj|ipdb|lastbuildstate|recipe)$' })
  if ($badFiles.Count -gt 0) { throw 'Native build artifacts remain in the install tree.' }
  return $count
}

function Invoke-SafeRollback {
  param([object]$Backup, [string]$ExpectedVersion, [int]$MinimumFileCount)
  $swap = "$installRoot-swap-$([guid]::NewGuid().ToString('N'))"
  $failed = "$installRoot-failed-$([datetime]::UtcNow.ToString('yyyyMMdd-HHmmss'))"
  $hadOriginal = Test-Path -LiteralPath $installRoot
  if (-not (Invoke-RenameProbe)) { return $false }
  try {
    if (Test-Path -LiteralPath $installRoot) {
      Move-Item -LiteralPath $installRoot -Destination $swap -ErrorAction Stop
    }
  } catch {
    Notify "Rollback stopped before deletion: install tree is locked; manual intervention required: $(Get-OrcaLockSummary)"
    return $false
  }
  try {
    Copy-TreeContents -Source $Backup.FullName -Destination $installRoot
    [void](Assert-InstallTree -Path $installRoot -ExpectedVersion $ExpectedVersion -MinimumFileCount $MinimumFileCount)
    if (-not $hadOriginal) {
      Notify "Rollback restored $ExpectedVersion; no previous install swap was present."
      return $true
    }
    try {
      Remove-Item -LiteralPath $swap -Recurse -Force -ErrorAction Stop
    } catch {
      Notify "Rollback restored the backup but retained the original swap at ${swap}: $($_.Exception.Message)"
      return $true
    }
    Notify "Orca rollback succeeded to $ExpectedVersion."
    return $true
  } catch {
    $restoreError = $_.Exception.Message
    try {
      if (Test-Path -LiteralPath $installRoot) { Move-Item -LiteralPath $installRoot -Destination $failed -ErrorAction Stop }
      if (Test-Path -LiteralPath $swap) { Move-Item -LiteralPath $swap -Destination $installRoot -ErrorAction Stop }
      Notify "Rollback verification failed; original install restored. Failed copy retained at $failed. Reason: $restoreError"
    } catch {
      Notify "Rollback could not restore the original swap; manual intervention required. Swap: $swap; Reason: $($_.Exception.Message)"
    }
    return $false
  }
}

if ($TestMode) { return }

try {
  if (-not $mutex.WaitOne(0)) { throw 'Another Orca updater is already running.' }
  $mutexOwned = $true
  New-Item -ItemType Directory -Force -Path $root, $backupRoot, $logRoot | Out-Null
  Start-Transcript -LiteralPath (Join-Path $logRoot 'latest.log') -Append | Out-Null
  $transcriptStarted = $true

  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh.exe) is required.' }
  if (-not $Version) {
    $tag = gh release view --repo $repo --json tagName --jq .tagName
    if ($LASTEXITCODE -ne 0 -or -not $tag) { throw 'Could not resolve the latest Orca release.' }
    $Version = $tag -replace '^v', ''
  }
  $downloadDir = Join-Path $root $Version
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
  Invoke-WithRetry { gh release download "v$Version" --repo $repo --pattern 'orca-windows-setup.exe' --pattern 'orca-windows-setup.exe.sha256' --dir $downloadDir --clobber; if ($LASTEXITCODE -ne 0) { throw 'gh release download failed.' } } 'Release download'
  $installer = Join-Path $downloadDir 'orca-windows-setup.exe'
  $checksum = Join-Path $downloadDir 'orca-windows-setup.exe.sha256'
  $expected = (Get-Content -LiteralPath $checksum -Raw).Trim().Split()[0].ToUpperInvariant()
  $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($expected -ne $actual) { throw 'SHA-256 mismatch; installation aborted.' }
  $archiveCount = Get-ArchiveFileCount $installer

  if (-not (Stop-OrcaAndDrainDaemon -GraceSeconds $DaemonGraceSeconds)) {
    Write-InstallState -State 'deferred' -StateVersion $Version -Sha256 $actual -FileCount 0 -Reason 'active session, PTY, or daemon lock'
    return
  }
  if (-not (Invoke-RenameProbe)) {
    Write-InstallState -State 'deferred' -StateVersion $Version -Sha256 $actual -FileCount 0 -Reason 'install tree rename probe failed'
    return
  }

  $asar = Join-Path $installRoot 'resources\app.asar'
  $oldVersion = if (Test-Path -LiteralPath $asar) { Read-AsarVersion $asar } else { 'unknown' }
  $backup = Join-Path $backupRoot ("app-{0}-{1}" -f $oldVersion, (Get-Date -Format 'yyyyMMdd-HHmmss'))
  if (Test-Path -LiteralPath $installRoot) { Copy-TreeContents -Source $installRoot -Destination $backup }
  $backupCount = Assert-InstallTree -Path $backup -ExpectedVersion $oldVersion -MinimumFileCount $archiveCount
  Get-ChildItem -LiteralPath $backupRoot -Directory -Filter 'app-*' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | ForEach-Object {
    try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { Write-Warning "Could not prune backup $($_.FullName): $($_.Exception.Message)" }
  }

  if (-not (Invoke-RenameProbe)) {
    Write-InstallState -State 'deferred' -StateVersion $Version -Sha256 $actual -FileCount $backupCount -Reason 'final install-tree rename probe failed'
    return
  }
  $installStarted = $true
  $result = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($result.ExitCode -ne 0) { throw "Installer failed with exit code $($result.ExitCode)." }
  $installedCount = Assert-InstallTree -Path $installRoot -ExpectedVersion $Version -MinimumFileCount $archiveCount
  $fatalBefore = if (Test-Path $fatalLog) { (Get-Item $fatalLog).Length } else { 0 }
  Start-Process -FilePath (Join-Path $installRoot 'Orca.exe') | Out-Null
  Start-Sleep -Seconds $SmokeSeconds
  $fatalAfter = if (Test-Path $fatalLog) { (Get-Item $fatalLog).Length } else { 0 }
  if ($fatalAfter -gt $fatalBefore) { throw 'bootstrap-fatal.log grew during smoke test.' }
  Write-InstallState -State 'installed' -StateVersion $Version -Sha256 $actual -FileCount $installedCount -Reason ''
  Notify "Orca $Version installed successfully (SHA-256 $actual). APPDATA and .orca were untouched."
} catch {
  $reason = $_.Exception.Message
  Notify "Orca update failed: $reason"
  $latest = Get-ChildItem -LiteralPath $backupRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $rollbackState = 'failed'
  if ($installStarted -and $latest) {
    try {
      if (Stop-OrcaAndDrainDaemon -GraceSeconds $DaemonGraceSeconds) {
        $rollbackExpected = Read-AsarVersion (Join-Path $latest.FullName 'resources\app.asar')
        $rollbackCount = Get-InstallFileCount $latest.FullName
        if (Invoke-SafeRollback -Backup $latest -ExpectedVersion $rollbackExpected -MinimumFileCount $rollbackCount) {
          $rollbackState = 'rolled-back'
        } else {
          $rollbackState = 'manual-intervention'
        }
      } else {
        $rollbackState = 'manual-intervention'
        Notify 'Rollback deferred because an active PTY, session, or daemon lock remains.'
      }
    } catch {
      $rollbackState = 'manual-intervention'
      Notify "Rollback handling failed without deleting the install tree: $($_.Exception.Message)"
    }
  }
  Write-InstallState -State $rollbackState -StateVersion $Version -Sha256 $actual -FileCount 0 -Reason $reason
  throw
} finally {
  if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch { } }
  if ($mutexOwned) { try { $mutex.ReleaseMutex() } catch { }; try { $mutex.Dispose() } catch { } }
}

[CmdletBinding()]
param(
  [string]$Version,
  [int]$SmokeSeconds = 90,
  [int]$DaemonGraceSeconds = 120,
  [int]$DrainDeadlineMinutes = 0,
  [switch]$Force,
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
$drainAttempted = $false
$drainForced = $false
$resumedTerminals = -1
$serveWasRunning = $false
$serveRestarted = $false
$serveListening = $false
$serveState = $null
$lastOrcaSessionIdleSummary = 'not checked'
$mutex = New-Object System.Threading.Mutex($false, 'Local\OrcaWeeklyReleaseInstall')
$mutexOwned = $false

if ($Force -and -not $PSBoundParameters.ContainsKey('DrainDeadlineMinutes')) {
  $DrainDeadlineMinutes = 5
}

function Notify([string]$Message) {
  Write-Host $Message
  if ($TestMode) { return }
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
    [string]$Reason,
    [bool]$DrainForced = $false,
    [int]$ResumedTerminals = -1,
    [bool]$ServeWasRunning = $false,
    [bool]$ServeRestarted = $false,
    [bool]$ServeListening = $false
  )
  try {
    $hostname = if (-not [string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) {
      $env:COMPUTERNAME
    } else {
      [Environment]::MachineName
    }
    $payload = [ordered]@{
      version = $StateVersion
      sha256 = $Sha256
      installedAt = (Get-Date).ToUniversalTime().ToString('o')
      hostname = $hostname
      fileCount = $FileCount
      status = $State
      drainForced = $DrainForced
    }
    if ($Reason) { $payload.reason = $Reason }
    if ($ResumedTerminals -ge 0) { $payload.resumedTerminals = $ResumedTerminals }
    if ($ServeWasRunning) {
      $payload.serveWasRunning = $true
      $payload.serveRestarted = $ServeRestarted
      $payload.serveListening = $ServeListening
    }
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
  if ($TestMode) { throw 'TestMode process snapshot requires an explicit mock.' }
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
}

function Get-OrcaDaemonInfo([object[]]$AllProcesses) {
  if ($null -eq $AllProcesses) { return @() }
  @($AllProcesses | Where-Object Name -ieq 'orca-terminal-daemon.exe' | ForEach-Object {
      [pscustomobject]@{
        ProcessId = [int]$_.ProcessId
        ParentProcessId = [int]$_.ParentProcessId
        CommandLine = if ($null -ne $_.PSObject.Properties['CommandLine']) { [string]$_.CommandLine } else { '' }
      }
    })
}

function Get-OrcaDaemonPtyCount([object[]]$AllProcesses) {
  $daemonIds = @(Get-OrcaDaemonInfo $AllProcesses | Select-Object -ExpandProperty ProcessId)
  if ($daemonIds.Count -eq 0) { return 0 }
  @($AllProcesses | Where-Object { $daemonIds -contains [int]$_.ParentProcessId }).Count
}

function Get-OrcaProcessTree([object[]]$AllProcesses) {
  if ($null -eq $AllProcesses) { return @() }
  $roots = @($AllProcesses | Where-Object Name -ieq 'Orca.exe' | Select-Object -ExpandProperty ProcessId)
  $roots += @(Get-OrcaDaemonInfo $AllProcesses | Select-Object -ExpandProperty ProcessId)
  if ($roots.Count -eq 0) { return @() }
  $frontier = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($id in $roots) { [void]$frontier.Add([int]$id) }
  do {
    $found = @($AllProcesses | Where-Object { $frontier.Contains([int]$_.ParentProcessId) -and -not $frontier.Contains([int]$_.ProcessId) })
    foreach ($child in $found) { [void]$frontier.Add([int]$child.ProcessId) }
  } while ($found.Count -gt 0)
  @($AllProcesses | Where-Object { $frontier.Contains([int]$_.ProcessId) })
}

function Get-OrcaActivityProcesses([object[]]$AllProcesses) {
  if ($null -eq $AllProcesses) { return @() }
  $tree = @(Get-OrcaProcessTree $AllProcesses)
  if ($tree.Count -eq 0) { return @() }
  $rootIds = @(
    $tree | Where-Object { $_.Name -ieq 'Orca.exe' -or $_.Name -ieq 'orca-terminal-daemon.exe' } |
      Select-Object -ExpandProperty ProcessId
  )
  $infrastructure = @('conhost.exe', 'OpenConsole.exe', 'winpty-agent.exe')
  $shells = @('powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe')
  @($tree | Where-Object {
      $processId = [int]$_.ProcessId
      $name = [string]$_.Name
      if ($rootIds -contains $processId -or $infrastructure -contains $name) { return $false }
      if ($shells -contains $name) { return $false }
      return $true
    })
}

function Get-OrcaLockSummary {
  if ($TestMode) { return 'test-mode (process access blocked)' }
  $items = @(Get-Process -Name Orca,orca-terminal-daemon -ErrorAction SilentlyContinue | ForEach-Object {
      "$($_.ProcessName)#$($_.Id)"
    })
  if ($items.Count -eq 0) { return 'none' }
  $items -join ', '
}

function Test-OrcaBusy {
  $all = Get-ProcessSnapshot
  @(Get-OrcaActivityProcesses $all).Count -gt 0
}

function Get-OrcaCliPath {
  foreach ($name in @('orca.exe', 'orca.cmd')) {
    $candidate = Join-Path $installRoot "resources\bin\$name"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}

function Get-OrcaTerminalList {
  $cli = Get-OrcaCliPath
  if (-not $cli) { return $null }
  try {
    if ($cli -match '\.cmd$') {
      $raw = & cmd.exe /d /c "`"$cli`" terminal list --json" 2>$null | Out-String
    } else {
      $raw = & $cli terminal list --json 2>$null | Out-String
    }
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) { return $null }
    $payload = $raw | ConvertFrom-Json
    if (-not $payload.result -or $null -eq $payload.result.terminals) { return $null }
    return ,([pscustomobject]@{ Terminals = @($payload.result.terminals) })
  } catch {
    Write-Warning "Orca terminal list unavailable; using CPU fallback: $($_.Exception.Message)"
    return $null
  }
}

function Get-OrcaAgentCpuSnapshot {
  if ($TestMode) { throw 'TestMode CPU snapshot requires an explicit mock.' }
  $snapshot = @{}
  $all = Get-ProcessSnapshot
  $activity = @(Get-OrcaActivityProcesses $all)
  foreach ($agent in $activity) {
    try {
      $process = Get-Process -Id ([int]$agent.ProcessId) -ErrorAction Stop
      $snapshot[[int]$agent.ProcessId] = [double]$process.TotalProcessorTime.TotalSeconds
    } catch { }
  }
  return $snapshot
}

function Test-OrcaSessionsIdle {
  param(
    [int]$IdleMinutes = 5,
    [int]$CpuSampleSeconds = 10,
    [double]$CpuThresholdSeconds = 0.5
  )
  $terminalData = Get-OrcaTerminalList
  if ($null -ne $terminalData) {
    $terminals = @($terminalData.Terminals)
    if ($terminals.Count -eq 0) {
      $script:lastOrcaSessionIdleSummary = 'CLI terminals=0; idle=true'
      return $true
    }
    $now = [DateTimeOffset]::UtcNow
    $idle = $true
    $latestOutput = $null
    foreach ($terminal in $terminals) {
      try {
        $lastOutputAt = [int64]$terminal.lastOutputAt
        $lastOutput = [DateTimeOffset]::FromUnixTimeMilliseconds($lastOutputAt)
        if ($null -eq $latestOutput -or $lastOutput -gt $latestOutput) { $latestOutput = $lastOutput }
        if (($now - $lastOutput).TotalMinutes -lt $IdleMinutes) { $idle = $false }
      } catch {
        $idle = $false
      }
    }
    $latestLabel = if ($latestOutput) { $latestOutput.ToLocalTime().ToString('o') } else { 'unknown' }
    $script:lastOrcaSessionIdleSummary = "CLI terminals=$($terminals.Count); latestOutputAt=$latestLabel; idle=$idle"
    return $idle
  }

  $first = Get-OrcaAgentCpuSnapshot
  if ($first.Count -eq 0) {
    $script:lastOrcaSessionIdleSummary = 'CPU fallback agents=0; idle=true'
    return $true
  }
  if ($CpuSampleSeconds -gt 0) { Start-Sleep -Seconds $CpuSampleSeconds }
  $second = Get-OrcaAgentCpuSnapshot
  $delta = 0.0
  foreach ($id in $first.Keys) {
    if ($second.ContainsKey($id)) {
      $delta += [math]::Max(0, ([double]$second[$id] - [double]$first[$id]))
    }
  }
  $idle = $delta -lt $CpuThresholdSeconds
  $script:lastOrcaSessionIdleSummary = "CPU fallback agents=$($first.Count); cpuDeltaSeconds=$([math]::Round($delta, 3)); idle=$idle"
  return $idle
}

function Get-OrcaTerminalCount {
  $terminalData = Get-OrcaTerminalList
  if ($null -eq $terminalData) { return $null }
  @($terminalData.Terminals).Count
}

function Get-OrcaResumedTerminalCount {
  param([int]$WaitSeconds = 60)
  if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }
  $count = Get-OrcaTerminalCount
  if ($null -eq $count) { return -1 }
  return [int]$count
}

function Test-OrcaPortListening {
  param([int]$Port = 8765)
  try {
    return (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop).Count -gt 0)
  } catch {
    try {
      $lines = @(netstat.exe -ano -p tcp 2>$null | Where-Object { $_ -match ":$Port\s+\S+\s+LISTENING" })
      return $lines.Count -gt 0
    } catch {
      return $false
    }
  }
}

function Get-OrcaServeState {
  if ($TestMode) { throw 'TestMode serve detection requires an explicit mock.' }
  if (-not (Test-OrcaPortListening -Port 8765)) {
    return [pscustomobject]@{ Running = $false; Executable = $null; Arguments = $null; Port = 8765 }
  }
  $candidates = @(Get-ProcessSnapshot | Where-Object {
      $_.Name -ieq 'Orca.exe' -and ([string]$_.CommandLine -match '(?i)(^|\s)(--serve|serve)(\s|$)')
    })
  if ($candidates.Count -eq 0) {
    return [pscustomobject]@{ Running = $false; Executable = $null; Arguments = $null; Port = 8765 }
  }
  $candidate = $candidates | Select-Object -First 1
  $commandLine = [string]$candidate.CommandLine
  $match = [regex]::Match($commandLine, '^\s*"(?<exe>[^"]+)"\s*(?<args>.*)$')
  if (-not $match.Success) { $match = [regex]::Match($commandLine, '^\s*(?<exe>\S+)\s*(?<args>.*)$') }
  $executable = if ($match.Success) { $match.Groups['exe'].Value } else { $null }
  $arguments = if ($match.Success) { $match.Groups['args'].Value.Trim() } else { $null }
  if ([string]::IsNullOrWhiteSpace($executable)) {
    return [pscustomobject]@{ Running = $false; Executable = $null; Arguments = $null; Port = 8765 }
  }
  if ([string]::IsNullOrWhiteSpace($arguments)) { $arguments = '--serve --serve-port 8765' }
  [pscustomobject]@{ Running = $true; Executable = $executable; Arguments = $arguments; Port = 8765 }
}

function Invoke-RestartOrcaServe {
  param(
    [object]$State,
    [int]$WaitSeconds = 30
  )
  if (-not $State -or -not $State.Running) {
    return [pscustomobject]@{ Restarted = $false; Listening = $false }
  }
  if ($TestMode) { throw 'TestMode serve restart requires an explicit mock.' }
  try {
    $workingDirectory = Split-Path -Parent $State.Executable
    Start-Process -FilePath $State.Executable -ArgumentList $State.Arguments -WorkingDirectory $workingDirectory | Out-Null
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    do {
      if (Test-OrcaPortListening -Port ([int]$State.Port)) {
        return [pscustomobject]@{ Restarted = $true; Listening = $true }
      }
      Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    return [pscustomobject]@{ Restarted = $true; Listening = $false }
  } catch {
    Notify "Orca serve restart failed; installation remains successful: $($_.Exception.Message)"
    return [pscustomobject]@{ Restarted = $false; Listening = $false }
  }
}

function Send-DaemonIdleShutdown([object]$Daemon) {
  $match = [regex]::Match(
    $Daemon.CommandLine,
    '--socket\s+(?:"(?<socket>[^"]+)"|(?<socket>\S+))\s+--token\s+(?:"(?<token>[^"]+)"|(?<token>\S+))'
  )
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

function Invoke-ForceOrcaShutdown {
  if ($TestMode) { throw 'TestMode forced shutdown requires an explicit mock.' }
  $all = Get-ProcessSnapshot
  $roots = @($all | Where-Object { $_.Name -ieq 'Orca.exe' -or $_.Name -ieq 'orca-terminal-daemon.exe' })
  foreach ($root in $roots) {
    try { & taskkill.exe /PID ([int]$root.ProcessId) /T /F | Out-Null } catch { }
  }
  Start-Sleep -Seconds 3
  $remaining = @(Get-ProcessSnapshot | Where-Object { $_.Name -ieq 'Orca.exe' -or $_.Name -ieq 'orca-terminal-daemon.exe' })
  if ($remaining.Count -gt 0) {
    Notify "Orca drain deadline force-close could not stop the application tree; manual intervention required: $(Get-OrcaLockSummary)"
    return $false
  }
  return $true
}

function Stop-OrcaAndDrainDaemon {
  param(
    [int]$GraceSeconds,
    [int]$DrainDeadlineMinutes = 0,
    [int]$DrainPollSeconds = 120
  )
  if (Test-OrcaBusy) {
    if ($DrainDeadlineMinutes -le 0) {
      Notify 'Orca has an active agent session; update deferred without closing the app.'
      return $false
    }
    $script:drainAttempted = $true
    $drainDeadline = (Get-Date).AddMinutes($DrainDeadlineMinutes)
    $drained = $false
    while ((Get-Date) -lt $drainDeadline) {
      if (-not (Test-OrcaBusy)) {
        $drained = $true
        break
      }
      if (Test-OrcaSessionsIdle) {
        $drained = $true
        Notify "Orca sessions are idle; continuing the scheduled installation. $script:lastOrcaSessionIdleSummary"
        break
      }
      $all = Get-ProcessSnapshot
      $activeCount = @(Get-OrcaActivityProcesses $all).Count
      $remainingSeconds = [math]::Max(1, [int]($drainDeadline - (Get-Date)).TotalSeconds)
      $sleepSeconds = [math]::Min($DrainPollSeconds, $remainingSeconds)
      Notify "Orca drain waiting: $activeCount active session process(es); $script:lastOrcaSessionIdleSummary"
      Start-Sleep -Seconds $sleepSeconds
    }
    if (-not $drained -and (Test-OrcaBusy)) {
      $script:drainForced = $true
      $activeCount = @(Get-OrcaActivityProcesses (Get-ProcessSnapshot)).Count
      Notify "Orca drain deadline reached — forcing $activeCount session(s) to close and continuing the installation."
      return (Invoke-ForceOrcaShutdown)
    }
  }

  if ($TestMode) { return $true }

  $running = @(Get-Process -Name orca -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    $running | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Seconds 30
    if (Get-Process -Name orca -ErrorAction SilentlyContinue) {
      & taskkill.exe /IM Orca.exe /T /F | Out-Null
      Start-Sleep -Seconds 3
    }
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
    & taskkill.exe /PID $daemon.ProcessId /T /F | Out-Null
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
  param(
    [string]$Path,
    [string]$ExpectedVersion,
    [int]$MinimumFileCount,
    [switch]$SkipArtifactCheck
  )
  $asar = Join-Path $Path 'resources\app.asar'
  $actualVersion = Read-AsarVersion $asar
  if ($actualVersion -ne $ExpectedVersion) { throw "Tree version $actualVersion does not match $ExpectedVersion." }
  $count = Get-InstallFileCount $Path
  if ($MinimumFileCount -gt 0 -and $count -lt $MinimumFileCount) { throw "Tree file count $count is below expected minimum $MinimumFileCount." }
  if (-not $SkipArtifactCheck) {
    $badFiles = @(Get-ChildItem -LiteralPath $Path -Recurse -File | Where-Object { $_.Extension -match '^\.(tlog|obj|pdb|ilk|exp|lib|iobj|ipdb|lastbuildstate|recipe)$' })
    if ($badFiles.Count -gt 0) { throw 'Native build artifacts remain in the install tree.' }
  }
  return $count
}

function Invoke-SafeRollback {
  param(
    [object]$Backup,
    [string]$ExpectedVersion,
    [int]$MinimumFileCount,
    [switch]$SkipArtifactCheck
  )
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
    [void](Assert-InstallTree -Path $installRoot -ExpectedVersion $ExpectedVersion -MinimumFileCount $MinimumFileCount -SkipArtifactCheck:$SkipArtifactCheck)
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
  $drainAttempted = $false
  $drainForced = $false
  $resumedTerminals = -1
  $serveRestarted = $false
  $serveListening = $false
  $serveState = Get-OrcaServeState
  $serveWasRunning = [bool]$serveState.Running

  if (-not (Stop-OrcaAndDrainDaemon -GraceSeconds $DaemonGraceSeconds -DrainDeadlineMinutes $DrainDeadlineMinutes)) {
    Write-InstallState -State 'deferred' -StateVersion $Version -Sha256 $actual -FileCount 0 -Reason 'active session, PTY, or daemon lock' -DrainForced:$drainForced -ServeWasRunning:$serveWasRunning
    return
  }
  if (-not (Invoke-RenameProbe)) {
    Write-InstallState -State 'deferred' -StateVersion $Version -Sha256 $actual -FileCount 0 -Reason 'install tree rename probe failed' -DrainForced:$drainForced -ServeWasRunning:$serveWasRunning
    return
  }

  $asar = Join-Path $installRoot 'resources\app.asar'
  $oldVersion = if (Test-Path -LiteralPath $asar) { Read-AsarVersion $asar } else { 'unknown' }
  $backup = Join-Path $backupRoot ("app-{0}-{1}" -f $oldVersion, (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $sourceCount = Get-InstallFileCount $installRoot
  if (Test-Path -LiteralPath $installRoot) { Copy-TreeContents -Source $installRoot -Destination $backup }
  $backupCount = Assert-InstallTree -Path $backup -ExpectedVersion $oldVersion -MinimumFileCount $sourceCount -SkipArtifactCheck
  Get-ChildItem -LiteralPath $backupRoot -Directory -Filter 'app-*' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | ForEach-Object {
    try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { Write-Warning "Could not prune backup $($_.FullName): $($_.Exception.Message)" }
  }

  if (-not (Invoke-RenameProbe)) {
    Write-InstallState -State 'deferred' -StateVersion $Version -Sha256 $actual -FileCount $backupCount -Reason 'final install-tree rename probe failed' -DrainForced:$drainForced -ServeWasRunning:$serveWasRunning
    return
  }
  $installStarted = $true
  $result = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($result.ExitCode -ne 0) { throw "Installer failed with exit code $($result.ExitCode)." }
  $installedCount = Assert-InstallTree -Path $installRoot -ExpectedVersion $Version -MinimumFileCount $archiveCount
  Write-InstallState -State 'installed-pending-smoke' -StateVersion $Version -Sha256 $actual -FileCount $installedCount -Reason 'Installer completed; smoke test in progress.' -DrainForced:$drainForced -ServeWasRunning:$serveWasRunning
  if ($serveWasRunning) {
    $serveRestart = Invoke-RestartOrcaServe -State $serveState
    $serveRestarted = [bool]$serveRestart.Restarted
    $serveListening = [bool]$serveRestart.Listening
    if (-not $serveListening) { Notify 'Orca serve was running before update but port 8765 did not recover.' }
  }
  $fatalBefore = if (Test-Path $fatalLog) { (Get-Item $fatalLog).Length } else { 0 }
  Start-Process -FilePath (Join-Path $installRoot 'Orca.exe') | Out-Null
  Start-Sleep -Seconds $SmokeSeconds
  $fatalAfter = if (Test-Path $fatalLog) { (Get-Item $fatalLog).Length } else { 0 }
  if ($fatalAfter -gt $fatalBefore) { throw 'bootstrap-fatal.log grew during smoke test.' }
  if ($drainAttempted) {
    try {
      $resumedTerminals = Get-OrcaResumedTerminalCount -WaitSeconds 60
      if ($resumedTerminals -lt 0) { Notify 'Orca session resume check was unavailable; installation remains successful.' }
    } catch {
      Notify "Orca session resume check failed; installation remains successful: $($_.Exception.Message)"
      $resumedTerminals = -1
    }
  }
  Write-InstallState -State 'installed' -StateVersion $Version -Sha256 $actual -FileCount $installedCount -Reason '' -DrainForced:$drainForced -ResumedTerminals $resumedTerminals -ServeWasRunning:$serveWasRunning -ServeRestarted:$serveRestarted -ServeListening:$serveListening
  Notify "Orca $Version installed successfully (SHA-256 $actual). APPDATA and .orca were untouched."
} catch {
  $reason = $_.Exception.Message
  Notify "Orca update failed: $reason"
  $latest = Get-ChildItem -LiteralPath $backupRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $rollbackState = 'failed'
  if ($installStarted -and $latest) {
    try {
      if (Stop-OrcaAndDrainDaemon -GraceSeconds $DaemonGraceSeconds -DrainDeadlineMinutes $DrainDeadlineMinutes) {
        $rollbackExpected = Read-AsarVersion (Join-Path $latest.FullName 'resources\app.asar')
        $rollbackCount = Get-InstallFileCount $latest.FullName
        if (Invoke-SafeRollback -Backup $latest -ExpectedVersion $rollbackExpected -MinimumFileCount $rollbackCount -SkipArtifactCheck) {
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
  Write-InstallState -State $rollbackState -StateVersion $Version -Sha256 $actual -FileCount 0 -Reason $reason -DrainForced:$drainForced -ServeWasRunning:$serveWasRunning -ServeRestarted:$serveRestarted -ServeListening:$serveListening
  throw
} finally {
  if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch { } }
  if ($mutexOwned) { try { $mutex.ReleaseMutex() } catch { }; try { $mutex.Dispose() } catch { } }
}

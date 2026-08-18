[CmdletBinding()]
param(
  [string]$Version,
  [int]$SmokeSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = 'YAYPLANET-Ryan/orca-ceo-office'
$root = Join-Path $env:LOCALAPPDATA 'orca-updater\verified'
$backupRoot = Join-Path $env:LOCALAPPDATA 'orca-backups'
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\orca'
$logRoot = Join-Path $env:LOCALAPPDATA 'orca-updater\weekly'
$fatalLog = Join-Path $env:APPDATA 'orca\bootstrap-fatal.log'
$installStarted = $false
$mutex = New-Object System.Threading.Mutex($false, 'Local\OrcaWeeklyReleaseInstall')
if (-not $mutex.WaitOne(0)) { throw 'Another Orca updater is already running.' }
New-Item -ItemType Directory -Force -Path $root, $backupRoot, $logRoot | Out-Null
Start-Transcript -LiteralPath (Join-Path $logRoot 'latest.log') -Append | Out-Null

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
  if (-not $sevenZip) { return 0 }
  @(& $sevenZip l '-slt' $Path 2>$null | Where-Object { $_ -match '^Path = ' -and $_ -notmatch '\\$' }).Count
}

function Test-OrcaBusy {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $orcaIds = @($all | Where-Object Name -ieq 'Orca.exe' | Select-Object -ExpandProperty ProcessId)
  if ($orcaIds.Count -eq 0) { return $false }
  $frontier = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($id in $orcaIds) { [void]$frontier.Add([int]$id) }
  $children = @()
  do {
    $found = @($all | Where-Object { $frontier.Contains([int]$_.ParentProcessId) -and -not $frontier.Contains([int]$_.ProcessId) })
    foreach ($child in $found) { [void]$frontier.Add([int]$child.ProcessId); $children += $child }
  } while ($found.Count -gt 0)
  @($children | Where-Object Name -match '^(claude|codex|hermes|node)(\.exe)?$').Count -gt 0
}

try {
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

  if (Test-OrcaBusy) {
    Notify 'Orca has an active agent session; this run is deferred without closing the app.'
    return
  }

  $asar = Join-Path $installRoot 'resources\app.asar'
  $oldVersion = if (Test-Path -LiteralPath $asar) { Read-AsarVersion $asar } else { 'unknown' }
  $backup = Join-Path $backupRoot ("app-{0}-{1}" -f $oldVersion, (Get-Date -Format 'yyyyMMdd-HHmmss'))
  if (Test-Path -LiteralPath $installRoot) { Copy-Item -LiteralPath $installRoot -Destination $backup -Recurse -Force }
  Get-ChildItem -LiteralPath $backupRoot -Directory -Filter 'app-*' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | Remove-Item -Recurse -Force

  Get-Process -Name orca -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
  Start-Sleep -Seconds 30
  $running = Get-Process -Name orca -ErrorAction SilentlyContinue
  if ($running) { & taskkill.exe /IM Orca.exe /T /F | Out-Null; Start-Sleep -Seconds 3 }
  if (Get-Process -Name orca -ErrorAction SilentlyContinue) { throw 'Orca remained busy; installation aborted.' }

  $archiveCount = Get-ArchiveFileCount $installer
  $installStarted = $true
  $result = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($result.ExitCode -ne 0) { throw "Installer failed with exit code $($result.ExitCode)." }
  $newAsar = Join-Path $installRoot 'resources\app.asar'
  $installedVersion = Read-AsarVersion $newAsar
  if ($installedVersion -ne $Version) { throw "Installed version $installedVersion does not match $Version." }
  if ($archiveCount -gt 0 -and @(Get-ChildItem -LiteralPath $installRoot -Recurse -File).Count -lt $archiveCount) { throw 'Installed file count is below the installer archive count.' }
  $badFiles = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File | Where-Object { $_.Extension -match '^\.(tlog|obj|pdb|ilk|exp|lib|iobj|ipdb|lastbuildstate|recipe)$' })
  if ($badFiles.Count -gt 0) { throw 'Native build artifacts remain in the installed tree.' }
  $fatalBefore = if (Test-Path $fatalLog) { (Get-Item $fatalLog).Length } else { 0 }
  Start-Process -FilePath (Join-Path $installRoot 'Orca.exe') | Out-Null
  Start-Sleep -Seconds $SmokeSeconds
  $fatalAfter = if (Test-Path $fatalLog) { (Get-Item $fatalLog).Length } else { 0 }
  if ($fatalAfter -gt $fatalBefore) { throw 'bootstrap-fatal.log grew during smoke test.' }
  Notify "Orca $Version installed successfully. APPDATA and .orca were untouched."
} catch {
  Notify "Orca update failed: $($_.Exception.Message)"
  $latest = Get-ChildItem -LiteralPath $backupRoot -Directory -Filter 'app-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($installStarted -and $latest) {
    Get-Process -Name orca -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-Path $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
    Copy-Item -LiteralPath $latest.FullName -Destination $installRoot -Recurse -Force
    Notify 'Orca rolled back to the latest backup.'
  }
  throw
} finally {
  Stop-Transcript | Out-Null
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}

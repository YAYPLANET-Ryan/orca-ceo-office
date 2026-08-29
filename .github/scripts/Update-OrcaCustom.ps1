[CmdletBinding()]
param(
  [ValidateSet('Check', 'Install', 'RegisterTask', 'UnregisterTask')]
  [string]$Mode = 'Check',

  [switch]$AllowRestart
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepositoryOwner = 'YAYPLANET-Ryan'
$RepositoryName = 'orca-ceo-office'
$RepositorySlug = "$RepositoryOwner/$RepositoryName"
$ReleaseApiUri = "https://api.github.com/repos/$RepositorySlug/releases/latest"
$InstallerAssetName = 'orca-windows-setup.exe'
$ManifestAssetName = 'latest.yml'
$TaskName = 'ORCA Custom Update - Saturday 0430'
$UpdaterRoot = Join-Path $env:LOCALAPPDATA 'ORCA\custom-updater'
$CacheRoot = Join-Path $UpdaterRoot 'cache'
$BackupRoot = Join-Path $UpdaterRoot 'backups'
$LogRoot = Join-Path $UpdaterRoot 'logs'
$StableScriptRoot = Join-Path $UpdaterRoot 'scripts'
$LogPath = Join-Path $LogRoot 'Update-OrcaCustom.log'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Initialize-UpdaterDirectories {
  foreach ($path in @($UpdaterRoot, $CacheRoot, $BackupRoot, $LogRoot, $StableScriptRoot)) {
    if (-not (Test-Path -LiteralPath $path)) {
      New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
  }
}

function Write-UpdateLog {
  param([Parameter(Mandatory = $true)][string]$Message)

  Initialize-UpdaterDirectories
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  Write-Host $line
}

function Invoke-GitHubJson {
  param([Parameter(Mandatory = $true)][string]$Uri)

  $headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'ORCA-Custom-Updater'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  return Invoke-RestMethod -Method Get -Uri $Uri -Headers $headers -UseBasicParsing
}

function Get-ReleaseAsset {
  param(
    [Parameter(Mandatory = $true)]$Release,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $matches = @($Release.assets | Where-Object { $_.name -eq $Name })
  if ($matches.Count -ne 1) {
    throw "Expected one release asset named '$Name'; found $($matches.Count)."
  }
  return $matches[0]
}

function Save-GitHubAsset {
  param(
    [Parameter(Mandatory = $true)]$Asset,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $headers = @{ 'User-Agent' = 'ORCA-Custom-Updater' }
  Invoke-WebRequest -Uri $Asset.browser_download_url -Headers $headers -OutFile $Destination -UseBasicParsing
}

function Get-CanonicalPackage {
  Initialize-UpdaterDirectories
  Write-UpdateLog "Checking canonical release at $RepositorySlug."

  $release = Invoke-GitHubJson -Uri $ReleaseApiUri
  if ([bool]$release.draft -or [bool]$release.prerelease) {
    throw 'The latest GitHub release is draft or prerelease.'
  }

  $tag = [string]$release.tag_name
  $tagMatch = [regex]::Match($tag, '^v(\d+\.\d+\.\d+-ceo\.\d{8}\.\d+)$')
  if (-not $tagMatch.Success) {
    throw "Unexpected canonical release tag: $tag"
  }
  $targetVersion = $tagMatch.Groups[1].Value

  $targetCommit = [string]$release.target_commitish
  if ($targetCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw "Release target_commitish is not an immutable 40-character commit SHA: $targetCommit"
  }

  $manifestAsset = Get-ReleaseAsset -Release $release -Name $ManifestAssetName
  $installerAsset = Get-ReleaseAsset -Release $release -Name $InstallerAssetName
  $releaseCache = Join-Path $CacheRoot $targetVersion
  if (-not (Test-Path -LiteralPath $releaseCache)) {
    New-Item -ItemType Directory -Path $releaseCache -Force | Out-Null
  }

  $manifestPath = Join-Path $releaseCache $ManifestAssetName
  Save-GitHubAsset -Asset $manifestAsset -Destination $manifestPath
  $manifestText = Get-Content -LiteralPath $manifestPath -Raw
  $manifestVersionMatch = [regex]::Match($manifestText, '(?m)^version:\s*([^\s]+)\s*$')
  if (-not $manifestVersionMatch.Success) {
    throw 'latest.yml does not contain a version field.'
  }
  $manifestVersion = $manifestVersionMatch.Groups[1].Value.Trim('''', '"')
  if ($manifestVersion -ne $targetVersion) {
    throw "Manifest version '$manifestVersion' does not match release '$targetVersion'."
  }

  $digest = [string]$installerAsset.digest
  $digestMatch = [regex]::Match($digest, '^sha256:([0-9a-fA-F]{64})$')
  if (-not $digestMatch.Success) {
    throw 'The installer asset does not have a GitHub SHA-256 digest.'
  }
  $expectedSha256 = $digestMatch.Groups[1].Value.ToLowerInvariant()
  $installerPath = Join-Path $releaseCache $InstallerAssetName

  $reuseInstaller = $false
  if (Test-Path -LiteralPath $installerPath) {
    $existingItem = Get-Item -LiteralPath $installerPath
    if ($existingItem.Length -eq [int64]$installerAsset.size) {
      $existingHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
      $reuseInstaller = $existingHash -eq $expectedSha256
    }
  }

  if (-not $reuseInstaller) {
    Write-UpdateLog "Downloading $InstallerAssetName for $targetVersion."
    Save-GitHubAsset -Asset $installerAsset -Destination $installerPath
  }

  $installerItem = Get-Item -LiteralPath $installerPath
  if ($installerItem.Length -ne [int64]$installerAsset.size) {
    throw "Installer size mismatch: expected $($installerAsset.size), got $($installerItem.Length)."
  }
  $actualSha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "Installer SHA-256 mismatch: expected $expectedSha256, got $actualSha256."
  }

  Unblock-File -LiteralPath $installerPath
  Write-UpdateLog "Verified release $tag at commit $targetCommit and SHA-256 $actualSha256."

  return [pscustomobject]@{
    Tag = $tag
    Version = $targetVersion
    Commit = $targetCommit
    InstallerPath = $installerPath
    InstallerSha256 = $actualSha256
    InstallerSize = $installerItem.Length
    ManifestPath = $manifestPath
    ReleaseUrl = [string]$release.html_url
  }
}

function Get-InstalledOrcaState {
  $candidateExecutables = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Orca\Orca.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\orca\Orca.exe'),
    (Join-Path $env:ProgramFiles 'Orca\Orca.exe')
  )
  $executablePath = $candidateExecutables | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  $version = $null
  $feedPath = $null
  $feedCanonical = $false

  if ($executablePath) {
    $versionInfo = (Get-Item -LiteralPath $executablePath).VersionInfo
    foreach ($value in @($versionInfo.ProductVersion, $versionInfo.FileVersion)) {
      $versionMatch = [regex]::Match([string]$value, '\d+\.\d+\.\d+-ceo\.\d{8}\.\d+')
      if ($versionMatch.Success) {
        $version = $versionMatch.Value
        break
      }
    }

    $feedPath = Join-Path (Split-Path -Parent $executablePath) 'resources\app-update.yml'
    if (Test-Path -LiteralPath $feedPath) {
      $feedText = Get-Content -LiteralPath $feedPath -Raw
      $ownerMatch = [regex]::Match($feedText, '(?m)^\s*owner:\s*[''"]?([^''"\r\n]+)')
      $repoMatch = [regex]::Match($feedText, '(?m)^\s*repo:\s*[''"]?([^''"\r\n]+)')
      if ($ownerMatch.Success -and $repoMatch.Success) {
        $feedOwner = $ownerMatch.Groups[1].Value.Trim()
        $feedRepo = $repoMatch.Groups[1].Value.Trim()
        $feedCanonical = ($feedOwner -eq $RepositoryOwner -and $feedRepo -eq $RepositoryName)
      }
    }
  }

  return [pscustomobject]@{
    ExecutablePath = $executablePath
    Version = $version
    FeedPath = $feedPath
    FeedCanonical = $feedCanonical
  }
}

function ConvertTo-CustomVersionParts {
  param([Parameter(Mandatory = $true)][string]$Version)

  $match = [regex]::Match($Version, '^(\d+)\.(\d+)\.(\d+)-ceo\.(\d{8})\.(\d+)$')
  if (-not $match.Success) {
    return $null
  }
  return @(
    [int64]$match.Groups[1].Value,
    [int64]$match.Groups[2].Value,
    [int64]$match.Groups[3].Value,
    [int64]$match.Groups[4].Value,
    [int64]$match.Groups[5].Value
  )
}

function Compare-CustomVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  $leftParts = @(ConvertTo-CustomVersionParts -Version $Left)
  $rightParts = @(ConvertTo-CustomVersionParts -Version $Right)
  if ($leftParts.Count -ne 5 -or $rightParts.Count -ne 5) {
    throw "Cannot compare custom versions '$Left' and '$Right'."
  }
  for ($index = 0; $index -lt 5; $index++) {
    if ($leftParts[$index] -lt $rightParts[$index]) { return -1 }
    if ($leftParts[$index] -gt $rightParts[$index]) { return 1 }
  }
  return 0
}

function Backup-OrcaState {
  param([Parameter(Mandatory = $true)][string]$TargetVersion)

  Initialize-UpdaterDirectories
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dataPath = Join-Path $env:APPDATA 'orca\profiles\local-default\orca-data.json'
  if (Test-Path -LiteralPath $dataPath) {
    $dataBackup = Join-Path $BackupRoot "orca-data.json.pre-$TargetVersion-$stamp.bak"
    Copy-Item -LiteralPath $dataPath -Destination $dataBackup
    Write-UpdateLog "Backed up ORCA state to $dataBackup."
  }

  $installedState = Get-InstalledOrcaState
  if ($installedState.FeedPath -and (Test-Path -LiteralPath $installedState.FeedPath)) {
    $feedBackup = Join-Path $BackupRoot "app-update.yml.pre-$TargetVersion-$stamp.bak"
    Copy-Item -LiteralPath $installedState.FeedPath -Destination $feedBackup
    Write-UpdateLog "Backed up update feed to $feedBackup."
  }
}

function Stop-OrcaForUpdate {
  $processes = @(Get-Process -Name 'Orca' -ErrorAction SilentlyContinue)
  if ($processes.Count -eq 0) {
    return $false
  }

  foreach ($process in $processes) {
    try { [void]$process.CloseMainWindow() } catch { }
  }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Seconds 1
    if (@(Get-Process -Name 'Orca' -ErrorAction SilentlyContinue).Count -eq 0) {
      return $true
    }
  }

  Write-UpdateLog 'ORCA did not exit gracefully; forcing remaining ORCA processes to stop.'
  Get-Process -Name 'Orca' -ErrorAction SilentlyContinue | Stop-Process -Force
  return $true
}

function Install-CanonicalRelease {
  param([Parameter(Mandatory = $true)]$Package)

  $installed = Get-InstalledOrcaState
  if ($installed.Version) {
    $comparison = Compare-CustomVersion -Left $installed.Version -Right $Package.Version
    if ($comparison -gt 0) {
      Write-UpdateLog "Installed version $($installed.Version) is newer than $($Package.Version); downgrade blocked."
      return
    }
    if ($comparison -eq 0 -and $installed.FeedCanonical) {
      Write-UpdateLog "ORCA $($Package.Version) and the canonical update feed are already installed."
      return
    }
  }

  $running = @(Get-Process -Name 'Orca' -ErrorAction SilentlyContinue).Count -gt 0
  if ($running -and -not $AllowRestart) {
    Write-UpdateLog "Release $($Package.Version) is verified and staged, but ORCA is running. Re-run with -AllowRestart."
    exit 10
  }

  Backup-OrcaState -TargetVersion $Package.Version
  $wasRunning = $false
  if ($running) {
    $wasRunning = Stop-OrcaForUpdate
  }

  Write-UpdateLog "Starting silent installation of ORCA $($Package.Version)."
  $installerProcess = Start-Process -FilePath $Package.InstallerPath -ArgumentList '/S' -Wait -PassThru
  if ($installerProcess.ExitCode -ne 0) {
    throw "Installer failed with exit code $($installerProcess.ExitCode)."
  }

  $verifiedState = $null
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    $candidateState = Get-InstalledOrcaState
    if ($candidateState.Version -eq $Package.Version -and $candidateState.FeedCanonical) {
      $verifiedState = $candidateState
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $verifiedState) {
    $failedState = Get-InstalledOrcaState
    throw "Post-install verification failed. Version='$($failedState.Version)' FeedCanonical='$($failedState.FeedCanonical)'."
  }

  Write-UpdateLog "Installed ORCA $($Package.Version) with canonical feed $RepositorySlug."
  if ($wasRunning -and $verifiedState.ExecutablePath) {
    Start-Process -FilePath $verifiedState.ExecutablePath | Out-Null
    Write-UpdateLog 'Restarted ORCA after update.'
  }
}

function Register-OrcaUpdateTask {
  Initialize-UpdaterDirectories
  if (-not $PSCommandPath) {
    throw 'Cannot register the task because the current script path is unavailable.'
  }

  $stableScriptPath = Join-Path $StableScriptRoot 'Update-OrcaCustom.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $stableScriptPath -Force
  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$stableScriptPath`" -Mode Install -AllowRestart"
  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Saturday -At '04:30'
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Verify and install the canonical ORCA CEO Office release every Saturday at 04:30.' `
    -Force | Out-Null

  $task = Get-ScheduledTask -TaskName $TaskName
  Write-UpdateLog "Registered scheduled task '$TaskName' with state $($task.State)."
}

function Unregister-OrcaUpdateTask {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-UpdateLog "Unregistered scheduled task '$TaskName'."
  } else {
    Write-UpdateLog "Scheduled task '$TaskName' is not registered."
  }
}

try {
  switch ($Mode) {
    'Check' {
      $package = Get-CanonicalPackage
      $installed = Get-InstalledOrcaState
      [pscustomobject]@{
        Status = 'PASS'
        CanonicalRepository = $RepositorySlug
        LatestVersion = $package.Version
        ReleaseCommit = $package.Commit
        InstallerSha256 = $package.InstallerSha256
        InstalledVersion = $installed.Version
        CanonicalFeedInstalled = $installed.FeedCanonical
        ReleaseUrl = $package.ReleaseUrl
        CachePath = $package.InstallerPath
      } | Format-List
    }
    'Install' {
      $package = Get-CanonicalPackage
      Install-CanonicalRelease -Package $package
    }
    'RegisterTask' {
      Register-OrcaUpdateTask
    }
    'UnregisterTask' {
      Unregister-OrcaUpdateTask
    }
  }
} catch {
  Write-UpdateLog "FAIL: $($_.Exception.Message)"
  throw
}

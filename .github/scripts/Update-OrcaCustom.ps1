[CmdletBinding()]
param(
  [ValidateSet('Check', 'Install', 'Restore', 'RegisterTask', 'UnregisterTask')]
  [string]$Mode = 'Check',

  [switch]$AllowRestart,

  [string]$BackupPath,

  [switch]$ConfirmRestore
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
$StateBackupSchemaVersion = 1

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security

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

function Get-ByteSha256 {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash($Bytes)
    return -join @($hash | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha256.Dispose()
  }
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-OrcaStateItemDefinitions {
  $userDataRoot = Join-Path $env:APPDATA 'Orca'
  $items = @(
    [pscustomobject]@{
      Id = 'profile-data'
      Path = Join-Path $env:APPDATA 'Orca\profiles\local-default\orca-data.json'
      Sensitive = $true
      PreserveAcrossInstall = $true
    },
    [pscustomobject]@{
      Id = 'pairing-port'
      Path = Join-Path $userDataRoot 'mobile-ws-fallback-port.json'
      Sensitive = $false
      PreserveAcrossInstall = $true
    },
    [pscustomobject]@{
      Id = 'pairing-devices'
      Path = Join-Path $userDataRoot 'orca-devices.json'
      Sensitive = $true
      PreserveAcrossInstall = $true
    },
    [pscustomobject]@{
      Id = 'pairing-keypair'
      Path = Join-Path $userDataRoot 'orca-e2ee-keypair.json'
      Sensitive = $true
      PreserveAcrossInstall = $true
    }
  )

  $installedState = Get-InstalledOrcaState
  if ($installedState.FeedPath) {
    $items += [pscustomobject]@{
      Id = 'update-feed'
      Path = [string]$installedState.FeedPath
      Sensitive = $false
      PreserveAcrossInstall = $false
    }
  }
  return $items
}

function Protect-OrcaBackupDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Protect-OrcaStateFile {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  [byte[]]$plainBytes = [IO.File]::ReadAllBytes($Source)
  try {
    [byte[]]$protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllBytes($Destination, $protectedBytes)
  } finally {
    if ($plainBytes.Length -gt 0) {
      [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
  }
}

function Write-OrcaStateBytesAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][byte[]]$Bytes
  )

  $parent = Split-Path -Parent $Target
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $temporary = Join-Path $parent ('.orca-restore-{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
  $replacementBackup = "$temporary.previous"
  try {
    [IO.File]::WriteAllBytes($temporary, $Bytes)
    if (Test-Path -LiteralPath $Target) {
      [IO.File]::Replace($temporary, $Target, $replacementBackup)
    } else {
      [IO.File]::Move($temporary, $Target)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
    if (Test-Path -LiteralPath $replacementBackup) {
      Remove-Item -LiteralPath $replacementBackup -Force
    }
  }
}

function Get-ValidatedOrcaStateBackup {
  param([Parameter(Mandatory = $true)][string]$Path)

  $root = [IO.Path]::GetFullPath($BackupRoot).TrimEnd('\') + '\'
  $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Backup path must stay under '$BackupRoot'."
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "Backup directory does not exist: $resolved"
  }
  $backupItem = Get-Item -LiteralPath $resolved
  if (($backupItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Backup directory must not be a reparse point.'
  }

  $manifestPath = Join-Path $resolved 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Backup manifest is missing.'
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$manifest.SchemaVersion -ne $StateBackupSchemaVersion) {
    throw "Unsupported backup schema version '$($manifest.SchemaVersion)'."
  }

  $definitions = @{}
  foreach ($definition in @(Get-OrcaStateItemDefinitions)) {
    $definitions[[string]$definition.Id] = $definition
  }
  $seen = @{}
  foreach ($entry in @($manifest.Items)) {
    $id = [string]$entry.Id
    if (-not $definitions.ContainsKey($id) -or $seen.ContainsKey($id)) {
      throw "Backup manifest contains an unknown or duplicate item '$id'."
    }
    $seen[$id] = $true
    $definition = $definitions[$id]
    if (
      [bool]$entry.Sensitive -ne [bool]$definition.Sensitive -or
      [bool]$entry.PreserveAcrossInstall -ne [bool]$definition.PreserveAcrossInstall
    ) {
      throw "Backup item '$id' does not match the current recovery policy."
    }
    $expectedStoredName = if ([bool]$entry.Sensitive) { "$id.dpapi" } else { "$id.copy" }
    if ([string]$entry.StoredName -ne $expectedStoredName) {
      throw "Backup item '$id' has an invalid stored name."
    }
    if ([string]$entry.StoredSha256 -notmatch '^[0-9a-f]{64}$' -or [string]$entry.OriginalSha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Backup item '$id' has an invalid SHA-256 value."
    }
    $storedPath = Join-Path $resolved $expectedStoredName
    if (-not (Test-Path -LiteralPath $storedPath -PathType Leaf)) {
      throw "Backup item '$id' is missing."
    }
    $storedItem = Get-Item -LiteralPath $storedPath
    if (($storedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Backup item '$id' must not be a reparse point."
    }
    if ((Get-FileSha256 -Path $storedPath) -ne [string]$entry.StoredSha256) {
      throw "Backup item '$id' failed SHA-256 verification."
    }
  }

  return [pscustomobject]@{
    Path = $resolved
    Manifest = $manifest
    Definitions = $definitions
  }
}

function Backup-OrcaState {
  param([Parameter(Mandatory = $true)][string]$TargetVersion)

  Initialize-UpdaterDirectories
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-ffff'
  $backupDirectory = Join-Path $BackupRoot "pre-$TargetVersion-$stamp"
  New-Item -ItemType Directory -Path $backupDirectory | Out-Null
  Protect-OrcaBackupDirectory -Path $backupDirectory

  $entries = @()
  foreach ($definition in @(Get-OrcaStateItemDefinitions)) {
    if (-not (Test-Path -LiteralPath $definition.Path -PathType Leaf)) {
      continue
    }
    $storedName = if ($definition.Sensitive) { "$($definition.Id).dpapi" } else { "$($definition.Id).copy" }
    $storedPath = Join-Path $backupDirectory $storedName
    if ($definition.Sensitive) {
      Protect-OrcaStateFile -Source $definition.Path -Destination $storedPath
    } else {
      Copy-Item -LiteralPath $definition.Path -Destination $storedPath
    }
    $entries += [pscustomobject]@{
      Id = $definition.Id
      StoredName = $storedName
      Sensitive = [bool]$definition.Sensitive
      PreserveAcrossInstall = [bool]$definition.PreserveAcrossInstall
      OriginalLength = (Get-Item -LiteralPath $definition.Path).Length
      OriginalSha256 = Get-FileSha256 -Path $definition.Path
      StoredSha256 = Get-FileSha256 -Path $storedPath
    }
  }

  $manifest = [ordered]@{
    SchemaVersion = $StateBackupSchemaVersion
    CreatedAt = (Get-Date).ToString('o')
    TargetVersion = $TargetVersion
    Items = $entries
  }
  $manifestPath = Join-Path $backupDirectory 'manifest.json'
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  [void](Get-ValidatedOrcaStateBackup -Path $backupDirectory)
  Write-UpdateLog "Created and verified protected ORCA recovery backup at $backupDirectory."
  return $backupDirectory
}

function Assert-OrcaStateMatchesBackup {
  param([Parameter(Mandatory = $true)][string]$Path)

  $backup = Get-ValidatedOrcaStateBackup -Path $Path
  foreach ($entry in @($backup.Manifest.Items | Where-Object { [bool]$_.PreserveAcrossInstall })) {
    $definition = $backup.Definitions[[string]$entry.Id]
    if (-not (Test-Path -LiteralPath $definition.Path -PathType Leaf)) {
      throw "ORCA state item '$($entry.Id)' disappeared during the update."
    }
    if ((Get-FileSha256 -Path $definition.Path) -ne [string]$entry.OriginalSha256) {
      throw "ORCA state item '$($entry.Id)' changed during the update."
    }
  }
}

function Restore-OrcaStateFiles {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$PreservedOnly
  )

  $backup = Get-ValidatedOrcaStateBackup -Path $Path
  $entries = @($backup.Manifest.Items)
  if ($PreservedOnly) {
    $entries = @($entries | Where-Object { [bool]$_.PreserveAcrossInstall })
  }
  foreach ($entry in $entries) {
    $definition = $backup.Definitions[[string]$entry.Id]
    $storedPath = Join-Path $backup.Path ([string]$entry.StoredName)
    [byte[]]$bytes = if ([bool]$entry.Sensitive) {
      $protectedBytes = [IO.File]::ReadAllBytes($storedPath)
      [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
    } else {
      [IO.File]::ReadAllBytes($storedPath)
    }
    try {
      if ((Get-ByteSha256 -Bytes $bytes) -ne [string]$entry.OriginalSha256) {
        throw "Backup item '$($entry.Id)' failed decrypted SHA-256 verification."
      }
      Write-OrcaStateBytesAtomically -Target $definition.Path -Bytes $bytes
    } finally {
      if ($bytes.Length -gt 0) {
        [Array]::Clear($bytes, 0, $bytes.Length)
      }
    }
  }
}

function Read-PreservedPairingPort {
  $path = Join-Path $env:APPDATA 'Orca\mobile-ws-fallback-port.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return $null
  }
  $document = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  $port = 0
  if (-not [int]::TryParse([string]$document.port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'The saved ORCA pairing port file is invalid.'
  }
  return $port
}

function ConvertFrom-ExcludedTcpPortOutput {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Lines)

  $ranges = @()
  foreach ($line in $Lines) {
    $match = [regex]::Match($line, '^\s*(\d+)\s+(\d+)(?:\s+\*)?\s*$')
    if ($match.Success) {
      $ranges += [pscustomobject]@{
        Start = [int]$match.Groups[1].Value
        End = [int]$match.Groups[2].Value
      }
    }
  }
  return $ranges
}

function Get-WindowsExcludedTcpPortRanges {
  $netshPath = Join-Path $env:SystemRoot 'System32\netsh.exe'
  if (-not (Test-Path -LiteralPath $netshPath -PathType Leaf)) {
    throw 'Windows netsh.exe is unavailable for the pairing-port preflight.'
  }
  $output = @(& $netshPath interface ipv4 show excludedportrange protocol=tcp 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Windows excluded-port preflight failed with exit code $LASTEXITCODE."
  }
  return @(ConvertFrom-ExcludedTcpPortOutput -Lines @($output | ForEach-Object { [string]$_ }))
}

function Assert-PairingPortNotExcluded {
  param([AllowNull()][Nullable[int]]$Port)

  $port = $Port
  if ($null -eq $port) {
    return
  }
  foreach ($range in @(Get-WindowsExcludedTcpPortRanges)) {
    if ($port -ge $range.Start -and $port -le $range.End) {
      throw "Saved ORCA pairing port $port is reserved by Windows (excluded range $($range.Start)-$($range.End)). The update was stopped before ORCA shutdown."
    }
  }
}

function Assert-PreservedPairingPortAvailable {
  Assert-PairingPortNotExcluded -Port (Read-PreservedPairingPort)
}

function Read-BackupPairingPort {
  param([Parameter(Mandatory = $true)]$Backup)

  $entry = @($Backup.Manifest.Items | Where-Object { [string]$_.Id -eq 'pairing-port' } | Select-Object -First 1)
  if ($entry.Count -eq 0) {
    return $null
  }
  $portPath = Join-Path $Backup.Path ([string]$entry[0].StoredName)
  $document = Get-Content -LiteralPath $portPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $port = 0
  if (-not [int]::TryParse([string]$document.port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'The backup contains an invalid ORCA pairing port.'
  }
  return $port
}

function Wait-OrcaPairingPort {
  param([int]$TimeoutSeconds = 30)

  $port = Read-PreservedPairingPort
  if ($null -eq $port) {
    return
  }
  for ($attempt = 0; $attempt -lt $TimeoutSeconds; $attempt++) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
      if ($owner -and $owner.ProcessName -eq 'Orca') {
        Write-UpdateLog "Verified ORCA pairing listener on preserved port $port."
        return
      }
    }
    Start-Sleep -Seconds 1
  }
  throw "ORCA did not reclaim preserved pairing port $port within $TimeoutSeconds seconds."
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

  Assert-PreservedPairingPortAvailable
  $wasRunning = $false
  if ($running) {
    $wasRunning = Stop-OrcaForUpdate
  }

  try {
    # Why: pairing identity files must be snapshotted after the writer exits or the set can be internally inconsistent.
    $stateBackup = Backup-OrcaState -TargetVersion $Package.Version
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

    Assert-PreservedPairingPortAvailable
    try {
      Assert-OrcaStateMatchesBackup -Path $stateBackup
    } catch {
      Write-UpdateLog 'ORCA user state changed during installation; restoring the protected pre-update copy.'
      Restore-OrcaStateFiles -Path $stateBackup -PreservedOnly
      Assert-OrcaStateMatchesBackup -Path $stateBackup
    }
  } catch {
    if ($wasRunning) {
      $recoveryState = Get-InstalledOrcaState
      if ($recoveryState.ExecutablePath) {
        Start-Process -FilePath $recoveryState.ExecutablePath | Out-Null
        Write-UpdateLog 'Restarted ORCA after a failed update attempt.'
      }
    }
    throw
  }

  Write-UpdateLog "Installed ORCA $($Package.Version) with canonical feed $RepositorySlug."
  if ($wasRunning -and $verifiedState.ExecutablePath) {
    Start-Process -FilePath $verifiedState.ExecutablePath | Out-Null
    Write-UpdateLog 'Restarted ORCA after update.'
    Wait-OrcaPairingPort
  }
}

function Restore-OrcaState {
  if (-not $BackupPath) {
    throw 'Restore mode requires -BackupPath.'
  }
  $backup = Get-ValidatedOrcaStateBackup -Path $BackupPath
  Assert-PairingPortNotExcluded -Port (Read-BackupPairingPort -Backup $backup)
  $itemIds = @($backup.Manifest.Items | ForEach-Object { [string]$_.Id })
  if (-not $ConfirmRestore) {
    [pscustomobject]@{
      Status = 'DRY_RUN_PASS'
      BackupPath = $backup.Path
      TargetVersion = [string]$backup.Manifest.TargetVersion
      ItemIds = $itemIds -join ', '
      NextStep = 'Re-run with -ConfirmRestore and -AllowRestart if ORCA is running.'
    } | Format-List
    return
  }

  $installed = Get-InstalledOrcaState
  $running = @(Get-Process -Name 'Orca' -ErrorAction SilentlyContinue).Count -gt 0
  if ($running -and -not $AllowRestart) {
    Write-UpdateLog 'Restore is verified but ORCA is running. Re-run with -AllowRestart.'
    exit 10
  }

  $wasRunning = $false
  if ($running) {
    $wasRunning = Stop-OrcaForUpdate
  }
  $rollbackBackup = $null
  try {
    # Why: rollback must capture one stopped-writer state, not files sampled across concurrent registry writes.
    $rollbackBackup = Backup-OrcaState -TargetVersion 'pre-restore'
    Restore-OrcaStateFiles -Path $backup.Path
    Assert-OrcaStateMatchesBackup -Path $backup.Path
    Assert-PreservedPairingPortAvailable
  } catch {
    if ($rollbackBackup) {
      Restore-OrcaStateFiles -Path $rollbackBackup
    }
    if ($wasRunning -and $installed.ExecutablePath) {
      Start-Process -FilePath $installed.ExecutablePath | Out-Null
      Write-UpdateLog 'Restarted ORCA after a failed state restore.'
    }
    throw
  }

  Write-UpdateLog "Restored ORCA state from $($backup.Path). Rollback backup: $rollbackBackup."
  if ($wasRunning -and $installed.ExecutablePath) {
    Start-Process -FilePath $installed.ExecutablePath | Out-Null
    Write-UpdateLog 'Restarted ORCA after state restore.'
    Wait-OrcaPairingPort
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

function Invoke-OrcaCustomUpdater {
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
      'Restore' {
        Restore-OrcaState
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
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-OrcaCustomUpdater
}

[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

function Assert-Throws {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [Parameter(Mandatory = $true)][string]$MessagePattern
  )
  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notmatch $MessagePattern) {
      throw "Expected error matching '$MessagePattern', got '$($_.Exception.Message)'."
    }
    return
  }
  throw "Expected an error matching '$MessagePattern'."
}

$originalAppData = $env:APPDATA
$originalLocalAppData = $env:LOCALAPPDATA
$originalProgramFiles = $env:ProgramFiles
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('orca-updater-test-' + [Guid]::NewGuid().ToString('N'))

try {
  $env:APPDATA = Join-Path $testRoot 'Roaming'
  $env:LOCALAPPDATA = Join-Path $testRoot 'Local'
  $env:ProgramFiles = Join-Path $testRoot 'ProgramFiles'
  New-Item -ItemType Directory -Path $env:APPDATA, $env:LOCALAPPDATA, $env:ProgramFiles -Force | Out-Null

  . (Join-Path $PSScriptRoot 'Update-OrcaCustom.ps1')

  function Get-InstalledOrcaState {
    return [pscustomobject]@{
      ExecutablePath = $null
      Version = $null
      FeedPath = $null
      FeedCanonical = $false
    }
  }

  $fixtures = @{
    'profile-data' = '{"workspace":"test-only"}'
    'pairing-port' = '{"port":6768}'
    'pairing-devices' = '[{"deviceId":"test-device","token":"test-token"}]'
    'pairing-keypair' = '{"publicKeyB64":"test-public","secretKeyB64":"test-secret"}'
  }
  $definitions = @{}
  foreach ($definition in @(Get-OrcaStateItemDefinitions)) {
    $definitions[[string]$definition.Id] = $definition
    $parent = Split-Path -Parent $definition.Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Set-Content -LiteralPath $definition.Path -Value $fixtures[[string]$definition.Id] -Encoding UTF8
  }

  $backupPath = Backup-OrcaState -TargetVersion 'test.1'
  $validated = Get-ValidatedOrcaStateBackup -Path $backupPath
  Assert-True -Condition (@($validated.Manifest.Items).Count -eq 4) -Message 'Expected all four ORCA user-state items in the manifest.'

  $encryptedDevices = [Text.Encoding]::UTF8.GetString(
    [IO.File]::ReadAllBytes((Join-Path $backupPath 'pairing-devices.dpapi'))
  )
  Assert-True -Condition (-not $encryptedDevices.Contains('test-token')) -Message 'Sensitive pairing data was stored as plaintext.'

  foreach ($definition in $definitions.Values) {
    Set-Content -LiteralPath $definition.Path -Value 'changed' -Encoding UTF8
  }
  Restore-OrcaStateFiles -Path $backupPath
  Assert-OrcaStateMatchesBackup -Path $backupPath

  $portCopy = Join-Path $backupPath 'pairing-port.copy'
  $originalPortCopy = [IO.File]::ReadAllBytes($portCopy)
  Set-Content -LiteralPath $portCopy -Value 'tampered' -Encoding UTF8
  Assert-Throws -Action { Get-ValidatedOrcaStateBackup -Path $backupPath | Out-Null } -MessagePattern 'failed SHA-256 verification'
  [IO.File]::WriteAllBytes($portCopy, $originalPortCopy)

  $ranges = @(ConvertFrom-ExcludedTcpPortOutput -Lines @(
      '',
      'Start Port    End Port',
      '----------    --------',
      '',
      '      6990        7089',
      '     50000       50059     *',
      ''
    ))
  Assert-True -Condition ($ranges.Count -eq 2) -Message 'Excluded TCP port ranges were not parsed.'
  Assert-True -Condition ($ranges[0].Start -eq 6990 -and $ranges[0].End -eq 7089) -Message 'First excluded range was parsed incorrectly.'

  function Get-WindowsExcludedTcpPortRanges {
    return @([pscustomobject]@{ Start = 6990; End = 7089 })
  }
  Assert-PreservedPairingPortAvailable
  Set-Content -LiteralPath $definitions['pairing-port'].Path -Value '{"port":7078}' -Encoding UTF8
  Assert-Throws -Action { Assert-PreservedPairingPortAvailable } -MessagePattern 'reserved by Windows'

  Write-Host 'Update-OrcaCustom.Tests.ps1 PASS'
} finally {
  $env:APPDATA = $originalAppData
  $env:LOCALAPPDATA = $originalLocalAppData
  $env:ProgramFiles = $originalProgramFiles
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}

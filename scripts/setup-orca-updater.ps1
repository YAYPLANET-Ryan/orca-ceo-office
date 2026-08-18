[CmdletBinding()]
param(
  [string]$UpdaterPath,
  [string]$TaskName = 'ORCA Weekly GitHub Release Install'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($UpdaterPath)) {
  $UpdaterPath = Join-Path $PSScriptRoot 'orca-weekly-release-install.ps1'
}
$installDir = Join-Path $env:LOCALAPPDATA 'orca-updater'
$installedUpdater = Join-Path $installDir 'orca-weekly-release-install.ps1'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
if (Test-Path -LiteralPath $UpdaterPath -PathType Leaf) {
  Copy-Item -LiteralPath $UpdaterPath -Destination $installedUpdater -Force
} else {
  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { throw "Updater script not found and gh.exe is unavailable: $UpdaterPath" }
  $apiPath = 'repos/YAYPLANET-Ryan/orca-ceo-office/contents/scripts/orca-weekly-release-install.ps1?ref=ryan/update-session-continuity-20260818'
  $payload = gh api $apiPath | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $payload.content) { throw 'Could not download the canonical updater from GitHub.' }
  [IO.File]::WriteAllBytes($installedUpdater, [Convert]::FromBase64String(($payload.content -replace '\s', '')))
}

$action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$installedUpdater`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At '04:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Install verified Orca GitHub releases every Saturday at 04:00.' -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Registered: $TaskName"
Write-Host "Updater: $installedUpdater"
Write-Host "Next run: $($info.NextRunTime)"
Write-Host 'The task verifies only the GitHub release SHA-256 and never modifies APPDATA or .orca.'

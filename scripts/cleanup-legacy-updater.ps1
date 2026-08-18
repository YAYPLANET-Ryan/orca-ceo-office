[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskName = 'Orca CEO Updater'
$legacyScript = Join-Path $env:LOCALAPPDATA 'hermes\scripts\orca_ceo_updater.py'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Write-Host "Legacy task present: $([bool]$task)"
Write-Host "Legacy script present: $(Test-Path -LiteralPath $legacyScript)"
if (-not $Apply) {
  Write-Host 'Dry run only. Re-run with -Apply after reviewing the two paths above.'
  return
}
if (-not $PSCmdlet.ShouldProcess($taskName, 'Unregister legacy updater task')) { return }
if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
if (Test-Path -LiteralPath $legacyScript -PathType Leaf) {
  if ($PSCmdlet.ShouldProcess($legacyScript, 'Remove legacy updater script')) {
    Remove-Item -LiteralPath $legacyScript -Force
  }
}

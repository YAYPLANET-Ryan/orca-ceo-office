param([Parameter(Mandatory=$true)][string]$PlanPath,[Parameter(Mandatory=$true)][string]$ExpectedPlanSha256)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/ReleaseStartupGate.ps1"
. "$PSScriptRoot/WindowsReleaseOperations.ps1"
Assert-ReleasePlanHash $ExpectedPlanSha256
$PlanPath=[IO.Path]::GetFullPath($PlanPath)
if ((Get-ReleaseHash $PlanPath) -ne $ExpectedPlanSha256) { throw 'Plan hash mismatch' }
$plan=Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8|ConvertFrom-Json
Assert-ReleasePlan $plan -ForLaunch
$operations=New-WindowsReleaseOperations $plan
Invoke-ReleaseGuardedLaunch -Root $plan.installRoot -StateDirectory (Get-ReleaseStateDirectory $plan.installRoot) -PlanHash $ExpectedPlanSha256 -Operations $operations | ConvertTo-Json

param(
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [Parameter(Mandatory=$true)][string]$ExpectedPlanSha256,
    [ValidateSet('Validate','Inspect','Apply','Recover','Rollback')][string]$Mode = 'Inspect'
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/ReleaseTransaction.ps1"
. "$PSScriptRoot/WindowsReleaseOperations.ps1"
Assert-ReleasePlanHash $ExpectedPlanSha256
if ((Get-ReleaseHash $PlanPath) -ne $ExpectedPlanSha256) { throw 'Plan hash mismatch' }
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$plan.installRoot = Resolve-ReleaseRoot $plan.installRoot
if ($Mode -eq 'Validate') {
    Assert-ReleasePlan $plan
    [pscustomobject]@{result='ARTIFACTS_VALIDATED';liveMutation=$false;version=$plan.version}
    exit 0
}
# A fixed location per canonical target prevents two differently named plans from bypassing locking.
$stateDirectory = Get-ReleaseStateDirectory $plan.installRoot
$operations = New-WindowsReleaseOperations $plan
$result = Invoke-ReleaseTransaction -Root $plan.installRoot -StateDirectory $stateDirectory -PlanHash $ExpectedPlanSha256 -Operations $operations -Mode $Mode
$result | ConvertTo-Json -Depth 10
if ($result -and $result.phase -ne 'READY') { exit 2 }

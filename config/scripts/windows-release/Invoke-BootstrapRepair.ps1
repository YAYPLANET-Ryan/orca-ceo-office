param([Parameter(Mandatory=$true)][string]$PlanPath,[Parameter(Mandatory=$true)][string]$ExpectedPlanSha256,
      [ValidateSet('Validate','Inspect','Apply','Recover','Rollback')][string]$Mode='Validate')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/BootstrapRepair.ps1"
. "$PSScriptRoot/ReleaseTransaction.ps1"
Assert-ReleasePlanHash $ExpectedPlanSha256
if((Get-ReleaseHash $PlanPath) -ne $ExpectedPlanSha256){throw 'Plan hash mismatch'}
$plan=Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8|ConvertFrom-Json
Assert-BootstrapExecutionIdentity $plan.installRoot
if($Mode -eq 'Validate') {
    Assert-BootstrapRepairPlan $plan
    Assert-ReleaseVersion $plan.installRoot $plan.bootstrap.preRepairVersion
    Assert-KnownIncompleteProgram $plan.installRoot $plan.rollback.manifest $plan.bootstrap.initialMissingPaths
    @{result='R0_ARTIFACTS_AND_INITIAL_STATE_VALIDATED';liveWrites=$false}|ConvertTo-Json
    exit 0
}
$operations=New-BootstrapReleaseOperations $plan
$result=Invoke-ReleaseTransaction -Root $plan.installRoot -StateDirectory (Get-ReleaseStateDirectory $plan.installRoot) -PlanHash $ExpectedPlanSha256 -Operations $operations -Mode $Mode -DeferReadiness
$result|ConvertTo-Json -Depth 12
# Deliberately not READY: the approved maintenance transition precedes GUI launch.
if($result -and $result.install -eq 'VERIFIED' -and $result.readiness -eq 'DEFERRED_MAINTENANCE_FINALIZATION'){exit 0}
if($result){exit 2}

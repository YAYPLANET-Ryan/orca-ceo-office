param(
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [Parameter(Mandatory=$true)][string]$ExpectedPlanSha256,
    [ValidateSet('Validate','Inspect','Apply','Recover')][string]$Mode = 'Inspect'
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/ReleaseTransaction.ps1"
. "$PSScriptRoot/WindowsReleaseOperations.ps1"
if ((Get-ReleaseHash $PlanPath) -ne $ExpectedPlanSha256) { throw 'Plan hash mismatch' }
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$plan.installRoot = Resolve-ReleaseRoot $plan.installRoot
if ($Mode -eq 'Validate') {
    Assert-ReleasePlan $plan
    [pscustomobject]@{result='ARTIFACTS_VALIDATED';liveMutation=$false;version=$plan.version}
    exit 0
}
$algorithm = [Security.Cryptography.SHA256]::Create()
try { $key = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($plan.installRoot.ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
finally { $algorithm.Dispose() }
# A fixed location per canonical target prevents two differently named plans from bypassing locking.
$stateDirectory = Join-Path $env:LOCALAPPDATA ('OrcaRelease/' + $key)
$operations = New-WindowsReleaseOperations $plan
$result = Invoke-ReleaseTransaction -Root $plan.installRoot -StateDirectory $stateDirectory -PlanHash $ExpectedPlanSha256 -Operations $operations -Mode $Mode
$result | ConvertTo-Json -Depth 10
if ($result -and $result.phase -ne 'READY') { exit 2 }

param(
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [Parameter(Mandatory=$true)][string]$ExpectedPlanSha256,
    [switch]$Register,
    [switch]$RouteExistingStartup
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/WindowsReleaseOperations.ps1"
. "$PSScriptRoot/ReleaseStartupShortcut.ps1"
Assert-ReleasePlanHash $ExpectedPlanSha256
$PlanPath=[IO.Path]::GetFullPath($PlanPath)
if ((Get-ReleaseHash $PlanPath) -ne $ExpectedPlanSha256) { throw 'Plan hash mismatch' }
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ReleasePlan $plan
$runner = Join-Path $PSScriptRoot 'Invoke-VerifiedRelease.ps1'
$gate = Join-Path $PSScriptRoot 'Invoke-GuardedOrcaLaunch.ps1'
$startupFolder=[Environment]::GetFolderPath('Startup')
$runBypasses=@(Get-ReleaseStartupRunBypasses $plan.installRoot)
$shortcutPlan=Set-ReleaseStartupShortcutGate -Folder $startupFolder -InstallRoot $plan.installRoot -PlanPath $PlanPath -PlanHash $ExpectedPlanSha256 -GatePath $gate -BackupRoot (Join-Path (Get-ReleaseStateDirectory $plan.installRoot) 'startup-shortcuts')
foreach ($path in @($PlanPath,$runner)) { if ($path.Contains('"') -or $path.Contains("`n")) { throw 'Invalid task argument' } }
if (-not $Register) {
    [pscustomobject]@{result='PREVIEW_ONLY';apply='On-demand only';recover='At interactive user logon';
        executionTimeLimit='PT0S';multipleInstances='IgnoreNew';liveChanges=$false;directStartupShortcuts=$shortcutPlan.eligibleShortcuts;directRunEntries=$runBypasses.Count;
        limitation='Scheduler cannot survive OS shutdown. Registration routes logon through recovery and verified launch; existing direct startup requires explicit routing.'}
    exit 0
}
# Register only as part of an approved deployment, after the current app is safely closed.
Assert-ReleaseIdle $plan $null
if ($runBypasses.Count -gt 0) { throw 'HKCU Run directly starts Orca; bounded Run routing review required before registration' }
if ($shortcutPlan.eligibleShortcuts -gt 0 -and -not $RouteExistingStartup) { throw 'Direct Startup would bypass recovery; review routing before registration' }
Import-Module "$env:SystemRoot/System32/WindowsPowerShell/v1.0/Modules/ScheduledTasks/ScheduledTasks.psd1" -ErrorAction Stop
$root = Resolve-ReleaseRoot $plan.installRoot
$algorithm = [Security.Cryptography.SHA256]::Create()
try { $key = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-','').Substring(0,16) }
finally { $algorithm.Dispose() }
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
foreach ($mode in @('Apply','Recover')) {
    $name = 'Orca-VerifiedRelease-' + $key + '-' + $mode
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'Existing scheduled task must be reviewed; no overwrite' }
}
if ($RouteExistingStartup) { Set-ReleaseStartupShortcutGate -Folder $startupFolder -InstallRoot $plan.installRoot -PlanPath $PlanPath -PlanHash $ExpectedPlanSha256 -GatePath $gate -BackupRoot (Join-Path (Get-ReleaseStateDirectory $plan.installRoot) 'startup-shortcuts') -Apply }
foreach ($mode in @('Recover','Apply')) {
    $name = 'Orca-VerifiedRelease-' + $key + '-' + $mode
    $entry = $(if($mode -eq 'Recover'){$gate}else{$runner})
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $entry + '" -PlanPath "' + $PlanPath + '" -ExpectedPlanSha256 ' + $ExpectedPlanSha256
    if ($mode -eq 'Apply') { $arguments+=' -Mode Apply' }
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -Argument $arguments
    $definition = @{Action=$action;Principal=$principal;Settings=$settings}
    if ($mode -eq 'Recover') { $definition.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId }
    Register-ScheduledTask -TaskName $name -InputObject (New-ScheduledTask @definition) | Select-Object TaskName,State
}
# Deliberately does not start either task or close any application.

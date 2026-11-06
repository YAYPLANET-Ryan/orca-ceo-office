param(
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [Parameter(Mandatory=$true)][string]$ExpectedPlanSha256,
    [switch]$Register,
    [switch]$RouteExistingStartup,
    [string]$ExpectedBundleSha256
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/WindowsReleaseOperations.ps1"
. "$PSScriptRoot/ReleaseStartupShortcut.ps1"
. "$PSScriptRoot/ReleaseHelperBundle.ps1"
Assert-ReleasePlanHash $ExpectedPlanSha256
$PlanPath=[IO.Path]::GetFullPath($PlanPath)
if ((Get-ReleaseHash $PlanPath) -ne $ExpectedPlanSha256) { throw 'Plan hash mismatch' }
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ReleasePlan $plan
$runner = Join-Path $PSScriptRoot 'Invoke-VerifiedRelease.ps1'
$gate = Join-Path $PSScriptRoot 'Invoke-GuardedOrcaLaunch.ps1'
$bundleAvailable=Test-Path -LiteralPath (Join-Path $PSScriptRoot 'bundle-manifest.json')
if($ExpectedBundleSha256){Assert-ReleaseHelperBundle $PSScriptRoot $ExpectedBundleSha256|Out-Null;$gate=Join-Path $PSScriptRoot 'Invoke-ReleaseBundleEntry.ps1'}
$startupFolder=[Environment]::GetFolderPath('Startup')
$runBypasses=@(Get-ReleaseStartupRunBypasses $plan.installRoot)
$shortcutArguments=@{Folder=$startupFolder;InstallRoot=$plan.installRoot;PlanPath=$PlanPath;PlanHash=$ExpectedPlanSha256;GatePath=$gate;BackupRoot=(Join-Path (Get-ReleaseStateDirectory $plan.installRoot) 'startup-shortcuts');BundleSha256=$ExpectedBundleSha256}
$shortcutPlan=Set-ReleaseStartupShortcutGate @shortcutArguments
foreach ($path in @($PlanPath,$runner)) { if ($path.Contains('"') -or $path.Contains("`n")) { throw 'Invalid task argument' } }
if (-not $Register) {
    [pscustomobject]@{result='PREVIEW_ONLY';apply='On-demand only';recover='At interactive user logon';
        executionTimeLimit='PT0S';multipleInstances='IgnoreNew';effectiveExecutionPolicy=(Get-ExecutionPolicy);liveChanges=$false;directStartupShortcuts=$shortcutPlan.eligibleShortcuts;directRunEntries=$runBypasses.Count;runtimeBundleAvailable=$bundleAvailable;
        limitation='Scheduler cannot survive OS shutdown. Registration routes logon through recovery and verified launch; existing direct startup requires explicit routing.'}
    exit 0
}
# Register only as part of an approved deployment, after the current app is safely closed.
Assert-ReleaseIdle $plan $null
if(-not $bundleAvailable -or -not $ExpectedBundleSha256){throw 'Registration requires a pinned persistent runtime bundle, never a mutable worktree'}
Assert-ReleaseHelperBundle $PSScriptRoot $ExpectedBundleSha256|Out-Null
if ($runBypasses.Count -gt 0) { throw 'HKCU Run directly starts Orca; bounded Run routing review required before registration' }
if ($shortcutPlan.eligibleShortcuts -gt 0 -and -not $RouteExistingStartup) { throw 'Direct Startup would bypass recovery; review routing before registration' }
$registrationDirectory=Get-ReleaseStateDirectory $plan.installRoot
[IO.Directory]::CreateDirectory($registrationDirectory)|Out-Null
$registrationLock=[IO.File]::Open((Join-Path $registrationDirectory 'registration.lock'),'OpenOrCreate','ReadWrite','None')
try {
$launchLock=$null;$updateLock=$null
try {
$launchLock=[IO.File]::Open((Join-Path $registrationDirectory 'launch.lock'),'OpenOrCreate','ReadWrite','None')
$updateLock=[IO.File]::Open((Join-Path $registrationDirectory 'update.lock'),'OpenOrCreate','ReadWrite','None')
Assert-ReleaseIdle $plan $null
$registrationPath=Join-Path $registrationDirectory 'registration.json'
if(Test-Path -LiteralPath $registrationPath){throw 'Previous registration intent exists; inspect partial tasks and shortcut backups before retry. No overwrite.'}
$registration=[pscustomobject]@{schema=1;phase='PREPARING';planHash=$ExpectedPlanSha256;bundleHash=$ExpectedBundleSha256;root=$plan.installRoot;shortcuts=$shortcutPlan.shortcuts;createdTasks=@();error=$null;updatedAt=''}
Write-ReleaseJournal $registrationPath $registration
try {
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
$registration.phase='ROUTING';Write-ReleaseJournal $registrationPath $registration
if ($RouteExistingStartup) { $routed=Set-ReleaseStartupShortcutGate @shortcutArguments -Apply;$registration.shortcuts=$routed.shortcuts;Write-ReleaseJournal $registrationPath $registration }
foreach ($mode in @('Recover','Apply')) {
    $name = 'Orca-VerifiedRelease-' + $key + '-' + $mode
    $entry=Join-Path $PSScriptRoot 'Invoke-ReleaseBundleEntry.ps1'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $entry + '" -PlanPath "' + $PlanPath + '" -ExpectedPlanSha256 ' + $ExpectedPlanSha256
    $arguments+=' -ExpectedBundleSha256 '+$ExpectedBundleSha256
    if ($mode -eq 'Apply') { $arguments+=' -Entry Invoke-VerifiedRelease.ps1 -Mode Apply' }else{$arguments+=' -Entry Invoke-GuardedOrcaLaunch.ps1'}
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments
    $definition = @{Action=$action;Principal=$principal;Settings=$settings}
    if ($mode -eq 'Recover') { $definition.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId }
    $registration.phase='REGISTERING_'+$mode;Write-ReleaseJournal $registrationPath $registration
    Register-ScheduledTask -TaskName $name -InputObject (New-ScheduledTask @definition) | Select-Object TaskName,State
    $registration.createdTasks+= $name;Write-ReleaseJournal $registrationPath $registration
}
$registration.phase='REGISTERED';Write-ReleaseJournal $registrationPath $registration
}catch{$registration.phase='RECONCILIATION_REQUIRED';$registration.error=$_.Exception.Message;Write-ReleaseJournal $registrationPath $registration;throw}
}finally{if($updateLock){$updateLock.Dispose()};if($launchLock){$launchLock.Dispose()}}
}finally{$registrationLock.Dispose()}
# Deliberately does not start either task or close any application.

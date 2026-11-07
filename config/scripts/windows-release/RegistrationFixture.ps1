param([Parameter(Mandatory=$true)][string]$Sandbox,[ValidateSet('Prepare','Run','Preview','Inspect')][string]$Mode='Prepare',[string]$Scenario='success')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/ReleaseIntegrity.ps1"
$Sandbox=Resolve-ReleaseRoot $Sandbox
if($Sandbox -notmatch '[\\/]dist[\\/]release-regression[\\/]' -or -not(Test-Path -LiteralPath (Join-Path $Sandbox 'TEST_ONLY'))){throw 'Isolated fixture marker required'}
$bundle=Join-Path $Sandbox 'bundle'
if($Mode -eq 'Prepare'){
    foreach($folder in @('bundle','program','state','startup','scheduler')){[IO.Directory]::CreateDirectory((Join-Path $Sandbox $folder))|Out-Null}
    foreach($name in @('Register-ReleaseRecovery.ps1','ReleaseIntegrity.ps1','ReleaseHelperBundle.ps1','ReleaseStartupShortcut.ps1','ReleaseRegistrationState.ps1','Invoke-ReleaseBundleEntry.ps1')){
        [IO.File]::Copy((Join-Path $PSScriptRoot $name),(Join-Path $bundle $name),$false)
    }
    foreach($name in @('Invoke-VerifiedRelease.ps1','Invoke-GuardedOrcaLaunch.ps1')){[IO.File]::WriteAllText((Join-Path $bundle $name),"throw 'Not an executable fixture entry'")}
    @'
. "$PSScriptRoot/ReleaseIntegrity.ps1"
function Assert-ReleasePlan($Plan){if((Resolve-ReleaseRoot $Plan.installRoot) -ne (Join-Path $Sandbox 'program')){throw 'Fixture root mismatch'}}
function Assert-ReleaseIdle($Plan,$State){if(Test-Path -LiteralPath (Join-Path $Sandbox 'busy')){throw 'Synthetic busy target'}}
'@|Set-Content -LiteralPath (Join-Path $bundle 'WindowsReleaseOperations.ps1') -Encoding UTF8
    @'
function Get-ReleaseStateDirectory($Root){Join-Path $Sandbox 'state'}
function Get-ReleaseStartupFolder {Join-Path $Sandbox 'startup'}
function Get-ReleaseExecutionPolicy {'TEST_ONLY_POLICY'}
function Get-ReleaseStartupRunBypasses($Root){@()}
function Initialize-ReleaseScheduler {}
function New-ReleaseSchedulerPrincipal {@{UserId='TEST_ONLY'}}
function New-ScheduledTaskSettingsSet {param($ExecutionTimeLimit,$MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,[switch]$StartWhenAvailable) @{timeout=$ExecutionTimeLimit;instances=$MultipleInstances}}
function New-ScheduledTaskTrigger {param([switch]$AtLogOn,$User) @{kind='TEST_ONLY_LOGON'}}
function New-ScheduledTaskAction {param($Execute,$Argument) @{execute=$Execute;argument=$Argument}}
function New-ScheduledTask {param($Action,$Principal,$Settings,$Trigger) @{action=$Action;settings=$Settings;trigger=$Trigger}}
function Get-ScheduledTask {param($TaskName,$ErrorAction) $path=Join-Path $Sandbox ('scheduler/'+$TaskName+'.json');if(Test-Path -LiteralPath $path){@{name=$TaskName}}}
function Get-ReleaseScheduledTaskProjection($Name){$path=Join-Path $Sandbox ('scheduler/'+$Name+'.json');if(Test-Path -LiteralPath $path){$task=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json;@{status='FOUND';execute=$task.action.execute;arguments=$task.action.argument}}else{@{status='MISSING'}}}
function Register-ScheduledTask {
    param($TaskName,$InputObject)
    if($Scenario -eq 'fail-apply' -and $TaskName.EndsWith('-Apply')){throw 'Synthetic Apply registration failure'}
    if($Scenario -eq 'fail-recover' -and $TaskName.EndsWith('-Recover')){throw 'Synthetic Recover registration failure'}
    $InputObject|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $Sandbox ('scheduler/'+$TaskName+'.json')) -Encoding UTF8
    if($Scenario -eq 'crash-recover' -and $TaskName.EndsWith('-Recover')){[Environment]::Exit(31)}
    if($Scenario -eq 'hold-recover' -and $TaskName.EndsWith('-Recover')){[IO.File]::WriteAllText((Join-Path $Sandbox 'holding'),'TEST_ONLY');Start-Sleep -Seconds 45}
    [pscustomobject]@{TaskName=$TaskName;State='TEST_ONLY_REGISTERED'}
}
$script:FixtureShortcutImplementation=(Get-Command Set-ReleaseStartupShortcutGate).ScriptBlock
function Set-ReleaseStartupShortcutGate {
    param($Folder,$InstallRoot,$PlanPath,$PlanHash,$GatePath,$BackupRoot,[switch]$Apply,$BundleSha256,$ExpectedShortcuts,[scriptblock]$OnItemState)
    if($Apply -and $Scenario -eq 'drift-added'){$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut((Join-Path $Sandbox 'startup/Added.lnk'));$link.TargetPath=Join-Path $Sandbox 'program/Orca.exe';$link.Save()}
    if($Apply -and $Scenario -eq 'second-link-failure'){
        $fixturePersist=$OnItemState
        $PSBoundParameters['OnItemState']={param($detail) & $fixturePersist $detail;if($detail.path.EndsWith('ZZ-Second.lnk') -and $detail.status -eq 'BACKUP_PENDING'){throw 'Synthetic second shortcut failure'}}
    }
    if($Apply -and $Scenario -in @('crash-after-copy','crash-after-save')){
        $fixturePersist=$OnItemState
        $PSBoundParameters['OnItemState']={param($detail)
            if($Scenario -eq 'crash-after-copy' -and $detail.status -eq 'BACKUP_VERIFIED'){[Environment]::Exit(33)}
            if($Scenario -eq 'crash-after-save' -and $detail.status -eq 'ROUTED'){[Environment]::Exit(34)}
            & $fixturePersist $detail
        }
    }
    $result=& $script:FixtureShortcutImplementation @PSBoundParameters
    if($Apply -and $Scenario -eq 'crash-routing'){[Environment]::Exit(32)}
    $result
}
'@|Set-Content -LiteralPath (Join-Path $bundle 'ReleaseRegistrationPlatform.ps1') -Encoding UTF8
    $shell=New-Object -ComObject WScript.Shell
    $shortcut=$shell.CreateShortcut((Join-Path $Sandbox 'startup/Orca.lnk'));$shortcut.TargetPath=Join-Path $Sandbox 'program/Orca.exe';$shortcut.Save()
    [IO.File]::WriteAllText((Join-Path $Sandbox 'original-shortcut-hash'),(Get-ReleaseHash (Join-Path $Sandbox 'startup/Orca.lnk')))
    @{schema=1;installRoot=(Join-Path $Sandbox 'program')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $Sandbox 'plan.json') -Encoding UTF8
    $entries=@(Get-ChildItem -LiteralPath $bundle -File|ForEach-Object {[pscustomobject]@{path=$_.Name;size=$_.Length;sha256=(Get-ReleaseHash $_.FullName);requiredNonempty=$true}})
    @{schema=1;sourceRevision=('f'*40);files=$entries}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $bundle 'bundle-manifest.json') -Encoding UTF8
    return
}
if($Mode -eq 'Run' -and $Scenario -eq 'noncanonical-root'){$path=Join-Path $Sandbox 'plan.json';$plan=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json;$plan.installRoot=$plan.installRoot.Replace('\','/')+'/';$plan|ConvertTo-Json|Set-Content -LiteralPath $path -Encoding UTF8}
$argsForEntry=@{PlanPath=(Join-Path $Sandbox 'plan.json');ExpectedPlanSha256=(Get-ReleaseHash (Join-Path $Sandbox 'plan.json'));ExpectedBundleSha256=(Get-ReleaseHash (Join-Path $bundle 'bundle-manifest.json'));RouteExistingStartup=$true}
if($Mode -eq 'Run' -and $Scenario -eq 'second-link-failure'){$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut((Join-Path $Sandbox 'startup/ZZ-Second.lnk'));$link.TargetPath=Join-Path $Sandbox 'program/Orca.exe';$link.Save()}
if($Mode -eq 'Inspect'){
    . "$bundle/ReleaseRegistrationState.ps1"
    . "$bundle/ReleaseStartupShortcut.ps1"
    . "$bundle/ReleaseRegistrationPlatform.ps1"
    Get-ReleaseRegistrationState (Join-Path $Sandbox 'state') (Join-Path $Sandbox 'program') $argsForEntry.ExpectedPlanSha256 $argsForEntry.ExpectedBundleSha256|ConvertTo-Json -Depth 8
    return
}
if($Mode -eq 'Run'){$argsForEntry.Register=$true}
if($Scenario -eq 'uppercase-hashes'){$argsForEntry.ExpectedPlanSha256=$argsForEntry.ExpectedPlanSha256.ToUpperInvariant();$argsForEntry.ExpectedBundleSha256=$argsForEntry.ExpectedBundleSha256.ToUpperInvariant()}
& (Join-Path $bundle 'Register-ReleaseRecovery.ps1') @argsForEntry|ConvertTo-Json -Depth 10

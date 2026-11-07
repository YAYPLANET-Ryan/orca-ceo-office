param([Parameter(Mandatory=$true)][string]$PreviousPlanPath,[Parameter(Mandatory=$true)][string]$PreviousPlanSha256,
      [Parameter(Mandatory=$true)][string]$PlanPath,[Parameter(Mandatory=$true)][string]$ExpectedPlanSha256,[switch]$Apply)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/BootstrapRepair.ps1"
. "$PSScriptRoot/ReleasePlanTransition.ps1"
foreach($hash in @($PreviousPlanSha256,$ExpectedPlanSha256)){Assert-ReleasePlanHash $hash}
if((Get-ReleaseHash $PreviousPlanPath) -ne $PreviousPlanSha256 -or (Get-ReleaseHash $PlanPath) -ne $ExpectedPlanSha256){throw 'Plan changed'}
$old=Get-Content -LiteralPath $PreviousPlanPath -Raw -Encoding UTF8|ConvertFrom-Json
$new=Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8|ConvertFrom-Json
Assert-BootstrapExecutionIdentity $old.installRoot
$toBootstrap=[bool]$new.PSObject.Properties['bootstrap']
if($toBootstrap){
    Assert-ReleasePlan $old -ForLaunch
    Assert-BootstrapRepairPlan $new
}else{
    Assert-BootstrapRepairPlan $old -ForRecovery
    Assert-ReleasePlan $new
}
if($new.installRoot -ine $old.installRoot){throw 'Reviewed R0 baseline transition only'}
$directory=Get-ReleaseStateDirectory $old.installRoot
$launch=[IO.File]::Open((Join-Path $directory 'launch.lock'),'OpenOrCreate','ReadWrite','None')
try {
    $update=[IO.File]::Open((Join-Path $directory 'update.lock'),'OpenOrCreate','ReadWrite','None')
    try {
        $path=Join-Path $directory 'journal.json';$state=Read-ReleaseJournal $path
        Assert-ReleaseTransitionState $state $old.installRoot $PreviousPlanSha256 -ToBootstrap:$toBootstrap
        Assert-ReleaseIdle $new $state
        if($toBootstrap){
            $previousManifest=$old.candidate;$previousVersion=$old.version
            if($state.phase -eq 'ROLLED_BACK'){$previousManifest=$old.rollback.manifest;$previousVersion=$old.rollback.version}
            if($new.version -ne $previousVersion){throw 'R0 version does not match previous verified installation'}
            $priorCli=Get-BootstrapCliEntry $previousManifest;$nextCli=Get-BootstrapCliEntry $new.rollback.manifest
            if($priorCli.sha256 -ne $nextCli.sha256 -or $priorCli.size -ne $nextCli.size){throw 'R0 CLI differs from the previous verified baseline'}
            Assert-KnownIncompleteProgram $old.installRoot $previousManifest @('resources/bin/orca.exe')
            Assert-KnownIncompleteProgram $new.installRoot $new.rollback.manifest @('resources/bin/orca.exe')
        }else{
            if($new.rollback.version -ne $old.version){throw 'Normal plan baseline differs from completed R0'}
            $completedManifest=$old.candidate
            if($state.phase -eq 'ROLLED_BACK'){$completedManifest=$old.rollback.manifest}
            Assert-ReleaseFiles $old.installRoot $completedManifest -Exact
            Assert-ReleaseFiles $new.installRoot $new.rollback.manifest -Exact
        }
        Assert-ReleaseVersion $new.installRoot $new.rollback.version
        if(-not $Apply){@{result='TRANSITION_PREVIEW';liveChanges=$false}|ConvertTo-Json;return}
        $archive=Join-Path $directory ('journal-history-'+[guid]::NewGuid().ToString('N')+'.json')
        [IO.File]::Copy($path,$archive,$false)
        if((Get-ReleaseHash $path) -ne (Get-ReleaseHash $archive)){throw 'Journal history copy failed'}
        $next=[pscustomobject][ordered]@{schema=1;root=$new.installRoot;planHash=$ExpectedPlanSha256;phase='PREPARED';install='NOT_STARTED';rollback='NOT_NEEDED';readiness='NOT_TESTED';continuity='NOT_TESTED';installerPid=$null;installerStartedAt=$null;installerExitCode=$null;updatedAt='';error=$null;rollbackError=$null;previousJournal=$archive;previousJournalSha256=(Get-ReleaseHash $archive);previousInstallOutcome=$state.install;previousRollbackOutcome=$state.rollback}
        Write-ReleaseJournal $path $next
        @{result='TRANSITION_PREPARED_NOT_LAUNCHED';previousInstall=$state.install;previousRollback=$state.rollback;continuity='NOT_TESTED';history=$archive}|ConvertTo-Json
    }finally{if($update){$update.Dispose()}}
}finally{$launch.Dispose()}

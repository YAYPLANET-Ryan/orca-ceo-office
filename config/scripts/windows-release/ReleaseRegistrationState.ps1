. "$PSScriptRoot/ReleaseIntegrity.ps1"
. "$PSScriptRoot/ReleaseStartupShortcut.ps1"

function Get-ReleaseRegistrationTaskNames([string]$Root) {
    $rootPath=Resolve-ReleaseRoot $Root
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try{$key=([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($rootPath.ToLowerInvariant())))).Replace('-','').Substring(0,16)}finally{$algorithm.Dispose()}
    @{Apply=('Orca-VerifiedRelease-'+$key+'-Apply');Recover=('Orca-VerifiedRelease-'+$key+'-Recover')}
}

function Get-ReleaseRegistrationState([string]$Directory,[string]$Root,[string]$PlanHash,[string]$BundleHash) {
    $Directory=Resolve-ReleaseRoot $Directory;$Root=Resolve-ReleaseRoot $Root
    $path=Join-Path $Directory 'registration.json'
    if(-not(Test-Path -LiteralPath $path)){return [pscustomobject]@{result='NO_REGISTRATION';liveWrites=$false}}
    foreach($hash in @($PlanHash,$BundleHash)){Assert-ReleasePlanHash $hash}
    try{$record=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json}catch{return [pscustomobject]@{result='CORRUPT_JOURNAL';liveWrites=$false;action='Preserve file and prior atomic journal copy for review; no automatic fallback or retry'}}
    if($record.schema -ne 1 -or $record.root -ine $Root -or $record.planHash -ne $PlanHash -or $record.bundleHash -ne $BundleHash -or $record.phase -notin @('PREPARING','ROUTING','REGISTERING_Apply','REGISTERING_Recover','REGISTERED','RECONCILIATION_REQUIRED')){throw 'Unknown registration schema, phase, root or hash'}
    $names=Get-ReleaseRegistrationTaskNames $Root
    if($record.PSObject.Properties['taskNames']){foreach($mode in @('Apply','Recover')){if($record.taskNames.$mode -ne $names[$mode]){throw 'Intended task names differ from canonical root'}}}
    foreach($name in @($record.createdTasks)){if($name -notin @($names.Values)){throw 'Unexpected task name in registration record'}}
    Initialize-ReleaseScheduler
    $tasks=@(foreach($mode in @('Apply','Recover')){
        $actual=Get-ReleaseScheduledTaskProjection $names[$mode]
        $matches=$null
        if($actual.status -eq 'FOUND' -and $record.PSObject.Properties['gatePath'] -and $record.PSObject.Properties['planPath']){
            $expected=Get-ReleaseLaunchArguments $record.gatePath $record.planPath $PlanHash $BundleHash
            if($mode -eq 'Apply'){$expected=Get-ReleaseLaunchArguments $record.gatePath $record.planPath $PlanHash $BundleHash 'Invoke-VerifiedRelease.ps1' 'Apply'}
            $execute=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $matches=([IO.Path]::GetFullPath($actual.execute) -ieq $execute -and $actual.arguments -ceq $expected)
        }
        [pscustomobject]@{mode=$mode;name=$names[$mode];status=$actual.status;actionMatchesRecordedIntent=$matches;recordedCreated=($record.createdTasks -contains $names[$mode]);appearedBeforeJournal=($actual.status -eq 'FOUND' -and $record.createdTasks -notcontains $names[$mode])}
    })
    $startup=Resolve-ReleaseRoot (Get-ReleaseStartupFolder)
    $links=@(foreach($item in @($record.shortcuts)){
        $link=Resolve-ReleaseRoot $item.path
        if([IO.Path]::GetDirectoryName($link) -ine $startup -or [IO.Path]::GetExtension($link) -ine '.lnk'){throw 'Registration shortcut outside Startup scope'}
        $backup=Get-ReleaseFile (Join-Path $Directory 'startup-shortcuts') ([IO.Path]::GetFileName($link)+'.original')
        if((Resolve-ReleaseRoot $item.backupPath) -ine $backup){throw 'Registration backup outside approved state scope'}
        Assert-ReleasePlanHash $item.originalSha256
        $backupVerified=(Test-Path -LiteralPath $backup) -and (Get-ReleaseHash $backup) -eq $item.originalSha256
        $status='MISSING'
        if(Test-Path -LiteralPath $link){
            $hash=Get-ReleaseHash $link
            if($hash -eq $item.originalSha256){$status='ORIGINAL'}elseif($item.routedSha256 -and $hash -eq $item.routedSha256){$status='ROUTED_HASH_VERIFIED'}else{$status='MODIFIED_OR_UNRECORDED_ROUTING'}
        }
        [pscustomobject]@{path=$link;backupPath=$backup;backupVerified=$backupVerified;status=$status}
    })
    [pscustomobject]@{result='INSPECTED_NOT_RECONCILED';phase=$record.phase;tasks=$tasks;shortcuts=$links;liveWrites=$false;limitation='Actions are compared with recorded intent; principal, trigger and actual logon readiness remain uncertified. Legacy intent may have null action comparison. No automatic unregister, restoration or retry.'}
}

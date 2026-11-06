. "$PSScriptRoot/WindowsReleaseOperations.ps1"
. "$PSScriptRoot/ReleaseSecurityEvidence.ps1"

function Assert-BootstrapExecutionIdentity($ExpectedRoot) {
    if([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem -or -not [Environment]::UserInteractive){throw 'R0 requires the current interactive user, never SYSTEM/noninteractive profile'}
    $supported=Resolve-ReleaseRoot (Join-Path $env:LOCALAPPDATA 'Programs/orca')
    if((Resolve-ReleaseRoot $ExpectedRoot) -ine $supported){throw 'R0 profile/installation scope mismatch'}
}

function Assert-BootstrapRepairPlan($Plan,[switch]$ForRecovery) {
    if(-not $Plan.PSObject.Properties['bootstrap'] -or [string]::IsNullOrWhiteSpace($Plan.bootstrap.securityEvidence.sha256)){throw 'Security evidence pending: R0 is blocked until vendor resolution and real scoped scan reports exist'}
    Assert-ReleasePlan $Plan -ForBootstrap
    if($Plan.bootstrap.kind -ne 'R0_SAME_VERSION' -or $Plan.version -ne $Plan.rollback.version -or $Plan.version -ne $Plan.bootstrap.preRepairVersion){throw 'Only an exact same-version R0 repair is supported'}
    if($Plan.bootstrap.initialMissingPaths.Count -ne 1 -or $Plan.bootstrap.initialMissingPaths[0] -cne 'resources/bin/orca.exe'){throw 'Unapproved initial incomplete state'}
    $baseline=@{}
    foreach($file in $Plan.rollback.manifest.files){$key=$file.path.Replace('\','/');if($baseline.ContainsKey($key)){throw 'Duplicate baseline entry'};$baseline[$key]=$file}
    if(@($Plan.candidate.files).Count -ne $baseline.Count){throw 'R0 candidate differs from same-version rollback inventory'}
    $seen=@{}
    foreach($file in $Plan.candidate.files){
        $key=$file.path.Replace('\','/')
        if($seen.ContainsKey($key) -or -not $baseline.ContainsKey($key)){throw 'R0 candidate inventory mismatch'}
        $seen[$key]=$true;$original=$baseline[$key]
        if($file.sha256 -ne $original.sha256 -or $file.size -ne $original.size -or $file.requiredNonempty -ne $original.requiredNonempty){throw 'R0 candidate must equal every pinned baseline byte'}
    }
    $entry=Get-BootstrapCliEntry $Plan.candidate
    if($Plan.bootstrap.embeddedCliSha256 -ne $entry.sha256){throw 'Embedded payload proof differs from candidate'}
    Assert-ReleasePlanHash $Plan.bootstrap.installerProof.sha256
    if((Get-ReleaseHash $Plan.bootstrap.installerProof.path) -ne $Plan.bootstrap.installerProof.sha256){throw 'Installer proof changed'}
    $proof=Get-Content -LiteralPath $Plan.bootstrap.installerProof.path -Raw -Encoding UTF8|ConvertFrom-Json
    if($proof.result -ne 'PASS_EMBEDDED_CLI_MATCHES_APPROVED_PACKET' -or $proof.installerSha256 -ne $Plan.installer.sha256 -or $proof.embeddedCliSha256 -ne $entry.sha256){throw 'Pinned NSIS embedded CLI not proven'}
    Assert-BootstrapSecurityEvidence $Plan -ForRecovery:$ForRecovery
}

function New-BootstrapReleaseOperations($Plan) {
    $operations=New-WindowsReleaseOperations $Plan
    $operations.Preflight={
        param($value)
        Assert-BootstrapExecutionIdentity $value.installRoot
        Assert-BootstrapRepairPlan $value
        Assert-ReleaseIdle $value $null
        Assert-ReleaseVersion $value.installRoot $value.bootstrap.preRepairVersion
        Assert-KnownIncompleteProgram $value.installRoot $value.rollback.manifest $value.bootstrap.initialMissingPaths
    }
    $operations.VerifyRollback={
        param($value)
        Assert-BootstrapExecutionIdentity $value.installRoot
        Assert-BootstrapSecurityEvidence $value -ForRecovery
        Assert-ReleaseArchive $value.rollback
    }
    $operations.AssertQuiescent={param($state,$value) Assert-BootstrapExecutionIdentity $value.installRoot;Assert-ReleaseIdle $value $state}
    $operations.VerifyPrepared={param($value) Assert-KnownIncompleteProgram $value.installRoot $value.rollback.manifest $value.bootstrap.initialMissingPaths;Assert-ReleaseVersion $value.installRoot $value.bootstrap.preRepairVersion}
    $operations
}

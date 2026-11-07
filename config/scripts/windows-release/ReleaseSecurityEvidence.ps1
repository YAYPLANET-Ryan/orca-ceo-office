. "$PSScriptRoot/BootstrapFingerprint.ps1"

function Assert-BootstrapSecurityEvidence($Plan,[switch]$ForRecovery) {
    $evidence=$Plan.bootstrap.securityEvidence
    if([string]::IsNullOrWhiteSpace($evidence.sha256)){throw 'Security evidence pending: vendor resolution and scoped scan reports required'}
    Assert-ReleasePlanHash $evidence.sha256
    if((Get-ReleaseHash $evidence.path) -ne $evidence.sha256){throw 'Security evidence artifact changed'}
    $proof=Get-Content -LiteralPath $evidence.path -Raw -Encoding UTF8|ConvertFrom-Json
    if($proof.schema -ne 1 -or $proof.decision -ne 'FALSE_POSITIVE_RESOLVED'){throw 'Exact-hash vendor resolution missing'}
    Assert-ReleasePlanHash $proof.vendorStatementSha256
    if((Get-ReleaseHash $proof.vendorStatementPath) -ne $proof.vendorStatementSha256){throw 'Vendor statement missing or changed'}
    if($proof.installerSha256 -ne $Plan.installer.sha256 -or $proof.rollbackSha256 -ne $Plan.rollback.sha256){throw 'Security evidence belongs to different artifacts'}
    $candidate=Get-BootstrapCliEntry $Plan.candidate
    $baseline=Get-BootstrapCliEntry $Plan.rollback.manifest
    foreach($hash in @($candidate.sha256,$baseline.sha256,$Plan.bootstrap.embeddedCliSha256)) {
        if($hash -ne $proof.cliSha256){throw 'Security clearance does not match exact embedded/candidate/rollback bytes'}
    }
    $start=[DateTime]::Parse($proof.observationStartedAt).ToUniversalTime()
    $end=[DateTime]::Parse($proof.observationEndedAt).ToUniversalTime()
    $now=[DateTime]::UtcNow
    if(($end-$start).TotalSeconds -lt 7200 -or $end -gt $now -or (-not $ForRecovery -and ($now-$end).TotalHours -gt 24)){throw 'Security observation window missing, future-dated or stale'}
    if([string]::IsNullOrWhiteSpace($proof.engineVersion) -or [string]::IsNullOrWhiteSpace($proof.definitionsVersion)){throw 'Engine/definition identity required'}
    $scans=@($proof.scans)
    if($scans.Count -ne 2){throw 'Two scoped clean scans required'}
    foreach($scan in $scans) {
        if($scan.result -ne 'CLEAN' -or $scan.engineVersion -ne $proof.engineVersion -or $scan.definitionsVersion -ne $proof.definitionsVersion){throw 'Scan evidence invalid or definition drifted'}
        if($scan.cliSha256 -ne $proof.cliSha256 -or $scan.installerSha256 -ne $proof.installerSha256 -or $scan.rollbackSha256 -ne $proof.rollbackSha256){throw 'Scan scope does not cover exact deployment and rollback artifacts'}
        Assert-ReleasePlanHash $scan.reportSha256
        if((Get-ReleaseHash $scan.reportPath) -ne $scan.reportSha256){throw 'Scan report missing or changed'}
    }
    if([DateTime]::Parse($scans[0].at).ToUniversalTime() -gt $start -or [DateTime]::Parse($scans[1].at).ToUniversalTime() -lt $end){throw 'Scans do not bracket the observation interval'}
    if([DateTime]::Parse($scans[1].at).ToUniversalTime() -gt $now -or (-not $ForRecovery -and ($now-[DateTime]::Parse($scans[0].at).ToUniversalTime()).TotalHours -gt 26)){throw 'Scan timestamps stale or future-dated'}
}

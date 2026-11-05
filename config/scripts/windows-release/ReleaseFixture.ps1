param([Parameter(Mandatory=$true)][string]$Sandbox,
      [string]$Scenario='success',[string]$Mode='Apply',[string]$PlanHash='fixture-plan')
$ErrorActionPreference='Stop'
. "$PSScriptRoot/ReleaseTransaction.ps1"
. "$PSScriptRoot/ReleaseStartupGate.ps1"
$Sandbox = Resolve-ReleaseRoot $Sandbox
if (-not (Test-Path -LiteralPath (Join-Path $Sandbox 'TEST_ONLY'))) { throw 'Synthetic test marker required' }
if ($Sandbox -notmatch '[\\/]dist[\\/]release-regression[\\/]') { throw 'Not an isolated regression directory' }
$root=Join-Path $Sandbox 'program'; $backup=Join-Path $Sandbox 'backup'; $stateDir=Join-Path $Sandbox 'state'
function Copy-Fixture([string]$Value) { [IO.File]::WriteAllText((Join-Path $root 'program.bin'),$Value) }
function Check-Fixture([string]$Value) {
    $bytes=[Text.Encoding]::UTF8.GetBytes($Value); $algo=[Security.Cryptography.SHA256]::Create()
    try{$hash=([BitConverter]::ToString($algo.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$algo.Dispose()}
    Assert-ReleaseFiles $root ([pscustomobject]@{files=@([pscustomobject]@{path='program.bin';size=$bytes.Length;sha256=$hash;requiredNonempty=$true})})
}
$operations=@{
    Context=$null
    Preflight={if($Scenario -eq 'bad-backup'){throw 'Unverified rollback'};Check-Fixture 'old'}
    AssertQuiescent={param($state) if(Test-Path -LiteralPath (Join-Path $Sandbox 'installer-live')){throw 'Installer live; deferred'}}
    Install={
        param($state,$persist)
        [IO.File]::AppendAllText((Join-Path $Sandbox 'installs'),'1')
        Copy-Fixture 'new'
        if($Scenario -eq 'interrupt-install'){Copy-Fixture 'n';[Environment]::Exit(23)}
        if($Scenario -eq 'interrupt-after-complete'){[Environment]::Exit(23)}
        if($Scenario -eq 'hold-install'){Copy-Fixture 'n';[IO.File]::WriteAllText((Join-Path $Sandbox 'holding'),'yes');Start-Sleep -Seconds 45}
        if($Scenario -eq 'zero-file'){Copy-Fixture ''}
        if($Scenario -eq 'exit-unknown'){return $null}
        if($Scenario -eq 'interruption-status'){Copy-Fixture 'n';return 1073807364}
        if($Scenario -in @('fail-install','fail-rollback','interrupt-rollback')){return 17}
        return 0
    }
    VerifyCandidate={
        if($Scenario -eq 'missing-file') {
            Assert-ReleaseFiles $root ([pscustomobject]@{files=@([pscustomobject]@{path='missing-required.bin';size=3;sha256='irrelevant';requiredNonempty=$true})})
        }
        Check-Fixture 'new'
    }
    VerifyInstalled={Check-Fixture 'new'}
    VerifyRollback={if(-not(Test-Path -LiteralPath (Join-Path $backup 'program.bin'))){throw 'Missing rollback'}}
    Restore={
        Copy-Fixture 'o'
        if($Scenario -eq 'fail-rollback'){throw 'Synthetic restore failure'}
        if($Scenario -eq 'interrupt-rollback'){[Environment]::Exit(24)}
        Copy-Fixture 'old'
    }
    VerifyRestored={Check-Fixture 'old'}
    Ready={
        if($Scenario -eq 'readiness-fail'){throw 'Synthetic listener failure'}
        [IO.File]::WriteAllText((Join-Path $Sandbox 'launched'),'yes')
    }
    ReadyRollback={Check-Fixture 'old';[IO.File]::WriteAllText((Join-Path $Sandbox 'launched'),'rollback')}
}
if($Mode -eq 'Launch') {
    Invoke-ReleaseGuardedLaunch -Root $root -StateDirectory $stateDir -PlanHash $PlanHash -Operations $operations | ConvertTo-Json
} else {
    Invoke-ReleaseTransaction -Root $root -StateDirectory $stateDir -PlanHash $PlanHash -Operations $operations -Mode $Mode | ConvertTo-Json
}

. "$PSScriptRoot/ReleaseTransaction.ps1"

function Invoke-ReleaseGuardedLaunch([string]$Root, [string]$StateDirectory, [string]$PlanHash, $Operations) {
    $StateDirectory = Resolve-ReleaseRoot $StateDirectory
    [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
    $launchLock = [IO.File]::Open((Join-Path $StateDirectory 'launch.lock'),'OpenOrCreate','ReadWrite','None')
    try {
        $state = Invoke-ReleaseTransaction -Root $Root -StateDirectory $StateDirectory -PlanHash $PlanHash -Operations $Operations -Mode Recover
        if (-not $state -or ($state.phase -eq 'PREPARED' -and $state.install -eq 'NOT_STARTED')) {
            & $Operations.AssertQuiescent $null $Operations.Context
            & $Operations.VerifyRestored $Operations.Context
            & $Operations.ReadyRollback $Operations.Context
            $program = 'VERIFIED_BASELINE'
            $state=[pscustomobject]@{install='NOT_STARTED';rollback='BASELINE_NOT_CHANGED';continuity='NOT_TESTED'}
        } elseif ($state.phase -eq 'ROLLED_BACK') {
            & $Operations.VerifyRestored $Operations.Context
            & $Operations.ReadyRollback $Operations.Context
            $program = 'VERIFIED_ROLLBACK'
        } elseif ($state.phase -in @('READY','READINESS_FAILED') -and $state.install -eq 'VERIFIED' -and $state.installerExitCode -eq 0) {
            & $Operations.VerifyInstalled $Operations.Context
            & $Operations.Ready $Operations.Context
            $state.phase='READY';$state.readiness='WINDOW_AND_SERVER_READY'
            Write-ReleaseJournal (Join-Path $StateDirectory 'journal.json') $state
            $program = 'VERIFIED_CANDIDATE'
        } else { throw 'Release is incomplete or installer outcome unknown; launch refused' }
        $result = [pscustomobject][ordered]@{schema=1;program=$program;windowAndServer='READY';
            install=$state.install;rollback=$state.rollback;continuity=$state.continuity;updatedAt=''}
        Write-ReleaseJournal (Join-Path $StateDirectory 'guarded-launch.json') $result
        $result
    } finally { $launchLock.Dispose() }
}

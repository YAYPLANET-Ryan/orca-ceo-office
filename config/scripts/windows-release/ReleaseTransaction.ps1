. "$PSScriptRoot/ReleaseIntegrity.ps1"

function Invoke-ReleaseTransaction {
    param([string]$Root, [string]$StateDirectory, [string]$PlanHash, $Operations,
          [ValidateSet('Apply','Recover','Inspect')][string]$Mode = 'Inspect')
    $ErrorActionPreference = 'Stop'
    $Root = Resolve-ReleaseRoot $Root
    $StateDirectory = Resolve-ReleaseRoot $StateDirectory
    if ($StateDirectory -eq $Root -or $StateDirectory.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Journal must be outside installation' }
    [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
    # OS-owned lock survives crashes by releasing automatically; the journal survives by remaining on disk.
    try { $lock = [IO.File]::Open((Join-Path $StateDirectory 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw ('Release lock unavailable; contention or access failure; no action taken: ' + $_.Exception.GetType().Name) }
    try {
        $journal = Join-Path $StateDirectory 'journal.json'
        $state = Read-ReleaseJournal $journal
        if ($state -and ($state.root -ne $Root -or $state.planHash -ne $PlanHash)) { throw 'Pending or completed transaction belongs to another plan; explicit archival review required' }
        if ($Mode -eq 'Inspect') { return $state }
        if (-not $state) {
            if ($Mode -eq 'Recover') { return $null }
            & $Operations.Preflight $Operations.Context
            $state = [pscustomobject][ordered]@{schema=1;root=$Root;planHash=$PlanHash;
                phase='PREPARED';install='NOT_STARTED';rollback='NOT_NEEDED';readiness='NOT_TESTED';
                continuity='NOT_TESTED';installerPid=$null;installerStartedAt=$null;installerExitCode=$null;
                updatedAt='';error=$null;rollbackError=$null}
            Write-ReleaseJournal $journal $state
        }
        if ($state.phase -eq 'ROLLED_BACK') { & $Operations.VerifyRestored $Operations.Context; return $state }
        if ($state.phase -in @('READY','READINESS_FAILED')) { & $Operations.VerifyInstalled $Operations.Context; return $state }
        if ($state.phase -in @('INSTALLING','VERIFYING','ROLLING_BACK','ROLLBACK_FAILED')) {
            # A previous worker may be dead while its installer is still running.
            & $Operations.AssertQuiescent $state $Operations.Context
            if ($state.phase -in @('INSTALLING','VERIFYING') -and $state.install -ne 'FAILED' -and
                ($null -eq $state.installerExitCode -or $state.installerExitCode -eq 0)) {
                $candidateComplete = $false
                try { & $Operations.VerifyCandidate $Operations.Context; $candidateComplete = $true } catch { $state.error = $_.Exception.Message }
                if ($candidateComplete) {
                    $state.install = 'VERIFIED'; $state.phase = 'READINESS_FAILED'
                    $state.readiness = 'NOT_TESTED_AFTER_WORKER_INTERRUPTION'
                    Write-ReleaseJournal $journal $state
                    return $state
                }
            }
            if ($state.install -eq 'RUNNING') { $state.install = 'INTERRUPTED_OR_UNKNOWN' }
        } else {
            & $Operations.Preflight $Operations.Context
            if ($Mode -eq 'Recover') { return $state }
            $state.phase = 'INSTALLING'; $state.install = 'RUNNING'
            Write-ReleaseJournal $journal $state
            # Install invokes this synchronously in this function's session state.
            $persist = { Write-ReleaseJournal $journal $state }
            try {
                $state.installerExitCode = & $Operations.Install $state $persist $Operations.Context
                if ($null -ne $state.installerExitCode -and $state.installerExitCode -ne 0) { throw 'Installer returned nonzero exit status' }
                $state.phase = 'VERIFYING'
                Write-ReleaseJournal $journal $state
                & $Operations.VerifyCandidate $Operations.Context
                if ($null -eq $state.installerExitCode) {
                    $state.install = 'CONTENT_VERIFIED_EXIT_UNKNOWN'; $state.phase = 'READINESS_FAILED'
                    $state.readiness = 'NOT_TESTED_EXIT_UNKNOWN'
                    Write-ReleaseJournal $journal $state
                    return $state
                }
                $state.install = 'VERIFIED'; $state.phase = 'READINESS_FAILED'
                Write-ReleaseJournal $journal $state
                # Failure after a verified install must never trigger rollback over a running app.
                try { & $Operations.Ready $Operations.Context; $state.readiness = 'WINDOW_AND_SERVER_READY'; $state.phase = 'READY' }
                catch { $state.readiness = 'FAILED_OR_UNKNOWN'; $state.error = $_.Exception.Message }
                Write-ReleaseJournal $journal $state
                return $state
            } catch {
                $state.install = 'FAILED'; $state.error = $_.Exception.Message
                Write-ReleaseJournal $journal $state
            }
        }
        # Persist rollback intent before even validating its source, including after interrupted recovery.
        $state.phase = 'ROLLING_BACK'; $state.rollback = 'RUNNING'
        Write-ReleaseJournal $journal $state
        try {
            & $Operations.AssertQuiescent $state $Operations.Context
            & $Operations.VerifyRollback $Operations.Context
            & $Operations.Restore $Operations.Context
            & $Operations.VerifyRestored $Operations.Context
            $state.rollback = 'VERIFIED'; $state.phase = 'ROLLED_BACK'; $state.rollbackError = $null
        } catch {
            $state.rollback = 'FAILED'; $state.phase = 'ROLLBACK_FAILED'; $state.rollbackError = $_.Exception.Message
        }
        Write-ReleaseJournal $journal $state
        # Recovery never starts an application; a separate checked launch is required.
        return $state
    } finally { $lock.Dispose() }
}

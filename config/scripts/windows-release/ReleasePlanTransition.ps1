. "$PSScriptRoot/ReleaseIntegrity.ps1"

function Assert-ReleaseTransitionState($State,[string]$Root,[string]$PreviousPlanHash,[switch]$ToBootstrap) {
    if(-not $State -or $State.planHash -ne $PreviousPlanHash -or $State.root -ine $Root){throw 'Transition requires the exact previous journal and root'}
    if($ToBootstrap){
        $ready=$State.phase -eq 'READY' -and $State.install -eq 'VERIFIED' -and $null -ne $State.installerExitCode -and $State.installerExitCode -eq 0
        $restored=$State.phase -eq 'ROLLED_BACK' -and $State.rollback -eq 'VERIFIED'
        if(-not ($ready -or $restored)){throw 'Only verified READY/ROLLED_BACK history can precede R0; pending/unknown transaction retained'}
    }elseif($State.phase -eq 'ROLLED_BACK' -and $State.rollback -eq 'VERIFIED'){
        # Preserve the failed install in copied history; only the restored baseline qualifies.
        return
    }elseif($State.phase -ne 'READINESS_FAILED' -or $State.install -ne 'VERIFIED' -or $null -eq $State.installerExitCode -or $State.installerExitCode -ne 0 -or $State.readiness -ne 'DEFERRED_MAINTENANCE_FINALIZATION'){
        throw 'Only a completed, known-zero-exit deferred R0 transaction may finalize'
    }
}

. "$PSScriptRoot/ReleaseIntegrity.ps1"

function Assert-ReleasePendingRenameList([string]$Root, $Pending) {
    foreach ($value in $Pending) {
        if ($value -and ([string]$value).IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw 'Program has pending reboot file operations; manual reboot/recovery coordination required'
        }
    }
}

function Assert-NoReleasePendingRename([string]$Root) {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager')
    if (-not $key) { throw 'Cannot inspect pending reboot file operations' }
    try { $pending = @($key.GetValue('PendingFileRenameOperations', $null)) + @($key.GetValue('PendingFileRenameOperations2', $null)) }
    finally { $key.Dispose() }
    Assert-ReleasePendingRenameList $Root $pending
}

function Assert-ReleaseProcessTableIdle($Rows, $Plan, $State) {
    $root = (Resolve-ReleaseRoot $Plan.installRoot) + '\'
    $installerName = [IO.Path]::GetFileName($Plan.installer.path)
    foreach ($row in $Rows) {
        $path = [string]$row.ExecutablePath
        if ($row.Name -ieq 'Orca.exe' -or $row.Name -ieq $installerName -or
            $row.Name -match '(?i)(\.tmp$|^uninstall.*orca.*\.exe$)' -or
            ($path -and $path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase))) {
            throw 'Application/installer/uninstaller is live or unverifiable; no files changed'
        }
        if ($State -and $State.installerPid) {
            if ($row.ParentProcessId -eq $State.installerPid) {
                throw 'Prior installer child may still be active; recovery deferred'
            }
            if ($row.ProcessId -eq $State.installerPid) {
                if (-not $row.CreationDate -or -not $State.installerStartedAt) { throw 'Prior installer identity unverifiable' }
                $difference = [Math]::Abs(($row.CreationDate.ToUniversalTime() - [DateTime]::Parse($State.installerStartedAt).ToUniversalTime()).TotalSeconds)
                if ($difference -lt 1) { throw 'Prior installer still live; recovery deferred' }
            }
        }
    }
}

function Remove-ReleaseCandidateAdditions($Plan) {
    $baseline = @{}
    foreach ($entry in $Plan.rollback.manifest.files) { $baseline[$entry.path.Replace('\','/')] = $true }
    $candidate = @{}
    foreach ($entry in $Plan.candidate.files) { $candidate[$entry.path.Replace('\','/')] = $entry }
    $removals = @()
    foreach ($file in Get-ChildItem -LiteralPath $Plan.installRoot -Recurse -File -Force) {
        $relative = $file.FullName.Substring($Plan.installRoot.Length + 1).Replace('\','/')
        if ($baseline.ContainsKey($relative)) { continue }
        if (-not $candidate.ContainsKey($relative)) { throw 'Unrecognized added file; rollback requires manual review' }
        $entry = $candidate[$relative]
        $path = Get-ReleaseFile $Plan.installRoot $relative
        if ($file.Length -ne $entry.size -or (Get-ReleaseHash $path) -ne $entry.sha256) { throw 'Added file differs from reviewed candidate; rollback requires manual review' }
        $removals += $path
    }
    if ($removals.Count -gt 0 -and $Plan.removalApproval -ne 'APPROVED_LISTED_CANDIDATE_ADDITIONS') {
        throw 'Candidate-only file removal requires reviewed dry-run approval'
    }
    foreach ($path in $removals) { [IO.File]::Delete($path) }
}

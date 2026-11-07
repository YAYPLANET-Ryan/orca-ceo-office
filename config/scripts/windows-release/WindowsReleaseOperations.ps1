. "$PSScriptRoot/ReleaseIntegrity.ps1"
. "$PSScriptRoot/ReleaseWindowsSafety.ps1"
. "$PSScriptRoot/ReleaseArchive.ps1"

function Get-ReleaseProcessRows {
    Import-Module "$PSHOME/Modules/CimCmdlets/CimCmdlets.psd1" -ErrorAction Stop
    @(Get-CimInstance Win32_Process -ErrorAction Stop)
}

function Assert-ReleaseIdle($Plan, $State) {
    $rows = Get-ReleaseProcessRows
    $bootTime = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
    if (-not $bootTime) { throw 'Boot identity unavailable; recovery deferred' }
    Assert-ReleaseProcessTableIdle $rows $Plan $State $bootTime
    Assert-NoReleasePendingRename $Plan.installRoot
}

function Assert-ReleaseVersion([string]$Root, [string]$Version) {
    if ([string]::IsNullOrWhiteSpace($Version)) { throw 'Expected version is empty' }
    $actual = (Get-Item -LiteralPath (Join-Path $Root 'Orca.exe')).VersionInfo.FileVersion
    if ([string]::IsNullOrWhiteSpace($actual) -or $actual -ne $Version) {
        throw 'Exact installed version mismatch'
    }
}

function Assert-ReleasePlan($Plan, [switch]$ForLaunch, [switch]$ForBootstrap) {
    if ($Plan.schema -ne 1) { throw 'Unknown plan schema' }
    if ($Plan.PSObject.Properties['bootstrap'] -and -not $ForBootstrap) { throw 'Bootstrap plan requires the dedicated R0 entry' }
    $Plan.installRoot=Resolve-ReleaseRoot $Plan.installRoot
    if ([string]::IsNullOrWhiteSpace($Plan.version) -or [string]::IsNullOrWhiteSpace($Plan.rollback.version)) { throw 'Plan versions must be nonempty' }
    if ($Plan.installRoot -match '\s') { throw 'NSIS /D target with whitespace is unsupported' }
    if ($Plan.requiredPort -lt 1 -or $Plan.requiredPort -gt 65535 -or $Plan.readinessTimeoutSeconds -lt 10 -or $Plan.readinessTimeoutSeconds -gt 900) { throw 'Invalid readiness parameters' }
    $supportedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs/orca')).TrimEnd('\')
    if ((Resolve-ReleaseRoot $Plan.installRoot) -ine $supportedRoot) { throw 'Only this user current Orca installation is supported' }
    foreach ($manifest in @($Plan.candidate, $Plan.rollback.manifest)) {
        Assert-ReleaseEssentialManifest $manifest
    }
    $baselinePaths = @{}
    foreach ($entry in $Plan.rollback.manifest.files) { $baselinePaths[$entry.path.Replace('\','/')] = $true }
    $additions = @($Plan.candidate.files | Where-Object { -not $baselinePaths.ContainsKey($_.path.Replace('\','/')) })
    if ($additions.Count -gt 0 -and $Plan.removalApproval -ne 'APPROVED_LISTED_CANDIDATE_ADDITIONS') {
        throw 'Review candidate-only removal dry-run before authorizing an additive update'
    }
    $root = Resolve-ReleaseRoot $Plan.installRoot
    $backup = Resolve-ReleaseRoot $Plan.rollback.archive
    if ($backup -eq $root -or $backup.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($backup + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Rollback must be a separate program snapshot' }
    if (-not $ForLaunch) {
        if ((Get-ReleaseHash $Plan.installer.path) -ne $Plan.installer.sha256) { throw 'Installer hash mismatch' }
        Assert-ReleaseArchive $Plan.rollback
    }
}

function Wait-ReleaseReady($Plan) {
    Import-Module "$env:SystemRoot/System32/WindowsPowerShell/v1.0/Modules/NetTCPIP/NetTCPIP.psd1" -ErrorAction Stop
    Assert-ReleaseFiles $Plan.installRoot $Plan.candidate
    Assert-ReleaseVersion $Plan.installRoot $Plan.version
    $app = Join-Path $Plan.installRoot 'Orca.exe'
    if (-not @(Get-Process Orca -ErrorAction SilentlyContinue | Where-Object Path -eq $app).Count) {
        Start-Process -FilePath $app -WorkingDirectory $Plan.installRoot -WindowStyle Hidden | Out-Null
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($Plan.readinessTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $windows = @(Get-Process Orca -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -eq $app -and $_.MainWindowHandle -ne 0 -and $_.Responding
        })
        if ($windows.Count -eq 1) {
            $listeners = @(Get-NetTCPConnection -LocalPort $Plan.requiredPort -State Listen -ErrorAction SilentlyContinue)
            if ($listeners.Count -gt 0 -and @($listeners | Where-Object OwningProcess -ne $windows[0].Id).Count -eq 0) { return }
        }
        Start-Sleep -Seconds 2
    }
    throw 'Verified program did not reach responsive-window and same-process listener readiness; processes preserved'
}

function New-WindowsReleaseOperations($Plan) {
    $Plan.installRoot=Resolve-ReleaseRoot $Plan.installRoot
    @{
        Context = $Plan
        Preflight = {
            param($planValue)
            Assert-ReleasePlan $planValue
            Assert-ReleaseIdle $planValue $null
            Assert-ReleaseFiles $planValue.installRoot $planValue.rollback.manifest -Exact
            Assert-ReleaseVersion $planValue.installRoot $planValue.rollback.version
        }
        AssertQuiescent = { param($state,$planValue) Assert-ReleaseIdle $planValue $state }
        Install = {
            param($state, $persist, $planValue)
            $proc = Start-Process -FilePath $planValue.installer.path -ArgumentList @('/S','--updated',('/D=' + $planValue.installRoot)) -WindowStyle Hidden -PassThru
            $null = $proc.Handle
            $state.installerPid = $proc.Id
            $state.installerStartedAt = $proc.StartTime.ToUniversalTime().ToString('o')
            & $persist
            # No helper timeout: terminating the worker cannot safely cancel a file replacement.
            $proc.WaitForExit()
            $proc.ExitCode
        }
        VerifyCandidate = {
            param($planValue)
            Assert-ReleaseIdle $planValue $null
            Assert-ReleaseFiles $planValue.installRoot $planValue.candidate
            Assert-ReleaseVersion $planValue.installRoot $planValue.version
        }
        VerifyInstalled = {
            param($planValue)
            Assert-NoReleasePendingRename $planValue.installRoot
            Assert-ReleaseFiles $planValue.installRoot $planValue.candidate
            Assert-ReleaseVersion $planValue.installRoot $planValue.version
        }
        VerifyRollback = {
            param($planValue)
            Assert-ReleaseArchive $planValue.rollback
        }
        Restore = {
            param($planValue)
            Remove-ReleaseCandidateAdditions $planValue
            Restore-ReleaseArchive $planValue
        }
        VerifyRestored = {
            param($planValue)
            Assert-NoReleasePendingRename $planValue.installRoot
            Assert-ReleaseFiles $planValue.installRoot $planValue.rollback.manifest -Exact
            Assert-ReleaseVersion $planValue.installRoot $planValue.rollback.version
        }
        Ready = { param($planValue) Wait-ReleaseReady $planValue }
        ReadyRollback = {
            param($planValue)
            $launchPlan = $planValue | ConvertTo-Json -Depth 12 | ConvertFrom-Json
            $launchPlan.candidate = $planValue.rollback.manifest
            $launchPlan.version = $planValue.rollback.version
            Wait-ReleaseReady $launchPlan
        }
    }
}

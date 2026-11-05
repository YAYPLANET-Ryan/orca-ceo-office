param([Parameter(Mandatory=$true)][string]$Sandbox,[Parameter(Mandatory=$true)][string]$Case)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/WindowsReleaseOperations.ps1"
$Sandbox=Resolve-ReleaseRoot $Sandbox
if($Sandbox -notmatch '[\\/]dist[\\/]release-regression[\\/]' -or -not(Test-Path -LiteralPath (Join-Path $Sandbox 'TEST_ONLY'))){throw 'Synthetic fixture required'}
$root=Join-Path $Sandbox 'program'
$plan=[pscustomobject]@{installRoot=$root;installer=@{path=(Join-Path $Sandbox 'setup.exe')}}
$stamp=[DateTime]::UtcNow
$state=[pscustomobject]@{installerPid=42;installerStartedAt=$stamp.ToString('o')}
function Expect-Refusal($Body){$refused=$false;try{& $Body}catch{$refused=$true};if(-not $refused){throw 'Expected refusal did not happen'}}
switch($Case){
    'pending-rename' {Expect-Refusal {Assert-ReleasePendingRenameList $root @('\??\' + $root + '\program.bin')};Assert-ReleasePendingRenameList $root @('C:\unrelated\file')}
    'installer-child' {Expect-Refusal {Assert-ReleaseProcessTableIdle @([pscustomobject]@{Name='uninstall.exe';ExecutablePath=(Join-Path $root 'uninstall.exe');ProcessId=12;ParentProcessId=42;CreationDate=$stamp}) $plan $state}}
    'prior-pid-tolerance' {Expect-Refusal {Assert-ReleaseProcessTableIdle @([pscustomobject]@{Name='renamed.exe';ExecutablePath='C:\elsewhere\renamed.exe';ProcessId=42;ParentProcessId=1;CreationDate=$stamp.AddMilliseconds(20)}) $plan $state}}
    'pid-reuse' {Assert-ReleaseProcessTableIdle @([pscustomobject]@{Name='unrelated.exe';ExecutablePath='C:\elsewhere\unrelated.exe';ProcessId=42;ParentProcessId=1;CreationDate=$stamp.AddMinutes(3)}) $plan $state}
    'other-orca' {Expect-Refusal {Assert-ReleaseProcessTableIdle @([pscustomobject]@{Name='Orca.exe';ExecutablePath='C:\elsewhere\Orca.exe';ProcessId=12;ParentProcessId=1;CreationDate=$stamp}) $plan $state}}
    'archive-traversal' {
        $path=Join-Path $Sandbox 'bad.zip';$zip=[IO.Compression.ZipFile]::Open($path,'Create')
        try{$entry=$zip.CreateEntry('../escape.bin');$writer=New-Object IO.StreamWriter($entry.Open());try{$writer.Write('x')}finally{$writer.Dispose()}}finally{$zip.Dispose()}
        $rollback=[pscustomobject]@{archive=$path;sha256=(Get-ReleaseHash $path);manifest=@{files=@()}}
        Expect-Refusal {Assert-ReleaseArchive $rollback}
    }
    'additive-rollback' {
        $backup=Join-Path $Sandbox 'backup';$entry=[pscustomobject]@{path='program.bin';size=3;sha256=(Get-ReleaseHash (Join-Path $backup 'program.bin'));requiredNonempty=$true}
        $extra=Join-Path $root 'new-only.bin';[IO.File]::WriteAllText($extra,'new')
        $addition=[pscustomobject]@{path='new-only.bin';size=3;sha256=(Get-ReleaseHash $extra);requiredNonempty=$true}
        $archive=Join-Path $Sandbox 'rollback.zip';[IO.Compression.ZipFile]::CreateFromDirectory($backup,$archive)
        $plan|Add-Member NoteProperty candidate ([pscustomobject]@{files=@($entry,$addition)})
        $plan|Add-Member NoteProperty rollback ([pscustomobject]@{archive=$archive;sha256=(Get-ReleaseHash $archive);manifest=[pscustomobject]@{files=@($entry)}})
        $plan|Add-Member NoteProperty removalApproval 'REVIEW_REQUIRED'
        Expect-Refusal {Remove-ReleaseCandidateAdditions $plan}
        if(-not(Test-Path -LiteralPath $extra)){throw 'Unapproved file removal'}
        $plan.removalApproval='APPROVED_LISTED_CANDIDATE_ADDITIONS'
        Remove-ReleaseCandidateAdditions $plan
        Restore-ReleaseArchive $plan
        Assert-ReleaseFiles $root $plan.rollback.manifest -Exact
        $operations=New-WindowsReleaseOperations $plan
        & $operations.VerifyRollback $operations.Context
    }
    'unknown-addition' {
        $extra=Join-Path $root 'unknown.bin';[IO.File]::WriteAllText($extra,'new')
        $plan|Add-Member NoteProperty candidate ([pscustomobject]@{files=@()})
        $plan|Add-Member NoteProperty rollback ([pscustomobject]@{manifest=[pscustomobject]@{files=@([pscustomobject]@{path='program.bin'})}})
        $plan|Add-Member NoteProperty removalApproval 'APPROVED_LISTED_CANDIDATE_ADDITIONS'
        Expect-Refusal {Remove-ReleaseCandidateAdditions $plan}
        if(-not(Test-Path -LiteralPath $extra)){throw 'Unknown file was removed'}
    }
    'path-escape' {Expect-Refusal {Get-ReleaseFile $root '../escape.bin'};Expect-Refusal {Get-ReleaseFile $root 'C:\escape.bin'};Expect-Refusal {Resolve-ReleaseRoot 'C:\PROGRA~1\orca'}}
    'wrong-version' {
        [IO.File]::Copy("$PSHOME/powershell.exe",(Join-Path $root 'Orca.exe'))
        Expect-Refusal {Assert-ReleaseVersion $root 'not-the-file-version'}
    }
    'nsis-whitespace' {Expect-Refusal {Assert-ReleasePlan ([pscustomobject]@{schema=1;installRoot='C:\Users\Test User\AppData\Local\Programs\orca'})}}
    'process-exit-handle' {
        $proc=Start-Process -FilePath "$PSHOME/powershell.exe" -ArgumentList @('-NoProfile','-Command','exit 17') -PassThru -WindowStyle Hidden
        $null=$proc.Handle
        if(-not $proc.WaitForExit(30000)){throw 'Synthetic process did not exit'}
        if($proc.ExitCode -ne 17){throw 'Exit status was not captured'}
    }
    default {throw 'Unknown safety fixture'}
}
[pscustomobject]@{case=$Case;result='PASS';syntheticOnly=$true}|ConvertTo-Json

param([Parameter(Mandatory=$true)][string]$Sandbox,[Parameter(Mandatory=$true)][string]$Case)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/WindowsReleaseOperations.ps1"
. "$PSScriptRoot/ReleaseStartupShortcut.ps1"
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
    'orphan-nsis-uninstaller' {Expect-Refusal {Assert-ReleaseProcessTableIdle @([pscustomobject]@{Name='Un_A.exe';ExecutablePath='C:\Temp\ns1234.tmp\Un_A.exe';ProcessId=12;ParentProcessId=999;CreationDate=$stamp}) $plan $state}}
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
    'nsis-whitespace' {Expect-Refusal {Assert-ReleasePlan ([pscustomobject]@{schema=1;version='1';rollback=@{version='1'};installRoot='C:\Users\Test User\AppData\Local\Programs\orca'})}}
    'process-exit-handle' {
        $proc=Start-Process -FilePath "$PSHOME/powershell.exe" -ArgumentList @('-NoProfile','-Command','exit 17') -PassThru -WindowStyle Hidden
        $null=$proc.Handle
        if(-not $proc.WaitForExit(30000)){throw 'Synthetic process did not exit'}
        if($proc.ExitCode -ne 17){throw 'Exit status was not captured'}
    }
    'nested-backslash-archive' {
        $zipPath=Join-Path $Sandbox 'nested.zip'
        $zip=[IO.Compression.ZipFile]::Open($zipPath,'Create')
        try{$entry=$zip.CreateEntry('sub\nested.bin');$stream=$entry.Open();try{$bytes=[Text.Encoding]::UTF8.GetBytes('old');$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}finally{$zip.Dispose()}
        $manifestEntry=[pscustomobject]@{path='sub/nested.bin';size=3;sha256=(Get-ReleaseHash (Join-Path $Sandbox 'backup/program.bin'));requiredNonempty=$true}
        $plan|Add-Member NoteProperty rollback ([pscustomobject]@{archive=$zipPath;sha256=(Get-ReleaseHash $zipPath);manifest=[pscustomobject]@{files=@($manifestEntry)}})
        Assert-ReleaseArchive $plan.rollback
        Restore-ReleaseArchive $plan
        Assert-ReleaseFiles $root $plan.rollback.manifest
    }
    'pid-previous-boot' {
        $state.installerStartedAt=$stamp.AddHours(-1).ToString('o')
        Assert-ReleaseProcessTableIdle @([pscustomobject]@{Name='unrelated.exe';ExecutablePath='C:\elsewhere\unrelated.exe';ProcessId=12;ParentProcessId=42;CreationDate=$stamp}) $plan $state $stamp.AddMinutes(-10)
    }
    'empty-version' {
        [IO.File]::WriteAllText((Join-Path $root 'Orca.exe'),'not a versioned PE')
        Expect-Refusal {Assert-ReleaseVersion $root $null}
    }
    'partial-addition' {
        $backup=Join-Path $Sandbox 'backup';$baseline=[pscustomobject]@{path='program.bin';size=3;sha256=(Get-ReleaseHash (Join-Path $backup 'program.bin'));requiredNonempty=$true}
        $extra=Join-Path $root 'new-only.bin';[IO.File]::WriteAllText($extra,'new')
        $addition=[pscustomobject]@{path='new-only.bin';size=3;sha256=(Get-ReleaseHash $extra);requiredNonempty=$true}
        [IO.File]::WriteAllText($extra,'n')
        $archive=Join-Path $Sandbox 'rollback.zip';[IO.Compression.ZipFile]::CreateFromDirectory($backup,$archive)
        $plan|Add-Member NoteProperty candidate ([pscustomobject]@{files=@($baseline,$addition)})
        $plan|Add-Member NoteProperty rollback ([pscustomobject]@{archive=$archive;sha256=(Get-ReleaseHash $archive);manifest=[pscustomobject]@{files=@($baseline)}})
        $plan|Add-Member NoteProperty removalApproval 'APPROVED_LISTED_CANDIDATE_ADDITIONS'
        Expect-Refusal {Remove-ReleaseCandidateAdditions $plan}
        if(-not(Test-Path -LiteralPath $extra)){throw 'Unapproved partial file was removed'}
        $plan|Add-Member NoteProperty partialCandidateRemovalApproval 'APPROVED_REVIEWED_CANDIDATE_PATHS'
        Remove-ReleaseCandidateAdditions $plan
        Restore-ReleaseArchive $plan
        Assert-ReleaseFiles $root $plan.rollback.manifest -Exact
        $preserved=@(Get-ChildItem -LiteralPath (Join-Path $Sandbox 'partial-candidate-evidence') -File -Recurse)
        if($preserved.Count -ne 1 -or [IO.File]::ReadAllText($preserved[0].FullName) -ne 'n'){throw 'Partial file bytes were not preserved'}
    }
    {$_ -in @('startup-shortcut','startup-shortcut-alias','startup-shortcut-hidden')} {
        $folder=Join-Path $Sandbox 'startup';[IO.Directory]::CreateDirectory($folder)|Out-Null
        $shell=New-Object -ComObject WScript.Shell
        $name=$(if($Case -eq 'startup-shortcut-alias'){'My Work.lnk'}else{'Orca.lnk'})
        $path=Join-Path $folder $name;$link=$shell.CreateShortcut($path);$link.TargetPath=Join-Path $root 'Orca.exe';$link.Save()
        if($Case -eq 'startup-shortcut-hidden'){[IO.File]::SetAttributes($path,[IO.FileAttributes]::Hidden)}
        $originalHash=Get-ReleaseHash $path
        $arguments=@{Folder=$folder;InstallRoot=$root;PlanPath=(Join-Path $Sandbox 'plan.json');PlanHash=('a'*64);GatePath=(Join-Path $Sandbox 'gate.ps1');BackupRoot=(Join-Path $Sandbox 'startup-backup')}
        if($Case -eq 'startup-shortcut-alias'){$arguments.InstallRoot=$root.Replace('\','/')+'/'}
        $preview=Set-ReleaseStartupShortcutGate @arguments
        if($preview.routed -or $preview.eligibleShortcuts -ne 1 -or (Get-ReleaseHash $path) -ne $originalHash){throw 'Preview modified startup'}
        Set-ReleaseStartupShortcutGate @arguments -Apply|Out-Null
        $after=$shell.CreateShortcut($path)
        if($after.Arguments -notmatch 'gate.ps1' -or (Get-ReleaseHash (Join-Path $Sandbox ('startup-backup/'+$name+'.original'))) -ne $originalHash){throw 'Startup routing/backup failed'}
    }
    'hold-launch-lock' {
        $lock=[IO.File]::Open((Join-Path $Sandbox 'state/launch.lock'),'OpenOrCreate','ReadWrite','None')
        try{[IO.File]::WriteAllText((Join-Path $Sandbox 'lock-held'),'ready');Start-Sleep -Seconds 45}finally{$lock.Dispose()}
    }
    'plan-hash-format' {Assert-ReleasePlanHash ('a'*64);Expect-Refusal {Assert-ReleasePlanHash 'not a hash'};Expect-Refusal {Assert-ReleasePlanHash ('a'*64+' extra')}}
    'launch-plan-missing-installer' {
        $entries=@(foreach($name in @('Orca.exe','resources/app.asar','resources/bin/orca.exe','resources.pak','icudtl.dat')){[pscustomobject]@{path=$name;size=1;sha256=('a'*64);requiredNonempty=$true}})
        $manifest=[pscustomobject]@{files=$entries}
        $fixturePlan=[pscustomobject]@{schema=1;version='1';installRoot=(Join-Path $env:LOCALAPPDATA 'Programs/orca');requiredPort=6768;readinessTimeoutSeconds=30;removalApproval='REVIEW_REQUIRED';candidate=$manifest;
            installer=@{path=(Join-Path $Sandbox 'absent-installer.exe');sha256=('a'*64)};
            rollback=@{version='1';archive=(Join-Path $Sandbox 'absent-rollback.zip');sha256=('a'*64);manifest=$manifest}}
        Assert-ReleasePlan $fixturePlan -ForLaunch
        Expect-Refusal {Assert-ReleasePlan $fixturePlan}
    }
    'journal-replace-failure' {
        $path=Join-Path $Sandbox 'journal.json'
        Write-ReleaseJournal $path ([pscustomobject]@{schema=1;phase='PREPARED';updatedAt=''})
        $lock=[IO.File]::Open($path,'Open','Read','None')
        try{Expect-Refusal {Write-ReleaseJournal $path ([pscustomobject]@{schema=1;phase='INSTALLING';updatedAt=''})}}finally{$lock.Dispose()}
        if((Read-ReleaseJournal $path).phase -ne 'PREPARED'){throw 'Prior valid journal was lost'}
    }
    'renamed-run-entry' {
        $entries=@([pscustomobject]@{name='Updater';value=('"'+(Join-Path $root 'Orca.exe')+'"')},[pscustomobject]@{name='Other';value='C:\Windows\notepad.exe'})
        $names=@(Get-ReleaseRunBypassNames $entries $root)
        if($names.Count -ne 1 -or $names[0] -ne 'Updater'){throw 'Renamed direct Run entry bypassed detection'}
    }
    'unreviewed-startup-target' {
        $folder=Join-Path $Sandbox 'startup';[IO.Directory]::CreateDirectory($folder)|Out-Null
        $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut((Join-Path $folder 'Unrelated Name.lnk'))
        $link.TargetPath=Join-Path $Sandbox 'different-program/Orca.exe';$link.Save()
        Expect-Refusal {Set-ReleaseStartupShortcutGate -Folder $folder -InstallRoot $root -PlanPath (Join-Path $Sandbox 'plan.json') -PlanHash ('a'*64) -GatePath (Join-Path $Sandbox 'gate.ps1') -BackupRoot (Join-Path $Sandbox 'backup-shortcuts')}
    }
    default {throw 'Unknown safety fixture'}
}
[pscustomobject]@{case=$Case;result='PASS';syntheticOnly=$true}|ConvertTo-Json

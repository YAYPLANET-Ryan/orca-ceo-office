. "$PSScriptRoot/ReleaseIntegrity.ps1"

function Get-ReleaseRunBypassNames($Entries,[string]$InstallRoot) {
    $InstallRoot=Resolve-ReleaseRoot $InstallRoot
    @(foreach($entry in $Entries) {
        $value=([string]$entry.value).Replace('/','\')
        if ($value.IndexOf($InstallRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $value -match '(?i)orca\.exe') { $entry.name }
    })
}

function Get-ReleaseStartupRunBypasses([string]$InstallRoot) {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
    if (-not $key) { return @() }
    try {
        $entries=@(foreach($name in $key.GetValueNames()){[pscustomobject]@{name=$name;value=$key.GetValue($name)}})
        Get-ReleaseRunBypassNames $entries $InstallRoot
    } finally { $key.Dispose() }
}

function Get-ReleaseLaunchArguments([string]$GatePath,[string]$PlanPath,[string]$PlanHash,[string]$BundleSha256,[string]$Entry='Invoke-GuardedOrcaLaunch.ps1',[string]$Mode) {
    foreach($path in @($GatePath,$PlanPath)){if($path.Contains('"') -or $path -match '[\r\n]'){throw 'Invalid launch argument'}}
    Assert-ReleasePlanHash $PlanHash
    $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$GatePath+'" -PlanPath "'+$PlanPath+'" -ExpectedPlanSha256 '+$PlanHash.ToLowerInvariant()
    if($BundleSha256){Assert-ReleasePlanHash $BundleSha256;if($Entry -notin @('Invoke-VerifiedRelease.ps1','Invoke-GuardedOrcaLaunch.ps1')){throw 'Invalid scheduled entry'};$arguments+=' -ExpectedBundleSha256 '+$BundleSha256.ToLowerInvariant()+' -Entry '+$Entry}
    if($Mode){if($Mode -ne 'Apply'){throw 'Invalid scheduled mode'};$arguments+=' -Mode Apply'}
    $arguments
}

function Set-ReleaseStartupShortcutGate([string]$Folder,[string]$InstallRoot,[string]$PlanPath,[string]$PlanHash,[string]$GatePath,[string]$BackupRoot,[switch]$Apply,[string]$BundleSha256,$ExpectedShortcuts,[scriptblock]$OnItemState) {
    $InstallRoot=Resolve-ReleaseRoot $InstallRoot
    $Folder=Resolve-ReleaseRoot $Folder
    $BackupRoot=Resolve-ReleaseRoot $BackupRoot
    $PlanPath=[IO.Path]::GetFullPath($PlanPath)
    $GatePath=[IO.Path]::GetFullPath($GatePath)
    Assert-ReleasePlanHash $PlanHash
    if($BundleSha256){Assert-ReleasePlanHash $BundleSha256}
    foreach ($value in @($PlanPath,$GatePath)) { if ($value.Contains('"') -or $value -match '[\r\n]') { throw 'Invalid startup argument' } }
    $gateArguments=Get-ReleaseLaunchArguments $GatePath $PlanPath $PlanHash $BundleSha256
    $shell=New-Object -ComObject WScript.Shell
    $selected=@()
    foreach ($file in Get-ChildItem -LiteralPath $Folder -Filter '*.lnk' -File -Force -ErrorAction Stop|Sort-Object FullName) {
        $shortcut=$shell.CreateShortcut($file.FullName)
        if ([string]::IsNullOrWhiteSpace($shortcut.TargetPath) -or $shortcut.TargetPath -notmatch '(?i)(^|[\\/])Orca\.exe$') { continue }
        if ([IO.Path]::GetFullPath($shortcut.TargetPath) -ine (Join-Path $InstallRoot 'Orca.exe')) { throw 'Orca startup target differs from reviewed installation; routing review required' }
        if (-not [string]::IsNullOrWhiteSpace($shortcut.Arguments)) { throw 'Existing startup arguments require separate review' }
        $selected+=[pscustomobject]@{path=$file.FullName;shortcut=$shortcut;originalSha256=(Get-ReleaseHash $file.FullName);backupPath=(Join-Path $BackupRoot ($file.Name+'.original'))}
    }
    if($PSBoundParameters.ContainsKey('ExpectedShortcuts')){
        if(@($ExpectedShortcuts).Count -ne $selected.Count){throw 'Startup set changed since preview'}
        foreach($item in $selected){$expected=@($ExpectedShortcuts|Where-Object {[IO.Path]::GetFullPath($_.path) -eq $item.path});if($expected.Count -ne 1 -or $expected[0].originalSha256 -ne $item.originalSha256){throw 'Startup path or original bytes changed since preview'}}
    }
    if ($Apply) {
        $backupDirectory=Resolve-ReleaseRoot $BackupRoot
        [IO.Directory]::CreateDirectory($backupDirectory)|Out-Null
        foreach ($item in $selected) {
            $backup=Get-ReleaseFile $backupDirectory ([IO.Path]::GetFileName($item.path)+'.original')
            if (Test-Path -LiteralPath $backup) { throw 'Startup backup already exists; review before changing it' }
        }
        foreach ($item in $selected) {
            $backup=Get-ReleaseFile $backupDirectory ([IO.Path]::GetFileName($item.path)+'.original')
            if((Get-ReleaseHash $item.path) -ne $item.originalSha256){throw 'Startup original changed before backup'}
            $detail=[pscustomobject]@{path=$item.path;originalSha256=$item.originalSha256;backupPath=$backup;routedSha256=$null;status='BACKUP_PENDING'}
            if($OnItemState){& $OnItemState $detail}
            [IO.File]::Copy($item.path,$backup,$false)
            if ((Get-ReleaseHash $backup) -ne $item.originalSha256 -or (Get-ReleaseHash $item.path) -ne $item.originalSha256) { throw 'Startup backup verification failed' }
            $detail.status='BACKUP_VERIFIED';if($OnItemState){& $OnItemState $detail}
            $item.shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $item.shortcut.Arguments=$gateArguments
            $detail.status='ROUTING';if($OnItemState){& $OnItemState $detail}
            $item.shortcut.Save()
            $saved=$shell.CreateShortcut($item.path)
            if ([IO.Path]::GetFullPath($saved.TargetPath) -ine [IO.Path]::GetFullPath($item.shortcut.TargetPath) -or $saved.Arguments -ne $item.shortcut.Arguments) { throw 'Startup gate write verification failed' }
            $detail.routedSha256=Get-ReleaseHash $item.path;$detail.status='ROUTED';if($OnItemState){& $OnItemState $detail}
        }
    }
    $details=@(foreach($item in $selected){[pscustomobject]@{path=$item.path;originalSha256=$item.originalSha256;backupPath=$item.backupPath;routedSha256=$(if($Apply){Get-ReleaseHash $item.path}else{$null});status=$(if($Apply){'ROUTED'}else{'PLANNED'})}})
    [pscustomobject]@{eligibleShortcuts=$selected.Count;routed=[bool]$Apply;backupCreated=[bool]($Apply -and $selected.Count);gatePath=$GatePath;gateArguments=$gateArguments;shortcuts=$details}
}

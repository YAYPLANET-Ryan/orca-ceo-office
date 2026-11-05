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

function Set-ReleaseStartupShortcutGate([string]$Folder,[string]$InstallRoot,[string]$PlanPath,[string]$PlanHash,[string]$GatePath,[string]$BackupRoot,[switch]$Apply) {
    $InstallRoot=Resolve-ReleaseRoot $InstallRoot
    $PlanPath=[IO.Path]::GetFullPath($PlanPath)
    $GatePath=[IO.Path]::GetFullPath($GatePath)
    Assert-ReleasePlanHash $PlanHash
    foreach ($value in @($PlanPath,$GatePath)) { if ($value.Contains('"') -or $value -match '[\r\n]') { throw 'Invalid startup argument' } }
    $shell=New-Object -ComObject WScript.Shell
    $selected=@()
    foreach ($file in Get-ChildItem -LiteralPath $Folder -Filter '*.lnk' -File -Force -ErrorAction Stop) {
        $shortcut=$shell.CreateShortcut($file.FullName)
        if ([string]::IsNullOrWhiteSpace($shortcut.TargetPath) -or $shortcut.TargetPath -notmatch '(?i)(^|[\\/])Orca\.exe$') { continue }
        if ([IO.Path]::GetFullPath($shortcut.TargetPath) -ine (Join-Path $InstallRoot 'Orca.exe')) { throw 'Orca startup target differs from reviewed installation; routing review required' }
        if (-not [string]::IsNullOrWhiteSpace($shortcut.Arguments)) { throw 'Existing startup arguments require separate review' }
        $selected+=[pscustomobject]@{path=$file.FullName;shortcut=$shortcut}
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
            [IO.File]::Copy($item.path,$backup,$false)
            if ((Get-ReleaseHash $backup) -ne (Get-ReleaseHash $item.path)) { throw 'Startup backup verification failed' }
            $item.shortcut.TargetPath="$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe"
            $item.shortcut.Arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$GatePath+'" -PlanPath "'+$PlanPath+'" -ExpectedPlanSha256 '+$PlanHash
            $item.shortcut.Save()
            $saved=$shell.CreateShortcut($item.path)
            if ([IO.Path]::GetFullPath($saved.TargetPath) -ine [IO.Path]::GetFullPath($item.shortcut.TargetPath) -or $saved.Arguments -ne $item.shortcut.Arguments) { throw 'Startup gate write verification failed' }
        }
    }
    [pscustomobject]@{eligibleShortcuts=$selected.Count;routed=[bool]$Apply;backupCreated=[bool]($Apply -and $selected.Count)}
}

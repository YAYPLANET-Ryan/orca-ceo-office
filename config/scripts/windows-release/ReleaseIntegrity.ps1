Set-StrictMode -Version Latest
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1" -ErrorAction Stop

function Get-ReleaseHash([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Resolve-ReleaseRoot([string]$Path) {
    if ($Path -match '(?i)(^|[\\/])[^\\/]*~[0-9]+([\\/]|$)') { throw 'Short-name alias refused' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full -match '(?i)(^|[\\/])[^\\/]*~[0-9]+([\\/]|$)' -or $full.StartsWith('\\')) { throw 'Short-name and network aliases refused' }
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'Volume root refused' }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Reparse point refused'
            }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    $full
}

function Get-ReleaseFile([string]$Root, [string]$Relative) {
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')) { throw 'Invalid manifest path' }
    $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $full.StartsWith($Root.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escaped root' }
    Resolve-ReleaseRoot $full
}

function Assert-ReleaseEssentialManifest($Manifest) {
    foreach ($required in @('Orca.exe','resources/app.asar','resources/bin/orca.exe','resources.pak','icudtl.dat')) {
        $entry = @($Manifest.files | Where-Object { $_.path.Replace('\','/') -ieq $required })
        if ($entry.Count -ne 1 -or -not $entry[0].requiredNonempty -or $entry[0].size -le 0) { throw 'Essential file missing from manifest' }
    }
}

function Assert-ReleaseFiles([string]$Root, $Manifest, [switch]$Exact) {
    $Root = Resolve-ReleaseRoot $Root
    if (@($Manifest.files).Count -eq 0) { throw 'Empty manifest refused' }
    $seen = @{}
    foreach ($entry in $Manifest.files) {
        $path = Get-ReleaseFile $Root $entry.path
        if ($seen.ContainsKey($path)) { throw 'Duplicate manifest entry' }
        $seen[$path] = $true
        $item = Get-Item -LiteralPath $path -ErrorAction Stop
        if ($item.PSIsContainer -or $entry.size -lt 0 -or $item.Length -ne $entry.size -or ($entry.requiredNonempty -and $item.Length -eq 0)) {
            throw ('Missing, empty or wrong-sized program file: ' + $entry.path)
        }
        if ((Get-ReleaseHash $path) -ne $entry.sha256) { throw ('Hash mismatch: ' + $entry.path) }
    }
    if ($Exact) {
        foreach ($item in Get-ChildItem -LiteralPath $Root -Recurse -File -Force) {
            if (-not $seen.ContainsKey($item.FullName)) { throw 'Unexpected program file after rollback; manual review required' }
        }
    }
}

function Write-ReleaseJournal([string]$Path, $State) {
    $State.updatedAt = [DateTime]::UtcNow.ToString('o')
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.pending'
    $bytes = [Text.Encoding]::UTF8.GetBytes(($State | ConvertTo-Json -Depth 12))
    $stream = [IO.File]::Open($temporary, 'CreateNew', 'Write', 'None')
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    # Keep the prior valid intent, but never silently downgrade a corrupt latest journal.
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, $Path + '.previous') }
    else { [IO.File]::Move($temporary, $Path) }
}

function Read-ReleaseJournal([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $state = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.schema -ne 1 -or $state.phase -notin @('PREPARED','INSTALLING','VERIFYING','ROLLING_BACK','ROLLBACK_FAILED','ROLLED_BACK','READY','READINESS_FAILED')) {
        throw 'Unknown or corrupt journal; installation refused'
    }
    $state
}

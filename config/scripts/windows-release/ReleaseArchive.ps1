. "$PSScriptRoot/ReleaseIntegrity.ps1"
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-ReleaseArchive($Rollback) {
    if ((Get-ReleaseHash $Rollback.archive) -ne $Rollback.sha256) { throw 'Rollback archive hash mismatch' }
    $archive = [IO.Compression.ZipFile]::OpenRead($Rollback.archive)
    try {
        $entries = @{}
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $relative = $entry.FullName.Replace('\','/')
            Get-ReleaseFile ([IO.Path]::GetDirectoryName($Rollback.archive)) $relative | Out-Null
            if ($entries.ContainsKey($relative)) { throw 'Duplicate archive entry' }
            $entries[$relative] = $entry
        }
        if ($entries.Count -ne @($Rollback.manifest.files).Count) { throw 'Archive inventory mismatch' }
        foreach ($expected in $Rollback.manifest.files) {
            $relative = $expected.path.Replace('\','/')
            if (-not $entries.ContainsKey($relative)) { throw 'Archive entry missing' }
            $entry = $entries[$relative]
            if ($entry.Length -ne $expected.size -or ($expected.requiredNonempty -and $entry.Length -eq 0)) { throw 'Archive entry size mismatch' }
            $stream = $entry.Open(); $algorithm = [Security.Cryptography.SHA256]::Create()
            try { $hash = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
            finally { $algorithm.Dispose(); $stream.Dispose() }
            if ($hash -ne $expected.sha256) { throw 'Archive entry hash mismatch' }
        }
    } finally { $archive.Dispose() }
}

function Restore-ReleaseArchive($Plan) {
    # Revalidate before opening targets; no executable staging outside the install root.
    Assert-ReleaseArchive $Plan.rollback
    $archive = [IO.Compression.ZipFile]::OpenRead($Plan.rollback.archive)
    try {
        foreach ($expected in $Plan.rollback.manifest.files) {
            $entry = $archive.GetEntry($expected.path.Replace('\','/'))
            $target = Get-ReleaseFile $Plan.installRoot $expected.path
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            $inputStream = $entry.Open()
            try {
                $outputStream = [IO.File]::Open($target,'Create','Write','None')
                try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) }
                finally { $outputStream.Dispose() }
            } finally { $inputStream.Dispose() }
        }
    } finally { $archive.Dispose() }
}

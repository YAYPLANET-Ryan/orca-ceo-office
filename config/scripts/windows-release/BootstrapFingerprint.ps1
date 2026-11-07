. "$PSScriptRoot/ReleaseIntegrity.ps1"

function Assert-KnownIncompleteProgram([string]$Root,$Manifest,[string[]]$ExpectedMissing) {
    $Root=Resolve-ReleaseRoot $Root
    Assert-ReleaseEssentialManifest $Manifest
    if ($ExpectedMissing.Count -ne 1 -or $ExpectedMissing[0] -cne 'resources/bin/orca.exe') { throw 'R0 initial allowance is exactly the native CLI path' }
    $seen=@{};$missing=@();$present=@()
    foreach($entry in $Manifest.files) {
        $path=Get-ReleaseFile $Root $entry.path
        if($seen.ContainsKey($path)){throw 'Duplicate baseline path'}
        $seen[$path]=$true
        if(-not(Test-Path -LiteralPath $path)){$missing+=$entry.path.Replace('\','/');continue}
        $present+=$entry
    }
    foreach($file in Get-ChildItem -LiteralPath $Root -File -Recurse -Force) {
        if(-not $seen.ContainsKey($file.FullName)){throw 'Unknown program file; R0 refused'}
    }
    if($missing.Count -ne 1 -or $missing[0] -cne $ExpectedMissing[0]){throw 'Measured missing-file set differs from approved R0 state'}
    Assert-ReleaseFiles $Root ([pscustomobject]@{files=$present})
}

function Get-BootstrapCliEntry($Manifest) {
    $entries=@($Manifest.files|Where-Object {$_.path.Replace('\','/') -ceq 'resources/bin/orca.exe'})
    if($entries.Count -ne 1 -or $entries[0].size -le 0){throw 'Exactly one nonempty native CLI entry required'}
    $entries[0]
}

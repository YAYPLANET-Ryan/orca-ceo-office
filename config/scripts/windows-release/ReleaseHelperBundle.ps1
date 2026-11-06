. "$PSScriptRoot/ReleaseIntegrity.ps1"

function Assert-ReleaseHelperBundle([string]$Directory,[string]$ExpectedManifestHash) {
    $Directory=Resolve-ReleaseRoot $Directory
    Assert-ReleasePlanHash $ExpectedManifestHash
    $path=Join-Path $Directory 'bundle-manifest.json'
    if((Get-ReleaseHash $path) -ne $ExpectedManifestHash){throw 'Bundle manifest changed'}
    $manifest=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
    if($manifest.schema -ne 1 -or $manifest.sourceRevision -notmatch '\A[0-9a-f]{40}\z'){throw 'Invalid bundle provenance'}
    Assert-ReleaseFiles $Directory $manifest
    $known=@('bundle-manifest.json')+@($manifest.files.path)
    foreach($file in Get-ChildItem -LiteralPath $Directory -File -Recurse -Force) {
        $relative=$file.FullName.Substring($Directory.Length+1).Replace('\','/')
        if($known -notcontains $relative){throw 'Unexpected runtime bundle file'}
    }
    $manifest
}

function New-ReleaseHelperBundle([string]$SourceDirectory,[string]$OutputDirectory,[string]$SourceRevision) {
    $SourceDirectory=Resolve-ReleaseRoot $SourceDirectory
    $OutputDirectory=Resolve-ReleaseRoot $OutputDirectory
    if($SourceRevision -notmatch '\A[0-9a-f]{40}\z'){throw 'Exact source revision required'}
    if(Test-Path -LiteralPath $OutputDirectory){throw 'Existing bundle must never be overwritten'}
    if($OutputDirectory -eq $SourceDirectory -or $OutputDirectory.StartsWith($SourceDirectory+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Bundle must be outside source directory'}
    $files=@(Get-ChildItem -LiteralPath $SourceDirectory -File -Filter '*.ps1'|Where-Object {$_.Name -notlike '*Fixture.ps1'})
    if(-not @($files|Where-Object Name -eq 'Invoke-ReleaseBundleEntry.ps1').Count){throw 'Verified loader required'}
    [IO.Directory]::CreateDirectory($OutputDirectory)|Out-Null
    $entries=@(foreach($file in $files) {
        $sourcePath=Get-ReleaseFile $SourceDirectory $file.Name
        $target=Get-ReleaseFile $OutputDirectory $file.Name
        $hash=Get-ReleaseHash $sourcePath
        [IO.File]::Copy($sourcePath,$target,$false)
        if((Get-ReleaseHash $target) -ne $hash -or (Get-ReleaseHash $sourcePath) -ne $hash){throw 'Source changed while freezing bundle'}
        [pscustomobject]@{path=$file.Name;size=$file.Length;sha256=$hash;requiredNonempty=$true}
    })
    $manifest=[pscustomobject]@{schema=1;sourceRevision=$SourceRevision;createdAt=[DateTime]::UtcNow.ToString('o');files=$entries}
    $path=Join-Path $OutputDirectory 'bundle-manifest.json'
    $manifest|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $path -Encoding UTF8
    $hash=Get-ReleaseHash $path
    Assert-ReleaseHelperBundle $OutputDirectory $hash|Out-Null
    [pscustomobject]@{directory=$OutputDirectory;manifestSha256=$hash;sourceRevision=$SourceRevision;files=$entries.Count;registered=$false}
}

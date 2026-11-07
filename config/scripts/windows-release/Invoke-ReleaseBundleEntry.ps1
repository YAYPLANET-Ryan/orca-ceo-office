param([Parameter(Mandatory=$true)][string]$ExpectedBundleSha256,
      [Parameter(Mandatory=$true)][ValidateSet('Invoke-BootstrapRepair.ps1','Invoke-VerifiedRelease.ps1','Invoke-GuardedOrcaLaunch.ps1')][string]$Entry,
      [Parameter(Mandatory=$true)][string]$PlanPath,[Parameter(Mandatory=$true)][string]$ExpectedPlanSha256,
      [ValidateSet('Validate','Inspect','Apply','Recover','Rollback')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1" -ErrorAction Stop
# Validate all bytes with OS primitives before loading bundle modules.
$cursor=[IO.Path]::GetFullPath($PSScriptRoot)
while($cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Bundle parent reparse point refused'};$cursor=[IO.Path]::GetDirectoryName($cursor)}
foreach($hash in @($ExpectedBundleSha256,$ExpectedPlanSha256)){if($hash -notmatch '\A[0-9a-fA-F]{64}\z'){throw 'Invalid pinned hash'}}
$manifestPath=Join-Path $PSScriptRoot 'bundle-manifest.json'
if((Get-FileHash -LiteralPath $manifestPath).Hash -ne $ExpectedBundleSha256){throw 'Bundle manifest hash mismatch'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.schema -ne 1 -or $manifest.sourceRevision -notmatch '\A[0-9a-f]{40}\z'){throw 'Invalid bundle manifest'}
$seen=@{}
foreach($file in $manifest.files) {
    if($file.path -notmatch '\A[A-Za-z0-9-]+\.ps1\z' -or $seen.ContainsKey($file.path)){throw 'Invalid/duplicate bundle path'}
    $seen[$file.path]=$true
    $path=Join-Path $PSScriptRoot $file.path
    $item=Get-Item -LiteralPath $path -Force
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint -or $item.Length -le 0 -or $item.Length -ne $file.size -or (Get-FileHash -LiteralPath $path).Hash -ne $file.sha256){throw 'Bundle payload missing or changed'}
}
if(-not $seen.ContainsKey($Entry) -or -not $seen.ContainsKey('Invoke-ReleaseBundleEntry.ps1')){throw 'Entry is not in pinned bundle'}
foreach($item in Get-ChildItem -LiteralPath $PSScriptRoot -Force){if($item.PSIsContainer -or ($item.Name -ne 'bundle-manifest.json' -and -not $seen.ContainsKey($item.Name))){throw 'Unexpected bundle entry'}}
$entryArguments=@{PlanPath=[IO.Path]::GetFullPath($PlanPath);ExpectedPlanSha256=$ExpectedPlanSha256}
if($Entry -ne 'Invoke-GuardedOrcaLaunch.ps1'){$entryArguments.Mode=$Mode}
$global:LASTEXITCODE=0
& (Join-Path $PSScriptRoot $Entry) @entryArguments
exit $LASTEXITCODE

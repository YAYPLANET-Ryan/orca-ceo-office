param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$CandidateRoot,
    [Parameter(Mandatory=$true)][string]$Installer,
    [Parameter(Mandatory=$true)][string]$InstallerSha256,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [int]$RequiredPort = 6768,
    [switch]$ApproveCandidateAdditions,
    [switch]$ApprovePartialCandidateAdditions
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/WindowsReleaseOperations.ps1"
if ($ApprovePartialCandidateAdditions -and -not $ApproveCandidateAdditions) { throw 'Partial candidate removal also requires reviewed candidate-path approval' }
$InstallRoot = Resolve-ReleaseRoot $InstallRoot
$CandidateRoot = Resolve-ReleaseRoot $CandidateRoot
$OutputDirectory = Resolve-ReleaseRoot $OutputDirectory
if (Test-Path -LiteralPath $OutputDirectory) { throw 'New output directory required; never overwrite a reviewed recovery plan' }
if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'plan.json')) { throw 'Reviewed plan already exists; no overwrite' }
foreach ($protected in @($InstallRoot,$CandidateRoot)) {
    if ($OutputDirectory.StartsWith($protected + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Snapshot must be outside source trees' }
}
if ((Get-ReleaseHash $Installer) -ne $InstallerSha256) { throw 'Installer hash mismatch' }
$essential = @('Orca.exe','resources/app.asar','resources/bin/orca.exe','resources.pak','icudtl.dat')
function New-ProgramManifest([string]$Root) {
    $entries = @(foreach ($file in Get-ChildItem -LiteralPath $Root -File -Recurse -Force) {
        $relative = $file.FullName.Substring($Root.Length + 1).Replace('\','/')
        $checked = Get-ReleaseFile $Root $relative
        [pscustomobject]@{path=$relative;size=$file.Length;sha256=(Get-ReleaseHash $checked);requiredNonempty=($essential -contains $relative)}
    })
    [pscustomobject]@{files=$entries}
}
$baseline = New-ProgramManifest $InstallRoot
$candidate = New-ProgramManifest $CandidateRoot
Assert-ReleaseEssentialManifest $baseline
Assert-ReleaseEssentialManifest $candidate
Assert-ReleaseFiles $InstallRoot $baseline -Exact
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$backup = Join-Path $OutputDirectory 'rollback-program.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($InstallRoot,$backup,[IO.Compression.CompressionLevel]::Optimal,$false)
# Re-read both sides: a moving or partial snapshot must not become rollback authority.
Assert-ReleaseFiles $InstallRoot $baseline -Exact
$plan = [ordered]@{schema=1;createdAt=[DateTime]::UtcNow.ToString('o');installRoot=$InstallRoot;
    version=(Get-Item -LiteralPath (Join-Path $CandidateRoot 'Orca.exe')).VersionInfo.FileVersion;
    installer=@{path=[IO.Path]::GetFullPath($Installer);sha256=$InstallerSha256};candidate=$candidate;
    rollback=@{archive=$backup;sha256=(Get-ReleaseHash $backup);manifest=$baseline;version=(Get-Item -LiteralPath (Join-Path $InstallRoot 'Orca.exe')).VersionInfo.FileVersion};
    requiredPort=$RequiredPort;readinessTimeoutSeconds=180;continuity='NOT_TESTED';
    removalApproval=$(if($ApproveCandidateAdditions){'APPROVED_LISTED_CANDIDATE_ADDITIONS'}else{'REVIEW_REQUIRED'});
    partialCandidateRemovalApproval=$(if($ApprovePartialCandidateAdditions){'APPROVED_REVIEWED_CANDIDATE_PATHS'}else{'REVIEW_REQUIRED'})}
$baselinePaths = @{}
foreach ($entry in $baseline.files) { $baselinePaths[$entry.path.Replace('\','/')] = $true }
$additions = @($candidate.files | Where-Object { -not $baselinePaths.ContainsKey($_.path.Replace('\','/')) })
$additions | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'candidate-additions-dry-run.json') -Encoding UTF8
if ($additions.Count -eq 0 -or $ApproveCandidateAdditions) { Assert-ReleasePlan ([pscustomobject]$plan) }
$path = Join-Path $OutputDirectory 'plan.json'
$plan | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8
[pscustomobject]@{plan=$path;sha256=(Get-ReleaseHash $path);rollbackFiles=$baseline.files.Count;candidateFiles=$candidate.files.Count;candidateOnlyRemovalCount=$additions.Count;removalApproval=$plan.removalApproval;liveMutation=$false} | ConvertTo-Json

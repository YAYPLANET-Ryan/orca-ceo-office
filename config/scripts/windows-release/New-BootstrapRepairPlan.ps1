param([Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$RollbackMetadataPath,
      [Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$InstallerSha256,
      [Parameter(Mandatory=$true)][string]$InstallerProofPath,[Parameter(Mandatory=$true)][string]$OutputDirectory,
      [string]$SecurityEvidencePath)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/BootstrapRepair.ps1"
$InstallRoot=Resolve-ReleaseRoot $InstallRoot
Assert-BootstrapExecutionIdentity $InstallRoot
$OutputDirectory=Resolve-ReleaseRoot $OutputDirectory
if(Test-Path -LiteralPath $OutputDirectory){throw 'New immutable plan directory required'}
if($OutputDirectory.StartsWith($InstallRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Plan must be outside installation'}
$rollback=Get-Content -LiteralPath $RollbackMetadataPath -Raw -Encoding UTF8|ConvertFrom-Json
Assert-ReleaseArchive $rollback
Assert-ReleaseVersion $InstallRoot $rollback.version
Assert-KnownIncompleteProgram $InstallRoot $rollback.manifest @('resources/bin/orca.exe')
if((Get-ReleaseHash $Installer) -ne $InstallerSha256){throw 'Installer hash mismatch'}
$proof=Get-Content -LiteralPath $InstallerProofPath -Raw -Encoding UTF8|ConvertFrom-Json
$cli=Get-BootstrapCliEntry $rollback.manifest
if($proof.installerSha256 -ne $InstallerSha256 -or $proof.embeddedCliSha256 -ne $cli.sha256 -or $proof.result -ne 'PASS_EMBEDDED_CLI_MATCHES_APPROVED_PACKET'){throw 'Exact embedded payload proof required'}
$security=[ordered]@{path='';sha256='';status='PENDING_VENDOR_RESOLUTION'}
if($SecurityEvidencePath){$security.path=[IO.Path]::GetFullPath($SecurityEvidencePath);$security.sha256=Get-ReleaseHash $SecurityEvidencePath;$security.status='PROVIDED_NOT_YET_VALIDATED'}
$plan=[pscustomobject][ordered]@{schema=1;installRoot=$InstallRoot;version=$rollback.version;
    installer=[pscustomobject]@{path=[IO.Path]::GetFullPath($Installer);sha256=$InstallerSha256};candidate=$rollback.manifest;rollback=$rollback;
    requiredPort=6768;readinessTimeoutSeconds=180;continuity='NOT_TESTED';removalApproval='REVIEW_REQUIRED';partialCandidateRemovalApproval='REVIEW_REQUIRED';
    bootstrap=[pscustomobject]@{kind='R0_SAME_VERSION';preRepairVersion=$rollback.version;initialMissingPaths=@('resources/bin/orca.exe');embeddedCliSha256=$cli.sha256;
        installerProof=[pscustomobject]@{path=[IO.Path]::GetFullPath($InstallerProofPath);sha256=(Get-ReleaseHash $InstallerProofPath)};securityEvidence=[pscustomobject]$security}}
$status='DRAFT_BLOCKED_SECURITY_PENDING'
if($SecurityEvidencePath){Assert-BootstrapRepairPlan $plan;$status='ARTIFACTS_VALIDATED_NOT_INSTALLED'}
[IO.Directory]::CreateDirectory($OutputDirectory)|Out-Null
$path=Join-Path $OutputDirectory 'bootstrap-plan.json'
$plan|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $path -Encoding UTF8
@{result=$status;plan=$path;sha256=(Get-ReleaseHash $path);appClosed=$false;installed=$false}|ConvertTo-Json

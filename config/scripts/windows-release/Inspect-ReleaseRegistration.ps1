param([string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'Programs/orca'),[string]$ExpectedPlanSha256,[string]$ExpectedBundleSha256)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/ReleaseRegistrationState.ps1"
. "$PSScriptRoot/ReleaseRegistrationPlatform.ps1"
$InstallRoot=Resolve-ReleaseRoot $InstallRoot
if($InstallRoot -ine (Resolve-ReleaseRoot (Join-Path $env:LOCALAPPDATA 'Programs/orca'))){throw 'Only the current user Orca registration may be inspected'}
$directory=Get-ReleaseStateDirectory $InstallRoot
if(-not(Test-Path -LiteralPath (Join-Path $directory 'registration.json'))){@{result='NO_REGISTRATION';liveWrites=$false}|ConvertTo-Json;exit 0}
if(-not $ExpectedPlanSha256 -or -not $ExpectedBundleSha256){throw 'Existing registration requires -ExpectedPlanSha256 and -ExpectedBundleSha256 from the reviewed plan/bundle'}
$lock=[IO.File]::Open((Join-Path $directory 'registration.lock'),'Open','ReadWrite','None')
try{Get-ReleaseRegistrationState $directory $InstallRoot $ExpectedPlanSha256 $ExpectedBundleSha256|ConvertTo-Json -Depth 8}finally{$lock.Dispose()}

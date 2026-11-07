param([Parameter(Mandatory=$true)][string]$OutputDirectory,[Parameter(Mandatory=$true)][string]$ExpectedSourceRevision)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/ReleaseHelperBundle.ps1"
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$head=(& git -C $repo rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $head -cne $ExpectedSourceRevision){throw 'Source HEAD differs from reviewed revision'}
$changes=@(& git -C $repo status --porcelain --untracked-files=all -- config/scripts/windows-release)
if($LASTEXITCODE -ne 0 -or $changes.Count){throw 'Release procedure working tree must be clean'}
New-ReleaseHelperBundle -SourceDirectory $PSScriptRoot -OutputDirectory $OutputDirectory -SourceRevision $head|ConvertTo-Json

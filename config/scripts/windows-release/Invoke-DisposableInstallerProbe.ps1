param([Parameter(Mandatory=$true)][string]$ManifestPath)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or -not $env:RUNNER_TEMP){
    throw 'Installer probe is restricted to a disposable GitHub Windows runner'
}
$temporary=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$root=Join-Path $temporary ('orca-installer-probe-'+[guid]::NewGuid().ToString('N'))
$install=Join-Path $root 'installed'
if(-not [IO.Path]::GetFullPath($install).StartsWith([IO.Path]::GetFullPath($root)+'\',[StringComparison]::OrdinalIgnoreCase)){
    throw 'Every probe install must remain inside its owned root'
}
if(-not [IO.Path]::GetFullPath($install).StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)){
    throw 'Probe target escaped the runner temporary directory'
}
$manifest=Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8|ConvertFrom-Json
$installer=[IO.Path]::GetFullPath($manifest.installer.path)
if((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.installer.sha256){
    throw 'Installer hash changed before the disposable probe'
}
[IO.Directory]::CreateDirectory($root)|Out-Null
$evidence=[ordered]@{result='FAIL';source=$manifest.source;version=$manifest.version;rounds=@();
    securityClearance='NOT_ESTABLISHED';protocolRollback='NOT_TESTED';actualConversationLaptopReboot='NOT_TESTED';
    installedWindowResponse='NOT_TESTED';sameMainProcess6768='NOT_TESTED';installedNativePty='NOT_TESTED';protocol36Upgrade='NOT_TESTED';phase='PREPARE'}
$completed=$false
function Set-ProbePhase([string]$Name) {
    $evidence.phase=$Name
    Write-Host ('[disposable-install] '+$Name)
    $evidence|ConvertTo-Json -Depth 8|Set-Content -LiteralPath 'dist/ceo-disposable-installer-proof.json' -Encoding UTF8
}
function Stop-ProbeApp {
    foreach($entry in @(Get-Process -Name Orca,orca-terminal-daemon -ErrorAction SilentlyContinue)){
        if($entry.Path -and $entry.Path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){
            & taskkill.exe /PID $entry.Id /T /F 2>$null|Out-Null
            Wait-Process -Id $entry.Id -Timeout 15 -ErrorAction SilentlyContinue
        }
    }
}
function Install-Probe {
    $process=Start-Process -FilePath $installer -ArgumentList @('/S',('/D='+$install)) -WindowStyle Hidden -PassThru
    $null=$process.Handle
    if(-not $process.WaitForExit(180000)){
        & taskkill.exe /PID $process.Id /T /F|Out-Null
        throw 'Disposable installer exceeded its deadline'
    }
    if($process.ExitCode -ne 0){throw ('Disposable NSIS failed: '+$process.ExitCode)}
}
function Assert-ProbeFiles {
    foreach($file in $manifest.files){
        $relative=$file.path.Replace('\','/')
        if(-not $relative.StartsWith('dist/win-unpacked/')){throw 'Unexpected build manifest path'}
        $target=[IO.Path]::GetFullPath((Join-Path $install $relative.Substring(18)))
        if(-not $target.StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Manifest escaped probe'}
        $item=Get-Item -LiteralPath $target
        if($item.Length -le 0 -or $item.Length -ne $file.size -or
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){
            throw 'Disposable installed program differs from the verified build'
        }
    }
    $script='const a=require("@electron/asar");const p=JSON.parse(a.extractFile(process.argv[1],"package.json"));if(p.version!==process.argv[2]||p.orcaRecoverySource!==process.argv[3])process.exit(1)'
    & node -e $script (Join-Path $install 'resources/app.asar') $manifest.version $manifest.source
    if($LASTEXITCODE -ne 0){throw 'Installed ASAR version/source mismatch'}
}
try {
    $env:ORCA_BACKGROUND_LAUNCH='1'
    Set-ProbePhase 'PROCESS_QUERY_POLICY'
    & node .github/scripts/check-nsis-process-query-abort.mjs
    if($LASTEXITCODE -ne 0){throw 'NSIS unsafe process-query continuation policy failed'}
    Set-ProbePhase 'NORMAL_INSTALL'
    Install-Probe
    Set-ProbePhase 'VERIFY_NORMAL_INSTALL'
    Assert-ProbeFiles
    $evidence.rounds+=@{kind='NORMAL_INSTALL';result='PASS'}
    Stop-ProbeApp
    $asar=Join-Path $install 'resources/app.asar'
    $pak=Join-Path $install 'resources.pak'
    $cli=Join-Path $install 'resources/bin/orca.exe'
    @{missing=$asar;zeroByte=@($pak,$cli);target=$install}|ConvertTo-Json|Write-Output
    Remove-Item -LiteralPath $asar -WhatIf
    Remove-Item -LiteralPath $asar
    [IO.File]::WriteAllBytes($pak,[byte[]]@())
    [IO.File]::WriteAllBytes($cli,[byte[]]@())
    Set-ProbePhase 'REPAIR_INSTALL'
    Install-Probe
    Set-ProbePhase 'VERIFY_REPAIR'
    Assert-ProbeFiles
    $evidence.rounds+=@{kind='REPAIR_MISSING_ASAR_ZERO_PAK_CLI';result='PASS'}
    Stop-ProbeApp
    Set-ProbePhase 'WINDOW_SERVER_READINESS'
    $busy=@(Get-NetTCPConnection -LocalPort 6768,9335 -State Listen -ErrorAction SilentlyContinue)
    if($busy.Count){throw 'Disposable readiness ports are already occupied'}
    $probeProfile=Join-Path $root 'isolated-profile'
    $isolatedHome=Join-Path $probeProfile 'home'
    $roaming=Join-Path $isolatedHome 'AppData/Roaming'
    $probeLocalAppData=Join-Path $isolatedHome 'AppData/Local'
    foreach($directory in @($roaming,$probeLocalAppData)){[IO.Directory]::CreateDirectory($directory)|Out-Null}
    $childEnvironment=@{HOME=$isolatedHome;USERPROFILE=$isolatedHome;APPDATA=$roaming;LOCALAPPDATA=$probeLocalAppData;
        ORCA_E2E_HOME_DIR=$isolatedHome;ORCA_E2E_USER_DATA_DIR=$probeProfile;ORCA_E2E_RUNTIME_WS_PORT='6768';ORCA_BACKGROUND_LAUNCH='1';ELECTRON_RUN_AS_NODE=$null}
    $app=Start-Process -FilePath (Join-Path $install 'Orca.exe') -ArgumentList '--remote-debugging-port=9335' -Environment $childEnvironment -WindowStyle Hidden -PassThru
    $deadline=[DateTime]::UtcNow.AddSeconds(90)
    $ready=$false
    while([DateTime]::UtcNow -lt $deadline){
        $app.Refresh()
        if($app.HasExited){throw 'Disposable installed app exited before readiness'}
        $ports=@(Get-NetTCPConnection -LocalPort 6768,9335 -State Listen -ErrorAction SilentlyContinue|
            Where-Object OwningProcess -eq $app.Id|Select-Object -ExpandProperty LocalPort -Unique)
        if($app.Responding -and $ports -contains 6768 -and $ports -contains 9335){$ready=$true;break}
        Start-Sleep -Milliseconds 250
    }
    if(-not $ready){throw 'Installed app did not own both readiness listeners before its deadline'}
    $evidence.sameMainProcess6768='PASS'
    & node .github/scripts/check-installed-window.mjs
    if($LASTEXITCODE -ne 0){throw 'Installed renderer did not respond over CDP'}
    $evidence.installedWindowResponse='PASS_HIDDEN_RENDERER_CDP'
    Set-ProbePhase 'STOP_READINESS_APP'
    Stop-ProbeApp
    Set-ProbePhase 'NATIVE_PTY_SMOKE'
    & node tests/tools/windows-pty-native-capability-smoke/run.mjs ('--exe='+(Join-Path $install 'Orca.exe'))
    if($LASTEXITCODE -ne 0){throw 'Installed Windows native PTY capability smoke failed'}
    $evidence.installedNativePty='PASS'
    Set-ProbePhase 'CLI_SMOKE'
    & node config/scripts/desktop-distribution/runtime-verification/smoke-packaged-cli.mjs ('--app-dir='+$install)
    if($LASTEXITCODE -ne 0){throw 'Installed package CLI smoke failed'}
    Set-ProbePhase 'PROTOCOL55_FALLBACK'
    & node .github/scripts/check-installed-protocol55-fallback.mjs $install $root
    if($LASTEXITCODE -ne 0){throw 'Disposable protocol55 program fallback failed'}
    $evidence.protocolRollback='PASS_SYNTHETIC_PROTOCOL55_FALLBACK_ONLY'
    Set-ProbePhase 'LEGACY36_UPGRADE'
    & node .github/scripts/check-installed-protocol55-fallback.mjs $install $root --legacy36-upgrade
    if($LASTEXITCODE -ne 0){throw 'Disposable legacy36 to candidate55 qualification failed'}
    $evidence.protocol36Upgrade='PASS_SYNTHETIC_LEGACY19_REFERENCE_ONLY'
    $completed=$true
} catch {
    $evidence.error=$_.Exception.Message
    $evidence.failedPhase=$evidence.phase
    Set-ProbePhase 'ERROR'
    throw
} finally {
    if(-not $completed -and -not $evidence.failedPhase){$evidence.failedPhase=$evidence.phase}
    Set-ProbePhase 'CLEANUP'
    Stop-ProbeApp
    if($completed){$evidence.result='PASS_INSTALLED_ARTIFACT_ONLY'}
    $evidence|ConvertTo-Json -Depth 8|Set-Content -LiteralPath 'dist/ceo-disposable-installer-proof.json' -Encoding UTF8
}

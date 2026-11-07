import { runProcess } from '@orca/process-host'
import { readFileSync } from 'node:fs'

export async function inspectDisposableDeleteSharing({ env, install, signal }) {
  try {
    const cleanEnv = Object.fromEntries(
      Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')
    )
    const result = await runProcess({
      program: `${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`,
      args: [
        '-NoProfile',
        '-Command',
        readFileSync(new URL('./inspect-disposable-delete-sharing.ps1', import.meta.url), 'utf8')
      ],
      env: { ...cleanEnv, ORCA_PROBE_INSTALL: install },
      signal,
      timeoutMs: 15000,
      maxOutputBytes: 65536
    })
    return result.code === 0
      ? JSON.parse(result.stdout)
      : { sharingObservationFailed: true, code: result.code }
  } catch {
    return { sharingObservationFailed: true }
  }
}

// Diagnostics only: the caller retains the exact installer deadline and every PASS oracle.
export async function runObservedDisposableInstaller(
  spec,
  { install, isolated, phase, checkpoint }
) {
  const observations = []
  const env = Object.fromEntries(
    Object.entries(spec.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')
  )
  env.ORCA_PROBE_INSTALL = install
  env.ORCA_PROBE_ISOLATED = isolated
  env.ORCA_PROBE_INSTALLER = spec.program
  let pending = Promise.resolve()
  let stopped = false
  const observationAbort = new AbortController()
  const sample = (full = false) => {
    pending = pending.then(async () => {
      if (stopped) {
        return
      }
      try {
        const result = await runProcess({
          program: `${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`,
          args: [
            '-NoProfile',
            '-Command',
            `$ErrorActionPreference='Stop'; $root=[IO.Path]::GetFullPath($env:ORCA_PROBE_INSTALL).TrimEnd('\\')+'\\'; $fixture=[IO.Path]::GetFullPath($env:ORCA_PROBE_ISOLATED).TrimEnd('\\')+'\\'; $full=$env:ORCA_PROBE_FULL -eq '1'; $all=@(Get-CimInstance Win32_Process); $owned=@($all | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -eq $env:ORCA_PROBE_INSTALLER -or $_.ExecutablePath.StartsWith($fixture,[StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) }); $ids=@($owned.ProcessId); for($i=0;$i -lt 8;$i++){ $born=@{}; foreach($parent in $owned){$born[$parent.ProcessId]=$parent.CreationDate}; $children=@($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId -and $_.CreationDate -ge $born[$_.ParentProcessId] }); if(!$children.Count){break}; $owned+=$children; $ids=@($owned.ProcessId) }; $rows=@($owned | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; $relative=$null; if($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){$relative=$_.ExecutablePath.Substring($root.Length)}; $modules=@(); try {if($full -and $p -and [Math]::Abs(($p.StartTime.ToUniversalTime()-$_.CreationDate.ToUniversalTime()).TotalSeconds) -lt 1){$modules=@($p.Modules | Where-Object {$_.FileName.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)} | ForEach-Object {$_.FileName.Substring($root.Length)})}} catch {}; [ordered]@{pid=$_.ProcessId;parent=$_.ParentProcessId;image=$_.Name;relativeInstallPath=$relative;cpuSeconds=$p.CPU;responding=$p.Responding;hasMainWindow=($null -ne $p -and $p.MainWindowHandle -ne 0);installModules=$modules} }); $files=@(); if($full){$files=@(Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue)}; [ordered]@{atUtc=[DateTime]::UtcNow.ToString('o');processes=$rows;directorySnapshot=$full;remainingInstallFileCount=$(if($full){$files.Count}else{$null});remainingInstallBytes=$(if($full){($files | Measure-Object Length -Sum).Sum}else{$null});asarExists=$(if($full){Test-Path -LiteralPath ($root+'resources\\app.asar')}else{$null})}|ConvertTo-Json -Depth 5 -Compress`
          ],
          env: { ...env, ORCA_PROBE_FULL: full ? '1' : '0' },
          signal: spec.signal
            ? AbortSignal.any([spec.signal, observationAbort.signal])
            : observationAbort.signal,
          timeoutMs: 15000,
          maxOutputBytes: 65536
        })
        observations.push(
          result.code === 0
            ? JSON.parse(result.stdout)
            : { observationFailed: true, code: result.code, timedOut: result.timedOut }
        )
      } catch {
        observations.push({ observationFailed: true })
      }
      try {
        checkpoint('INSTALLER_PROGRESS_OBSERVATION', { activeInstallerPhase: phase, observations })
      } catch {
        observations.push({ diagnosticCheckpointFailed: true })
      }
    })
  }
  sample(true)
  await pending
  const timers = [15000, 60000, 120000, 165000].map((ms) => setTimeout(() => sample(), ms))
  try {
    const result = await runProcess(spec)
    stopped = true
    observationAbort.abort()
    timers.forEach(clearTimeout)
    await pending
    if (result.code !== 0 || result.timedOut || result.signal) {
      observations.push(await inspectDisposableDeleteSharing({ env, install, signal: spec.signal }))
    }
    checkpoint('INSTALLER_PROCESS_RESULT', {
      activeInstallerPhase: phase,
      installerProcessResult: {
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut
      },
      observations
    })
    return result
  } finally {
    stopped = true
    observationAbort.abort()
    timers.forEach(clearTimeout)
    await pending
  }
}

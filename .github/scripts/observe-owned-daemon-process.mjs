import { runProcess } from '@orca/process-host'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

export async function observeOwnedDaemonProcess({
  terminalPid,
  profile,
  physicalProtocol,
  isolated,
  install
}) {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) {
    throw new Error('SystemRoot is required for the owned process observation')
  }
  const record = readJson(path.join(profile, 'daemon', `daemon-v${physicalProtocol}.pid`))
  if (
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !record.launchNonce ||
    !Number.isSafeInteger(terminalPid) ||
    terminalPid <= 0
  ) {
    throw new Error('Synthetic daemon requires a process identity record')
  }
  const observed = await runProcess({
    program: path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: [
      '-NoProfile',
      '-Command',
      `$p=Get-Process -Id ${record.pid} -ErrorAction Stop; $ids=@(); $cursor=${terminalPid}; for($i=0; $i -lt 16 -and $cursor -gt 0; $i++){ if($ids -contains $cursor){throw 'Synthetic ancestor cycle'}; $ids+=([int]$cursor); if($cursor -eq ${record.pid}){break}; $info=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+$cursor) -ErrorAction Stop; if(!$info){throw 'Synthetic ancestor unavailable'}; $cursor=$info.ParentProcessId }; [ordered]@{pid=$p.Id;executablePath=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();terminalAncestry=$ids}|ConvertTo-Json -Compress`
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')
    ),
    timeoutMs: 30000,
    maxOutputBytes: 16384
  })
  if (observed.code !== 0) {
    throw new Error('Cannot observe the owned synthetic daemon process')
  }
  const processIdentity = JSON.parse(observed.stdout)
  const executable = realpathSync(processIdentity.executablePath)
  const withinFixture = path.relative(isolated, executable)
  const withinInstall = path.relative(install, executable)
  if (
    processIdentity.pid !== record.pid ||
    !processIdentity.startTicks ||
    !processIdentity.terminalAncestry.includes(record.pid) ||
    withinFixture.startsWith('..') ||
    path.isAbsolute(withinFixture) ||
    (!withinInstall.startsWith('..') && !path.isAbsolute(withinInstall))
  ) {
    throw new Error('Daemon executable must be inside the fixture and outside the install')
  }
  return {
    pid: record.pid,
    launchNonce: record.launchNonce,
    startedAtMs: record.startedAtMs,
    executablePath: executable,
    executableSha256: hash(executable),
    processStartTicks: processIdentity.startTicks,
    terminalAncestry: processIdentity.terminalAncestry
  }
}

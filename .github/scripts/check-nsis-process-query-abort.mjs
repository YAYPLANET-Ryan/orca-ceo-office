import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import { expect } from '@stablyai/playwright-test'

if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.platform !== 'win32' ||
  !process.env.RUNNER_TEMP
) {
  throw new Error('NSIS process-query fault probe requires the disposable Windows runner')
}
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const builder = path.dirname(builderRequire.resolve('app-builder-lib/package.json'))
const { getMakeNsisPath } = require(path.join(builder, 'out/toolsets/windows.js'))
const compiler = await getMakeNsisPath()
const temporary = realpathSync(process.env.RUNNER_TEMP)
const root = mkdtempSync(path.join(temporary, 'orca-nsis-query-'))
const hook = realpathSync('config/nsis/orca-process-check.nsh')
const manifest = JSON.parse(readFileSync('dist/ceo-installer-manifest.json', 'utf8'))
const includes = path.join(builder, 'templates/nsis/include')
const systemRoot = process.env.SystemRoot
if (!systemRoot) {
  throw new Error('SystemRoot is required for the healthy process-query control')
}
function literal(value) {
  if (/["$\r\n]/.test(value)) {
    throw new Error('Unsupported NSIS fixture path')
  }
  return `"${value}"`
}
const results = []
async function compileFixture(script) {
  const compiled = await runProcess({
    program: compiler.path,
    args: ['-V2', script],
    env: { ...process.env, ...compiler.env },
    timeoutMs: 60000
  })
  assert.equal(compiled.code, 0, `NSIS fixture did not compile: ${JSON.stringify(compiled)}`)
}
for (const label of [
  'available',
  'unavailable',
  'drive-root',
  'unc-root',
  'relative-root',
  'drive-relative-root'
]) {
  const unavailable = label === 'unavailable'
  const expectedCode = label === 'available' ? 0 : 2
  const installRoot =
    label === 'relative-root'
      ? 'install-relative'
      : label === 'drive-relative-root'
        ? `${path.parse(temporary).root.slice(0, 2)}install-relative`
        : label === 'drive-root'
          ? path.parse(temporary).root
          : label === 'unc-root'
            ? ['', '', '127.0.0.1', 'OrcaScopeFixtureShare'].join(path.win32.sep)
            : path.join(root, 'query-install')
  const script = path.join(root, `${label}.nsi`)
  const executable = path.join(root, `${label}.exe`)
  const marker = path.join(root, `${label}-continued.txt`)
  const powershell = unavailable
    ? path.join(root, 'absent-powershell.exe')
    : path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  assert(!existsSync(marker) && (!unavailable || !existsSync(powershell)))
  writeFileSync(
    script,
    `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile ${literal(executable)}
InstallDir ${literal(path.join(root, 'query-install'))}
!include "LogicLib.nsh"
!addincludedir ${literal(includes)}
Var PowerShellPath
!include ${literal(hook)}
!include "allowOnlyOneInstallerInstance.nsh"
!macroundef _CHECK_APP_RUNNING
!macro _CHECK_APP_RUNNING
  !insertmacro FIND_PROCESS "OrcaScopeFixture.exe" $R0
  FileOpen $1 ${literal(marker)} w
  FileWrite $1 "process-scoped continuation"
  FileClose $1
!macroend
Function .onInit
  StrCpy $INSTDIR ${literal(installRoot)}
  StrCpy $PowerShellPath ${literal(powershell)}
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`
  )
  await compileFixture(script)
  const ran = await runProcess({ program: executable, args: ['/S'], timeoutMs: 90000 })
  assert.equal(ran.code, expectedCode, `Wrong process-query policy: ${label}`)
  assert.equal(existsSync(marker), expectedCode === 0, `Unsafe continuation after query: ${label}`)
  results.push({ label, exitCode: ran.code, continued: existsSync(marker) })
}
const workerScript = path.join(root, 'worker.nsi')
const workerTemplate = path.join(root, 'worker.exe')
writeFileSync(
  workerScript,
  `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile ${literal(workerTemplate)}
Section
  FileOpen $0 "$EXEDIR\\ready" w
  FileWrite $0 "ready"
  FileClose $0
  wait:
    Sleep 1000
    Goto wait
SectionEnd
`
)
await compileFixture(workerScript)
const targetingCases = []
for (const [index, directory] of ['install', "install O'Brien"].entries()) {
  const install = path.join(root, directory)
  const locations = [
    ['target', install, false],
    ['nested', path.join(install, 'helper'), false],
    ['sibling-prefix', `${install}-other`, true],
    ['retained-daemon', path.join(root, `retained-${index}`), true]
  ]
  const workers = []
  try {
    for (const [label, folder, expectedAlive] of locations) {
      mkdirSync(folder, { recursive: true })
      const executable = path.join(folder, 'OrcaScopeFixture.exe')
      copyFileSync(workerTemplate, executable)
      const child = spawnProcess({ program: executable, args: ['/S'] })
      const worker = { label, folder, expectedAlive, child, exited: false }
      child.once('exit', () => {
        worker.exited = true
      })
      workers.push(worker)
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      await expect.poll(() => existsSync(path.join(folder, 'ready')), { timeout: 15000 }).toBe(true)
      assert.equal(worker.exited, false, 'Synthetic worker exited before process control')
    }
    const script = path.join(root, `targeting-${index}.nsi`)
    const executable = path.join(install, `targeting-${index}.exe`)
    writeFileSync(
      script,
      `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile ${literal(executable)}
InstallDir ${literal(install)}
!include "LogicLib.nsh"
!addincludedir ${literal(includes)}
Var PowerShellPath
!include ${literal(hook)}
!include "allowOnlyOneInstallerInstance.nsh"
!macroundef _CHECK_APP_RUNNING
!macro _CHECK_APP_RUNNING
  !insertmacro FIND_PROCESS "OrcaScopeFixture.exe" $R0
  \${if} $R0 != 0
    SetErrorLevel 31
    Quit
  \${endIf}
  !insertmacro KILL_PROCESS "OrcaScopeFixture.exe" ${index}
!macroend
Function .onInit
  StrCpy $PowerShellPath ${literal(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'))}
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`
    )
    await compileFixture(script)
    const controlled = await runProcess({ program: executable, args: ['/S'], timeoutMs: 120000 })
    assert.equal(controlled.code, 0, `Scoped process control failed: ${directory}`)
    for (const worker of workers) {
      if (!worker.expectedAlive) {
        await expect.poll(() => worker.exited, { timeout: 10000 }).toBe(true)
      }
      assert.equal(!worker.exited, worker.expectedAlive, worker.label)
      targetingCases.push({
        case: directory,
        label: worker.label,
        alive: !worker.exited
      })
    }
  } finally {
    for (const worker of workers) {
      if (!worker.exited) {
        worker.child.kill()
      }
    }
  }
}
writeFileSync(
  'dist/ceo-nsis-process-query-proof.json',
  `${JSON.stringify(
    {
      result: 'PASS_DISPOSABLE_PROCESS_QUERY_POLICY',
      source: manifest.source,
      scope: 'Guard branch and real FIND/KILL against owned synthetic workers only',
      results,
      targetingResult: 'PASS_OWNED_PROCESS_TARGET_MATRIX',
      targetingCases
    },
    null,
    2
  )}\n`
)

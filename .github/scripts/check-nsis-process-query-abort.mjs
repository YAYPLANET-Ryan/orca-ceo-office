import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { runProcess } from '@orca/process-host'

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
for (const unavailable of [false, true]) {
  const label = unavailable ? 'unavailable' : 'available'
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
!include "LogicLib.nsh"
!addincludedir ${literal(includes)}
Var PowerShellPath
!macro _CHECK_APP_RUNNING
  FileOpen $1 ${literal(marker)} w
  FileWrite $1 "process-scoped continuation"
  FileClose $1
!macroend
!include ${literal(hook)}
Function .onInit
  StrCpy $PowerShellPath ${literal(powershell)}
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`
  )
  const compiled = await runProcess({
    program: compiler.path,
    args: ['-V2', script],
    env: { ...process.env, ...compiler.env },
    timeoutMs: 60000
  })
  assert.equal(
    compiled.code,
    0,
    `NSIS fault fixture did not compile: ${label} ${JSON.stringify(compiled)}`
  )
  const ran = await runProcess({ program: executable, args: ['/S'], timeoutMs: 90000 })
  assert.equal(ran.code, unavailable ? 2 : 0, `Wrong process-query policy: ${label}`)
  assert.equal(existsSync(marker), !unavailable, `Unsafe continuation after query: ${label}`)
  results.push({ label, exitCode: ran.code, continued: existsSync(marker) })
}
writeFileSync(
  'dist/ceo-nsis-process-query-proof.json',
  `${JSON.stringify(
    {
      result: 'PASS_DISPOSABLE_PROCESS_QUERY_POLICY',
      source: manifest.source,
      scope: 'Real NSIS guard; downstream discovery replaced by marker, no process termination',
      results
    },
    null,
    2
  )}\n`
)

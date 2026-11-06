import { _electron as electron, expect } from '@stablyai/playwright-test'
import { runProcess } from '@orca/process-host'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const evidence = {
  result: 'FAIL',
  actualConversationLaptopReboot: 'NOT_TESTED',
  securityClearance: 'NOT_ESTABLISHED',
  daemonExecutablePath: 'NOT_OBSERVED_IDENTITY_AND_INPUT_ORACLES_REQUIRED'
}
try {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.platform !== 'win32' ||
    !process.env.RUNNER_TEMP
  ) {
    throw new Error('Protocol fallback probe requires the disposable GitHub Windows runner')
  }
  const [installArg, probeRootArg] = process.argv.slice(2)
  const temporary = realpathSync(process.env.RUNNER_TEMP)
  const install = realpathSync(installArg)
  const probeRoot = realpathSync(probeRootArg)
  for (const target of [install, probeRoot]) {
    const relative = path.relative(temporary, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Protocol fallback target is outside runner temporary storage')
    }
  }
  // NSIS consumes the final /D argument verbatim; this fixture uses the runner's unquoted path.
  if (/\s|"/.test(install)) {
    throw new Error('Disposable fallback requires an unambiguous NSIS install path')
  }
  const require = createRequire(import.meta.url)
  const asar = require('@electron/asar')
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const candidate = readJson('dist/ceo-installer-manifest.json')
  const fallbackDirectory = path.resolve('dist/protocol55-fallback')
  const fallback = readJson(path.join(fallbackDirectory, 'ceo-installer-manifest.json'))
  const fallbackInstaller = path.join(fallbackDirectory, 'orca-ceo-setup.exe')
  const fallbackHash = '84ac34455fd4299f8c8176585e3e848e5accc246bc9986a3b49158f01de7b218'
  if (
    fallback.source !== 'e0048b332ac8d54c9612822f54323e4a825f5542' ||
    fallback.version !== '1.4.251-ceo.20261106.36' ||
    fallback.installer.sha256 !== fallbackHash ||
    hash(fallbackInstaller) !== fallbackHash
  ) {
    throw new Error('Fallback must be the pinned, previously verified protocol55 installer')
  }
  function verifyInstalled(manifest) {
    const expected = new Set([
      'Orca.exe',
      'resources/app.asar',
      'resources/bin/orca.exe',
      'resources/bin/orca-agent-hook.exe',
      'resources.pak',
      'icudtl.dat'
    ])
    for (const file of manifest.files) {
      const relative = file.path.replaceAll('\\', '/').replace(/^dist\/win-unpacked\//, '')
      if (!expected.delete(relative)) {
        throw new Error('Unexpected or duplicate essential file')
      }
      const target = path.join(install, relative)
      if (statSync(target).size !== file.size || file.size <= 0 || hash(target) !== file.sha256) {
        throw new Error('Installed file differs from its pinned manifest')
      }
    }
    if (expected.size) {
      throw new Error('Essential manifest is incomplete')
    }
    const metadata = JSON.parse(
      asar.extractFile(path.join(install, 'resources/app.asar'), 'package.json')
    )
    if (metadata.version !== manifest.version || metadata.orcaRecoverySource !== manifest.source) {
      throw new Error('Installed fallback source/version does not match its manifest')
    }
  }
  verifyInstalled(candidate)
  const isolated = path.join(probeRoot, 'protocol55')
  if (existsSync(isolated)) {
    throw new Error('Fresh synthetic protocol fixture required')
  }
  const home = path.join(isolated, 'home')
  const profile = path.join(isolated, 'profile')
  const workspace = path.join(isolated, 'commands')
  for (const directory of [home, profile, workspace]) {
    mkdirSync(directory, { recursive: true })
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(isolated, 'appdata'),
    LOCALAPPDATA: path.join(isolated, 'localappdata'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    ORCA_E2E_HOME_DIR: home,
    ORCA_E2E_USER_DATA_DIR: profile,
    ORCA_E2E_RUNTIME_WS_PORT: '6768',
    ORCA_BACKGROUND_LAUNCH: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(evidence, {
    candidateSource: candidate.source,
    candidateVersion: candidate.version,
    fallbackSource: fallback.source,
    fallbackVersion: fallback.version,
    fallbackInstallerSha256: fallbackHash
  })
  let app = null
  async function launch() {
    app = await electron.launch({
      executablePath: path.join(install, 'Orca.exe'),
      env,
      timeout: 120000
    })
    const page = await app.firstWindow({ timeout: 120000 })
    await page.waitForFunction(
      () => Boolean(window.api) && Boolean(document.getElementById('root')?.firstElementChild),
      undefined,
      { timeout: 30000 }
    )
    await page.evaluate(() => window.api.app.awaitFirstWindowStartupServices())
    return page
  }
  async function closeGracefully() {
    const closing = app
    await closing.close()
    await expect.poll(() => closing.process().exitCode, { timeout: 10000 }).toBe(0)
    app = null
  }
  async function backend(page) {
    const result = await page.evaluate(() => window.api.pty.management.listSessions())
    if (result.degraded) {
      throw new Error('A local PTY fallback cannot prove daemon continuity')
    }
    return result.sessions
  }
  async function identity(page, id) {
    const sessions = await page.evaluate(() =>
      window.api.pty.listSessions({ connectionId: null, includeUnrouted: true })
    )
    const row = sessions.find((session) => session.id === id)
    if (!row?.incarnationId) {
      throw new Error('PTY incarnation is missing')
    }
    const physical = await backend(page)
    if (
      physical.length !== 1 ||
      !physical[0].isAlive ||
      physical[0].protocolVersion !== 55 ||
      !physical[0].pid
    ) {
      throw new Error('Expected exactly one live synthetic protocol55 session')
    }
    if (physical[0].sessionId !== id || physical[0].incarnationId !== row.incarnationId) {
      throw new Error('Frontend and daemon PTY identities do not agree')
    }
    return {
      ptyId: id,
      incarnationId: row.incarnationId,
      pid: physical[0].pid,
      sessionId: physical[0].sessionId,
      protocolVersion: physical[0].protocolVersion
    }
  }
  async function marker(page, id, phase) {
    const text = `ORCA_PROTOCOL55_${phase}`
    const filename = `orca-protocol55-${phase.toLowerCase()}.txt`
    const accepted = await page.evaluate(
      ({ id, text, filename }) =>
        window.api.pty.writeAccepted(id, `echo ${text}>${filename}\r`, 'driving', {
          requireWriteSettlement: true
        }),
      { id, text, filename }
    )
    if (!accepted) {
      throw new Error('Synthetic terminal input was refused')
    }
    await expect
      .poll(
        () => {
          const file = path.join(workspace, filename)
          return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
        },
        { timeout: 30000 }
      )
      .toBe(text)
  }
  try {
    const first = await launch()
    if ((await backend(first)).length) {
      throw new Error('Synthetic fixture unexpectedly owns prior terminals')
    }
    const created = await first.evaluate(
      (cwd) =>
        window.api.pty.spawn({
          cols: 80,
          rows: 24,
          cwd,
          shellOverride: 'cmd.exe',
          spawnIntent: 'interactive'
        }),
      workspace
    )
    const before = await identity(first, created.id)
    await marker(first, created.id, 'BEFORE')
    await closeGracefully()
    const installed = await runProcess({
      program: fallbackInstaller,
      args: ['/S', `/D=${install}`],
      env,
      timeoutMs: 180000
    })
    if (installed.code !== 0) {
      throw new Error(`Pinned fallback NSIS exited ${installed.code}`)
    }
    verifyInstalled(fallback)
    const second = await launch()
    const attached = await second.evaluate(
      ({ id, cwd }) =>
        window.api.pty.spawn({
          cols: 80,
          rows: 24,
          cwd,
          sessionId: id,
          attachOnlyView: true,
          spawnIntent: 'user-resume'
        }),
      { id: before.ptyId, cwd: workspace }
    )
    if (attached.id !== before.ptyId || attached.isReattach !== true) {
      throw new Error('Fallback did not reattach the original PTY')
    }
    const after = await identity(second, attached.id)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Fallback changed PTY, incarnation, process or protocol identity')
    }
    await marker(second, attached.id, 'AFTER')
    evidence.before = before
    evidence.after = after
    evidence.fallbackInstallerExitCode = installed.code
    evidence.result = 'PASS_SYNTHETIC_PROTOCOL55_PROGRAM_FALLBACK'
    await second.evaluate(
      (sessionId) => window.api.pty.management.killOne({ sessionId }),
      before.sessionId
    )
    await closeGracefully()
  } catch (error) {
    evidence.result = 'FAIL'
    evidence.error = error.message
    throw error
  } finally {
    try {
      if (app) {
        await app.close()
      }
    } catch (error) {
      evidence.result = 'FAIL_CLEANUP'
      evidence.cleanupError = error.message
      process.exitCode = 1
    } finally {
      writeFileSync(
        'dist/ceo-protocol55-fallback-proof.json',
        `${JSON.stringify(evidence, null, 2)}\n`
      )
    }
  }
} catch (error) {
  evidence.result = 'FAIL'
  evidence.error = error.message
  writeFileSync('dist/ceo-protocol55-fallback-proof.json', `${JSON.stringify(evidence, null, 2)}\n`)
  throw error
}

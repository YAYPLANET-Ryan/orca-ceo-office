import { verifyInstalledArtifact } from './verify-installed-artifact.mjs'
import { observeOwnedDaemonProcess } from './observe-owned-daemon-process.mjs'
import {
  runObservedDisposableInstaller,
  inspectDisposableDeleteSharing
} from './observe-disposable-installer.mjs'
import { _electron as electron, expect } from '@stablyai/playwright-test'
import { runProcess } from '@orca/process-host'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const legacyUpgrade = process.argv[4] === '--legacy36-upgrade'
const proofFile = legacyUpgrade
  ? 'dist/ceo-protocol36-upgrade-proof.json'
  : 'dist/ceo-protocol55-fallback-proof.json'
const successResult = legacyUpgrade
  ? 'PASS_SYNTHETIC_LEGACY36_ADOPTION_IN_CANDIDATE55'
  : 'PASS_SYNTHETIC_PROTOCOL55_PROGRAM_FALLBACK'
const evidence = {
  result: 'FAIL',
  actualConversationLaptopReboot: 'NOT_TESTED',
  securityClearance: 'NOT_ESTABLISHED',
  daemonExecutablePath: 'NOT_OBSERVED_IDENTITY_AND_INPUT_ORACLES_REQUIRED'
}
let deadline
const deadlineAbort = new AbortController()
function checkpoint(phase, facts = {}) {
  Object.assign(evidence, facts, { phase })
  writeFileSync(proofFile, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`[${legacyUpgrade ? 'protocol36-upgrade' : 'protocol55-fallback'}] ${phase}`)
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
  let install = realpathSync(installArg)
  const probeRoot = realpathSync(probeRootArg)
  for (const target of [install, probeRoot]) {
    const relative = path.relative(temporary, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Protocol fallback target is outside runner temporary storage')
    }
  }
  if (legacyUpgrade) {
    const dedicatedInstall = path.join(probeRoot, 'l36')
    if (existsSync(dedicatedInstall)) {
      throw new Error('Legacy qualification requires a fresh install directory')
    }
    mkdirSync(dedicatedInstall)
    install = realpathSync(dedicatedInstall)
    // Pinned7039 archive: longest relative file path179 chars (inner SHA7ccf06da).
    // Legacy NSIS must not be tested through an accidental MAX_PATH overflow.
    const maxAbsolutePathChars = install.length + 1 + 179
    if (maxAbsolutePathChars >= 260) {
      throw new Error('Pinned legacy reference exceeds the Windows path budget')
    }
    evidence.legacyInstallPathBudget = { maxRelativePathChars: 179, maxAbsolutePathChars }
  }
  // NSIS consumes the final /D argument verbatim; this fixture uses the runner's unquoted path.
  if (/\s|"/.test(install)) {
    throw new Error('Disposable fallback requires an unambiguous NSIS install path')
  }
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const candidate = readJson('dist/ceo-installer-manifest.json')
  const fallbackDirectory = path.resolve(
    legacyUpgrade ? 'dist/protocol36-reference' : 'dist/protocol55-fallback'
  )
  const fallback = readJson(
    legacyUpgrade
      ? '.github/fixtures/protocol36-reference.json'
      : path.join(fallbackDirectory, 'ceo-installer-manifest.json')
  )
  const fallbackInstaller = path.join(
    fallbackDirectory,
    legacyUpgrade ? 'orca-windows-setup.exe' : 'orca-ceo-setup.exe'
  )
  const fallbackHash = legacyUpgrade
    ? '7039105aee15d81eb6414b3e3b2d7a7a61f0539254fc902dac81d8fa0d6f60f2'
    : '84ac34455fd4299f8c8176585e3e848e5accc246bc9986a3b49158f01de7b218'
  if (
    fallback.source !==
      (legacyUpgrade
        ? '7896bd2618f62215ab0852f6618fb9d4ea8d6ede'
        : 'e0048b332ac8d54c9612822f54323e4a825f5542') ||
    fallback.version !== (legacyUpgrade ? '1.4.191-ceo.20261105.19' : '1.4.251-ceo.20261106.36') ||
    fallback.installer.sha256 !== fallbackHash ||
    hash(fallbackInstaller) !== fallbackHash
  ) {
    throw new Error('Reference must match its pinned installer bytes, source and version')
  }
  const physicalProtocol = legacyUpgrade ? 36 : 55
  const replacementManifest = legacyUpgrade ? candidate : fallback
  const replacementInstaller = legacyUpgrade
    ? path.resolve(candidate.installer.path)
    : fallbackInstaller
  if (hash(replacementInstaller) !== replacementManifest.installer.sha256) {
    throw new Error('Replacement installer hash differs from the verified build')
  }
  function verifyInstalled(manifest) {
    verifyInstalledArtifact({
      install,
      manifest,
      legacyReference: legacyUpgrade && manifest === fallback,
      onMismatch: (facts) =>
        checkpoint('INSTALLED_CONTENT_MISMATCH', { installedContentMismatch: facts })
    })
  }

  if (!legacyUpgrade) {
    verifyInstalled(candidate)
  }
  const isolated = path.join(probeRoot, legacyUpgrade ? 'protocol36-upgrade' : 'protocol55')
  if (existsSync(isolated)) {
    throw new Error('Fresh synthetic protocol fixture required')
  }
  const home = path.join(isolated, 'home')
  const profile = path.join(isolated, 'profile')
  const workspace = path.join(isolated, 'commands')
  for (const directory of [home, profile, workspace]) {
    mkdirSync(directory, { recursive: true })
  }
  const profileSeed = path.join(profile, 'orca-data.json')
  writeFileSync(
    profileSeed,
    JSON.stringify({
      repos: [],
      folderWorkspaces: [],
      settings: {
        telemetry: {
          optedIn: false,
          installId: '00000000-0000-4000-8000-000000000000',
          existedBeforeTelemetryRelease: false
        }
      },
      onboarding: { flowVersion: 4, closedAt: 1, outcome: 'completed', lastCompletedStep: 5 },
      workspaceSession: { activeRepoId: null, activeWorktreeId: null, activeTabId: null }
    }),
    { flag: 'wx' }
  )
  evidence.syntheticProfile = {
    kind: 'EXISTING_EMPTY_LOCAL_PROFILE',
    seedSha256: hash(profileSeed)
  }
  writeFileSync(
    path.join(workspace, 'protocol55-input-collector.mjs'),
    readFileSync(new URL('./protocol55-input-collector.mjs', import.meta.url))
  )
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
    fallbackInstallerSha256: fallbackHash,
    scenario: legacyUpgrade ? 'LEGACY36_TO_CANDIDATE55' : 'SAME55_PROGRAM_FALLBACK',
    physicalProtocolExpected: physicalProtocol,
    startingVersion: legacyUpgrade ? fallback.version : candidate.version,
    replacementVersion: replacementManifest.version,
    exactProductionF7ImageTested: false
  })
  let app = null
  let diagnosticPage = null
  let diagnosticPtyId = null
  async function launch() {
    const phase = evidence.phase
    app = await electron.launch({
      executablePath: path.join(install, 'Orca.exe'),
      env,
      timeout: 120000
    })
    checkpoint(`${phase}_WAIT_WINDOW`, { guiPid: app.process().pid })
    const page = await app.firstWindow({ timeout: 120000 })
    diagnosticPage = page
    checkpoint(`${phase}_WAIT_BRIDGE`)
    await page.waitForFunction(
      () => Boolean(window.api) && Boolean(document.getElementById('root')?.firstElementChild),
      undefined,
      { timeout: 30000 }
    )
    checkpoint(`${phase}_WAIT_STARTUP_SERVICES`)
    await page.evaluate(() => window.api.app.awaitFirstWindowStartupServices())
    const repos = await page.evaluate(() => window.api.repos.list())
    if (!Array.isArray(repos) || repos.length !== 0) {
      throw new Error(
        'Synthetic empty-profile seed was not honored; automatic HOME startup is outside this fixture'
      )
    }
    checkpoint(`${phase}_EMPTY_PROFILE_CONFIRMED`, { syntheticRepoCount: repos.length })
    return page
  }
  async function closeGracefully() {
    const closing = app
    const child = closing.process()
    const release = { guiPid: child.pid, status: 'REQUESTED_NOT_AWAITED' }
    evidence.controllerReleases ??= []
    evidence.controllerReleases.push(release)
    void closing.close().then(
      () => {
        release.status = 'COMPLETED'
      },
      (error) => {
        release.status = 'REJECTED'
        release.warning = error.message
      }
    )
    await expect.poll(() => child.exitCode, { timeout: 30000 }).toBe(0)
    checkpoint('GUI_EXIT_ZERO', { guiExitCode: child.exitCode })
    // Detached hosts can retain controller pipes after the GUI has exited normally.
    for (const stream of child.stdio) {
      stream?.destroy()
    }
    app = null
  }
  async function backend(page) {
    const result = await page.evaluate(() => window.api.pty.management.listSessions())
    if (result.degraded) {
      throw new Error('A local PTY fallback cannot prove daemon continuity')
    }
    return result.sessions
  }
  async function identity(page, id, spawnIncarnation, legacyListedShape = false) {
    const sessions = await page.evaluate(() => window.api.pty.listSessions({ connectionId: null }))
    const row = sessions.find((session) => session.id === id)
    if (!row || typeof spawnIncarnation !== 'string' || !spawnIncarnation) {
      throw new Error('PTY spawn-reply incarnation or frontend row is missing')
    }
    if (!legacyListedShape && !row.incarnationId) {
      throw new Error('Current frontend listed incarnation is missing')
    }
    let physical = []
    let duplicateObserved = false
    await expect
      .poll(
        async () => {
          physical = await backend(page)
          checkpoint('OBSERVE_PHYSICAL_SESSION', {
            physicalInventory: physical.map(
              ({ sessionId, incarnationId, pid, protocolVersion, isAlive, state }) => ({
                sessionId,
                incarnationId,
                pid,
                protocolVersion,
                isAlive,
                state
              })
            )
          })
          if (physical.length > 1) {
            duplicateObserved = true
            evidence.firstDuplicateInventory ??= evidence.physicalInventory
          }
          evidence.duplicateObserved = duplicateObserved
          return (
            !duplicateObserved &&
            physical.length === 1 &&
            physical[0].isAlive &&
            physical[0].protocolVersion === physicalProtocol &&
            Boolean(physical[0].pid)
          )
        },
        { timeout: 20000 }
      )
      .toBe(true)
    if (
      physical[0].sessionId !== id ||
      !physical[0].incarnationId ||
      physical[0].incarnationId !== spawnIncarnation ||
      (row.incarnationId && physical[0].incarnationId !== row.incarnationId)
    ) {
      throw new Error('Frontend and daemon PTY identities do not agree')
    }
    evidence.identityObservations ??= []
    evidence.identityObservations.push({
      legacyListedShape,
      listedIncarnation: row.incarnationId ?? null,
      spawnIncarnation,
      physicalIncarnation: physical[0].incarnationId
    })
    return {
      ptyId: id,
      incarnationId: physical[0].incarnationId,
      pid: physical[0].pid,
      sessionId: physical[0].sessionId,
      protocolVersion: physical[0].protocolVersion
    }
  }
  async function marker(page, id, phase) {
    const text = `ORCA_PROTOCOL55_${phase}`
    const filename = `orca-protocol55-${phase.toLowerCase()}.txt`
    if (existsSync(path.join(workspace, filename))) {
      throw new Error('Synthetic input marker existed before the write being tested')
    }
    const accepted = await page.evaluate(
      ({ id, text }) =>
        window.api.pty.writeAccepted(id, `${text}\r`, 'driving', {
          requireWriteSettlement: true
        }),
      { id, text }
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
    deadline = setTimeout(
      () => {
        evidence.result = 'FAIL_TIMEOUT'
        checkpoint('DEADLINE_EXCEEDED', { interruptedPhase: evidence.phase })
        process.exitCode = 1
        deadlineAbort.abort()
        setTimeout(() => process.exit(1), 15000).unref()
      },
      (legacyUpgrade ? 11 : 8) * 60 * 1000
    )
    deadline.unref()
    if (legacyUpgrade) {
      checkpoint('INSTALL_LEGACY36_REFERENCE')
      const initial = await runProcess({
        program: fallbackInstaller,
        args: ['/S', `/D=${install}`],
        env,
        timeoutMs: 180000,
        signal: deadlineAbort.signal
      })
      if (initial.code !== 0 || initial.timedOut || initial.signal) {
        throw new Error(
          `Legacy reference installer exited ${initial.code}, timedOut=${initial.timedOut}`
        )
      }
      verifyInstalled(fallback)
    }
    checkpoint(legacyUpgrade ? 'LAUNCH_LEGACY36_REFERENCE' : 'LAUNCH_CANDIDATE')
    const first = await launch()
    if ((await backend(first)).length) {
      throw new Error('Synthetic fixture unexpectedly owns prior terminals')
    }
    checkpoint('CREATE_SYNTHETIC_TERMINAL')
    const collectorPath = path.join(workspace, 'protocol55-input-collector.mjs')
    if ([process.execPath, collectorPath].some((value) => /[^a-zA-Z0-9_:\\/.-]/.test(value))) {
      throw new Error(
        'The hosted Node fixture requires a space-free path without shell metacharacters'
      )
    }
    const created = await first.evaluate(
      ({ cwd, command }) =>
        window.api.pty.spawn({
          cols: 80,
          rows: 24,
          cwd,
          shellOverride: 'cmd.exe',
          command,
          commandDelivery: 'provider',
          spawnIntent: 'interactive'
        }),
      { cwd: workspace, command: `${process.execPath} ${collectorPath}` }
    )
    diagnosticPtyId = created.id
    const before = await identity(first, created.id, created.incarnationId, legacyUpgrade)
    const daemonBefore = await observeOwnedDaemonProcess({
      terminalPid: before.pid,
      profile,
      physicalProtocol,
      isolated,
      install
    })
    const observed = (await backend(first))[0]
    checkpoint('WAIT_INPUT_COLLECTOR', {
      before,
      daemonBefore,
      daemonExecutablePath: daemonBefore.executablePath,
      initialShell: {
        cwd: observed.cwd,
        shellState: observed.shellState,
        foregroundProcess: observed.foregroundProcess ?? null
      }
    })
    const readyFile = path.join(workspace, 'orca-protocol55-ready.json')
    await expect
      .poll(
        () => {
          try {
            return Boolean(readJson(readyFile).instanceId)
          } catch {
            return false
          }
        },
        { timeout: 30000 }
      )
      .toBe(true)
    const workerBefore = readJson(readyFile)
    if (!Number.isInteger(workerBefore.pid) || workerBefore.pid <= 0 || !workerBefore.instanceId) {
      throw new Error('Synthetic input collector identity is missing')
    }
    evidence.inputCollectorBefore = workerBefore
    process.kill(workerBefore.pid, 0)
    checkpoint('WRITE_BEFORE', { before })
    await marker(first, created.id, 'BEFORE')
    checkpoint('QUIT_CANDIDATE')
    await closeGracefully()
    checkpoint(legacyUpgrade ? 'INSTALL_CANDIDATE_OVER_LEGACY36' : 'INSTALL_PINNED_FALLBACK')
    const installed = await runObservedDisposableInstaller(
      {
        program: replacementInstaller,
        args: ['/S', `/D=${install}`],
        env,
        timeoutMs: 180000,
        signal: deadlineAbort.signal
      },
      {
        install,
        isolated,
        phase: legacyUpgrade ? 'LEGACY36_REPLACEMENT' : 'SAME55_FALLBACK',
        checkpoint
      }
    )
    if (installed.code !== 0 || installed.timedOut || installed.signal) {
      throw new Error(`Replacement NSIS exited ${installed.code}, timedOut=${installed.timedOut}`)
    }
    verifyInstalled(replacementManifest)
    checkpoint(legacyUpgrade ? 'LAUNCH_CANDIDATE_AFTER_LEGACY36' : 'LAUNCH_FALLBACK', {
      replacementInstallerExitCode: installed.code
    })
    const second = await launch()
    checkpoint('REATTACH_ORIGINAL_TERMINAL')
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
    const after = await identity(second, attached.id, attached.incarnationId)
    const daemonAfter = await observeOwnedDaemonProcess({
      terminalPid: after.pid,
      profile,
      physicalProtocol,
      isolated,
      install
    })
    checkpoint('VERIFY_IDENTITIES', { after, daemonAfter })
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Fallback changed PTY, incarnation, process or protocol identity')
    }
    if (JSON.stringify(daemonBefore) !== JSON.stringify(daemonAfter)) {
      throw new Error('Fallback changed daemon process, executable bytes or launch identity')
    }
    checkpoint('WRITE_AFTER')
    await marker(second, attached.id, 'AFTER')
    evidence.inputCollectorAfter = readJson(readyFile)
    if (JSON.stringify(workerBefore) !== JSON.stringify(evidence.inputCollectorAfter)) {
      throw new Error('Fallback restarted the synthetic input collector')
    }
    process.kill(workerBefore.pid, 0)
    evidence.before = before
    evidence.after = after
    if (legacyUpgrade) {
      evidence.upgradeInstallerExitCode = installed.code
    } else {
      evidence.fallbackInstallerExitCode = installed.code
    }
    evidence.result = successResult
    checkpoint('CLEANUP_SYNTHETIC_TERMINAL')
    const cleanup = await second.evaluate(
      (sessionId) => window.api.pty.management.killOne({ sessionId }),
      before.sessionId
    )
    if (!cleanup.success) {
      throw new Error('Synthetic terminal cleanup was refused')
    }
    await closeGracefully()
  } catch (error) {
    evidence.result = 'FAIL'
    checkpoint('ERROR', { failedPhase: evidence.phase, error: error.message })
    if (evidence.installedContentMismatch) {
      evidence.postFailureDeleteSharing = await inspectDisposableDeleteSharing({
        env,
        install,
        signal: deadlineAbort.signal
      })
    }
    console.error(error.message)
    let diagnosticTimeout
    try {
      const collectorError = path.join(workspace, 'orca-protocol55-input-error.json')
      if (existsSync(collectorError)) {
        evidence.collectorFailure = readJson(collectorError)
      }
      if (diagnosticPage && diagnosticPtyId) {
        const snapshot = await Promise.race([
          diagnosticPage.evaluate(
            (id) => window.api.pty.getMainBufferSnapshot(id, { scrollbackRows: 20 }),
            diagnosticPtyId
          ),
          new Promise((resolve) => {
            diagnosticTimeout = setTimeout(() => resolve(null), 2000)
            diagnosticTimeout.unref()
          })
        ])
        evidence.syntheticTerminalOutput = snapshot?.data?.slice(-4000) ?? 'UNAVAILABLE'
      }
    } catch {
      evidence.syntheticTerminalOutput = 'UNAVAILABLE'
    } finally {
      clearTimeout(diagnosticTimeout)
      checkpoint('ERROR_DIAGNOSTIC')
    }
    throw error
  } finally {
    try {
      if (app) {
        await closeGracefully()
      }
    } catch (error) {
      evidence.result = 'FAIL_CLEANUP'
      evidence.cleanupError = error.message
      process.exitCode = 1
    } finally {
      writeFileSync(proofFile, `${JSON.stringify(evidence, null, 2)}\n`)
    }
  }
} catch (error) {
  evidence.result = 'FAIL'
  evidence.error = error.message
  writeFileSync(proofFile, `${JSON.stringify(evidence, null, 2)}\n`)
  throw error
} finally {
  clearTimeout(deadline)
  if (deadlineAbort.signal.aborted) {
    evidence.result = 'FAIL_TIMEOUT'
    writeFileSync(proofFile, `${JSON.stringify(evidence, null, 2)}\n`)
  }
}
if (evidence.result === successResult && (process.exitCode ?? 0) === 0) {
  // Both GUIs exited normally and the proof is durable; only this controller may remain open.
  process.exit(0)
}

import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../../shared/quit-teardown-deadline'
import { createQuitRuntimeFixture as quitRuntime } from './testing/main-process-quit-runtime-fixture'

const settled = () => vi.fn(async () => {})
const idle = () => vi.fn()
const stopAgentHookServer = idle()
const stopStructuredAgentSessionRuntime = settled()
const beginSshShutdown = settled()
const killAllPty = idle()
const quitEffects = { ptyAttached: true, daemonConnected: true, saved: false }
let pendingObservations = false
const flushProviderObservations = vi.fn(async () => true)
/** Final-save calls seen by the first microtask after the SSH shutdown began. */
let flushesByNextMicrotask = -1

// Every teardown member settles except the profile store, so only the writer can hold quit.
const dependencies: Record<string, Record<string, unknown>> = {
  '../ipc/filesystem/watchers/filesystem-watcher-shutdown': { closeAllWatchers: settled() },
  '../ipc/worktrees/creation/worktree-base-directory-watcher': {
    disposeWorktreeBaseDirectoryWatchers: settled()
  },
  '../ipc/folder-repo-git-upgrade': { stopFolderRepoGitUpgradeWatch: idle() },
  '../ipc/pty/kill-all': { killAllPty },
  '../daemon/providers/lifecycle/daemon-provider-state': {
    disconnectDaemon: vi.fn(async () => {
      quitEffects.daemonConnected = false
    }),
    shutdownDaemon: settled()
  },
  '../ipc/ssh/ssh-shutdown-drain': { beginSshShutdown },
  './main-process-connector-startup': { desktopConnectorCloud: () => null },
  '../agent-hooks/server/agent-hook-server': {
    agentHookServer: {
      stop: stopAgentHookServer,
      flushProviderObservations,
      get hasPendingProviderObservations() {
        return pendingObservations
      }
    }
  },
  '../agent-hooks/wsl-relay/wsl-hook-relay-manager': { wslHookRelayManager: { disposeAll: idle() } },
  '../agent-hooks/installation/managed-agent-hook-controls': {
    removeManagedAgentHooksAsync: vi.fn(async () => [])
  },
  '../runtime/agent-session/structured-agent-session-runtime': {
    stopStructuredAgentSessionRuntime
  },
  '../runtime/agent-session/structured-agent-session-runtime-teardown': {
    setStructuredAgentSessionTeardownTrigger: idle()
  },
  '../runtime/files/watch/file-watcher-leases': { awaitRuntimeFileWatcherUnsubscribes: settled() },
  '../runtime/rpc/server/runtime-metadata': { clearRuntimeMetadataIfOwned: idle() },
  '../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime': {
    shutdownPairedRuntimeBrowserClientHosts: settled()
  },
  '../ipc/browser/desktop-browser-bridge-wiring': { disposeDesktopBrowserBridge: idle() },
  '../orca-profiles/profile-cloud-session-owner': { flushUnsavedCloudSessions: idle() },
  '../browser/guest-lifecycle/manager/browser-manager': {
    browserManager: { setBrowserGuestStateChangedListener: idle(), setOffscreenTabOpener: idle() }
  },
  '../browser/sessions/profiles/browser-session-registry': { browserSessionRegistry: {} },
  '../browser/routing/local-host-partitions/local-ssh-browser-route': {
    closeAllLocalSshBrowserRoutes: settled()
  },
  '../codex/history/index/codex-state-db-backfill-recovery': {
    stopCodexStateDbBackfillRecoveries: settled()
  },
  '../codex/history/bridges/codex-account-session-bridge': {
    stopCodexAccountSessionBridges: idle()
  },
  '../git/refs/maintenance/local-repo-ref-maintenance': { awaitPackedRefsLockRelease: settled() },
  '../workspaces/removal/worktree-background-removal': { stopBackgroundWorktreeRemovals: idle() },
  '../dock/unread-badge': { setUnreadDockBadgeCount: idle() },
  '../tray/system-tray': { destroySystemTray: idle() },
  '../telemetry/client': { shutdownTelemetry: settled() },
  '../observability/index': { shutdownObservability: settled() },
  '../updater/updater-service': { isQuittingForUpdate: vi.fn(() => false) },
  '../updater/updater-lifecycle-diagnostics': { recordUpdaterLifecycle: idle() },
  '../macos-permissions/macos-tcc-prompt-notice': { stopTccPromptNotice: idle() },
  '../pty/history/terminal-history-gc': { cancelHistoryGc: idle() },
  './window-all-closed-quit-policy': { shouldQuitWhenAllWindowsClosed: vi.fn(() => false) },
  './configure-process': { isDevParentShutdownRequested: vi.fn(() => false) },
  '../persistence/loading-store/user-data-path': {
    getCanonicalUserDataPath: vi.fn(() => '/unused')
  }
}

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('./main-process-state')
  for (const moduleName of Object.keys(dependencies)) {
    vi.doUnmock(moduleName)
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

async function startQuit(
  flushFinalOrThrowAsync: () => Promise<void>,
  services: Record<string, unknown> = {},
  observations?: () => Promise<boolean>
) {
  beginSshShutdown.mockClear()
  killAllPty.mockClear()
  Object.assign(quitEffects, { ptyAttached: true, daemonConnected: true, saved: false })
  killAllPty.mockImplementation(() => {
    quitEffects.ptyAttached = false
  })
  pendingObservations = observations !== undefined
  flushProviderObservations.mockImplementation(observations ?? (async () => true))
  flushesByNextMicrotask = -1
  vi.resetModules()
  vi.useFakeTimers()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const admission = { release: vi.fn() }
  const store = {
    flushFinalOrThrowAsync: vi.fn(flushFinalOrThrowAsync),
    freezeWritesAsync: settled()
  }
  beginSshShutdown.mockImplementation(async () => {
    void Promise.resolve().then(() => {
      flushesByNextMicrotask = store.flushFinalOrThrowAsync.mock.calls.length
    })
  })
  const profileStateAdmission: typeof admission | undefined = admission
  const state = {
    isQuitting: false,
    watcherShutdownDone: true,
    store,
    profileStateAdmission,
    ...services
  }
  vi.doMock('electron', () => ({ app }))
  vi.doMock('./main-process-state', () => ({ mainProcessState: state }))
  for (const [moduleName, exports] of Object.entries(dependencies)) {
    vi.doMock(moduleName, () => exports)
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  const { quitTeardownStartGate } = await import('./quit/quit-teardown-start-gate')
  quitTeardownStartGate.resetForTests()
  installMainProcessQuitHandlers()
  app.emit('before-quit', { defaultPrevented: false })
  app.emit('will-quit', { preventDefault: vi.fn() })
  return { app, admission, store, state }
}

it('keeps the owned attachment until the final provider observation is acknowledged', async () => {
  const observation = Promise.withResolvers<boolean>()
  await startQuit(
    async () => {
      quitEffects.saved = true
    },
    {},
    () => observation.promise
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(quitEffects).toEqual({ ptyAttached: true, daemonConnected: true, saved: false })
  observation.resolve(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(quitEffects).toEqual({ ptyAttached: false, daemonConnected: false, saved: true })
})

it.each([
  ['unreachable', 'timed-out'],
  ['exception', 'failed'],
  ['stop', 'timed-out']
])('reports %s without preventing bounded normal teardown', async (failure, outcome) => {
  if (failure === 'stop') {
    stopAgentHookServer.mockImplementationOnce(() => {
      throw new Error('Synthetic stop failure')
    })
  }
  const { state, admission } = await startQuit(
    async () => {
      quitEffects.saved = true
    },
    {},
    () => {
      if (failure === 'exception') {
        throw new Error('Synthetic failure')
      }
      return new Promise<boolean>(() => {})
    }
  )
  await vi.runAllTimersAsync()
  expect(quitEffects).toEqual({ ptyAttached: false, daemonConnected: false, saved: true })
  expect(state.profileStateAdmission).toBe(failure === 'stop' ? admission : undefined)
  expect(console.warn).toHaveBeenCalledWith(
    '[agent-hooks] Provider observation acknowledgement incomplete at quit',
    { outcome }
  )
})

it('quits at the teardown deadline without releasing admission while the writer is pending', async () => {
  const { app, admission, store, state } = await startQuit(() => new Promise<void>(() => {}))
  await vi.advanceTimersByTimeAsync(WILL_QUIT_TEARDOWN_DEADLINE_MS - 1)
  expect(app.quit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(app.quit).toHaveBeenCalledOnce()
  expect(console.warn).toHaveBeenCalledWith('[shutdown] Quit teardown deadline reached', {
    pendingTeardowns: ['state']
  })
  expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
  expect(store.freezeWritesAsync).not.toHaveBeenCalled()
  expect(admission.release).not.toHaveBeenCalled()
  expect(state.profileStateAdmission).toBe(admission)
})

it('joins pane-grid and observation drains before final save while detaching after acknowledgement', async () => {
  const panes = Promise.withResolvers<void>()
  const observation = Promise.withResolvers<boolean>()
  await startQuit(
    async () => {
      quitEffects.saved = true
    },
    {
      runtime: quitRuntime(() => panes.promise)
    },
    () => observation.promise
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(quitEffects).toEqual({ ptyAttached: true, daemonConnected: true, saved: false })
  observation.resolve(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(quitEffects).toEqual({ ptyAttached: true, daemonConnected: false, saved: false })
  panes.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(quitEffects).toEqual({ ptyAttached: false, daemonConnected: false, saved: true })
})

it('writes a pane grid still inside its write burst before the final flush', async () => {
  const paneGrids = Promise.withResolvers<void>()
  const { store } = await startQuit(async () => {}, {
    runtime: quitRuntime(() => paneGrids.promise)
  })
  await vi.advanceTimersByTimeAsync(0)
  // Before the SSH shutdown too: nothing is awaited between it and the final save.
  expect(beginSshShutdown).not.toHaveBeenCalled()
  expect(store.flushFinalOrThrowAsync).not.toHaveBeenCalled()
  paneGrids.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(beginSshShutdown).toHaveBeenCalledOnce()
  expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
  expect(beginSshShutdown.mock.invocationCallOrder[0]).toBeLessThan(
    store.flushFinalOrThrowAsync.mock.invocationCallOrder[0]!
  )
  // Nothing awaited between them: the save started in the same turn as the SSH shutdown.
  expect(flushesByNextMicrotask).toBe(1)
})

it.each([
  ['chat teardown', 'RPC stop'],
  ['RPC stop', 'chat teardown']
] as const)(
  'closes notification dismissals only once %s and then %s settle',
  async (first, second) => {
    const sessionTeardown = Promise.withResolvers<void>()
    const rpcStop = Promise.withResolvers<void>()
    const release = { 'chat teardown': sessionTeardown.resolve, 'RPC stop': rpcStop.resolve }
    stopStructuredAgentSessionRuntime.mockClear()
    stopStructuredAgentSessionRuntime.mockImplementationOnce(() => sessionTeardown.promise)
    const closeNotificationDismissals = vi.fn(() => new Promise<void>(() => {}))
    const { app } = await startQuit(async () => {}, {
      runtime: quitRuntime(() => null, closeNotificationDismissals),
      runtimeRpc: { setMobileRelayPairingProvider: idle(), stop: vi.fn(() => rpcStop.promise) }
    })
    expect(stopStructuredAgentSessionRuntime).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeNotificationDismissals).not.toHaveBeenCalled()
    release[first]()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeNotificationDismissals).not.toHaveBeenCalled()
    release[second]()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeNotificationDismissals).toHaveBeenCalledOnce()
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(WILL_QUIT_TEARDOWN_DEADLINE_MS)
    expect(console.warn).toHaveBeenCalledWith('[shutdown] Quit teardown deadline reached', {
      pendingTeardowns: ['notification-dismissals']
    })
    expect(app.quit).toHaveBeenCalledOnce()
  }
)

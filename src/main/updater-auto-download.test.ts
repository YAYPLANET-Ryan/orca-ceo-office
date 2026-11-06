import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  appMock,
  autoUpdaterMock,
  moduleFactories,
  resetUpdaterMocks,
  chooseLocalBuildMock,
  fetchNewerReleaseTagsMock
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

const originalResourcesPath = process.resourcesPath
let resourcesDir: string | null = null

function useUpdateRepository(owner: string, repo: string): void {
  resourcesDir = mkdtempSync(join(tmpdir(), 'orca-auto-download-'))
  writeFileSync(
    join(resourcesDir, 'app-update.yml'),
    `owner: ${owner}\nrepo: ${repo}\nprovider: github\n`,
    'utf-8'
  )
  Object.defineProperty(process, 'resourcesPath', { value: resourcesDir, configurable: true })
}

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

describe('updater auto-download policy', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true
    })
    if (resourcesDir) {
      rmSync(resourcesDir, { recursive: true, force: true })
      resourcesDir = null
    }
  })

  it('automatically downloads updates for a packaged custom release feed', async () => {
    useUpdateRepository('YAYPLANET-Ryan', 'orca')
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater({ webContents: { send: vi.fn() } } as never)

    expect(autoUpdaterMock.autoDownload).toBe(true)
  })

  it('keeps upstream release downloads interactive', async () => {
    useUpdateRepository('stablyai', 'orca')
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater({ webContents: { send: vi.fn() } } as never)

    expect(autoUpdaterMock.autoDownload).toBe(false)
  })

  it.each(['upstream', 'ceo', 'missing', 'corrupt'])(
    'keeps CEO builds manual-only even with %s updater configuration',
    async (config) => {
      useUpdateRepository(config === 'ceo' ? 'YAYPLANET-Ryan' : 'stablyai', 'orca')
      if (config === 'missing') {
        rmSync(join(resourcesDir!, 'app-update.yml'))
      }
      if (config === 'corrupt') {
        writeFileSync(join(resourcesDir!, 'app-update.yml'), '[broken')
      }
      appMock.getVersion.mockReturnValue('1.4.191-ceo.20261026.1')
      const updater = await import('./updater')
      const send = vi.fn()
      const beforeQuit = vi.fn()
      updater.setupAutoUpdater({ webContents: { send } } as never, { onBeforeQuit: beforeQuit })
      updater.checkForUpdates()
      updater.checkForUpdatesFromMenu()
      updater.checkForUpdatesFromMenu({ localBuild: true })
      updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.240' })
      updater.downloadUpdate()
      updater.quitAndInstall()
      await expect(updater.listAvailableReleaseBuilds('stable')).rejects.toThrow(
        'verified CEO installer'
      )
      await vi.advanceTimersByTimeAsync(60_000)
      expect(updater.getUpdateStatus()).toMatchObject({
        state: 'error',
        message: expect.stringContaining('verified CEO installer')
      })
      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
      expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(autoUpdaterMock.on).not.toHaveBeenCalled()
      expect(chooseLocalBuildMock).not.toHaveBeenCalled()
      expect(fetchNewerReleaseTagsMock).not.toHaveBeenCalled()
      expect(beforeQuit).not.toHaveBeenCalled()
      expect(appMock.quit).not.toHaveBeenCalled()
      expect(updater.getRemoteServerUpdateSupport().automatic).toBe(false)
    }
  )
})

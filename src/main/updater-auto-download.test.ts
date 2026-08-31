import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { autoUpdaterMock, moduleFactories, resetUpdaterMocks } = await vi.hoisted(async () =>
  (await import('./updater-test-harness')).createUpdaterMocks()
)

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
})

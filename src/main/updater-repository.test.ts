import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildReleaseTagHrefPattern,
  getLatestReleaseDownloadUrl,
  getReleasesAtomFeedUrl,
  getReleasesDownloadBase,
  getUpdateRepository,
  isCustomUpdateRepository,
  resetUpdateRepositoryCacheForTest,
  resolveChannelRepository
} from './updater-repository'

const originalResourcesPath = process.resourcesPath
let created: string[] = []

function useResourcesDir(contents: string | null): void {
  const dir = mkdtempSync(join(tmpdir(), 'orca-update-repo-'))
  created.push(dir)
  if (contents !== null) {
    writeFileSync(join(dir, 'app-update.yml'), contents, 'utf-8')
  }
  Object.defineProperty(process, 'resourcesPath', { value: dir, configurable: true })
}

const CUSTOM = 'owner: YAYPLANET-Ryan\nrepo: orca\nprovider: github\n'

/** Present but unusable — an absent file is the ordinary checkout case and is
 *  covered separately. */
const UNUSABLE = [
  { name: 'missing owner', contents: 'repo: orca\n' },
  { name: 'missing repo', contents: 'owner: someone\n' },
  { name: 'blank values', contents: 'owner: "   "\nrepo: ""\n' },
  { name: 'malformed yaml', contents: 'owner: [unclosed\n' }
]

beforeEach(() => {
  created = []
  resetUpdateRepositoryCacheForTest()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  Object.defineProperty(process, 'resourcesPath', {
    value: originalResourcesPath,
    configurable: true
  })
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true })
  }
  resetUpdateRepositoryCacheForTest()
  vi.restoreAllMocks()
})

describe('getUpdateRepository', () => {
  // The failure this guards: the repository was a constant, so a custom build
  // polled upstream regardless of its own app-update.yml, offered the next
  // upstream release, and replaced itself with stock Orca when installed.
  it('takes owner and repo from app-update.yml', () => {
    useResourcesDir(CUSTOM)
    expect(getUpdateRepository()).toEqual({ owner: 'YAYPLANET-Ryan', repo: 'orca' })
    expect(isCustomUpdateRepository()).toBe(true)
    expect(getLatestReleaseDownloadUrl()).toBe(
      'https://github.com/YAYPLANET-Ryan/orca/releases/latest/download'
    )
    expect(getReleasesDownloadBase()).toBe(
      'https://github.com/YAYPLANET-Ryan/orca/releases/download'
    )
    expect(getReleasesAtomFeedUrl()).toBe('https://github.com/YAYPLANET-Ryan/orca/releases.atom')
  })

  // Accepted residual risk, recorded so the behaviour is deliberate rather than
  // forgotten: a damaged config sends a custom build back to upstream. Refusing to
  // guess was tried and reverted — see the note in updater-repository.ts.
  it.each(UNUSABLE)('falls back to upstream and says so: $name', ({ contents }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    useResourcesDir(contents)
    expect(getUpdateRepository()).toEqual({ owner: 'stablyai', repo: 'orca' })
    expect(error).toHaveBeenCalledOnce()
  })

  // A checkout has no packaged config, so its absence is ordinary and must not be
  // reported as a fault.
  it('falls back quietly when there is no config at all', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    useResourcesDir(null)
    expect(error).not.toHaveBeenCalled()
    expect(getUpdateRepository()).toEqual({ owner: 'stablyai', repo: 'orca' })
    expect(isCustomUpdateRepository()).toBe(false)
    expect(getLatestReleaseDownloadUrl()).toBe(
      'https://github.com/stablyai/orca/releases/latest/download'
    )
  })
})

describe('buildReleaseTagHrefPattern', () => {
  it('matches tag links for the configured repository only', () => {
    useResourcesDir(CUSTOM)
    const body = [
      '<a href="https://github.com/YAYPLANET-Ryan/orca/releases/tag/v1.4.176-ceo.20260808.10">',
      '<a href="https://github.com/stablyai/orca/releases/tag/v1.4.177-rc.1">'
    ].join('\n')
    const tags = [...body.matchAll(buildReleaseTagHrefPattern())].map((m) => m[1])
    expect(tags).toEqual(['v1.4.176-ceo.20260808.10'])
  })

  // A dot is the one regex metacharacter GitHub allows in a name, so leaving it
  // unescaped would match a neighbouring repository differing only there.
  it('escapes a dot so it cannot match any character', () => {
    useResourcesDir('owner: a.b\nrepo: orca\n')
    const body = [
      '<a href="https://github.com/a.b/orca/releases/tag/v1.0.0">',
      '<a href="https://github.com/axb/orca/releases/tag/v2.0.0">'
    ].join('\n')
    const tags = [...body.matchAll(buildReleaseTagHrefPattern())].map((m) => m[1])
    expect(tags).toEqual(['v1.0.0'])
  })
})

describe('resolveChannelRepository', () => {
  // stable and rc both resolve to the main repository, and that is the one a fork
  // republishes under its own name.
  it('redirects the main repository to the configured one', () => {
    useResourcesDir(CUSTOM)
    expect(resolveChannelRepository('stablyai/orca', 'stablyai/orca')).toBe('YAYPLANET-Ryan/orca')
  })

  // hourly and adhoc are upstream build channels; a fork does not publish to them,
  // so redirecting would turn a working lookup into a 404.
  it.each(['stablyai/orca-hourly', 'stablyai/orca-adhoc'])(
    'leaves the dedicated dev channel %s alone',
    (channelRepo) => {
      useResourcesDir(CUSTOM)
      expect(resolveChannelRepository(channelRepo, 'stablyai/orca')).toBe(channelRepo)
    }
  )

  it('is a no-op for an upstream build', () => {
    useResourcesDir('owner: stablyai\nrepo: orca\n')
    expect(resolveChannelRepository('stablyai/orca', 'stablyai/orca')).toBe('stablyai/orca')
  })
})

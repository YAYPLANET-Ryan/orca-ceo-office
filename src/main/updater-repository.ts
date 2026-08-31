import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/** Which GitHub repository the updater pulls releases from.
 *
 *  electron-builder writes owner/repo into app-update.yml from the publish block,
 *  and everyone reasonably expects that file to decide where a build looks for
 *  updates. It did not: the repository was hardcoded here, and the updater
 *  overrides electron-updater's provider with a generic URL built from these
 *  constants. A custom build therefore polled the upstream repository no matter
 *  what its own app-update.yml said, offered the next upstream release, and
 *  replaced itself with stock Orca when that release was installed — observed
 *  twice on 2026-08-08, once ending on an upstream RC.
 *
 *  Reading the generated file makes it authoritative.
 *
 *  Known residual risk, accepted deliberately: a packaged build whose config is
 *  missing or damaged falls back to the upstream defaults, which for a custom
 *  build means polling upstream — the same shape as the incident above, though
 *  reached by a different route. Refusing to guess instead was tried and reverted:
 *  the URL builders are called on ordinary code paths, so returning nothing turns
 *  a degraded config into thrown exceptions across the update path, and it broke
 *  59 upstream tests that would then conflict on every weekly merge. The observed
 *  failure was a hardcoded constant, which this fixes; a damaged app-update.yml in
 *  a packaged install is hypothetical and means the install is already broken.
 *  It is logged at error level so it is at least visible if it ever happens.
 */
const DEFAULT_OWNER = 'stablyai'
const DEFAULT_REPO = 'orca'

type UpdateRepository = { owner: string; repo: string }

let cached: UpdateRepository | null = null

/** Only reported when the file is there but unusable. A checkout has no packaged
 *  config at all, so its absence is ordinary and must not be logged as a fault —
 *  and importing electron here to tell the two apart broke every updater test
 *  that mocks the module without `app`. */
function warnDegraded(reason: string): void {
  console.error(`[updater] ${reason}; falling back to ${DEFAULT_OWNER}/${DEFAULT_REPO}`)
}

function readConfiguredRepository(): UpdateRepository {
  // Why not electron-updater's own loader: it only exposes the parsed config once
  // a check is running, and this is needed to build the feed URL before that.
  try {
    const configPath = join(process.resourcesPath, 'app-update.yml')
    if (!existsSync(configPath)) {
      return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO }
    }
    const parsed = parse(readFileSync(configPath, 'utf-8')) as {
      owner?: unknown
      repo?: unknown
    } | null
    const owner = typeof parsed?.owner === 'string' ? parsed.owner.trim() : ''
    const repo = typeof parsed?.repo === 'string' ? parsed.repo.trim() : ''
    if (!owner || !repo) {
      warnDegraded('app-update.yml has no owner/repo')
      return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO }
    }
    return { owner, repo }
  } catch (err) {
    warnDegraded(
      `could not read app-update.yml (${err instanceof Error ? err.message : String(err)})`
    )
    return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO }
  }
}

export function getUpdateRepository(): UpdateRepository {
  if (!cached) {
    cached = readConfiguredRepository()
  }
  return cached
}

export function isCustomUpdateRepository(): boolean {
  const { owner, repo } = getUpdateRepository()
  return owner !== DEFAULT_OWNER || repo !== DEFAULT_REPO
}

export function getReleasesAtomFeedUrl(): string {
  const { owner, repo } = getUpdateRepository()
  return `https://github.com/${owner}/${repo}/releases.atom`
}

export function getReleasesDownloadBase(): string {
  const { owner, repo } = getUpdateRepository()
  return `https://github.com/${owner}/${repo}/releases/download`
}

export function getLatestReleaseDownloadUrl(): string {
  const { owner, repo } = getUpdateRepository()
  return `https://github.com/${owner}/${repo}/releases/latest/download`
}

/** Matches the `/releases/tag/<tag>` links in the atom feed for this repository. */
export function buildReleaseTagHrefPattern(): RegExp {
  const { owner, repo } = getUpdateRepository()
  const escaped = `${owner}/${repo}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`href="https://github\\.com/${escaped}/releases/tag/([^"]+)"`, 'g')
}

/** `owner/repo` for the configured repository. */
export function getUpdateRepositorySlug(): string {
  const { owner, repo } = getUpdateRepository()
  return `${owner}/${repo}`
}

/** Redirects the main release repository to the configured one, leaving the
 *  dedicated dev-channel repositories (hourly, adhoc) alone — those are upstream
 *  build channels and a fork does not publish to them. */
export function resolveChannelRepository(channelRepo: string, mainRepo: string): string {
  return channelRepo === mainRepo ? getUpdateRepositorySlug() : channelRepo
}

export function resetUpdateRepositoryCacheForTest(): void {
  cached = null
}

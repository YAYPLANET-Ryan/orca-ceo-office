import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

export function nativeCachePlatformScope(runnerOS, imageOS, osRelease) {
  if (runnerOS !== 'Linux') {
    return imageOS || runnerOS
  }
  const { ID, VERSION_ID } = parseEnv(osRelease ?? '')
  if (!ID || !VERSION_ID || !/^[a-z0-9._-]+$/i.test(ID) || !/^[a-z0-9._-]+$/i.test(VERSION_ID)) {
    throw new Error('Linux native cache requires a known os-release ID and VERSION_ID')
  }
  return `${ID}-${VERSION_ID}`
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  const runnerOS = process.env.RUNNER_OS
  const osRelease = runnerOS === 'Linux' ? readFileSync('/etc/os-release', 'utf8') : undefined
  console.log(nativeCachePlatformScope(runnerOS, process.env.ImageOS, osRelease))
}

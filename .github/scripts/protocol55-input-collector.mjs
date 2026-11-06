import { randomUUID } from 'node:crypto'
import { realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.platform !== 'win32' ||
  !process.env.RUNNER_TEMP
) {
  throw new Error('Synthetic PTY collector requires the disposable Windows runner')
}
const root = realpathSync(import.meta.dirname)
const relative = path.relative(realpathSync(process.env.RUNNER_TEMP), root)
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !process.stdin.isTTY) {
  throw new Error('Synthetic collector requires its private temporary PTY')
}
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let pending = ''
let expected = 'BEFORE'
function fail(reason) {
  writeFileSync(
    path.join(root, 'orca-protocol55-input-error.json'),
    JSON.stringify({ reason, pid: process.pid, expected })
  )
  throw new Error(reason)
}
process.stdin.on('data', (chunk) => {
  pending += String(chunk)
  if (pending.length > 1024) {
    fail('Synthetic terminal input exceeded its fixed payload')
  }
  let delimiter
  while ((delimiter = pending.search(/[\r\n]/)) !== -1) {
    const line = pending.slice(0, delimiter)
    pending = pending.slice(delimiter + 1)
    if (!line) {
      continue
    }
    if (expected === 'DONE' || line !== `ORCA_PROTOCOL55_${expected}`) {
      fail('Unexpected or duplicate synthetic terminal input')
    }
    writeFileSync(path.join(root, `orca-protocol55-${expected.toLowerCase()}.txt`), line)
    expected = expected === 'BEFORE' ? 'AFTER' : 'DONE'
  }
})
process.stdin.resume()
writeFileSync(
  path.join(root, 'orca-protocol55-ready.json'),
  JSON.stringify({ pid: process.pid, instanceId: randomUUID() })
)
process.stdout.write('ORCA_PROTOCOL55_WORKER_READY\r\n')

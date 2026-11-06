import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (
  pkg.orcaBuildChannel !== 'ceo-review' ||
  pkg.orcaRecoverySource !== process.env.ORCA_RECOVERY_SOURCE
) {
  throw new Error('Refuse an unstamped CEO package')
}
function fileFacts(file) {
  const size = statSync(file).size
  if (size <= 0) {
    throw new Error(`Required package file is empty: ${file}`)
  }
  return { path: file, size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
}
const required = [
  'Orca.exe',
  'resources/app.asar',
  'resources/bin/orca.exe',
  'resources/bin/orca-agent-hook.exe',
  'resources.pak',
  'icudtl.dat'
]
const proof = {
  source: pkg.orcaRecoverySource,
  upstreamSource: pkg.orcaUpstreamSource,
  version: pkg.version,
  channel: pkg.orcaBuildChannel,
  installer: fileFacts('dist/orca-ceo-setup.exe'),
  files: required.map((file) => fileFacts(path.join('dist/win-unpacked', file))),
  liveInstallationPerformed: false,
  operatingAcceptance: 'NOT_ESTABLISHED'
}
writeFileSync('dist/ceo-installer-manifest.json', `${JSON.stringify(proof, null, 2)}\n`)
console.log(
  JSON.stringify({ version: proof.version, source: proof.source, installer: proof.installer })
)

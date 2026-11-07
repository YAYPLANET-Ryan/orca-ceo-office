import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export function verifyInstalledArtifact({ install, manifest, legacyReference, onMismatch }) {
  if (
    legacyReference &&
    (manifest.source !== '7896bd2618f62215ab0852f6618fb9d4ea8d6ede' ||
      manifest.version !== '1.4.191-ceo.20261105.19')
  ) {
    throw new Error('Five-file verification is restricted to the pinned legacy reference')
  }
  const expected = new Set([
    'Orca.exe',
    'resources/app.asar',
    'resources/bin/orca.exe',
    'resources.pak',
    'icudtl.dat'
  ])
  if (!legacyReference) {
    expected.add('resources/bin/orca-agent-hook.exe')
  }
  const checks = []
  for (const file of manifest.files) {
    const relative = file.path.replaceAll('\\', '/').replace(/^dist\/win-unpacked\//, '')
    if (!expected.delete(relative)) {
      throw new Error('Unexpected or duplicate essential file')
    }
    const target = path.join(install, relative)
    const present = existsSync(target)
    const size = present ? statSync(target).size : null
    const actualHash =
      present && size > 0 && (size === file.size || size <= 512 * 1024 * 1024)
        ? createHash('sha256').update(readFileSync(target)).digest('hex')
        : null
    checks.push({
      relative,
      expectedSize: file.size,
      actualSize: size,
      expectedSha256: file.sha256,
      actualSha256: actualHash,
      present
    })
  }
  if (expected.size) {
    throw new Error('Essential manifest is incomplete')
  }
  const mismatches = checks.filter(
    (file) =>
      !file.present ||
      file.expectedSize <= 0 ||
      file.actualSize !== file.expectedSize ||
      file.actualSha256 !== file.expectedSha256
  )
  if (mismatches.length) {
    onMismatch?.({ expectedSource: manifest.source, expectedVersion: manifest.version, checks })
    throw new Error(
      `Installed file differs from its pinned manifest: ${mismatches.map((f) => f.relative).join(', ')}`
    )
  }
  const asar = createRequire(import.meta.url)('@electron/asar')
  const archive = path.join(install, 'resources/app.asar')
  asar.uncache(archive)
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json'))
  if (metadata.version !== manifest.version || metadata.orcaRecoverySource !== manifest.source) {
    throw new Error('Installed package source or version differs from the verified installer')
  }
}

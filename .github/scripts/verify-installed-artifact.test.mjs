import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { verifyInstalledArtifact } from './verify-installed-artifact.mjs'

const asar = createRequire(import.meta.url)('@electron/asar')
async function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-verifier-data-only-'))
  const install = path.join(root, 'installed')
  const payload = path.join(root, 'payload')
  mkdirSync(path.join(install, 'resources/bin'), { recursive: true })
  mkdirSync(payload)
  const source = 'a'.repeat(40)
  const version = '1.4.253-ceo.20261107.1'
  const names = [
    'Orca.exe',
    'resources/app.asar',
    'resources/bin/orca.exe',
    'resources/bin/orca-agent-hook.exe',
    'resources.pak',
    'icudtl.dat'
  ]
  writeFileSync(
    path.join(payload, 'package.json'),
    JSON.stringify({ version, orcaRecoverySource: source })
  )
  await asar.createPackage(payload, path.join(install, 'resources/app.asar'))
  for (const name of names.filter((name) => !name.endsWith('.asar'))) {
    writeFileSync(path.join(install, name), 'SYNTHETIC_NON_EXECUTABLE_FILE')
  }
  const manifest = {
    source,
    version,
    files: names.map((name) => {
      const bytes = readFileSync(path.join(install, name))
      return {
        path: `dist/win-unpacked/${name}`,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    })
  }
  const failures = []
  const verify = () =>
    verifyInstalledArtifact({
      install,
      manifest,
      legacyReference: false,
      onMismatch: (facts) => failures.push(facts)
    })
  try {
    await run({ install, payload, manifest, failures, verify })
  } finally {
    assert(root.startsWith(path.join(tmpdir(), 'orca-verifier-data-only-')))
    rmSync(root, { recursive: true, force: true })
  }
}
test('accepts matching content and exact source/version', () => fixture(({ verify }) => verify()))
for (const kind of ['missing', 'empty', 'wrong-hash']) {
  test(`rejects ${kind} content and reports complete actual/expected facts`, () =>
    fixture(({ install, failures, verify }) => {
      const file = path.join(install, 'resources.pak')
      if (kind === 'missing') {
        rmSync(file)
      } else {
        writeFileSync(file, kind === 'empty' ? '' : 'X'.repeat(readFileSync(file).length))
      }
      assert.throws(verify, /differs from its pinned manifest/)
      assert.equal(failures.length, 1)
      assert.equal(failures[0].checks.length, 6)
      const observed = failures[0].checks.find((f) => f.relative === 'resources.pak')
      assert(
        kind === 'missing'
          ? !observed.present
          : kind === 'empty'
            ? observed.actualSize === 0
            : observed.actualSha256 !== observed.expectedSha256
      )
    }))
}
for (const field of ['source', 'version']) {
  test(`rejects wrong package ${field} despite matching file bytes`, () =>
    fixture(({ manifest, verify }) => {
      manifest[field] += 'wrong'
      assert.throws(verify, /package source or version differs/)
    }))
}
test('rejects omitted essential entry', () =>
  fixture(({ manifest, verify }) => {
    manifest.files.pop()
    assert.throws(verify, /manifest is incomplete/)
  }))
test('rejects duplicate essential entry', () =>
  fixture(({ manifest, verify }) => {
    manifest.files.push(manifest.files[0])
    assert.throws(verify, /Unexpected or duplicate/)
  }))
test('five-file exception rejects unpinned source', () =>
  fixture(({ install, manifest }) => {
    assert.throws(
      () => verifyInstalledArtifact({ install, manifest, legacyReference: true }),
      /restricted to the pinned/
    )
  }))
test('pinned legacy source accepts five matching files', () =>
  fixture(async ({ install, payload, manifest }) => {
    manifest.source = '7896bd2618f62215ab0852f6618fb9d4ea8d6ede'
    manifest.version = '1.4.191-ceo.20261105.19'
    writeFileSync(
      path.join(payload, 'package.json'),
      JSON.stringify({ version: manifest.version, orcaRecoverySource: manifest.source })
    )
    await asar.createPackage(payload, path.join(install, 'resources/app.asar'))
    manifest.files = manifest.files.filter((f) => !f.path.endsWith('orca-agent-hook.exe'))
    const bytes = readFileSync(path.join(install, 'resources/app.asar'))
    const entry = manifest.files.find((f) => f.path.endsWith('app.asar'))
    entry.size = bytes.length
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    verifyInstalledArtifact({ install, manifest, legacyReference: true })
  }))

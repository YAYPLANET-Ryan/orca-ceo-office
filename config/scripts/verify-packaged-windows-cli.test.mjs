import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyPackagedWindowsCli } = require('./verify-packaged-windows-cli.cjs')
const assets = ['bin/orca.exe', 'bin/orca.cmd', 'app.asar.unpacked/out/cli/index.js', '../Orca.exe']
const fixtureRoots = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture({ missing, empty, directory } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-windows-cli-layout-'))
  fixtureRoots.push(root)
  const resourcesDir = join(root, 'resources')
  for (const asset of assets) {
    if (asset === missing) {
      continue
    }
    const file = join(resourcesDir, asset)
    mkdirSync(dirname(file), { recursive: true })
    if (asset === directory) {
      mkdirSync(file)
    } else {
      writeFileSync(file, asset === empty ? '' : 'fixture bytes')
    }
  }
  return resourcesDir
}

describe('packaged Windows CLI integrity', () => {
  it('accepts a complete nonempty packaged CLI layout', () => {
    expect(() => verifyPackagedWindowsCli(fixture(), 'win32')).not.toThrow()
  })

  it.each(assets)('rejects a missing %s, including on cross-architecture builds', (asset) => {
    expect(() => verifyPackagedWindowsCli(fixture({ missing: asset }), 'win32')).toThrow(
      'missing required CLI asset'
    )
  })

  it.each(assets)('rejects an empty %s', (asset) => {
    expect(() => verifyPackagedWindowsCli(fixture({ empty: asset }), 'win32')).toThrow(
      'empty or invalid CLI asset'
    )
  })

  it('rejects a directory masquerading as the native launcher', () => {
    expect(() => verifyPackagedWindowsCli(fixture({ directory: 'bin/orca.exe' }), 'win32')).toThrow(
      'empty or invalid CLI asset'
    )
  })

  it.each(['darwin', 'linux'])('does not impose Windows layout on %s', (platform) => {
    expect(() => verifyPackagedWindowsCli('nonexistent-resources', platform)).not.toThrow()
  })

  it('checks the actual package before other post-packaging probes', () => {
    const builder = readFileSync(new URL('../electron-builder.config.cjs', import.meta.url), 'utf8')
    expect(builder).toContain(
      'verifyPackagedWindowsCli(resourcesDir, context.electronPlatformName)'
    )
    expect(builder.indexOf('verifyPackagedWindowsCli(resourcesDir,')).toBeLessThan(
      builder.indexOf('prunePackagedRuntimeNodeModules(resourcesDir,')
    )
  })
})
